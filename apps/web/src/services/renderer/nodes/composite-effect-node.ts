import type { CanvasRenderer } from "../canvas-renderer";
import { createOffscreenCanvas } from "../canvas-utils";
import { getEffect } from "@/lib/effects";
import type { EffectParamValues } from "@/types/effects";
import { BaseNode } from "./base-node";
import { webglEffectRenderer } from "../webgl-effect-renderer";

export type CompositeEffectNodeParams = {
	contentNodes: BaseNode[];
	effectType: string;
	effectParams: EffectParamValues;
	scale: number;
	/**
	 * When true, the composited content is scaled so its OPAQUE bounding box
	 * covers the whole canvas before `scale` is applied on top. This is what a
	 * blur-fill background needs: 16:9 footage fitted onto a 9:16 canvas only
	 * occupies a middle band of the composite, so a fixed canvas-relative scale
	 * never reaches the canvas edges. When the content already covers the canvas
	 * the cover factor is 1 and behavior is identical to `coverCanvas: false`.
	 */
	coverCanvas?: boolean;
};

/** Probe resolution used to find the content's opaque bounding box. */
const COVER_PROBE_SIZE = 64;
/** Safety cap so tiny content (e.g. a lone sticker) can't force absurd zoom. */
const MAX_COVER_SCALE = 8;
/** Linear downscale of the blur composite — the blur destroys the detail a
 *  full-res composite would preserve, so 1/4 is visually identical upscaled. */
const COMPOSITE_SCALE = 0.25;
/** Long-edge floor for the reduced composite so tiny previews stay clean. */
const COMPOSITE_MIN_LONG_EDGE = 480;
/** How much timeline time may pass before the cover-probe re-runs. Bounds the
 *  staleness of animated content drifting inside the bounding box; scene edits
 *  rebuild node instances, which resets the cache entirely. */
const COVER_BOUNDS_REFRESH_SECONDS = 0.5;

type ContentBounds = {
	/** Fractions of the canvas (0..1). */
	x0: number;
	y0: number;
	x1: number;
	y1: number;
};

function computeContentBounds({
	source,
}: {
	source: OffscreenCanvas | HTMLCanvasElement;
}): ContentBounds | null {
	const probe = createOffscreenCanvas({
		width: COVER_PROBE_SIZE,
		height: COVER_PROBE_SIZE,
	});
	const probeCtx = probe.getContext("2d") as
		| OffscreenCanvasRenderingContext2D
		| CanvasRenderingContext2D
		| null;
	if (!probeCtx) return null;

	probeCtx.drawImage(
		source as CanvasImageSource,
		0,
		0,
		COVER_PROBE_SIZE,
		COVER_PROBE_SIZE,
	);

	let data: Uint8ClampedArray;
	try {
		data = probeCtx.getImageData(0, 0, COVER_PROBE_SIZE, COVER_PROBE_SIZE).data;
	} catch {
		return null;
	}

	let minX = COVER_PROBE_SIZE;
	let minY = COVER_PROBE_SIZE;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < COVER_PROBE_SIZE; y++) {
		for (let x = 0; x < COVER_PROBE_SIZE; x++) {
			const alpha = data[(y * COVER_PROBE_SIZE + x) * 4 + 3];
			if (alpha === 0) continue;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}

	if (maxX < minX || maxY < minY) return null;

	return {
		x0: minX / COVER_PROBE_SIZE,
		y0: minY / COVER_PROBE_SIZE,
		x1: (maxX + 1) / COVER_PROBE_SIZE,
		y1: (maxY + 1) / COVER_PROBE_SIZE,
	};
}

export class CompositeEffectNode extends BaseNode<CompositeEffectNodeParams> {
	// Pooled composite canvas — allocating a fresh full canvas every frame was
	// measurable GC/alloc churn during playback. Node instances live until the
	// scene is rebuilt, so the pool's lifetime is bounded.
	private composite: OffscreenCanvas | HTMLCanvasElement | null = null;
	private compositeCtx:
		| OffscreenCanvasRenderingContext2D
		| CanvasRenderingContext2D
		| null = null;
	private cachedBounds: ContentBounds | null = null;
	private cachedBoundsTime: number | null = null;

	/** Cover-probe result, recomputed at most every
	 *  `COVER_BOUNDS_REFRESH_SECONDS` of timeline time (seeks past the window
	 *  also recompute) — the getImageData readback stalls the GPU pipeline, so
	 *  it must not run per frame. */
	private getContentBounds({
		source,
		time,
	}: {
		source: OffscreenCanvas | HTMLCanvasElement;
		time: number;
	}): ContentBounds | null {
		if (
			this.cachedBoundsTime !== null &&
			Math.abs(time - this.cachedBoundsTime) < COVER_BOUNDS_REFRESH_SECONDS
		) {
			return this.cachedBounds;
		}
		this.cachedBounds = computeContentBounds({ source });
		this.cachedBoundsTime = time;
		return this.cachedBounds;
	}

	async render({
		renderer,
		time,
	}: {
		renderer: CanvasRenderer;
		time: number;
	}): Promise<void> {
		// Composite at reduced resolution: this whole render exists to be
		// blurred, so the detail a full-res composite preserves is thrown away
		// anyway. Everything below that touches pixels (content re-render, blur
		// passes, cover probe) runs on ~1/16 the area.
		const longEdge = Math.max(renderer.width, renderer.height);
		const compositeScale = Math.min(
			1,
			Math.max(COMPOSITE_SCALE, COMPOSITE_MIN_LONG_EDGE / longEdge),
		);
		const compositeWidth = Math.max(
			2,
			Math.round(renderer.width * compositeScale),
		);
		const compositeHeight = Math.max(
			2,
			Math.round(renderer.height * compositeScale),
		);

		if (
			!this.composite ||
			this.composite.width !== compositeWidth ||
			this.composite.height !== compositeHeight
		) {
			this.composite = createOffscreenCanvas({
				width: compositeWidth,
				height: compositeHeight,
			});
			this.compositeCtx = this.composite.getContext("2d") as
				| OffscreenCanvasRenderingContext2D
				| CanvasRenderingContext2D
				| null;
		} else {
			this.compositeCtx?.clearRect(0, 0, compositeWidth, compositeHeight);
		}

		const offscreen = this.composite;
		const offscreenCtx = this.compositeCtx;
		if (!offscreenCtx) {
			throw new Error("failed to get offscreen canvas context");
		}

		const originalContext = renderer.context;
		renderer.context = offscreenCtx;

		// Content nodes lay out against renderer.width/height (full-res canvas
		// coordinates, incl. absolute transform positions); the base scale maps
		// their output into the reduced composite.
		offscreenCtx.save();
		offscreenCtx.scale(
			compositeWidth / renderer.width,
			compositeHeight / renderer.height,
		);
		for (const node of this.params.contentNodes) {
			await node.render({ renderer, time });
		}
		offscreenCtx.restore();

		renderer.context = originalContext;

		const effectDefinition = getEffect({ effectType: this.params.effectType });

		// Default draw: uniform scale about the canvas center.
		let scale = this.params.scale;
		let destWidth = renderer.width * scale;
		let destHeight = renderer.height * scale;
		let destX = (renderer.width - destWidth) / 2;
		let destY = (renderer.height - destHeight) / 2;

		if (this.params.coverCanvas) {
			const bounds = this.getContentBounds({ source: offscreen, time });
			if (bounds) {
				const boundsWidth = (bounds.x1 - bounds.x0) * renderer.width;
				const boundsHeight = (bounds.y1 - bounds.y0) * renderer.height;
				if (boundsWidth > 0 && boundsHeight > 0) {
					const cover = Math.min(
						Math.max(
							renderer.width / boundsWidth,
							renderer.height / boundsHeight,
						),
						MAX_COVER_SCALE,
					);
					scale = cover * this.params.scale;
					// Recenter so the content's bounding-box center lands on the
					// canvas center — otherwise off-center content scaled about the
					// canvas center can still leave uncovered edges.
					const centerX = ((bounds.x0 + bounds.x1) / 2) * renderer.width;
					const centerY = ((bounds.y0 + bounds.y1) / 2) * renderer.height;
					destWidth = renderer.width * scale;
					destHeight = renderer.height * scale;
					destX = renderer.width / 2 - centerX * scale;
					destY = renderer.height / 2 - centerY * scale;
				}
			}
		}

		// Uniforms get the composite's dimensions so resolution-relative params
		// (e.g. blur sigma scales with width/1920) keep the same visual strength
		// they'd have at full res.
		const passes = effectDefinition.renderer.passes.map((pass) => ({
			fragmentShader: pass.fragmentShader,
			uniforms: pass.uniforms({
				effectParams: this.params.effectParams,
				width: compositeWidth,
				height: compositeHeight,
			}),
			textures: pass.textures?.({
				effectParams: this.params.effectParams,
				width: compositeWidth,
				height: compositeHeight,
			}),
		}));
		const effectResult = webglEffectRenderer.applyEffect({
			source: offscreen as CanvasImageSource,
			width: compositeWidth,
			height: compositeHeight,
			passes,
		});

		renderer.context.save();
		renderer.context.drawImage(
			effectResult,
			0,
			0,
			compositeWidth,
			compositeHeight,
			destX,
			destY,
			destWidth,
			destHeight,
		);
		renderer.context.restore();
	}
}
