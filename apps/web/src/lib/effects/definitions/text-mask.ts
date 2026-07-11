// Text-reveal mask — footage visible only through glyph shapes.
//
// Adapted from OpenCut-app/OpenCut (pre-rewrite tag, MIT) —
// apps/web/src/masks/builtin/definitions/text.ts. Their glyph feather is a
// Rust/WASM jump-flood crate (not portable). The portable part is the Canvas2D
// `fillText` glyph rasterization, ported here: we rasterize the text to an
// offscreen alpha canvas, then reuse the pen mask's separable-Gaussian feather +
// composite passes (buildCustomMaskPasses in custom-mask.ts) — the feather and
// composite passes are agnostic to what was rasterized. Pure layout math lives
// in lib/effects/masks/text-layout.ts (unit-testable); this module is the
// browser-only rasterizer + param resolution, mirroring custom-mask.ts.
import type { MaskShape } from "@/types/rendering";
import { DEFAULT_FONT, SYSTEM_FONTS } from "@/constants/font-constants";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import {
	buildTextMaskFontString,
	getTextMaskGlyphPx,
	getTextMaskLineHeightPx,
	getTextMaskLineOffsets,
	getTextMaskLines,
} from "@/lib/effects/masks/text-layout";

export interface ResolvedTextMask {
	text: string;
	fontFamily: string;
	fontWeight: "normal" | "bold";
	fontSize: number;
	centerX: number;
	centerY: number;
	rotation: number;
	feather: number;
	inverted: boolean;
}

export function resolveTextMask({
	mask,
}: {
	mask: MaskShape;
}): ResolvedTextMask {
	return {
		text: mask.text ?? "",
		fontFamily: mask.fontFamily ?? DEFAULT_FONT,
		fontWeight: mask.fontWeight ?? "normal",
		fontSize: mask.fontSize ?? DEFAULT_TEXT_ELEMENT.fontSize,
		centerX: mask.centerX ?? 0,
		centerY: mask.centerY ?? 0,
		rotation: mask.rotation ?? 0,
		feather: mask.feather ?? 0,
		inverted: mask.inverted ?? false,
	};
}

/** A text mask only takes effect once it has non-blank content. */
export function isTextMaskActive({ mask }: { mask: MaskShape }): boolean {
	return (mask.text ?? "").trim().length > 0;
}

/** A fresh text mask with sensible defaults (mirrors pre-rewrite `buildDefault`). */
export function createDefaultTextMask(): MaskShape {
	return {
		type: "text",
		feather: 0,
		inverted: false,
		centerX: 0,
		centerY: 0,
		rotation: 0,
		text: "Text",
		fontFamily: DEFAULT_FONT,
		fontWeight: "normal",
		fontSize: DEFAULT_TEXT_ELEMENT.fontSize,
	};
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

// A custom family may not be loaded yet when a frame first rasterizes (fonts
// load async — see google-fonts.loadFullFont). If the family isn't ready the
// glyph shapes fall back to a system font, so we skip caching that frame; once
// the real font loads a later frame re-rasterizes and caches the correct shapes.
function isTextMaskFontReady({
	fontFamily,
	fontString,
}: {
	fontFamily: string;
	fontString: string;
}): boolean {
	if (SYSTEM_FONTS.has(fontFamily)) {
		return true;
	}
	if (typeof document === "undefined" || !document.fonts?.check) {
		return true;
	}
	try {
		return document.fonts.check(fontString);
	} catch {
		return true;
	}
}

// Cache the rasterized hard-edge alpha canvas keyed by (text params, size).
// Parallel to custom-mask.ts's `rasterCache` (different key shape); feather stays
// a GLSL uniform so changing it reuses the same cached canvas. Bounded LRU-ish.
const RASTER_CACHE_LIMIT = 12;
const rasterCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

function getRasterCacheKey({
	mask,
	width,
	height,
}: {
	mask: ResolvedTextMask;
	width: number;
	height: number;
}): string {
	return JSON.stringify({
		w: width,
		h: height,
		t: mask.text,
		ff: mask.fontFamily,
		fw: mask.fontWeight,
		fs: mask.fontSize,
		cx: mask.centerX,
		cy: mask.centerY,
		r: mask.rotation,
	});
}

/**
 * Rasterize the mask's text to an offscreen alpha canvas (opaque white glyphs,
 * transparent elsewhere), sized to the element's pixel bounds. Returns `null`
 * when the text is blank (inactive mask). Browser-only: uses Canvas2D
 * `fillText`. Cached by (text params + size); skips caching until the requested
 * font family is loaded so an early fallback render isn't pinned.
 */
export function rasterizeTextMask({
	mask,
	width,
	height,
}: {
	mask: MaskShape;
	width: number;
	height: number;
}): OffscreenCanvas | HTMLCanvasElement | null {
	if (!isTextMaskActive({ mask })) {
		return null;
	}
	const resolved = resolveTextMask({ mask });
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

	const glyphPx = getTextMaskGlyphPx({
		fontSize: resolved.fontSize,
		height: h,
	});
	const fontString = buildTextMaskFontString({
		fontWeight: resolved.fontWeight,
		glyphPx,
		fontFamily: resolved.fontFamily,
	});
	const lines = getTextMaskLines({ text: resolved.text });
	const lineHeightPx = getTextMaskLineHeightPx({ glyphPx });
	const offsets = getTextMaskLineOffsets({
		lineCount: lines.length,
		lineHeightPx,
	});

	ctx.clearRect(0, 0, w, h);
	ctx.save();
	ctx.translate(w / 2 + resolved.centerX * w, h / 2 + resolved.centerY * h);
	if (resolved.rotation) {
		ctx.rotate((resolved.rotation * Math.PI) / 180);
	}
	ctx.font = fontString;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = "#ffffff";
	for (let index = 0; index < lines.length; index++) {
		ctx.fillText(lines[index], 0, offsets[index]);
	}
	ctx.restore();

	// Only cache once the real font is ready, so a fallback-font render for an
	// unloaded custom family doesn't get pinned under this key.
	if (isTextMaskFontReady({ fontFamily: resolved.fontFamily, fontString })) {
		if (rasterCache.size >= RASTER_CACHE_LIMIT) {
			const oldest = rasterCache.keys().next().value;
			if (oldest !== undefined) {
				rasterCache.delete(oldest);
			}
		}
		rasterCache.set(key, canvas);
	}
	return canvas;
}
