import { toast } from "sonner";
import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	type WrappedCanvas,
} from "mediabunny";

/**
 * Why a sink for a given mediaId+tier failed to initialize (see
 * `initializeSink`). "codec-unsupported" is the specific, expected case this
 * browser can't decode the stored codec (matches `canDecode()` returning
 * false); "init-failed" covers everything else (missing video track, decoder
 * construction failure) — still recoverable, still worth telling the user
 * about, just without the more specific copy.
 */
export type SinkInitFailureReason = "codec-unsupported" | "init-failed";

interface VideoSinkData {
	input: Input;
	sink: CanvasSink;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	/** The newest frame handed to a consumer (still being drawn this frame). */
	currentFrame: WrappedCanvas | null;
	/**
	 * Decoded frames AHEAD of currentFrame, ascending timestamps. Serving from
	 * here is synchronous, which is what keeps steady playback off the decoder
	 * on the render path.
	 */
	ring: WrappedCanvas[];
	lastTime: number;
	lastAccess: number;
	/** True while fillRing() is decoding in the background. */
	filling: boolean;
	fillPromise: Promise<void> | null;
	/** Set by seekToTime/clearVideo to stop an in-flight fill after its current decode. */
	fillCancelled: boolean;
	warmPromise: Promise<void> | null;
	/**
	 * Per-sink task chain: getFrameAt and warm for one mediaId run strictly one
	 * at a time. Two clips of the same media prepared/rendered concurrently (or
	 * warm racing getFrameAt) would otherwise interleave mutations of this
	 * sink's single iterator — historically only prevented by the render tree
	 * being awaited serially. Enforcing it here keeps the invariant no matter
	 * how callers schedule their fetches.
	 */
	chain: Promise<unknown>;
	/** Long-edge decode cap the sink was created with (preview/export tiers only). */
	maxSize: number | null;
	/**
	 * The File this sink was built from. A given (mediaId, tier) key does NOT
	 * uniquely determine which file backs it: scene-builder can swap a preview
	 * element between an asset's original and its proxy at the SAME tier
	 * ("preview") depending on playback/settle state (see
	 * scene-builder.ts/preview's `useIsPlaybackSettled`) or export's
	 * `forceProxyAssetIds` fallback. Without this, `ensureSink` would see an
	 * already-cached sink for the key and keep serving frames decoded from the
	 * OLD file even after the caller asked for a different one — silently
	 * undoing a settle-to-original (or fallback-to-proxy) scene rebuild.
	 */
	file: File;
}

/**
 * Decode tiers. "full" decodes at the source's native resolution — required
 * whenever an element's on-screen sampling could exceed the output/preview
 * canvas density (e.g. a >1x zoom transform), where downscaling at decode
 * would bake in a soft, upscaled result. "preview" caps the decoded long edge
 * at `previewMaxSize` so the live render loop never pays for pixels the
 * preview canvas can't show (e.g. 4K sources on a 1080p project). "export"
 * is the same cap mechanism applied to export/snapshot scenes, capped at the
 * output canvas's long edge instead of the (possibly zoomed) preview canvas —
 * see scene-builder.ts's per-element full-res fallback. Each tier gets its
 * own sink/decoder, keyed mediaId+tier, so the tiers never fight over one
 * iterator position.
 */
export type VideoSinkTier = "full" | "preview" | "export";

/** Tiers whose sink decodes at a capped (non-native) resolution. */
function isCappedTier(tier: VideoSinkTier): tier is "preview" | "export" {
	return tier === "preview" || tier === "export";
}

/** How far ahead of a clip's start a warm() pre-seek is worth doing. */
export const WARM_LOOKAHEAD_SECONDS = 1.0;

/** A sink read this recently is considered in active use by a renderer. */
const ACTIVE_USE_WINDOW_MS = 250;

/** mediaIds are nanoids (no ":"), so these suffixes can't collide. */
const PREVIEW_KEY_SUFFIX = "::preview";
const EXPORT_KEY_SUFFIX = "::export";

function sinkKey({
	mediaId,
	tier,
}: {
	mediaId: string;
	tier: VideoSinkTier;
}): string {
	if (tier === "preview") return `${mediaId}${PREVIEW_KEY_SUFFIX}`;
	if (tier === "export") return `${mediaId}${EXPORT_KEY_SUFFIX}`;
	return mediaId;
}

/**
 * How far past the last served frame a request still counts as sequential
 * playback (served by the ring / bounded forward decode) rather than a seek.
 */
const SEQUENTIAL_WINDOW_SECONDS = 2.0;

/** Decoded frames to keep buffered ahead of the playhead. */
export const PREFETCH_RING_CAPACITY = 4;

/**
 * CanvasSink reuses its pooled canvases round-robin: the Nth yield after a
 * frame OVERWRITES that frame's canvas (mediabunny media-sink
 * `_videoSampleToWrappedCanvas`). Every WrappedCanvas we hold live must
 * therefore fit inside the pool or frames silently alias (corrupted frames).
 * Live at once: currentFrame (1) + ring (PREFETCH_RING_CAPACITY) + one frame
 * mid-yield in a fill/iterate (1) + a frame stashed by a second clip of the
 * same media across a prepare/render pass (1), plus one slot of margin.
 */
const SINK_POOL_SIZE = PREFETCH_RING_CAPACITY + 4;

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	/**
	 * Sink keys (mediaId+tier, see `sinkKey`) whose `initializeSink` call
	 * failed — e.g. `canDecode()` came back false for this browser. Recorded
	 * instead of left to an unhandled throw so getFrameAt/warm degrade to
	 * their existing "nothing to render yet" null path rather than crashing
	 * the render loop, and so a known-bad sink isn't re-probed (and re-toasted)
	 * on every single animation frame. Cleared on disposeSink (clearVideo/
	 * clearAll/tier-cap rebuild), so a project reload or a later-arriving
	 * proxy gets a fresh attempt.
	 */
	private sinkInitFailures = new Map<string, SinkInitFailureReason>();

	/**
	 * `tolerateStale` opts into the realtime drop policy: when the exact frame
	 * for `time` isn't decoded yet mid-playback, return the newest frame <=
	 * `time` immediately instead of awaiting the decode. Only the live preview
	 * sets it — export/snapshot/thumbnail paths must keep the default (false)
	 * or a late decode would embed a duplicated frame in their output.
	 */
	async getFrameAt({
		mediaId,
		file,
		time,
		tolerateStale = false,
		tier = "full",
		previewMaxSize,
	}: {
		mediaId: string;
		file: File;
		time: number;
		tolerateStale?: boolean;
		/** Decode tier; elements that need native-resolution decode (full res
		 *  fallback) must stay on the "full" default. */
		tier?: VideoSinkTier;
		/** Long-edge cap for the preview/export tiers' decoded frames. */
		previewMaxSize?: number;
	}): Promise<WrappedCanvas | null> {
		await this.ensureSink({ mediaId, file, tier, previewMaxSize });

		const sinkData = this.sinks.get(sinkKey({ mediaId, tier }));
		if (!sinkData) return null;

		return this.runExclusive({
			sinkData,
			task: () => this.getFrameAtExclusive({ sinkData, time, tolerateStale }),
		});
	}

	/**
	 * Serialize getFrameAt/warm per mediaId (see VideoSinkData.chain). The
	 * background ring fill is NOT chained — it must overlap the render path —
	 * so iterator-touching steps (iterateToTime/seekToTime) still explicitly
	 * cancel/await it before mutating the iterator.
	 */
	private runExclusive<T>({
		sinkData,
		task,
	}: {
		sinkData: VideoSinkData;
		task: () => Promise<T>;
	}): Promise<T> {
		const result = sinkData.chain.then(task, task);
		sinkData.chain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async getFrameAtExclusive({
		sinkData,
		time,
		tolerateStale,
	}: {
		sinkData: VideoSinkData;
		time: number;
		tolerateStale: boolean;
	}): Promise<WrappedCanvas | null> {
		sinkData.lastAccess = performance.now();

		this.consumeRing({ sinkData, time });

		{
			const frame = this.serveCurrent({ sinkData, time });
			if (frame) return frame;
		}

		// lastTime === currentFrame.timestamp whenever currentFrame is set (all
		// writers keep them in lockstep), so inWindow implies currentFrame's
		// timestamp <= time.
		const inWindow =
			sinkData.currentFrame !== null &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + SEQUENTIAL_WINDOW_SECONDS;

		if (inWindow) {
			// The next decoded frame is already past `time` (variable frame rate
			// gap): currentFrame is the newest frame <= time; nothing better
			// exists. Mirrors CanvasSink.getCanvas ("last frame with start <=
			// timestamp") semantics.
			if (sinkData.ring.length > 0) {
				this.startFill({ sinkData });
				return sinkData.currentFrame;
			}

			if (sinkData.filling) {
				// Drop policy (realtime preview): a fill decode is in flight and
				// the exact frame isn't buffered yet. Never await a mid-window
				// decode on the render path — serve the newest frame <= time
				// immediately and let the ring catch up in the background.
				// Awaiting here turned one slow GOP into a visible stall for
				// every layer stacked behind it.
				if (tolerateStale) return sinkData.currentFrame;

				// Exact mode (export/snapshot): wait for the in-flight fill and
				// re-check — the old "wait for a late prefetch instead of
				// re-seeking" behavior. Escalating to seekToTime here instead
				// was the deterministic mid-playback freeze.
				while (sinkData.fillPromise) {
					await sinkData.fillPromise;
					this.consumeRing({ sinkData, time });
					const frame = this.serveCurrent({ sinkData, time });
					if (frame) return frame;
					if (sinkData.ring.length > 0) return sinkData.currentFrame;
				}
			}

			// Decoder idle (paused scrub / single-frame step, or exact mode
			// after the fill drained): advance the iterator sequentially —
			// bounded forward decode, no keyframe re-seek. Serving a stale
			// frame here instead would leave a paused preview showing the wrong
			// frame with nothing scheduled to repaint it.
			if (sinkData.iterator) {
				const frame = await this.iterateToTime({ sinkData, targetTime: time });
				if (frame) {
					this.startFill({ sinkData });
					return frame;
				}
			}
		}

		// Genuine seek (outside the sequential window, or the iterator died):
		// a keyframe re-seek is unavoidable, await it as before.
		return this.seekToTime({ sinkData, time });
	}

	/** Serve currentFrame if it exactly covers `time`, topping up the ring. */
	private serveCurrent({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): WrappedCanvas | null {
		const current = sinkData.currentFrame;
		if (current && this.isFrameValid({ frame: current, time })) {
			this.startFill({ sinkData });
			return current;
		}
		return null;
	}

	/**
	 * Adopt the newest ring frame at or before `time` as currentFrame, dropping
	 * any older ring frames (at playbackRate>1 the playhead legitimately skips
	 * source frames — serving each one late is worse than dropping).
	 *
	 * Deliberately does NOT kick the fill: the drop policy must only trigger on
	 * a fill that was already in flight when the request arrived (decoder
	 * genuinely behind realtime). Kicking here would make a paused single-frame
	 * step look "mid-fill" and stale-serve a frame nothing will ever repaint.
	 */
	private consumeRing({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): void {
		let adopted: WrappedCanvas | null = null;
		while (sinkData.ring.length > 0 && sinkData.ring[0].timestamp <= time) {
			adopted = sinkData.ring.shift() as WrappedCanvas;
		}
		if (adopted) {
			sinkData.currentFrame = adopted;
			// Keep lastTime tracking the newest frame the consumer holds. Without
			// this, steady playback served entirely by the ring fast path leaves
			// lastTime frozen at the last seek position; once the playhead is >2s
			// past it, the sequential window can never match and any late fill
			// escalates to a full seekToTime (keyframe re-seek + forward decode)
			// — a deterministic mid-playback freeze.
			sinkData.lastTime = adopted.timestamp;
		}
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}

	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<WrappedCanvas | null> {
		if (!sinkData.iterator) return null;

		// Only entered with the fill idle and the ring empty (getFrameAtExclusive
		// guards both), so the iterator's next yield follows currentFrame.
		try {
			while (true) {
				const { value: frame, done } = await sinkData.iterator.next();

				if (done || !frame) break;

				sinkData.currentFrame = frame;
				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}

	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		try {
			// Stop the background fill before tearing down the iterator it reads.
			if (sinkData.fillPromise) {
				sinkData.fillCancelled = true;
				await sinkData.fillPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.ring = [];
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;
				sinkData.lastTime = frame.timestamp;

				// Fill the ring in the background. Awaiting even one extra decode
				// here doubled the on-screen stall of every seek that happens
				// mid-render (the render loop awaits this whole call).
				this.startFill({ sinkData });

				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	/**
	 * Position a clip's decoder at `time` before the playhead gets there, so
	 * crossing into the clip doesn't pay the keyframe re-seek + forward decode
	 * on the render path (the render loop awaits getFrameAt, so a cold or
	 * stale-positioned iterator at a clip boundary froze the preview at the
	 * same spot on every playthrough). Fire-and-forget; safe to call every
	 * frame — it no-ops when the sink is already positioned, mid-warm, or in
	 * active use by another clip of the same media.
	 */
	async warm({
		mediaId,
		file,
		time,
		tier = "full",
		previewMaxSize,
	}: {
		mediaId: string;
		file: File;
		time: number;
		tier?: VideoSinkTier;
		previewMaxSize?: number;
	}): Promise<void> {
		await this.ensureSink({ mediaId, file, tier, previewMaxSize });

		const sinkData = this.sinks.get(sinkKey({ mediaId, tier }));
		if (!sinkData) return;

		if (sinkData.warmPromise) return;

		// Run on the per-sink chain so a warm never interleaves with a
		// getFrameAt touching the same iterator; warmPromise stays as the
		// dedup flag so repeated per-frame warm calls don't queue up.
		const warmPromise = this.runExclusive({
			sinkData,
			task: () => this.warmExclusive({ sinkData, time }),
		}).finally(() => {
			sinkData.warmPromise = null;
		});
		sinkData.warmPromise = warmPromise;
		await warmPromise;
	}

	private async warmExclusive({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<void> {
		// Another clip of the same media is actively rendering from this sink —
		// repositioning its iterator would glitch that clip.
		if (performance.now() - sinkData.lastAccess < ACTIVE_USE_WINDOW_MS) return;

		// Already showing the right frame, or close enough that the cheap
		// sequential path will cover it.
		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			return;
		}
		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + SEQUENTIAL_WINDOW_SECONDS
		) {
			return;
		}

		await this.seekToTime({ sinkData, time });
	}

	private startFill({ sinkData }: { sinkData: VideoSinkData }): void {
		if (
			sinkData.filling ||
			!sinkData.iterator ||
			sinkData.ring.length >= PREFETCH_RING_CAPACITY
		) {
			return;
		}

		sinkData.filling = true;
		sinkData.fillCancelled = false;
		sinkData.fillPromise = this.fillRing({ sinkData });
	}

	private async fillRing({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		try {
			while (
				!sinkData.fillCancelled &&
				sinkData.iterator &&
				sinkData.ring.length < PREFETCH_RING_CAPACITY
			) {
				const { value: frame, done } = await sinkData.iterator.next();

				if (done || !frame) break;

				// A seek started while this decode was in flight; the frame belongs
				// to the abandoned position — drop it, the seek clears the ring.
				if (sinkData.fillCancelled) break;

				sinkData.ring.push(frame);
			}
		} catch (error) {
			console.warn("Ring fill failed:", error);
			sinkData.iterator = null;
		} finally {
			sinkData.filling = false;
			sinkData.fillPromise = null;
		}
	}

	private async ensureSink({
		mediaId,
		file,
		tier,
		previewMaxSize,
	}: {
		mediaId: string;
		file: File;
		tier: VideoSinkTier;
		previewMaxSize?: number;
	}): Promise<void> {
		const key = sinkKey({ mediaId, tier });

		// Already know this sink can't init (e.g. codec unsupported here) — the
		// user's already been told once; don't re-run the (WebCodecs) probe and
		// re-toast on every render-loop frame that touches this clip.
		if (this.sinkInitFailures.has(key)) return;

		const existing = this.sinks.get(key);
		if (existing) {
			// The preview/export cap follows the project's canvas size, which can
			// change mid-session (frame preset switch) — rebuild the sink at the
			// new cap instead of serving stale-resolution frames forever.
			const capChanged =
				isCappedTier(tier) &&
				previewMaxSize !== undefined &&
				existing.maxSize !== previewMaxSize;
			// The same (mediaId, tier) key can legitimately point at a different
			// File over time — a preview scene swapping between an asset's
			// original and its proxy at the same "preview" tier (settle-to-
			// original / display-aware upscale guard), or an export scene's
			// forceProxyAssetIds fallback. Reference equality is enough: File
			// objects for an asset's original/proxy are created once and held
			// for the asset's lifetime, never mutated in place.
			const fileChanged = existing.file !== file;
			if (capChanged || fileChanged) {
				this.disposeSink({ key });
			} else {
				return;
			}
		}

		if (this.initPromises.has(key)) {
			await this.initPromises.get(key);
			return;
		}

		const initPromise = this.initializeSink({
			mediaId,
			file,
			tier,
			previewMaxSize,
		});
		this.initPromises.set(key, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(key);
		}
	}

	private async initializeSink({
		mediaId,
		file,
		tier,
		previewMaxSize,
	}: {
		mediaId: string;
		file: File;
		tier: VideoSinkTier;
		previewMaxSize?: number;
	}): Promise<void> {
		const key = sinkKey({ mediaId, tier });
		let input: Input | undefined;
		try {
			input = new Input({
				source: new BlobSource(file),
				formats: ALL_FORMATS,
			});

			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			// Capped tiers (preview/export): have mediabunny convert decoded frames
			// straight to the capped size (aspect preserved), so every downstream
			// copy/composite of this frame touches fewer pixels. Sources already
			// within the cap keep their native size — no upscaling, no wasted
			// conversion.
			let outputSize: { width: number; height: number } | undefined;
			if (isCappedTier(tier) && previewMaxSize !== undefined) {
				const longEdge = Math.max(
					videoTrack.displayWidth,
					videoTrack.displayHeight,
				);
				if (longEdge > previewMaxSize) {
					const scale = previewMaxSize / longEdge;
					outputSize = {
						width: Math.max(2, Math.round(videoTrack.displayWidth * scale)),
						height: Math.max(2, Math.round(videoTrack.displayHeight * scale)),
					};
				}
			}

			const baseSinkOptions = {
				// Must stay >= the maximum number of live WrappedCanvas frames —
				// see the SINK_POOL_SIZE accounting above.
				poolSize: SINK_POOL_SIZE,
				fit: "contain" as const,
				...outputSize,
			};

			// Explicit hardware-decode hint: measured 1080p ~580→~950fps (+64%)
			// and 4K HEVC ~112→~309fps (+176%), AND far tighter run-to-run
			// variance vs the WebCodecs default "no-preference" (perf audit #5).
			// `canDecode()` above already confirms this codec/config decodes here
			// at all, but that doesn't guarantee the hardware path specifically
			// works on every device — if constructing the sink under
			// prefer-hardware throws, fall back to the default once rather than
			// failing this media's ingest/playback entirely.
			let sink: CanvasSink;
			try {
				sink = new CanvasSink(videoTrack, {
					...baseSinkOptions,
					decoderOptions: { hardwareAcceleration: "prefer-hardware" },
				});
			} catch (error) {
				console.warn(
					`prefer-hardware CanvasSink init failed for ${mediaId}; falling back to no-preference`,
					error,
				);
				sink = new CanvasSink(videoTrack, baseSinkOptions);
			}

			this.sinks.set(key, {
				input,
				sink,
				iterator: null,
				currentFrame: null,
				ring: [],
				lastTime: -1,
				lastAccess: Number.NEGATIVE_INFINITY,
				filling: false,
				fillPromise: null,
				fillCancelled: false,
				warmPromise: null,
				chain: Promise.resolve(),
				maxSize: isCappedTier(tier) ? (previewMaxSize ?? null) : null,
				file,
			});
		} catch (error) {
			// Free the Input's resources — we're not keeping it (no sink gets
			// registered for `key`), unlike the success path where the sink's
			// own disposeSink() does this later.
			input?.dispose();

			const reason: SinkInitFailureReason =
				error instanceof Error &&
				error.message === "Video codec not supported for decoding"
					? "codec-unsupported"
					: "init-failed";
			this.sinkInitFailures.set(key, reason);

			console.error(`Failed to initialize video sink for ${mediaId}:`, error);

			// Un-silence (HEVC cross-browser decode design doc, gap 1):
			// previously this rethrew with no catch anywhere in the call chain,
			// so a codec this browser can't decode surfaced as an unhandled
			// rejection and a dead preview. getFrameAt/warm already treat "no
			// sink" as "nothing to render yet" (their existing out-of-range
			// null path) — swallowing here instead of rethrowing degrades the
			// preview gracefully rather than crashing the render loop, while
			// still telling the user why via the same toast pattern the ingest
			// pipeline uses for other undecodable-media cases.
			toast.warning(
				reason === "codec-unsupported"
					? `"${file.name}" can't be decoded in this browser (unsupported codec) — this clip may not preview or export correctly here.`
					: `"${file.name}" couldn't be prepared for preview in this browser.`,
			);
		}
	}

	/**
	 * Whether the sink for this media+tier is known to have failed to
	 * initialize (e.g. `canDecode()` said no for this browser) — set by
	 * `initializeSink`'s catch instead of an unhandled throw. Reachable by UI
	 * code that wants to show/confirm degraded-playback state beyond the
	 * one-shot toast already fired when the failure was first recorded.
	 */
	getSinkInitFailure({
		mediaId,
		tier = "full",
	}: {
		mediaId: string;
		tier?: VideoSinkTier;
	}): SinkInitFailureReason | null {
		return this.sinkInitFailures.get(sinkKey({ mediaId, tier })) ?? null;
	}

	private disposeSink({ key }: { key: string }): void {
		const sinkData = this.sinks.get(key);
		if (sinkData) {
			// Stop any in-flight ring fill; iterator.return() below queues behind
			// its pending next(), after which the fill loop bails.
			sinkData.fillCancelled = true;
			sinkData.ring = [];
			sinkData.currentFrame = null;

			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}

			// Free the mediabunny Input's decoders/resources; without this the
			// decoder leaks every time a cached video is cleared.
			sinkData.input.dispose();

			this.sinks.delete(key);
		}

		this.initPromises.delete(key);
		// A key can be "known bad" (see sinkInitFailures) without ever having a
		// sinks entry — clear it unconditionally so a project reload or a
		// later-arriving proxy gets a fresh init attempt instead of being stuck
		// on a stale failure forever.
		this.sinkInitFailures.delete(key);
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		// A media can hold one sink per tier — dispose them all.
		for (const tier of ["full", "preview", "export"] as const) {
			this.disposeSink({ key: sinkKey({ mediaId, tier }) });
		}
	}

	clearAll(): void {
		// Map keys are mediaId+tier, not bare mediaIds — dispose by key directly.
		for (const key of Array.from(this.sinks.keys())) {
			this.disposeSink({ key });
		}
		this.initPromises.clear();
		// A key can be "known bad" (sinkInitFailures) with no corresponding
		// sinks entry, so the loop above alone wouldn't clear it — sweep the
		// rest directly (project switch/unload should always get a clean slate).
		this.sinkInitFailures.clear();
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
			bufferedFrames: Array.from(this.sinks.values()).reduce(
				(sum, s) => sum + s.ring.length,
				0,
			),
		};
	}
}

export const videoCache = new VideoCache();
