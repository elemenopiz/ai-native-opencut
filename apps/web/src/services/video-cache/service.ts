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
	currentFrame: WrappedCanvas | null;
	nextFrame: WrappedCanvas | null;
	lastTime: number;
	lastAccess: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
	warmPromise: Promise<void> | null;
	/** Long-edge decode cap the sink was created with (preview tier only). */
	maxSize: number | null;
}

/**
 * Decode tiers. "full" decodes at the source's native resolution and is what
 * export and snapshot MUST use. "preview" caps the decoded long edge at
 * `previewMaxSize` so the render loop never pays for pixels the preview
 * canvas can't show (e.g. 4K sources on a 1080p project). Each tier gets its
 * own sink/decoder, keyed mediaId+tier, so the tiers never fight over one
 * iterator position.
 */
export type VideoSinkTier = "full" | "preview";

/** How far ahead of a clip's start a warm() pre-seek is worth doing. */
export const WARM_LOOKAHEAD_SECONDS = 1.0;

/** A sink read this recently is considered in active use by a renderer. */
const ACTIVE_USE_WINDOW_MS = 250;

/** mediaIds are nanoids (no ":"), so this suffix can't collide. */
const PREVIEW_KEY_SUFFIX = "::preview";

function sinkKey({
	mediaId,
	tier,
}: {
	mediaId: string;
	tier: VideoSinkTier;
}): string {
	return tier === "preview" ? `${mediaId}${PREVIEW_KEY_SUFFIX}` : mediaId;
}

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();

	async getFrameAt({
		mediaId,
		file,
		time,
		tier = "full",
		previewMaxSize,
	}: {
		mediaId: string;
		file: File;
		time: number;
		/** Decode tier; export/snapshot must stay on the "full" default. */
		tier?: VideoSinkTier;
		/** Long-edge cap for the preview tier's decoded frames. */
		previewMaxSize?: number;
	}): Promise<WrappedCanvas | null> {
		await this.ensureSink({ mediaId, file, tier, previewMaxSize });

		const sinkData = this.sinks.get(sinkKey({ mediaId, tier }));
		if (!sinkData) return null;

		sinkData.lastAccess = performance.now();

		// A warm() pre-seek may be repositioning the iterator; wait for it so the
		// two paths never interleave mutations of the same iterator.
		if (sinkData.warmPromise) {
			await sinkData.warmPromise;
		}

		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			// Keep lastTime tracking the newest frame the consumer holds. Without
			// this, steady playback served entirely by the prefetch fast path leaves
			// lastTime frozen at the last seek position; once the playhead is >2s
			// past it, the sequential iterateToTime window below can never match and
			// any late prefetch escalates to a full seekToTime (keyframe re-seek +
			// forward decode) — a deterministic mid-playback freeze.
			sinkData.lastTime = sinkData.currentFrame.timestamp;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return sinkData.currentFrame;
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return frame;
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

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

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
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;
				sinkData.lastTime = frame.timestamp;

				// Fill the one-frame buffer in the background. Awaiting a second
				// decode here doubled the on-screen stall of every seek that happens
				// mid-render (the render loop awaits this whole call).
				this.startPrefetch({ sinkData });

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

		// Another clip of the same media is actively rendering from this sink —
		// repositioning its iterator would glitch that clip.
		if (performance.now() - sinkData.lastAccess < ACTIVE_USE_WINDOW_MS) return;

		// Already showing the right frame, or close enough that the cheap
		// sequential iterate path will cover it.
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
			time < sinkData.lastTime + 2.0
		) {
			return;
		}

		const warmPromise = this.seekToTime({ sinkData, time }).then(() => {
			sinkData.warmPromise = null;
		});
		sinkData.warmPromise = warmPromise;
		await warmPromise;
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
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

		const existing = this.sinks.get(key);
		if (existing) {
			// The preview cap follows the project's canvas size, which can change
			// mid-session (frame preset switch) — rebuild the sink at the new cap
			// instead of serving stale-resolution frames forever.
			if (
				tier === "preview" &&
				previewMaxSize !== undefined &&
				existing.maxSize !== previewMaxSize
			) {
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

			// Preview tier: have mediabunny convert decoded frames straight to the
			// capped size (aspect preserved), so every downstream copy/composite of
			// this frame touches fewer pixels. Sources already within the cap keep
			// their native size — no upscaling, no wasted conversion.
			let outputSize: { width: number; height: number } | undefined;
			if (tier === "preview" && previewMaxSize !== undefined) {
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

			const sink = new CanvasSink(videoTrack, {
				poolSize: 3,
				fit: "contain",
				...outputSize,
			});

			this.sinks.set(sinkKey({ mediaId, tier }), {
				input,
				sink,
				iterator: null,
				currentFrame: null,
				nextFrame: null,
				lastTime: -1,
				lastAccess: Number.NEGATIVE_INFINITY,
				prefetching: false,
				prefetchPromise: null,
				warmPromise: null,
				maxSize: tier === "preview" ? (previewMaxSize ?? null) : null,
			});
		} catch (error) {
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	private disposeSink({ key }: { key: string }): void {
		const sinkData = this.sinks.get(key);
		if (sinkData) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}

			// Free the mediabunny Input's decoders/resources; without this the
			// decoder leaks every time a cached video is cleared.
			sinkData.input.dispose();

			this.sinks.delete(key);
		}

		this.initPromises.delete(key);
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		// A media can hold one sink per tier — dispose them all.
		for (const tier of ["full", "preview"] as const) {
			this.disposeSink({ key: sinkKey({ mediaId, tier }) });
		}
	}

	clearAll(): void {
		// Map keys are mediaId+tier, not bare mediaIds — dispose by key directly.
		for (const key of Array.from(this.sinks.keys())) {
			this.disposeSink({ key });
		}
		this.initPromises.clear();
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

export const videoCache = new VideoCache();
