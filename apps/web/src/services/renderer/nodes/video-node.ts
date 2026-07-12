import type { WrappedCanvas } from "mediabunny";
import type { CanvasRenderer } from "../canvas-renderer";
import { VisualNode, type VisualNodeParams } from "./visual-node";
import {
	videoCache,
	WARM_LOOKAHEAD_SECONDS,
} from "@/services/video-cache/service";
import { perfStats } from "../perf-stats";

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	file: File;
	mediaId: string;
	/**
	 * When set (preview scenes only), frames decode via the capped "preview"
	 * sink tier instead of at native source resolution. Export/snapshot scenes
	 * leave this unset and stay on the full-res tier.
	 */
	previewDecodeMaxSize?: number;
}

export class VideoNode extends VisualNode<VideoNodeParams> {
	/** Frame fetched by prepare() and the exact time it was fetched for. */
	private preparedFrame: WrappedCanvas | null = null;
	private preparedTime: number | null = null;
	private preparePromise: Promise<void> | null = null;

	/**
	 * Fetch this clip's frame ahead of the paint pass. All VideoNodes prepare
	 * in parallel (see BaseNode.prepare), which is the whole point: with N
	 * video layers the serial render path used to stack N decode waits.
	 * Deduped by time so composite-effect double-paints (the same node
	 * instance is both a root child and a contentNode) share one fetch.
	 */
	async prepare({
		renderer,
		time,
	}: {
		renderer: CanvasRenderer;
		time: number;
	}): Promise<void> {
		await super.prepare({ renderer, time });

		if (this.preparedTime === time && this.preparePromise) {
			return this.preparePromise;
		}

		this.preparedTime = time;
		this.preparedFrame = null;
		const promise = this.fetchFrame({
			time,
			tolerateStale: renderer.realtime,
		}).then((frame) => {
			// A newer prepare may have superseded this one while the decode ran.
			if (this.preparedTime === time) {
				this.preparedFrame = frame;
			}
		});
		this.preparePromise = promise;
		return promise;
	}

	async render({ renderer, time }: { renderer: CanvasRenderer; time: number }) {
		await super.render({ renderer, time });

		let frame: WrappedCanvas | null;
		if (this.preparedTime === time && this.preparePromise) {
			// Normally settled already — CanvasRenderer.render runs the prepare
			// pass before painting — so this await doesn't stall the paint.
			await this.preparePromise;
			frame = this.preparedFrame;
		} else {
			// Callers that render without a prepare pass (defensive fallback)
			// fetch inline, exactly as before the two-phase split.
			frame = await this.fetchFrame({
				time,
				tolerateStale: renderer.realtime,
			});
		}

		if (frame) {
			this.renderVisual({
				renderer,
				source: frame.canvas,
				sourceWidth: frame.canvas.width,
				sourceHeight: frame.canvas.height,
				timelineTime: time,
			});
		}
	}

	/** The frame for `time`, or null when the clip isn't on screen (in which
	 *  case an upcoming clip start warms its decoder off the render path). */
	private async fetchFrame({
		time,
		tolerateStale,
	}: {
		time: number;
		tolerateStale: boolean;
	}): Promise<WrappedCanvas | null> {
		const tier =
			this.params.previewDecodeMaxSize !== undefined ? "preview" : "full";

		if (!this.isInRange({ time })) {
			// Shortly before this clip starts, position its decoder at the first
			// frame in the background so the boundary crossing doesn't stall the
			// render loop on a keyframe re-seek.
			const untilStart = this.params.timeOffset - time;
			if (untilStart > 0 && untilStart <= WARM_LOOKAHEAD_SECONDS) {
				void videoCache.warm({
					mediaId: this.params.mediaId,
					file: this.params.file,
					time: this.getSourceLocalTime({ time: this.params.timeOffset }),
					tier,
					previewMaxSize: this.params.previewDecodeMaxSize,
				});
			}
			return null;
		}

		const decodeStart = perfStats.enabled ? performance.now() : 0;
		const frame = await videoCache.getFrameAt({
			mediaId: this.params.mediaId,
			file: this.params.file,
			time: this.getSourceLocalTime({ time }),
			tolerateStale,
			tier,
			previewMaxSize: this.params.previewDecodeMaxSize,
		});
		if (decodeStart !== 0) {
			perfStats.addDecodeTime({ ms: performance.now() - decodeStart });
		}
		return frame;
	}
}
