import { describe, expect, it } from "bun:test";
import { toPlainReferenceImages } from "../types";
import type { ReferenceImage } from "../types";

/**
 * `toPlainReferenceImages` is the one piece of runtime logic added to
 * `types.ts` alongside the new `ReferenceImage`/`ReferenceRole` types (the
 * rest is type-only and needs no test). It exists so a caller building a
 * `BackendRequest` from a single roled source can derive the compat
 * `referenceImages: string[]` array without hand-rolling `.map(r => r.url)`
 * — and, critically, so the two arrays stay index-aligned (see
 * `BackendRequest.referenceImageRefs`'s docblock).
 */
describe("toPlainReferenceImages", () => {
	it("extracts urls in order", () => {
		const refs: ReferenceImage[] = [
			{ url: "https://x/a.png", role: "appearance", handle: "Orlando" },
			{ url: "https://x/b.png", role: "environment" },
		];
		expect(toPlainReferenceImages(refs)).toEqual([
			"https://x/a.png",
			"https://x/b.png",
		]);
	});

	it("returns an empty array for an empty input", () => {
		expect(toPlainReferenceImages([])).toEqual([]);
	});

	it("keeps output index-aligned with the input for BackendRequest's parallel-array contract", () => {
		const refs: ReferenceImage[] = [
			{ url: "https://x/a.png" },
			{ url: "https://x/b.png", role: "grade" },
			{ url: "https://x/c.png", role: "style", handle: "moody" },
		];
		const plain = toPlainReferenceImages(refs);
		refs.forEach((ref, i) => {
			expect(plain[i]).toBe(ref.url);
		});
	});
});
