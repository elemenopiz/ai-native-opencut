import type { CanvasRenderer } from "../canvas-renderer";
import { createOffscreenCanvas } from "../canvas-utils";
import { BaseNode } from "./base-node";
import { loadImageSource } from "./image-node";
import type { Transform } from "@/types/timeline";
import type { Effect } from "@/types/effects";
import type { BlendMode } from "@/types/rendering";
import type { ElementAnimations } from "@/types/animation";
import type { MediaAsset } from "@/types/assets";
import {
	resolveOpacityAtTime,
	resolveTransformAtTime,
	getElementLocalTime,
} from "@/lib/animation";
import { renderTransition } from "../transition-renderer";
import { getTransition } from "@/lib/transitions";
import { videoCache } from "@/services/video-cache/service";

export interface TransitionSourceParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	playbackRate?: number;
	reversed?: boolean;
	transform: Transform;
	animations?: ElementAnimations;
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
}

export interface TransitionNodeParams {
	transitionType: string;
	transitionDuration: number;
	cutTime: number;
	sourceA: TransitionSourceParams;
	sourceB: TransitionSourceParams;
	mediaMap: Map<string, MediaAsset>;
	mediaIdA?: string;
	mediaIdB?: string;
}

export class TransitionNode extends BaseNode<TransitionNodeParams> {
	async render({
		renderer,
		time,
	}: {
		renderer: CanvasRenderer;
		time: number;
	}): Promise<void> {
		const { transitionType, transitionDuration, cutTime } = this.params;
		const halfDuration = transitionDuration / 2;
		const transitionStart = cutTime - halfDuration;
		const transitionEnd = cutTime + halfDuration;

		if (time < transitionStart || time >= transitionEnd) return;

		const progress = (time - transitionStart) / transitionDuration;

		const [canvasA, canvasB] = await Promise.all([
			this.renderSourceFrame({
				renderer,
				sourceParams: this.params.sourceA,
				mediaId: this.params.mediaIdA,
				time,
			}),
			this.renderSourceFrame({
				renderer,
				sourceParams: this.params.sourceB,
				mediaId: this.params.mediaIdB,
				time,
			}),
		]);

		if (!canvasA || !canvasB) return;

		const definition = getTransition({ transitionType });

		const result = renderTransition({
			sourceA: canvasA,
			sourceB: canvasB,
			width: renderer.width,
			height: renderer.height,
			progress,
			fragmentShader: definition.fragmentShader,
		});

		renderer.context.save();
		renderer.context.globalCompositeOperation = "source-over";
		renderer.context.drawImage(result as CanvasImageSource, 0, 0);
		renderer.context.restore();
	}

	/** The source-local media time for a frame fetch (simple rate/trim/reverse
	 *  path; speed curves are ignored for the brief transition window).
	 *
	 *  The transition window straddles the cut, so the outgoing clip gets
	 *  sampled past its end and the incoming clip before its start. Clamping to
	 *  the media's real bounds turns those over-reads into handle footage when
	 *  the source has it (trimmed media) or a held edge frame when it doesn't —
	 *  instead of an out-of-range fetch that nulls the frame and blanks the
	 *  whole transition. */
	private getSourceLocalTime({
		sourceParams,
		mediaDuration,
		time,
	}: {
		sourceParams: TransitionSourceParams;
		mediaDuration: number | undefined;
		time: number;
	}): number {
		const elapsed = time - sourceParams.timeOffset;
		const reversed = sourceParams.reversed ?? false;
		const baseRate = sourceParams.playbackRate ?? 1;
		const effElapsed = reversed ? sourceParams.duration - elapsed : elapsed;
		const localTime = effElapsed * baseRate + sourceParams.trimStart;

		const maxTime =
			mediaDuration !== undefined && mediaDuration > 0
				? Math.max(0, mediaDuration - 0.001)
				: Number.POSITIVE_INFINITY;
		return Math.min(Math.max(localTime, 0), maxTime);
	}

	/** Fetch the source clip's frame at `time` and draw it (with its transform)
	 *  onto a full-frame canvas the transition shader can blend. Returns null if
	 *  the frame can't be resolved. */
	private async renderSourceFrame({
		renderer,
		sourceParams,
		mediaId,
		time,
	}: {
		renderer: CanvasRenderer;
		sourceParams: TransitionSourceParams;
		mediaId: string | undefined;
		time: number;
	}): Promise<HTMLCanvasElement | OffscreenCanvas | null> {
		const media = mediaId ? this.params.mediaMap.get(mediaId) : undefined;
		if (!media) return null;

		// Resolve the actual pixel source (decoded video frame or loaded image).
		let source: CanvasImageSource | null = null;
		let sourceWidth = 0;
		let sourceHeight = 0;

		if (media.type === "video" && media.file) {
			const frame = await videoCache.getFrameAt({
				mediaId: mediaId as string,
				file: media.file,
				time: this.getSourceLocalTime({
					sourceParams,
					mediaDuration: media.duration,
					time,
				}),
			});
			if (frame) {
				source = frame.canvas;
				sourceWidth = frame.canvas.width;
				sourceHeight = frame.canvas.height;
			}
		} else if (media.type === "image" && media.url) {
			const loaded = await loadImageSource(media.url);
			source = loaded.source;
			sourceWidth = loaded.width;
			sourceHeight = loaded.height;
		}

		if (!source || sourceWidth <= 0 || sourceHeight <= 0) return null;

		const offscreen = createOffscreenCanvas({
			width: renderer.width,
			height: renderer.height,
		});
		const ctx = offscreen.getContext("2d") as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (!ctx) return null;

		const animLocalTime = getElementLocalTime({
			timelineTime: time,
			elementStartTime: sourceParams.timeOffset,
			elementDuration: sourceParams.duration,
		});

		const transform = resolveTransformAtTime({
			baseTransform: sourceParams.transform,
			animations: sourceParams.animations,
			localTime: animLocalTime,
		});
		const opacity = resolveOpacityAtTime({
			baseOpacity: sourceParams.opacity,
			animations: sourceParams.animations,
			localTime: animLocalTime,
		});

		// Contain-fit into the frame, then apply the element transform — mirrors
		// VisualNode.renderVisual so a transition source lines up with how the
		// clip renders outside the transition window.
		const containScale = Math.min(
			renderer.width / sourceWidth,
			renderer.height / sourceHeight,
		);
		const scaledWidth = sourceWidth * containScale * transform.scale;
		const scaledHeight = sourceHeight * containScale * transform.scale;
		const x = renderer.width / 2 + transform.position.x - scaledWidth / 2;
		const y = renderer.height / 2 + transform.position.y - scaledHeight / 2;

		(ctx as CanvasRenderingContext2D).globalAlpha = opacity;

		if (transform.rotate !== 0) {
			const centerX = x + scaledWidth / 2;
			const centerY = y + scaledHeight / 2;
			ctx.translate(centerX, centerY);
			ctx.rotate((transform.rotate * Math.PI) / 180);
			ctx.translate(-centerX, -centerY);
		}

		ctx.drawImage(source, x, y, scaledWidth, scaledHeight);

		return offscreen;
	}
}
