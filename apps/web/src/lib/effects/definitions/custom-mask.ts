// Custom pen-tool freeform mask — the render-side pipeline.
//
// Adapted from OpenCut-app/OpenCut (pre-rewrite tag, MIT). Their freeform mask
// feathers a rasterized path with a Rust/WASM jump-flood crate, which is not
// portable. Instead we rasterize the closed bezier path to an offscreen
// Canvas2D alpha mask (browser `Path2D`), then feather it with a portable
// separable GLSL Gaussian blur and composite it into the element frame — all
// through our existing `pass.textures` mechanism (see webgl-utils.ts).
import type { MaskShape } from "@/types/rendering";
import type { EffectPassData } from "@/services/renderer/webgl-utils";
import {
	buildFreeformPath2D,
	getRasterTransform,
} from "@/lib/effects/masks/freeform-path";
import customMaskFeatherShader from "./custom-mask-feather.frag.glsl";
import customMaskCompositeShader from "./custom-mask-composite.frag.glsl";

export interface ResolvedCustomMask {
	points: NonNullable<MaskShape["points"]>;
	closed: boolean;
	centerX: number;
	centerY: number;
	rotation: number;
	scale: number;
	feather: number;
	inverted: boolean;
}

export function resolveCustomMask({
	mask,
}: {
	mask: MaskShape;
}): ResolvedCustomMask {
	return {
		points: mask.points ?? [],
		closed: mask.closed ?? false,
		centerX: mask.centerX ?? 0,
		centerY: mask.centerY ?? 0,
		rotation: mask.rotation ?? 0,
		scale: mask.scale ?? 1,
		feather: mask.feather ?? 0,
		inverted: mask.inverted ?? false,
	};
}

/** A custom mask only takes effect once it is a closed path of >= 3 anchors. */
export function isCustomMaskActive({ mask }: { mask: MaskShape }): boolean {
	return (mask.closed ?? false) && (mask.points?.length ?? 0) >= 3;
}

/** Feather radius in pixels, matching the analytic shape mask's convention. */
export function getCustomMaskFeatherPx({
	feather,
	width,
	height,
}: {
	feather: number;
	width: number;
	height: number;
}): number {
	const shortSide = Math.min(width, height);
	return Math.max(feather * shortSide * 0.5, 0);
}

function createMaskCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): OffscreenCanvas | HTMLCanvasElement {
	try {
		return new OffscreenCanvas(width, height);
	} catch {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}
}

// Cache the rasterized hard-edge alpha canvas keyed by (geometry, size). The
// Path2D fill is the only per-frame cost worth avoiding; feather stays a GLSL
// uniform so changing it reuses the same cached canvas. Bounded LRU-ish map.
const RASTER_CACHE_LIMIT = 12;
const rasterCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

function getRasterCacheKey({
	mask,
	width,
	height,
}: {
	mask: ResolvedCustomMask;
	width: number;
	height: number;
}): string {
	return JSON.stringify({
		w: width,
		h: height,
		cx: mask.centerX,
		cy: mask.centerY,
		r: mask.rotation,
		s: mask.scale,
		p: mask.points,
	});
}

/**
 * Rasterize the closed pen path to an offscreen alpha canvas (opaque white
 * inside the path, transparent outside), sized to the element's pixel bounds.
 * Returns `null` when the path is not an active (closed, >= 3-point) mask.
 * Browser-only: uses `Path2D` and Canvas2D. Cached by geometry + size.
 */
export function rasterizeCustomMask({
	mask,
	width,
	height,
}: {
	mask: MaskShape;
	width: number;
	height: number;
}): OffscreenCanvas | HTMLCanvasElement | null {
	if (!isCustomMaskActive({ mask })) {
		return null;
	}
	const resolved = resolveCustomMask({ mask });
	const w = Math.max(1, Math.round(width));
	const h = Math.max(1, Math.round(height));
	const key = getRasterCacheKey({ mask: resolved, width: w, height: h });

	const cached = rasterCache.get(key);
	if (cached) {
		return cached;
	}

	const canvas = createMaskCanvas({ width: w, height: h });
	const ctx = canvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!ctx) {
		return null;
	}

	const transform = getRasterTransform({
		centerX: resolved.centerX,
		centerY: resolved.centerY,
		rotationDeg: resolved.rotation,
		scale: resolved.scale,
		width: w,
		height: h,
	});
	const path = buildFreeformPath2D({
		points: resolved.points,
		transform,
		closed: true,
	});

	ctx.clearRect(0, 0, w, h);
	ctx.fillStyle = "#ffffff";
	ctx.fill(path);

	if (rasterCache.size >= RASTER_CACHE_LIMIT) {
		const oldest = rasterCache.keys().next().value;
		if (oldest !== undefined) {
			rasterCache.delete(oldest);
		}
	}
	rasterCache.set(key, canvas);
	return canvas;
}

/**
 * The three-pass GLSL pipeline that turns a rasterized mask canvas + the element
 * frame into the masked result: horizontal feather, vertical feather, then a
 * composite pass that multiplies the coverage into the element frame (bound as
 * an auxiliary texture). Feed to `webglEffectRenderer.applyEffect` with
 * `source` set to the rasterized mask canvas.
 */
export function buildCustomMaskPasses({
	featherPx,
	inverted,
	source,
}: {
	featherPx: number;
	inverted: boolean;
	/** The element frame to composite the mask into (bound as u_sourceTexture). */
	source: CanvasImageSource;
}): EffectPassData[] {
	return [
		{
			fragmentShader: customMaskFeatherShader,
			uniforms: { u_direction: [1, 0], u_featherPx: featherPx },
		},
		{
			fragmentShader: customMaskFeatherShader,
			uniforms: { u_direction: [0, 1], u_featherPx: featherPx },
		},
		{
			fragmentShader: customMaskCompositeShader,
			uniforms: { u_inverted: inverted ? 1 : 0 },
			textures: [
				{
					uniform: "u_sourceTexture",
					unit: 1,
					source: source as TexImageSource,
					filter: "linear",
				},
			],
		},
	];
}
