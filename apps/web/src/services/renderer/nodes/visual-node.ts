import type { CanvasRenderer } from "../canvas-renderer";
import { createOffscreenCanvas, getContext2D } from "../canvas-utils";
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
} from "@/lib/effects/definitions/custom-mask";
import { rasterizeTextMask } from "@/lib/effects/definitions/text-mask";
import { webglEffectRenderer } from "../webgl-effect-renderer";

// Sampling resolution for the cumulative speed-ramp LUT. 120 samples/sec with
// midpoint sampling keeps the LUT at least as accurate as the per-frame left
// Riemann integration it replaces (dt ~1/30s); the cap bounds memory for very
// long clips by stretching the sample spacing instead of truncating coverage.
const SPEED_LUT_SAMPLES_PER_SECOND = 120;
const SPEED_LUT_MAX_SAMPLES = 20_000;

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
	// Instance-level caches are safe because params are immutable per scene
	// build — nodes are recreated whenever the timeline changes.
	private speedCurveLut: Float64Array | null = null;
	private speedCurveLutDt = 0;
	private elementScratchCanvas: OffscreenCanvas | HTMLCanvasElement | null =
		null;

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

	// Integrating the rate curve from 0 on every query is O(clip position) per
	// frame, 60x/sec on the playback render path (also hit by video-node's
	// warm()). Instead the cumulative integral is sampled once into a LUT and
	// queries become a linear interpolation between samples.
	private getSpeedCurveLut({
		baseRate,
		animations,
	}: {
		baseRate: number;
		animations: ElementAnimations;
	}): { samples: Float64Array; dt: number } {
		if (this.speedCurveLut) {
			return { samples: this.speedCurveLut, dt: this.speedCurveLutDt };
		}

		const duration = Math.max(
			this.params.duration,
			1 / SPEED_LUT_SAMPLES_PER_SECOND,
		);
		const sampleCount = Math.min(
			Math.ceil(duration * SPEED_LUT_SAMPLES_PER_SECOND) + 1,
			SPEED_LUT_MAX_SAMPLES,
		);
		const dt = duration / (sampleCount - 1);
		const samples = new Float64Array(sampleCount);
		let cumulative = 0;
		for (let i = 1; i < sampleCount; i++) {
			// Midpoint rule: exact for the piecewise-linear rate segments the
			// keyframe channel produces, so the LUT is at least as accurate as
			// the coarse left-Riemann integration it replaced.
			const rate = resolvePlaybackRateAtTime({
				basePlaybackRate: baseRate,
				animations,
				localTime: (i - 0.5) * dt,
			});
			cumulative += rate * dt;
			samples[i] = cumulative;
		}

		this.speedCurveLut = samples;
		this.speedCurveLutDt = dt;
		return { samples, dt };
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
		const { samples, dt } = this.getSpeedCurveLut({ baseRate, animations });
		const maxIndex = samples.length - 1;
		const position = Math.min(Math.max(localTime, 0) / dt, maxIndex);
		const lower = Math.floor(position);
		const upper = Math.min(lower + 1, maxIndex);
		const fraction = position - lower;
		return (
			this.params.trimStart +
			samples[lower] +
			(samples[upper] - samples[lower]) * fraction
		);
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

		const roundedWidth = Math.round(scaledWidth);
		const roundedHeight = Math.round(scaledHeight);

		// Reuse the per-instance scratch canvas across frames; a fresh
		// OffscreenCanvas per frame was a major playback allocation. Recreated
		// only when the element's scaled size changes (e.g. scale animation).
		let elementCanvas = this.elementScratchCanvas;
		if (
			!elementCanvas ||
			elementCanvas.width !== roundedWidth ||
			elementCanvas.height !== roundedHeight
		) {
			elementCanvas = createOffscreenCanvas({
				width: roundedWidth,
				height: roundedHeight,
			});
			this.elementScratchCanvas = elementCanvas;
		}
		const elementCtx = getContext2D(elementCanvas);
		if (!elementCtx) {
			renderer.context.drawImage(source, x, y, scaledWidth, scaledHeight);
			renderer.context.restore();
			return;
		}

		// Clear before drawing: the reused canvas holds last frame's pixels and
		// sources with transparency would composite over them.
		elementCtx.clearRect(0, 0, roundedWidth, roundedHeight);
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
				width: roundedWidth,
				height: roundedHeight,
				passes,
			});
		}

		if (mask && (mask.type === "custom" || mask.type === "text")) {
			// Rasterized mask kinds (non-analytic): rasterize to an alpha canvas —
			// a closed bezier path for "custom", glyph shapes for "text" — then
			// feather + composite it into the element frame via the shared texture-
			// pass pipeline (see custom-mask.ts / text-mask.ts). Inactive masks
			// (open/<3-point paths, blank text) rasterize to null and leave the
			// element fully visible. `feather`/`inverted` live on the base MaskShape.
			const maskCanvas =
				mask.type === "custom"
					? rasterizeCustomMask({
							mask,
							width: roundedWidth,
							height: roundedHeight,
						})
					: rasterizeTextMask({
							mask,
							width: roundedWidth,
							height: roundedHeight,
						});
			if (maskCanvas) {
				currentResult = webglEffectRenderer.applyEffect({
					source: maskCanvas,
					width: roundedWidth,
					height: roundedHeight,
					passes: buildCustomMaskPasses({
						featherPx: getCustomMaskFeatherPx({
							feather: mask.feather,
							width: roundedWidth,
							height: roundedHeight,
						}),
						inverted: mask.inverted,
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
				width: roundedWidth,
				height: roundedHeight,
				passes,
			});
		}

		renderer.context.drawImage(currentResult, x, y, scaledWidth, scaledHeight);
		renderer.context.restore();
	}
}
