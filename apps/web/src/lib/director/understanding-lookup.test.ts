import { describe, expect, it } from "bun:test";
import type { AssetUnderstanding as CanonicalUnderstanding } from "@/lib/search/asset-understanding";
import {
	adaptUnderstandingForManifest,
	cacheUnderstanding,
	clearUnderstandingCache,
	manifestUnderstandingLookup,
	styleProbeLookup,
} from "./understanding-lookup";

/** A complete canonical record with sensible defaults; override per test. */
function canonical(
	over: Partial<CanonicalUnderstanding> = {},
): CanonicalUnderstanding {
	return {
		mediaId: "m1",
		caption: "product on marble, backlit",
		role: "b-roll",
		roleConfidence: 0.7,
		tags: ["product", "marble"],
		faces: [],
		modelName: "test-model",
		createdAt: 1,
		...over,
	};
}

describe("adaptUnderstandingForManifest", () => {
	it("resolves the role BELIEF via effectiveRole — a confirmed override wins", () => {
		const u = canonical({ role: "b-roll", roleConfirmed: "hero" });
		const m = adaptUnderstandingForManifest(u);
		expect(m.role).toBe("hero"); // override beats the inferred role
		expect(m.roleConfirmed).toBe(true); // collapsed to the boolean the manifest wants
	});

	it("falls back to the inferred role when there is no override", () => {
		const m = adaptUnderstandingForManifest(
			canonical({ role: "product", roleConfirmed: undefined }),
		);
		expect(m.role).toBe("product");
		expect(m.roleConfirmed).toBe(false);
	});

	it("passes the screen-rec role through (vocabulary now shared)", () => {
		const m = adaptUnderstandingForManifest(canonical({ role: "screen-rec" }));
		expect(m.role).toBe("screen-rec");
	});

	it("carries the styleProbe through instead of dropping it", () => {
		const u = canonical({
			styleProbe: {
				palette: "warm amber",
				lensMood: "shallow DoF, wistful",
				setting: "sunlit kitchen",
			},
		});
		const m = adaptUnderstandingForManifest(u);
		expect(m.styleProbe).toEqual({
			palette: "warm amber",
			lensMood: "shallow DoF, wistful",
			setting: "sunlit kitchen",
		});
	});

	it("omits styleProbe when the canonical record has none", () => {
		const m = adaptUnderstandingForManifest(
			canonical({ styleProbe: undefined }),
		);
		expect(m.styleProbe).toBeUndefined();
	});

	it("carries the DEEPENED perception fields through when present (Bet 1)", () => {
		const u = canonical({
			motion: "handheld",
			shotType: "close-up",
			composition: { subjectPosition: "center", ruleOfThirds: true },
			emotion: "tense",
			audio: { hasSpeech: true, energy: "high" },
			continuityFingerprint: {
				lighting: "soft key",
				whiteBalance: "warm",
				wardrobe: "navy blazer",
				colorSignature: "warm amber",
			},
		});
		const m = adaptUnderstandingForManifest(u);
		expect(m.motion).toBe("handheld");
		expect(m.shotType).toBe("close-up");
		expect(m.composition).toEqual({
			subjectPosition: "center",
			ruleOfThirds: true,
		});
		expect(m.emotion).toBe("tense");
		expect(m.audio).toEqual({ hasSpeech: true, energy: "high" });
		expect(m.continuityFingerprint).toEqual({
			lighting: "soft key",
			whiteBalance: "warm",
			wardrobe: "navy blazer",
			colorSignature: "warm amber",
		});
	});

	it("degrades silently: a SHALLOW canonical record (no deepened fields) omits them all from the manifest shape", () => {
		const m = adaptUnderstandingForManifest(canonical());
		expect(m.motion).toBeUndefined();
		expect(m.shotType).toBeUndefined();
		expect(m.composition).toBeUndefined();
		expect(m.emotion).toBeUndefined();
		expect(m.audio).toBeUndefined();
		expect(m.continuityFingerprint).toBeUndefined();
	});

	it("carries caption, confidence, tags, and the named face fields", () => {
		const u = canonical({
			caption: "founder to-camera",
			role: "face-anchor",
			roleConfidence: 0.9,
			tags: ["person", "interview"],
			faces: [
				{ personaMatch: "persona_mara", score: 0.92, isNew: false },
				{ score: 0.4, isNew: true },
			],
		});
		const m = adaptUnderstandingForManifest(u);
		expect(m.caption).toBe("founder to-camera");
		expect(m.roleConfidence).toBe(0.9);
		expect(m.tags).toEqual(["person", "interview"]);
		expect(m.faces).toEqual([
			{ personaMatch: "persona_mara", score: 0.92, isNew: false },
			{ personaMatch: undefined, score: 0.4, isNew: true },
		]);
	});
});

describe("understanding cache", () => {
	it("round-trips through cacheUnderstanding → lookup → clear", () => {
		clearUnderstandingCache();
		expect(manifestUnderstandingLookup("m1")).toBeUndefined();

		cacheUnderstanding(canonical({ mediaId: "m1", role: "hero" }));
		const hit = manifestUnderstandingLookup("m1");
		expect(hit?.role).toBe("hero");

		clearUnderstandingCache();
		expect(manifestUnderstandingLookup("m1")).toBeUndefined();
	});

	// Follow-up A: `cacheUnderstanding` is the seam `saveUnderstanding` now calls,
	// so a freshly-understood asset shows up in the live cache without a reload.
	// Follow-up B: it also refreshes the parallel style-probe cache in lockstep.
	it("cacheUnderstanding refreshes the style-probe cache in lockstep", () => {
		clearUnderstandingCache();
		expect(styleProbeLookup("m1")).toBeUndefined();

		cacheUnderstanding(
			canonical({
				mediaId: "m1",
				styleProbe: { palette: "warm amber", setting: "sunlit kitchen" },
			}),
		);
		expect(styleProbeLookup("m1")).toEqual({
			palette: "warm amber",
			setting: "sunlit kitchen",
		});

		// An update with no probe drops the stale probe (never leaks a prior read).
		cacheUnderstanding(canonical({ mediaId: "m1" }));
		expect(styleProbeLookup("m1")).toBeUndefined();

		clearUnderstandingCache();
	});
});
