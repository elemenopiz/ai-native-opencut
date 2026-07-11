import type { CanvasRenderer } from "../canvas-renderer";
import { VisualNode, type VisualNodeParams } from "./visual-node";
import {
	videoCache,
	WARM_LOOKAHEAD_SECONDS,
} from "@/services/video-cache/service";

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
	async render({ renderer, time }: { renderer: CanvasRenderer; time: number }) {
		await super.render({ renderer, time });

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
			return;
		}

		const videoTime = this.getSourceLocalTime({ time });
		const frame = await videoCache.getFrameAt({
			mediaId: this.params.mediaId,
			file: this.params.file,
			time: videoTime,
			tier,
			previewMaxSize: this.params.previewDecodeMaxSize,
		});

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
}
