import { describe, expect, it } from "bun:test";
import type { MediaType } from "@/types/assets";
import {
	aspectRatioTag,
	buildLibraryManifest,
	orientationOf,
	type AssetBeatGrid,
	type AssetBeatGridLookup,
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

describe("orientationOf / aspectRatioTag", () => {
	it("classifies width×height into a coarse orientation bucket", () => {
		expect(orientationOf(1920, 1080)).toBe("landscape");
		expect(orientationOf(1080, 1920)).toBe("portrait");
		expect(orientationOf(1080, 1080)).toBe("square");
	});

	it("returns undefined when either dimension is missing or non-positive", () => {
		expect(orientationOf(undefined, 1080)).toBeUndefined();
		expect(orientationOf(1920, undefined)).toBeUndefined();
		expect(orientationOf(0, 1080)).toBeUndefined();
		expect(orientationOf(-100, 1080)).toBeUndefined();
	});

	it("reduces pixel dimensions to a familiar compact aspect-ratio label", () => {
		expect(aspectRatioTag(1920, 1080)).toBe("16:9");
		expect(aspectRatioTag(1080, 1920)).toBe("9:16");
		expect(aspectRatioTag(1080, 1080)).toBe("1:1");
		expect(aspectRatioTag(1080, 1350)).toBe("4:5");
	});

	it("returns undefined when either dimension is missing", () => {
		expect(aspectRatioTag(undefined, 1080)).toBeUndefined();
		expect(aspectRatioTag(1920, undefined)).toBeUndefined();
	});
});

/** Build one dimensioned asset, video by default; overrides merge in. */
function dimensionedAsset(over: Partial<ManifestAsset> = {}): ManifestAsset {
	return { id: "m1", name: "clip1.mp4", type: "video" as MediaType, ...over };
}

describe("buildLibraryManifest — dims, provenance, and style facets", () => {
	it("includes a hero's width/height/durationSec/source/orientation when the asset carries them", () => {
		const list: ManifestAsset[] = [
			dimensionedAsset({
				width: 1920,
				height: 1080,
				durationSec: 12.5,
				source: "ai",
			}),
			{ id: "m2", name: "broll.mp4", type: "video" },
		];
		const understanding: AssetUnderstandingLookup = (id) =>
			id === "m1"
				? { mediaId: "m1", role: "hero", caption: "the hero shot" }
				: undefined;

		const m = buildLibraryManifest({ assets: list, understanding });

		expect(m.heroes).toEqual([
			{
				ref: "#1",
				mediaId: "m1",
				caption: "the hero shot",
				width: 1920,
				height: 1080,
				durationSec: 12.5,
				source: "ai",
				orientation: "16:9",
			},
		]);
	});

	it("leaves dims/provenance/orientation off a hero when the asset lacks them (backward compatible)", () => {
		const list: ManifestAsset[] = [dimensionedAsset()];
		const understanding: AssetUnderstandingLookup = () => ({
			mediaId: "m1",
			role: "hero",
			caption: "undimensioned hero",
		});
		const m = buildLibraryManifest({ assets: list, understanding });
		expect(m.heroes).toEqual([
			{ ref: "#1", mediaId: "m1", caption: "undimensioned hero" },
		]);
	});

	it("surfaces a hero's styleProbe (palette/lensMood/setting) restored from the Understanding Pass", () => {
		const list: ManifestAsset[] = [dimensionedAsset()];
		const understanding: AssetUnderstandingLookup = () => ({
			mediaId: "m1",
			role: "hero",
			caption: "founder to-camera",
			styleProbe: {
				palette: "warm amber",
				lensMood: "shallow DoF, wistful",
				setting: "sunlit kitchen",
			},
		});
		const m = buildLibraryManifest({ assets: list, understanding });

		expect(m.heroes[0]?.styleProbe).toEqual({
			palette: "warm amber",
			lensMood: "shallow DoF, wistful",
			setting: "sunlit kitchen",
		});
		// The look probe is a STRUCTURED (on-demand) field, never the always-on line.
		expect(m.digest).not.toContain("warm amber");
	});

	it("appends the orientation-mismatch clause to the digest when the canvas conflicts (grounded path)", () => {
		const list: ManifestAsset[] = [
			dimensionedAsset({
				id: "m1",
				name: "a.mp4",
				width: 1920,
				height: 1080,
			}),
			dimensionedAsset({ id: "m2", name: "b.mp4", width: 1920, height: 1080 }),
			dimensionedAsset({ id: "m3", name: "c.mp4", width: 1080, height: 1920 }),
		];
		const understanding: AssetUnderstandingLookup = (id) =>
			id === "m1"
				? { mediaId: "m1", role: "hero", caption: "hero" }
				: undefined;

		const m = buildLibraryManifest({
			assets: list,
			understanding,
			canvasOrientation: "portrait",
		});

		expect(m.grounded).toBe(true);
		expect(m.orientationMismatch).toEqual({
			canvasOrientation: "portrait",
			counts: { landscape: 2 },
			total: 2,
		});
		expect(m.digest).toContain("⚠ 2 landscape assets, canvas is portrait.");
	});

	it("appends the orientation-mismatch clause to the digest when the canvas conflicts (fallback path)", () => {
		const list: ManifestAsset[] = [
			dimensionedAsset({ id: "m1", name: "a.mp4", width: 1920, height: 1080 }),
			dimensionedAsset({ id: "m2", name: "b.mp4", width: 1080, height: 1920 }),
		];
		const m = buildLibraryManifest({
			assets: list,
			canvasOrientation: "portrait",
		});

		expect(m.grounded).toBe(false);
		expect(m.orientationMismatch).toEqual({
			canvasOrientation: "portrait",
			counts: { landscape: 1 },
			total: 1,
		});
		expect(m.digest).toContain("⚠ 1 landscape asset, canvas is portrait.");
	});

	it("names every conflicting orientation, in landscape/portrait/square order", () => {
		const list: ManifestAsset[] = [
			dimensionedAsset({ id: "m1", name: "a.mp4", width: 1920, height: 1080 }), // landscape
			dimensionedAsset({ id: "m2", name: "b.mp4", width: 1080, height: 1080 }), // square
			dimensionedAsset({ id: "m3", name: "c.mp4", width: 1080, height: 1920 }), // portrait, matches canvas
		];
		const m = buildLibraryManifest({
			assets: list,
			canvasOrientation: "portrait",
		});
		expect(m.digest).toContain(
			"⚠ 1 landscape, 1 square assets, canvas is portrait.",
		);
	});

	it("adds ZERO bytes to the digest when no canvasOrientation is given", () => {
		const list: ManifestAsset[] = [
			dimensionedAsset({ width: 1920, height: 1080 }),
		];
		const withoutOrientation = buildLibraryManifest({ assets: list });
		expect(withoutOrientation.orientationMismatch).toBeUndefined();
		expect(withoutOrientation.digest).not.toContain("⚠");
	});

	it("adds ZERO bytes to the digest when every dimensioned asset matches the canvas", () => {
		const list: ManifestAsset[] = [
			dimensionedAsset({ width: 1080, height: 1920 }),
		];
		const withMatchingCanvas = buildLibraryManifest({
			assets: list,
			canvasOrientation: "portrait",
		});
		const withoutOrientation = buildLibraryManifest({ assets: list });
		expect(withMatchingCanvas.orientationMismatch).toBeUndefined();
		expect(withMatchingCanvas.digest).toBe(withoutOrientation.digest);
	});

	it("skips assets with unknown dimensions when checking for a mismatch", () => {
		const list: ManifestAsset[] = [
			dimensionedAsset({ id: "m1", name: "a.mp4" }), // no width/height
			dimensionedAsset({ id: "m2", name: "b.mp4", width: 1920, height: 1080 }),
		];
		const m = buildLibraryManifest({
			assets: list,
			canvasOrientation: "portrait",
		});
		expect(m.orientationMismatch).toEqual({
			canvasOrientation: "portrait",
			counts: { landscape: 1 },
			total: 1,
		});
	});
});

/**
 * BEAT-GRID facet: grounds pacing decisions (cut-on-beat, matching a shot's
 * length to a bar) on the beat-snap grid's REAL analyzed tempo/beat-density/
 * energy for a matching library asset — see `stores/beat-grid-store.ts`'s
 * `BeatGrid` (analyzed on-demand in the UI, so at most one asset typically has
 * one). Zero bytes when no lookup is wired, or nothing matches — same
 * surface-when-present contract as speech/orientation.
 */
describe("buildLibraryManifest — beat-grid facet", () => {
	/** Injectable lookup returning `grid` only for `matchId`. */
	function beatGridFor(
		matchId: string,
		grid: AssetBeatGrid,
	): AssetBeatGridLookup {
		return (mediaId) => (mediaId === matchId ? grid : undefined);
	}

	it("appends the beat-grid clause to the digest (grounded path) with bpm + energyClass present", () => {
		const list: ManifestAsset[] = [
			{ id: "m1", name: "clip1.mp4", type: "video" },
			{ id: "m2", name: "song.mp3", type: "audio" },
		];
		const understanding: AssetUnderstandingLookup = (id) =>
			id === "m1"
				? { mediaId: "m1", role: "hero", caption: "hero" }
				: undefined;

		const m = buildLibraryManifest({
			assets: list,
			understanding,
			beatGrid: beatGridFor("m2", {
				bpm: 128,
				beatCount: 64,
				downbeatCount: 16,
				energyClass: "energetic",
			}),
		});

		expect(m.grounded).toBe(true);
		expect(m.beatGrid).toEqual({
			mediaId: "m2",
			assetName: "song.mp3",
			bpm: 128,
			beatCount: 64,
			downbeatCount: 16,
			energyClass: "energetic",
		});
		expect(m.digest).toContain(
			'♫ "song.mp3" 128bpm, 64 beats/16 downbeats, energetic.',
		);
	});

	it("appends the beat-grid clause to the digest (fallback path)", () => {
		const list: ManifestAsset[] = [
			{ id: "m1", name: "song.mp3", type: "audio" },
		];
		const m = buildLibraryManifest({
			assets: list,
			beatGrid: beatGridFor("m1", {
				bpm: 90,
				beatCount: 32,
				downbeatCount: 8,
				energyClass: "calm",
			}),
		});

		expect(m.grounded).toBe(false);
		expect(m.beatGrid).toEqual({
			mediaId: "m1",
			assetName: "song.mp3",
			bpm: 90,
			beatCount: 32,
			downbeatCount: 8,
			energyClass: "calm",
		});
		expect(m.digest).toContain(
			'♫ "song.mp3" 90bpm, 32 beats/8 downbeats, calm.',
		);
	});

	it("omits bpm/energyClass individually when the analyzer didn't resolve them", () => {
		const list: ManifestAsset[] = [
			{ id: "m1", name: "song.mp3", type: "audio" },
		];
		const m = buildLibraryManifest({
			assets: list,
			beatGrid: beatGridFor("m1", { beatCount: 20, downbeatCount: 5 }),
		});
		expect(m.digest).toContain('♫ "song.mp3" 20 beats/5 downbeats.');
	});

	it("adds ZERO bytes to the digest and manifest when no beatGrid lookup is given", () => {
		const list: ManifestAsset[] = [
			{ id: "m1", name: "song.mp3", type: "audio" },
		];
		const withLookup = buildLibraryManifest({
			assets: list,
			beatGrid: beatGridFor("nope", { beatCount: 1, downbeatCount: 1 }),
		});
		const without = buildLibraryManifest({ assets: list });
		expect(without.beatGrid).toBeUndefined();
		expect(without.digest).not.toContain("♫");
		// A lookup wired but matching nothing behaves identically to no lookup.
		expect(withLookup.digest).toBe(without.digest);
		expect(withLookup.beatGrid).toBeUndefined();
	});

	it("is byte-identical to the no-beatGrid digest when the lookup is absent entirely (explicit regression pin)", () => {
		const list: ManifestAsset[] = [
			{ id: "m1", name: "clip1.mp4", type: "video" },
			{ id: "m2", name: "clip2.mp4", type: "video" },
		];
		const before = buildLibraryManifest({ assets: list });
		const after = buildLibraryManifest({ assets: list, beatGrid: undefined });
		expect(after).toEqual(before);
	});
});
