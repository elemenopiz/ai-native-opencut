import type { CanvasRenderer } from "../canvas-renderer";
import { createOffscreenCanvas } from "../canvas-utils";
import { BaseNode } from "./base-node";
import type { ShapeElement, ShapeFill, ShapeKind } from "@/types/timeline";
import {
	getElementLocalTime,
	resolveOpacityAtTime,
	resolveTransformAtTime,
} from "@/lib/animation";
import { resolveEffectParamsAtTime } from "@/lib/animation/effect-param-channel";
import { getEffect } from "@/lib/effects";
import { webglEffectRenderer } from "../webgl-effect-renderer";

type Canvas2DContext =
	| CanvasRenderingContext2D
	| OffscreenCanvasRenderingContext2D;

/** Builds the shape's outline in LOCAL, unscaled coordinates centered on the
 *  origin — the caller is expected to have already translated/scaled/rotated
 *  the context (see `applyTransform` in `render`). */
function traceShapePath({
	ctx,
	shapeKind,
	width,
	height,
	cornerRadius,
}: {
	ctx: Canvas2DContext;
	shapeKind: ShapeKind;
	width: number;
	height: number;
	cornerRadius?: number;
}): void {
	ctx.beginPath();

	if (shapeKind === "rect") {
		const maxRadius = Math.min(width, height) / 2;
		const radius = Math.max(0, Math.min(cornerRadius ?? 0, maxRadius));
		ctx.roundRect(-width / 2, -height / 2, width, height, radius);
		return;
	}

	if (shapeKind === "ellipse") {
		ctx.ellipse(
			0,
			0,
			Math.max(width, 0) / 2,
			Math.max(height, 0) / 2,
			0,
			0,
			Math.PI * 2,
		);
		return;
	}

	// "line": the bounding box's own diagonal (top-left → bottom-right) is the
	// drawn segment — both `width` and `height` stay meaningful (a straight
	// horizontal line is just `height: 0`), unlike a two-endpoint primitive
	// that would need its own field pair.
	ctx.moveTo(-width / 2, -height / 2);
	ctx.lineTo(width / 2, height / 2);
}

/** Resolves a shape's fill to a canvas fillStyle — a flat color, or a linear
 *  gradient scoped to the shape's own local bounding box (not the canvas —
 *  this is what makes a lower-third scrim a self-contained, movable element
 *  rather than something baked to canvas size). Angle convention matches
 *  `lib/gradients`: 0deg = to top, 180deg = to bottom. */
function resolveFillStyle({
	ctx,
	fill,
	width,
	height,
}: {
	ctx: Canvas2DContext;
	fill: ShapeFill;
	width: number;
	height: number;
}): string | CanvasGradient {
	if (fill.type === "solid") {
		return fill.color;
	}

	const radians = (fill.angle * Math.PI) / 180;
	const dx = Math.sin(radians);
	const dy = -Math.cos(radians);
	const halfLength = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
	const gradient = ctx.createLinearGradient(
		-dx * halfLength,
		-dy * halfLength,
		dx * halfLength,
		dy * halfLength,
	);

	for (const stop of fill.stops) {
		gradient.addColorStop(Math.min(1, Math.max(0, stop.offset)), stop.color);
	}

	return gradient;
}

export type ShapeNodeParams = ShapeElement & {
	canvasCenter: { x: number; y: number };
};

export class ShapeNode extends BaseNode<ShapeNodeParams> {
	private drawContent({
		ctx,
		width,
		height,
	}: {
		ctx: Canvas2DContext;
		width: number;
		height: number;
	}): void {
		const { shapeKind, fill, stroke, cornerRadius } = this.params;

		traceShapePath({ ctx, shapeKind, width, height, cornerRadius });

		// A "line" has no interior — filling its (zero-area) closed path is a
		// harmless no-op on most engines, but skipping it is both cheaper and
		// avoids relying on that behavior.
		if (shapeKind !== "line") {
			ctx.fillStyle = resolveFillStyle({ ctx, fill, width, height });
			ctx.fill();
		}

		if (stroke && stroke.width > 0) {
			ctx.lineWidth = stroke.width;
			ctx.strokeStyle = stroke.color;
			ctx.stroke();
		}
	}

	isInRange({ time }: { time: number }): boolean {
		return (
			time >= this.params.startTime &&
			time < this.params.startTime + this.params.duration
		);
	}

	async render({ renderer, time }: { renderer: CanvasRenderer; time: number }) {
		if (!this.isInRange({ time })) {
			return;
		}

		const localTime = getElementLocalTime({
			timelineTime: time,
			elementStartTime: this.params.startTime,
			elementDuration: this.params.duration,
		});
		const transform = resolveTransformAtTime({
			baseTransform: this.params.transform,
			animations: this.params.animations,
			localTime,
		});
		const opacity = resolveOpacityAtTime({
			baseOpacity: this.params.opacity,
			animations: this.params.animations,
			localTime,
		});

		const x = transform.position.x + this.params.canvasCenter.x;
		const y = transform.position.y + this.params.canvasCenter.y;
		const { width, height } = this.params;

		const blendMode = (
			this.params.blendMode && this.params.blendMode !== "normal"
				? this.params.blendMode
				: "source-over"
		) as GlobalCompositeOperation;

		const applyTransform = (ctx: Canvas2DContext) => {
			ctx.translate(x, y);
			ctx.scale(transform.scale, transform.scale);
			if (transform.rotate) {
				ctx.rotate((transform.rotate * Math.PI) / 180);
			}
		};

		const enabledEffects =
			this.params.effects?.filter((effect) => effect.enabled) ?? [];

		// `crop`/`mask` are modeled on the type for parity with every other
		// visual element (see the ShapeElement doc comment) but not yet consumed
		// here — same acknowledged gap as `crop` on video/image/sticker
		// (scene-builder.ts) and `mask` on TextNode.
		if (enabledEffects.length === 0) {
			renderer.context.save();
			applyTransform(renderer.context);
			renderer.context.globalCompositeOperation = blendMode;
			renderer.context.globalAlpha = opacity;
			this.drawContent({ ctx: renderer.context, width, height });
			renderer.context.restore();
			return;
		}

		// Effects path: draw to a same-size offscreen canvas (mirrors TextNode)
		// so a blur/glow effect can spread past the shape's own outline without
		// hard clipping at its bounding box.
		const offscreen = createOffscreenCanvas({
			width: renderer.width,
			height: renderer.height,
		});
		const offscreenCtx = offscreen.getContext(
			"2d",
		) as OffscreenCanvasRenderingContext2D | null;

		if (!offscreenCtx) {
			renderer.context.save();
			applyTransform(renderer.context);
			renderer.context.globalCompositeOperation = blendMode;
			renderer.context.globalAlpha = opacity;
			this.drawContent({ ctx: renderer.context, width, height });
			renderer.context.restore();
			return;
		}

		offscreenCtx.save();
		applyTransform(offscreenCtx);
		this.drawContent({ ctx: offscreenCtx, width, height });
		offscreenCtx.restore();

		let currentSource: CanvasImageSource = offscreen;
		for (const effect of enabledEffects) {
			const resolvedParams = resolveEffectParamsAtTime({
				effect,
				animations: this.params.animations,
				localTime,
			});
			const definition = getEffect({ effectType: effect.type });
			const passes = definition.renderer.passes.map((pass) => ({
				fragmentShader: pass.fragmentShader,
				uniforms: pass.uniforms({
					effectParams: resolvedParams,
					width: renderer.width,
					height: renderer.height,
				}),
				textures: pass.textures?.({
					effectParams: resolvedParams,
					width: renderer.width,
					height: renderer.height,
				}),
			}));
			currentSource = webglEffectRenderer.applyEffect({
				source: currentSource,
				width: renderer.width,
				height: renderer.height,
				passes,
			});
		}

		renderer.context.save();
		renderer.context.globalCompositeOperation = blendMode;
		renderer.context.globalAlpha = opacity;
		renderer.context.drawImage(currentSource, 0, 0);
		renderer.context.restore();
	}
}
