import { describe, expect, it } from "bun:test";
import type { AssetUnderstanding } from "./asset-understanding";
import {
	assetSwatches,
	describeConfidence,
	detectStyleOutliers,
	extractSwatches,
	hasNewFace,
	libraryPalette,
	needsReview,
	roleCounts,
	styleClassesOf,
	topLookWords,
} from "./library-insights";

/** Build a minimal understanding record with overrides. */
function rec(overrides: Partial<AssetUnderstanding>): AssetUnderstanding {
	return {
		mediaId: "m",
		caption: "",
		role: "b-roll",
		roleConfidence: 0.8,
		tags: [],
		faces: [],
		modelName: "test",
		createdAt: 0,
		...overrides,
	};
}

/**
 * A trimmed cut of the brief's real reference dataset (a pastry brand): the
 * realistic 7-product/1-hero skew, one new face, one "anime style" outlier.
 */
const PASTRY: AssetUnderstanding[] = [
	rec({
		mediaId: "a",
		role: "product",
		roleConfidence: 0.85,
		tags: ["pastry", "dessert", "hands"],
		styleProbe: {
			palette: "soft neutral with pink accent",
			lensMood: "shallow DoF, clean product-style framing",
			setting: "indoor, even lighting",
		},
	}),
	rec({
		mediaId: "b",
		role: "product",
		roleConfidence: 0.85,
		tags: ["pastry", "hand", "green food", "overhead shot"],
		styleProbe: {
			palette: "muted with green and pink contrast",
			lensMood: "casual overhead smartphone",
			setting: "tabletop, indoor",
		},
	}),
	rec({
		mediaId: "c",
		role: "product",
		roleConfidence: 0.92,
		tags: ["cookies", "golden brown", "overhead shot"],
		styleProbe: {
			palette: "warm golden browns on cream white",
			lensMood: "bright natural light, crisp detail",
			setting: "daylight, hard shadows",
		},
	}),
	rec({
		mediaId: "d",
		role: "hero",
		roleConfidence: 0.85,
		tags: ["woman", "pastry", "outdoor café", "eating"],
		faces: [
			{
				isNew: true,
				score: 0.9,
				descriptor: "young woman, white t-shirt",
				anchorFrame: 0,
			},
		],
		styleProbe: {
			palette: "bright natural daylight, warm tones",
			lensMood: "casual handheld, shallow DoF",
			setting: "outdoor urban café, sunny",
		},
	}),
	rec({
		mediaId: "e",
		role: "product",
		roleConfidence: 0.9,
		tags: ["pastry", "teacup", "cozy", "anime style"],
		styleProbe: {
			palette: "warm golden tones, soft pastels",
			lensMood: "shallow DoF, soft bokeh",
			setting: "morning light, sunlit dining area",
		},
	}),
];

describe("describeConfidence", () => {
	it("treats 0 as no read, not a 0% belief", () => {
		expect(describeConfidence(0)).toEqual({ label: "no read", tone: "none" });
	});

	it("phrases the bands in plain language", () => {
		expect(describeConfidence(0.3).label).toBe("just a guess");
		expect(describeConfidence(0.6).label).toBe("fairly sure");
		expect(describeConfidence(0.85).label).toBe("confident");
		expect(describeConfidence(0.95).label).toBe("certain");
	});
});

describe("needsReview", () => {
	it("flags weak and degraded beliefs", () => {
		expect(needsReview(rec({ roleConfidence: 0 }))).toBe(true);
		expect(needsReview(rec({ roleConfidence: 0.5 }))).toBe(true);
		expect(needsReview(rec({ roleConfidence: 0.85 }))).toBe(false);
	});

	it("never flags a record the user already confirmed", () => {
		expect(needsReview(rec({ roleConfidence: 0, roleConfirmed: "hero" }))).toBe(
			false,
		);
	});
});

describe("swatches", () => {
	it("mines color words from look text, in order, deduped", () => {
		const swatches = extractSwatches("warm golden browns on cream white");
		expect(swatches.map((s) => s.word)).toEqual([
			"golden",
			"browns",
			"cream",
			"white",
		]);
	});

	it("returns nothing for text with no color words", () => {
		expect(extractSwatches("shallow DoF, crisp detail")).toEqual([]);
		expect(extractSwatches(undefined)).toEqual([]);
	});

	it("reads the whole style probe of an asset", () => {
		const words = assetSwatches(PASTRY[0]).map((s) => s.word);
		expect(words).toContain("pink");
		expect(words).toContain("neutral");
	});

	it("ranks the library palette by how many assets share a color", () => {
		const palette = libraryPalette(PASTRY);
		expect(palette[0].count).toBeGreaterThanOrEqual(palette[1]?.count ?? 0);
		expect(palette.map((s) => s.word)).toContain("pink");
	});
});

describe("topLookWords", () => {
	it("finds vocabulary shared by 2+ assets and keeps original casing", () => {
		const words = topLookWords(PASTRY, "lensMood");
		const dof = words.find((w) => w.word === "DoF");
		expect(dof).toBeDefined();
		expect(dof?.count).toBeGreaterThanOrEqual(3);
	});

	it("ignores one-off words", () => {
		const words = topLookWords(PASTRY, "lensMood", 10);
		expect(words.map((w) => w.word.toLowerCase())).not.toContain("bokeh");
	});
});

describe("style outliers", () => {
	it("classifies the anime-tagged asset", () => {
		expect(styleClassesOf(PASTRY[4])).toEqual(["anime / illustrated"]);
	});

	it("flags the single anime asset in a photographic library", () => {
		const outliers = detectStyleOutliers(PASTRY);
		expect(outliers.get("e")).toBe("anime / illustrated");
		expect(outliers.size).toBe(1);
	});

	it("stays quiet in a tiny library", () => {
		expect(detectStyleOutliers(PASTRY.slice(2, 5)).size).toBe(0);
	});

	it("treats a class shared by two assets as a sub-style, not an outlier", () => {
		const twin = rec({ mediaId: "f", tags: ["anime style"] });
		expect(detectStyleOutliers([...PASTRY, twin]).size).toBe(0);
	});
});

describe("roleCounts", () => {
	it("counts effective roles with every role present", () => {
		const counts = roleCounts(PASTRY);
		expect(counts.product).toBe(4);
		expect(counts.hero).toBe(1);
		expect(counts.logo).toBe(0);
	});

	it("honors a human confirmation over the inferred role", () => {
		const corrected = PASTRY.map((u) =>
			u.mediaId === "a" ? { ...u, roleConfirmed: "hero" as const } : u,
		);
		const counts = roleCounts(corrected);
		expect(counts.hero).toBe(2);
		expect(counts.product).toBe(3);
	});
});

describe("hasNewFace", () => {
	it("is true only for records with an unmatched recurring face", () => {
		expect(hasNewFace(PASTRY[3])).toBe(true);
		expect(hasNewFace(PASTRY[0])).toBe(false);
		expect(
			hasNewFace(
				rec({ faces: [{ isNew: false, score: 0.9, personaMatch: "p1" }] }),
			),
		).toBe(false);
	});
});
