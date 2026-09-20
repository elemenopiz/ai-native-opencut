import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPTION_TREATMENT, resolveCaptionTreatment } from "./captions";
import { captionBand } from "./layouts";
import { actionSafeBounds } from "./safe-area";
import { fontSizePx } from "./type-scale";
import type { Canvas, Orientation } from "./types";

const CANVASES: Record<string, Canvas> = {
	landscape: { width: 1920, height: 1080 },
	portrait: { width: 1080, height: 1920 },
	square: { width: 1080, height: 1080 },
};
const ORIENTATIONS = Object.keys(CANVASES) as Orientation[];

describe("resolveCaptionTreatment", () => {
	test.each(ORIENTATIONS)(
		"%s: placement matches layouts.ts's captionBand (action-safe)",
		(o) => {
			const canvas = CANVASES[o];
			const resolved = resolveCaptionTreatment(canvas, o);
			expect(resolved.placement).toEqual(captionBand(canvas, o));

			// Belt-and-suspenders: independently re-derive the action-safe rect
			// and confirm the placement nests inside it, rather than trusting
			// captionBand's own test alone.
			const safe = actionSafeBounds(canvas, o);
			expect(resolved.placement.x).toBeGreaterThanOrEqual(safe.x);
			expect(resolved.placement.y).toBeGreaterThanOrEqual(safe.y);
			expect(
				resolved.placement.x + resolved.placement.width,
			).toBeLessThanOrEqual(safe.x + safe.width + 1e-6);
			expect(
				resolved.placement.y + resolved.placement.height,
			).toBeLessThanOrEqual(safe.y + safe.height + 1e-6);
		},
	);

	test.each(ORIENTATIONS)(
		"%s: resolves font size from the caption type step",
		(o) => {
			const canvas = CANVASES[o];
			const resolved = resolveCaptionTreatment(canvas, o);
			expect(resolved.fontSizePx).toBeCloseTo(fontSizePx("caption", canvas), 6);
		},
	);

	test("stroke width is derived from font size and the ratio", () => {
		const canvas = CANVASES.landscape;
		const resolved = resolveCaptionTreatment(canvas, "landscape");
		expect(resolved.strokeWidthPx).toBeCloseTo(
			resolved.fontSizePx * DEFAULT_CAPTION_TREATMENT.strokeWidthRatio,
			6,
		);
	});

	test("an override treatment is honored (still a default, not enforced)", () => {
		const canvas = CANVASES.landscape;
		const override = {
			...DEFAULT_CAPTION_TREATMENT,
			typeStep: "body" as const,
			strokeWidthRatio: 0.2,
		};
		const resolved = resolveCaptionTreatment(canvas, "landscape", override);
		expect(resolved.typeStep).toBe("body");
		expect(resolved.fontSizePx).toBeCloseTo(fontSizePx("body", canvas), 6);
		expect(resolved.strokeWidthPx).toBeCloseTo(resolved.fontSizePx * 0.2, 6);
	});
});
