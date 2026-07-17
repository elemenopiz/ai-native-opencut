import { describe, expect, test } from "bun:test";
import { mediaAssetSignature } from "./assets";

// BUG56 (P3): a byte-identical duplicate upload was silently imported as a
// second, visually-indistinguishable asset with no signal at all.
// `mediaAssetSignature` is the pure name+size match predicate `processFiles`
// uses to decide when to show the (non-blocking, informational) duplicate
// toast — no hashing, just name + byte size.
describe("mediaAssetSignature", () => {
	test("same name + same size -> identical signature", () => {
		const a = mediaAssetSignature({ name: "clip.mp4", size: 12345 });
		const b = mediaAssetSignature({ name: "clip.mp4", size: 12345 });
		expect(a).toBe(b);
	});

	test("same name but different size -> different signature (not a false-positive dupe)", () => {
		const a = mediaAssetSignature({ name: "clip.mp4", size: 12345 });
		const b = mediaAssetSignature({ name: "clip.mp4", size: 99999 });
		expect(a).not.toBe(b);
	});

	test("same size but different name -> different signature", () => {
		const a = mediaAssetSignature({ name: "clip-a.mp4", size: 12345 });
		const b = mediaAssetSignature({ name: "clip-b.mp4", size: 12345 });
		expect(a).not.toBe(b);
	});
});
