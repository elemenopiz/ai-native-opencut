import { describe, expect, it } from "bun:test";
import type { MediaType } from "@/types/assets";
import {
	buildLibraryManifest,
	type AssetUnderstanding,
	type AssetUnderstandingLookup,
	type ManifestAsset,
} from "./asset-manifest";

/**
 * The ASSET MANIFEST digest is Tier-0 grounding: it rides in the Director's
 * once-per-turn system prompt, so it must (a) faithfully summarize the library
 * WHEN understanding data is present, (b) DEGRADE GRACEFULLY to media-type
 * counts + recent names when it is absent, and (c) stay byte-small regardless of
 * library size. These tests pin all three, plus the exact digest format.
 */

/** Build N assets `m1..mN`, video by default, with per-index type overrides. */
function assets(
	n: number,
	typeAt: Record<number, MediaType> = {},
): ManifestAsset[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `m${i + 1}`,
		name: `clip${i + 1}.mp4`,
		type: typeAt[i] ?? ("video" as MediaType),
	}));
}

/** Turn an index→understanding map into an injectable per-id lookup. */
function lookupFrom(
	list: ManifestAsset[],
	byIndex: Record<number, AssetUnderstanding>,
): AssetUnderstandingLookup {
	const byId = new Map<string, AssetUnderstanding>();
	for (const [idx, u] of Object.entries(byIndex)) {
		byId.set(list[Number(idx)].id, u);
	}
	return (mediaId) => byId.get(mediaId);
}

describe("buildLibraryManifest — grounded (understanding present)", () => {
	it("renders the faceted digest exactly (roles · named heroes · face-anchors · tail)", () => {
		// 31 assets: 4 hero (2 with captions at #4/#7), 1 logo, 3 face-anchor
		// (2 matching persona Mara, 1 new face), 23 b-roll.
		const list = assets(31);
		const understanding = lookupFrom(list, {
			0: { mediaId: "", role: "hero" },
			1: { mediaId: "", role: "hero" },
			3: { mediaId: "", role: "hero", caption: "product on marble, backlit" },
			6: { mediaId: "", role: "hero", caption: "founder to-camera" },
			2: { mediaId: "", role: "logo" },
			4: {
				mediaId: "",
				role: "face-anchor",
				faces: [{ personaMatch: "p_mara", score: 0.9 }],
			},
			5: {
				mediaId: "",
				role: "face-anchor",
				faces: [{ personaMatch: "p_mara", score: 0.88 }],
			},
			7: { mediaId: "", role: "face-anchor", faces: [{ isNew: true }] },
			// indices 8..30 carry no understanding → default to b-roll (23 assets).
		});

		const manifest = buildLibraryManifest({
			assets: list,
			understanding,
			personas: [{ id: "p_mara", name: "Mara" }],
		});

		expect(manifest.grounded).toBe(true);
		expect(manifest.digest).toBe(
			'LIBRARY (31 assets): 4 hero · 1 logo · 3 face-anchor (Mara ×2) · 23 b-roll. Heroes: #4 "product on marble, backlit", #7 "founder to-camera". 23 more b-roll — searchable via searchMedia.',
		);
	});

	it("exposes structured facets (role counts, hero mediaIds, face-anchors, tail)", () => {
		const list = assets(31);
		const understanding = lookupFrom(list, {
			0: { mediaId: "", role: "hero" },
			1: { mediaId: "", role: "hero" },
			3: { mediaId: "", role: "hero", caption: "product on marble, backlit" },
			6: { mediaId: "", role: "hero", caption: "founder to-camera" },
			2: { mediaId: "", role: "logo" },
			4: {
				mediaId: "",
				role: "face-anchor",
				faces: [{ personaMatch: "p_mara" }],
			},
			5: {
				mediaId: "",
				role: "face-anchor",
				faces: [{ personaMatch: "p_mara" }],
			},
			7: { mediaId: "", role: "face-anchor", faces: [{ isNew: true }] },
		});

		const m = buildLibraryManifest({
			assets: list,
			understanding,
			personas: [{ id: "p_mara", name: "Mara" }],
		});

		expect(m.roleCounts).toEqual({
			hero: 4,
			logo: 1,
			"face-anchor": 3,
			"b-roll": 23,
		});
		// Named heroes carry the FULL media id so a consumer can act on them.
		expect(m.heroes).toEqual([
			{ ref: "#4", mediaId: "m4", caption: "product on marble, backlit" },
			{ ref: "#7", mediaId: "m7", caption: "founder to-camera" },
		]);
		expect(m.faceAnchors).toEqual([{ name: "Mara", count: 2 }]);
		expect(m.tail).toEqual({ count: 23, role: "b-roll" });
	});

	it("resolves a face's personaMatch id to a persona NAME, counting once per asset", () => {
		const list = assets(3);
		const understanding = lookupFrom(list, {
			// Two faces of the SAME persona in one asset must count that asset once.
			0: {
				mediaId: "",
				role: "face-anchor",
				faces: [{ personaMatch: "p_ana" }, { personaMatch: "p_ana" }],
			},
			1: {
				mediaId: "",
				role: "face-anchor",
				faces: [{ personaMatch: "p_ana" }],
			},
			2: {
				mediaId: "",
				role: "face-anchor",
				faces: [{ personaMatch: "p_leo" }],
			},
		});

		const m = buildLibraryManifest({
			assets: list,
			understanding,
			personas: [
				{ id: "p_ana", name: "Ana" },
				{ id: "p_leo", name: "Leo" },
			],
		});

		expect(m.faceAnchors).toEqual([
			{ name: "Ana", count: 2 },
			{ name: "Leo", count: 1 },
		]);
		expect(m.digest).toContain("3 face-anchor (Ana ×2, Leo ×1)");
	});

	it("falls back to the raw personaMatch when it is not a known persona id", () => {
		const list = assets(1);
		const understanding = lookupFrom(list, {
			0: {
				mediaId: "",
				role: "face-anchor",
				faces: [{ personaMatch: "Mara" }],
			},
		});
		const m = buildLibraryManifest({
			assets: list,
			understanding,
			personas: [],
		});
		expect(m.faceAnchors).toEqual([{ name: "Mara", count: 1 }]);
	});

	it("caps named heroes even when more carry captions", () => {
		const list = assets(6);
		const understanding = lookupFrom(list, {
			0: { mediaId: "", role: "hero", caption: "a" },
			1: { mediaId: "", role: "hero", caption: "b" },
			2: { mediaId: "", role: "hero", caption: "c" },
			3: { mediaId: "", role: "hero", caption: "d" },
			4: { mediaId: "", role: "hero", caption: "e" },
			5: { mediaId: "", role: "hero", caption: "f" },
		});
		const m = buildLibraryManifest({ assets: list, understanding });
		expect(m.roleCounts.hero).toBe(6);
		expect(m.heroes).toHaveLength(3); // HERO_NAME_CAP
		expect(m.heroes.map((h) => h.ref)).toEqual(["#1", "#2", "#3"]);
	});

	it("counts understood-but-unroled assets as b-roll so roles sum to total", () => {
		const list = assets(4);
		const understanding = lookupFrom(list, {
			0: { mediaId: "", role: "hero", caption: "hero shot" },
			1: { mediaId: "", caption: "some caption but no role" },
			// 2, 3 carry no row at all.
		});
		const m = buildLibraryManifest({ assets: list, understanding });
		expect(m.roleCounts).toEqual({ hero: 1, "b-roll": 3 });
		const summed = Object.values(m.roleCounts).reduce((a, b) => a + b, 0);
		expect(summed).toBe(m.total);
	});
});

describe("buildLibraryManifest — graceful fallback (no understanding)", () => {
	it("degrades to media-type counts + recent names when no lookup is injected", () => {
		const list = assets(31, { 29: "image", 30: "audio" });
		const m = buildLibraryManifest({ assets: list });

		expect(m.grounded).toBe(false);
		expect(m.roleCounts).toEqual({});
		expect(m.typeCounts).toEqual({ video: 29, image: 1, audio: 1 });
		// The three most-recent (tail) names, plus the searchMedia CTA.
		expect(m.digest).toBe(
			"LIBRARY (31 assets): 29 video · 1 image · 1 audio. searchMedia finds footage semantically; addClip places a hit. Recent: clip29.mp4, clip30.mp4, clip31.mp4.",
		);
	});

	it("degrades when a lookup is wired but yields nothing useful (empty Understanding Pass)", () => {
		const list = assets(3);
		const emptyLookup: AssetUnderstandingLookup = () => undefined;
		const m = buildLibraryManifest({
			assets: list,
			understanding: emptyLookup,
		});
		expect(m.grounded).toBe(false);
		expect(m.digest.startsWith("LIBRARY (3 assets): 3 video")).toBe(true);
	});

	it("renders an empty library plainly", () => {
		const m = buildLibraryManifest({ assets: [] });
		expect(m.total).toBe(0);
		expect(m.grounded).toBe(false);
		expect(m.digest).toBe("LIBRARY: empty (no assets yet).");
	});

	it("pluralizes a single asset", () => {
		const m = buildLibraryManifest({ assets: assets(1) });
		expect(m.digest.startsWith("LIBRARY (1 asset): ")).toBe(true);
	});
});

describe("buildLibraryManifest — token size stays small", () => {
	it("does not grow with library size (bounded by the caps, not the count)", () => {
		// A huge library that is almost entirely b-roll, with a handful of facets.
		const list = assets(600);
		const understanding = lookupFrom(list, {
			0: {
				mediaId: "",
				role: "hero",
				caption: "the packshot, top-down on slate",
			},
			1: {
				mediaId: "",
				role: "hero",
				caption: "the founder mid-laugh, natural light",
			},
			2: {
				mediaId: "",
				role: "hero",
				caption: "wide establishing drone over the coast",
			},
			3: {
				mediaId: "",
				role: "hero",
				caption: "this fourth hero should not be named",
			},
			4: { mediaId: "", role: "logo" },
			5: { mediaId: "", role: "face-anchor", faces: [{ personaMatch: "p1" }] },
		});
		const m = buildLibraryManifest({
			assets: list,
			understanding,
			personas: [{ id: "p1", name: "Priya" }],
		});

		// Only 3 heroes named despite 4; b-roll is a single count + tail pointer.
		expect(m.heroes).toHaveLength(3);
		expect(m.digest).toContain("594 b-roll");
		// ~40-token target: keep a generous byte ceiling that a 600-asset library
		// cannot breach. (A rough char/token ratio of ~4 puts this well under 90.)
		expect(m.digest.length).toBeLessThan(340);
		// Rough token proxy: whitespace-delimited words.
		expect(m.digest.split(/\s+/).length).toBeLessThan(70);
	});
});
