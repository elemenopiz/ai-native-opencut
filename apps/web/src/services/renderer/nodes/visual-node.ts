import type { CanvasRenderer } from "../canvas-renderer";
import { createOffscreenCanvas } from "../canvas-utils";
import { BaseNode } from "./base-node";
import type { Effect } from "@/types/effects";
import type { BlendMode, MaskShape } from "@/types/rendering";
import type { Transform } from "@/types/timeline";
import type { ElementAnimations } from "@/types/animation";
import {
	getElementLocalTime,
	resolveOpacityAtTime,
	resolveTransformAtTime,
	resolvePlaybackRateAtTime,
} from "@/lib/animation";
import { resolveEffectParamsAtTime } from "@/lib/animation/effect-param-channel";
import { getNumberChannelForPath } from "@/lib/animation/number-channel";
import { TIME_EPSILON_SECONDS } from "@/constants/animation-constants";
import { getEffect } from "@/lib/effects";
import { maskShapeToEffectParams } from "@/lib/effects/definitions/shape-mask";
import {
	buildCustomMaskPasses,
	getCustomMaskFeatherPx,
	rasterizeCustomMask,
	resolveCustomMask,
} from "@/lib/effects/definitions/custom-mask";
import { webglEffectRenderer } from "../webgl-effect-renderer";

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	/** Playback speed multiplier (default 1.0). */
	playbackRate?: number;
	/** When true, the trimmed source span plays backwards. */
	reversed?: boolean;
	transform: Transform;
	animations?: ElementAnimations;
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	mask?: MaskShape;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
> extends BaseNode<Params> {
	protected getSourceLocalTime({ time }: { time: number }): number {
		const baseRate = this.params.playbackRate ?? 1.0;
		const elapsed = time - this.params.timeOffset;
		const reversed = this.params.reversed ?? false;
		const animations = this.params.animations;

		const speedChannel = animations
			? getNumberChannelForPath({ animations, propertyPath: "playbackRate" })
			: null;

		if (speedChannel && speedChannel.keyframes.length > 0) {
			const local = Math.max(0, Math.min(elapsed, this.params.duration));
			// Reverse mirrors the elapsed position within the clip span.
			const effLocal = reversed ? this.params.duration - local : local;
			return this.getSourceTimeViaSpeedCurve({
				localTime: effLocal,
				baseRate,
				animations: animations!,
			});
		}

		const effElapsed = reversed ? this.params.duration - elapsed : elapsed;
		return effElapsed * baseRate + this.params.trimStart;
	}

	private getSourceTimeViaSpeedCurve({
		localTime,
		baseRate,
		animations,
	}: {
		localTime: number;
		baseRate: number;
		animations: ElementAnimations;
	}): number {
		const steps = Math.max(10, Math.ceil(localTime * 30));
		const dt = localTime / steps;
		let sourceTime = this.params.trimStart;

		for (let i = 0; i < steps; i++) {
			const t = i * dt;
			const rate = resolvePlaybackRateAtTime({
				basePlaybackRate: baseRate,
				animations,
				localTime: t,
			});
			sourceTime += rate * dt;
		}

		return sourceTime;
	}

	protected getAnimationLocalTime({ time }: { time: number }): number {
		return getElementLocalTime({
			timelineTime: time,
			elementStartTime: this.params.timeOffset,
			elementDuration: this.params.duration,
		});
	}

	protected isInRange({ time }: { time: number }): boolean {
		// Visibility is governed by the clip's timeline slot, not its rate-scaled
		// source position. Gating on source-local time (rate * elapsed + trimStart)
		// made sped-up clips vanish for the tail of their slot and skipped the
		// first frame of reversed clips. Match text-node / effect-layer-node.
		const elapsed = time - this.params.timeOffset;
		return (
			elapsed >= -TIME_EPSILON_SECONDS &&
			elapsed < this.params.duration + TIME_EPSILON_SECONDS
		);
	}

	protected renderVisual({
		renderer,
		source,
		sourceWidth,
		sourceHeight,
		timelineTime,
	}: {
		renderer: CanvasRenderer;
		source: CanvasImageSource;
		sourceWidth: number;
		sourceHeight: number;
		timelineTime: number;
	}): void {
		renderer.context.save();

		const animationLocalTime = this.getAnimationLocalTime({
			time: timelineTime,
		});
		const transform = resolveTransformAtTime({
			baseTransform: this.params.transform,
			animations: this.params.animations,
			localTime: animationLocalTime,
		});
		const opacity = resolveOpacityAtTime({
			baseOpacity: this.params.opacity,
			animations: this.params.animations,
			localTime: animationLocalTime,
		});
		const containScale = Math.min(
			renderer.width / sourceWidth,
			renderer.height / sourceHeight,
		);
		const scaledWidth = sourceWidth * containScale * transform.scale;
		const scaledHeight = sourceHeight * containScale * transform.scale;
		const x = renderer.width / 2 + transform.position.x - scaledWidth / 2;
		const y = renderer.height / 2 + transform.position.y - scaledHeight / 2;

		renderer.context.globalCompositeOperation = (
			this.params.blendMode && this.params.blendMode !== "normal"
				? this.params.blendMode
				: "source-over"
		) as GlobalCompositeOperation;
		renderer.context.globalAlpha = opacity;

		if (transform.rotate !== 0) {
			const centerX = x + scaledWidth / 2;
			const centerY = y + scaledHeight / 2;
			renderer.context.translate(centerX, centerY);
			renderer.context.rotate((transform.rotate * Math.PI) / 180);
			renderer.context.translate(-centerX, -centerY);
		}

		const enabledEffects =
			this.params.effects?.filter((effect) => effect.enabled) ?? [];
		const mask = this.params.mask;

		if (enabledEffects.length === 0 && !mask) {
			renderer.context.drawImage(source, x, y, scaledWidth, scaledHeight);
			renderer.context.restore();
			return;
		}

		const elementCanvas = createOffscreenCanvas({
			width: Math.round(scaledWidth),
			height: Math.round(scaledHeight),
		});
		const elementCtx = elementCanvas.getContext("2d") as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (!elementCtx) {
			renderer.context.drawImage(source, x, y, scaledWidth, scaledHeight);
			renderer.context.restore();
			return;
		}

		elementCtx.drawImage(source, 0, 0, scaledWidth, scaledHeight);

		let currentResult: CanvasImageSource = elementCanvas;

		for (const effect of enabledEffects) {
			const resolvedParams = resolveEffectParamsAtTime({
				effect,
				animations: this.params.animations,
				localTime: animationLocalTime,
			});
			const definition = getEffect({ effectType: effect.type });
			const passes = definition.renderer.passes.map((pass) => ({
				fragmentShader: pass.fragmentShader,
				uniforms: pass.uniforms({
					effectParams: resolvedParams,
					width: scaledWidth,
					height: scaledHeight,
				}),
				textures: pass.textures?.({
					effectParams: resolvedParams,
					width: scaledWidth,
					height: scaledHeight,
				}),
			}));
			currentResult = webglEffectRenderer.applyEffect({
				source: currentResult,
				width: Math.round(scaledWidth),
				height: Math.round(scaledHeight),
				passes,
			});
		}

		if (mask && mask.type === "custom") {
			// Custom pen-tool path: rasterize the closed bezier path to an alpha
			// canvas, then feather + composite it into the element frame via the
			// texture-pass pipeline (see custom-mask.ts). Inactive paths (open or
			// < 3 points) rasterize to null and leave the element fully visible.
			const roundedWidth = Math.round(scaledWidth);
			const roundedHeight = Math.round(scaledHeight);
			const maskCanvas = rasterizeCustomMask({
				mask,
				width: roundedWidth,
				height: roundedHeight,
			});
			if (maskCanvas) {
				const resolved = resolveCustomMask({ mask });
				currentResult = webglEffectRenderer.applyEffect({
					source: maskCanvas,
					width: roundedWidth,
					height: roundedHeight,
					passes: buildCustomMaskPasses({
						featherPx: getCustomMaskFeatherPx({
							feather: resolved.feather,
							width: roundedWidth,
							height: roundedHeight,
						}),
						inverted: resolved.inverted,
						source: currentResult,
					}),
				});
			}
		} else if (mask) {
			const definition = getEffect({ effectType: "shape-mask" });
			const maskParams = maskShapeToEffectParams({ mask });
			const passes = definition.renderer.passes.map((pass) => ({
				fragmentShader: pass.fragmentShader,
				uniforms: pass.uniforms({
					effectParams: maskParams,
					width: scaledWidth,
					height: scaledHeight,
				}),
			}));
			currentResult = webglEffectRenderer.applyEffect({
				source: currentResult,
				width: Math.round(scaledWidth),
				height: Math.round(scaledHeight),
				passes,
			});
		}

		renderer.context.drawImage(currentResult, x, y, scaledWidth, scaledHeight);
		renderer.context.restore();
	}
}
