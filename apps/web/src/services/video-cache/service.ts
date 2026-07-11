import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	type WrappedCanvas,
} from "mediabunny";

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
}

/** How far ahead of a clip's start a warm() pre-seek is worth doing. */
export const WARM_LOOKAHEAD_SECONDS = 1.0;

/** A sink read this recently is considered in active use by a renderer. */
const ACTIVE_USE_WINDOW_MS = 250;

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
	}: {
		mediaId: string;
		file: File;
		time: number;
		tolerateStale?: boolean;
	}): Promise<WrappedCanvas | null> {
		await this.ensureSink({ mediaId, file });

		const sinkData = this.sinks.get(mediaId);
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
	}: {
		mediaId: string;
		file: File;
		time: number;
	}): Promise<void> {
		await this.ensureSink({ mediaId, file });

		const sinkData = this.sinks.get(mediaId);
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
	}: {
		mediaId: string;
		file: File;
	}): Promise<void> {
		if (this.sinks.has(mediaId)) return;

		if (this.initPromises.has(mediaId)) {
			await this.initPromises.get(mediaId);
			return;
		}

		const initPromise = this.initializeSink({ mediaId, file });
		this.initPromises.set(mediaId, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(mediaId);
		}
	}

	private async initializeSink({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: File;
	}): Promise<void> {
		try {
			const input = new Input({
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

			const sink = new CanvasSink(videoTrack, {
				// Must stay >= the maximum number of live WrappedCanvas frames —
				// see the SINK_POOL_SIZE accounting above.
				poolSize: SINK_POOL_SIZE,
				fit: "contain",
			});

			this.sinks.set(mediaId, {
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
			});
		} catch (error) {
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		const sinkData = this.sinks.get(mediaId);
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

			this.sinks.delete(mediaId);
		}

		this.initPromises.delete(mediaId);
	}

	clearAll(): void {
		for (const [mediaId] of this.sinks) {
			this.clearVideo({ mediaId });
		}
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
