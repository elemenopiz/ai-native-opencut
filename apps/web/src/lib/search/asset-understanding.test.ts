import { describe, expect, it } from "bun:test";
import {
	type AssetUnderstanding,
	ASSET_ROLES,
	applyRoleSignal,
	buildUnderstandingUserBlocks,
	computeLumaGrid,
	degradedUnderstanding,
	effectiveRole,
	gridDiff,
	type LumaGrid,
	normalizeRole,
	parseAssetUnderstanding,
	type PersonaRef,
	pickShotRepresentatives,
	renderPersonaRoster,
	segmentShots,
} from "./asset-understanding";

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const ROSTER: PersonaRef[] = [
	{ id: "p_mara", name: "Mara", descriptor: "woman, early 30s, dark curls" },
	{ id: "p_founder", name: "The Founder" },
];

const CTX = (
	over: Partial<Parameters<typeof parseAssetUnderstanding>[1]> = {},
) =>
	({
		mediaId: "m1",
		imageCount: 4,
		personas: ROSTER,
		modelName: "vlm-test",
		now: 1000,
		...over,
	}) as Parameters<typeof parseAssetUnderstanding>[1];

describe("parseAssetUnderstanding — happy path", () => {
	it("parses caption, role+confidence, multi-frame tags, and a style probe", () => {
		const u = parseAssetUnderstanding(
			JSON.stringify({
				caption: "A founder demoing an app on a laptop in a sunlit office",
				role: "hero",
				roleConfidence: 0.82,
				tags: ["laptop", "office", "founder", "app demo", "daylight"],
				style: {
					palette: "warm neutral",
					lensMood: "shallow depth, cinematic",
					setting: "sunlit open-plan office",
				},
			}),
			CTX(),
		);
		expect(u.mediaId).toBe("m1");
		expect(u.caption).toContain("founder");
		expect(u.role).toBe("hero");
		expect(u.roleConfidence).toBeCloseTo(0.82, 5);
		expect(u.tags).toEqual([
			"laptop",
			"office",
			"founder",
			"app demo",
			"daylight",
		]);
		expect(u.styleProbe).toEqual({
			palette: "warm neutral",
			lensMood: "shallow depth, cinematic",
			setting: "sunlit open-plan office",
		});
		expect(u.faces).toEqual([]);
		expect(u.modelName).toBe("vlm-test");
		expect(u.createdAt).toBe(1000);
	});

	it("dedupes tags case-insensitively and drops blanks, preserving order", () => {
		const u = parseAssetUnderstanding(
			JSON.stringify({
				role: "b-roll",
				tags: ["Sky", "sky", "  ", "cloud", 7],
			}),
			CTX(),
		);
		expect(u.tags).toEqual(["Sky", "cloud"]);
	});

	it("normalizes every role synonym to a canonical AssetRole", () => {
		expect(normalizeRole("screen recording")).toBe("screen-rec");
		expect(normalizeRole("wordmark")).toBe("logo");
		expect(normalizeRole("product shot")).toBe("product");
		expect(normalizeRole("talking head")).toBe("face-anchor");
		expect(normalizeRole("hero shot")).toBe("hero");
		expect(normalizeRole("background filler")).toBe("b-roll");
		expect(normalizeRole("nonsense")).toBeNull();
		for (const r of ASSET_ROLES) expect(normalizeRole(r)).toBe(r);
	});
});

describe("parseAssetUnderstanding — face reconciliation against the roster", () => {
	it("matches a reported cast name to its persona id (not new)", () => {
		const u = parseAssetUnderstanding(
			JSON.stringify({
				role: "face-anchor",
				faces: [
					{
						persona: "mara", // case-insensitive match
						descriptor: "woman, early 30s, dark curls, silver hoops",
						anchorIndex: 2,
						confidence: 0.9,
					},
				],
			}),
			CTX(),
		);
		expect(u.faces).toHaveLength(1);
		expect(u.faces[0].personaMatch).toBe("p_mara");
		expect(u.faces[0].isNew).toBe(false);
		expect(u.faces[0].anchorFrame).toBe(2);
		expect(u.faces[0].score).toBeCloseTo(0.9, 5);
	});

	it("flags a described stranger as a NEW recurring face (never fabricates a match)", () => {
		const u = parseAssetUnderstanding(
			JSON.stringify({
				role: "b-roll",
				faces: [
					{ persona: "Someone Unknown", descriptor: "older man, grey beard" },
				],
			}),
			CTX(),
		);
		expect(u.faces).toHaveLength(1);
		expect(u.faces[0].personaMatch).toBeUndefined();
		expect(u.faces[0].isNew).toBe(true);
		expect(u.faces[0].descriptor).toContain("grey beard");
	});

	it("clamps a hallucinated anchorIndex into range and drops actionless faces", () => {
		const u = parseAssetUnderstanding(
			JSON.stringify({
				role: "b-roll",
				faces: [
					{ descriptor: "a person", anchorIndex: 99 }, // out of range → clamped
					{ persona: "", descriptor: "" }, // nothing actionable → dropped
					{ nonsense: true }, // dropped
				],
			}),
			CTX({ imageCount: 3 }),
		);
		expect(u.faces).toHaveLength(1);
		expect(u.faces[0].anchorFrame).toBe(2); // clamped to imageCount-1
	});
});

describe("parseAssetUnderstanding — FAILS SAFE (never fabricates)", () => {
	it("degrades on unparseable prose to b-roll @ 0, empty tags/faces", () => {
		const u = parseAssetUnderstanding("sorry, I can't see the frames", CTX());
		expect(u.role).toBe("b-roll");
		expect(u.roleConfidence).toBe(0);
		expect(u.caption).toBe("");
		expect(u.tags).toEqual([]);
		expect(u.faces).toEqual([]);
		expect(u.styleProbe).toBeUndefined();
	});

	it("degrades on malformed JSON", () => {
		const u = parseAssetUnderstanding(
			'{"role": hero, tags: [unquoted]}',
			CTX(),
		);
		expect(u.role).toBe("b-roll");
		expect(u.roleConfidence).toBe(0);
		expect(u.faces).toEqual([]);
	});

	it("keeps a parsed body but zeroes an UNKNOWN role rather than guessing", () => {
		const u = parseAssetUnderstanding(
			JSON.stringify({ role: "cinematic vibes", tags: ["neon"] }),
			CTX(),
		);
		expect(u.role).toBe("b-roll");
		expect(u.roleConfidence).toBe(0);
		expect(u.tags).toEqual(["neon"]); // the usable parts survive
	});

	it("clamps an out-of-range confidence and tolerates a fenced code block", () => {
		const u = parseAssetUnderstanding(
			"```json\n" +
				JSON.stringify({ role: "product", roleConfidence: 5 }) +
				"\n```",
			CTX(),
		);
		expect(u.role).toBe("product");
		expect(u.roleConfidence).toBe(1);
	});

	it("degradedUnderstanding is a valid, un-fabricated record", () => {
		const u = degradedUnderstanding({ mediaId: "x", modelName: "m", now: 5 });
		expect(u).toEqual({
			mediaId: "x",
			caption: "",
			role: "b-roll",
			roleConfidence: 0,
			tags: [],
			faces: [],
			modelName: "m",
			createdAt: 5,
		});
	});
});

describe("role as a BELIEF — applyRoleSignal / effectiveRole", () => {
	const base: AssetUnderstanding = {
		mediaId: "m1",
		caption: "",
		role: "b-roll",
		roleConfidence: 0.4,
		tags: [],
		faces: [],
		modelName: "m",
		createdAt: 0,
	};

	it("effectiveRole honors a human confirmation over the inferred role", () => {
		expect(effectiveRole(base)).toBe("b-roll");
		expect(effectiveRole({ ...base, roleConfirmed: "hero" })).toBe("hero");
	});

	it("an agreeing signal raises confidence toward 1 without changing the role", () => {
		const next = applyRoleSignal(
			{ ...base, role: "hero", roleConfidence: 0.4 },
			{
				role: "hero",
				weight: 0.5,
			},
		);
		expect(next.role).toBe("hero");
		expect(next.roleConfidence).toBeCloseTo(0.7, 5); // 0.4 + (1-0.4)*0.5
	});

	it("a strong disagreeing signal FLIPS the role (usage promotes to hero)", () => {
		// b-roll @ 0.4 decays to 0.4*(1-0.8)=0.08; weight 0.8 > 0.08 → flip.
		const next = applyRoleSignal(base, { role: "hero", weight: 0.8 });
		expect(next.role).toBe("hero");
		expect(next.roleConfidence).toBeCloseTo(0.8, 5);
	});

	it("a weak disagreeing signal only decays the current belief, no flip", () => {
		const next = applyRoleSignal(
			{ ...base, roleConfidence: 0.9 },
			{
				role: "hero",
				weight: 0.2,
			},
		);
		expect(next.role).toBe("b-roll");
		expect(next.roleConfidence).toBeCloseTo(0.72, 5); // 0.9*(1-0.2)
	});

	it("a human confirmation is ABSOLUTE — signals can't move it", () => {
		const confirmed = { ...base, roleConfirmed: "logo" as const };
		expect(applyRoleSignal(confirmed, { role: "hero", weight: 1 })).toBe(
			confirmed,
		);
	});

	it("a zero-weight signal is a no-op", () => {
		expect(applyRoleSignal(base, { role: "hero", weight: 0 })).toBe(base);
	});
});

describe("buildUnderstandingUserBlocks / renderPersonaRoster", () => {
	it("puts hint + known cast first, then each decodable frame as an image block", () => {
		const blocks = buildUnderstandingUserBlocks([PNG, PNG], {
			personas: ROSTER,
			hint: "importing product footage",
		});
		expect(blocks[0].type).toBe("text");
		const intro = (blocks[0] as { text: string }).text;
		expect(intro).toContain("importing product footage");
		expect(intro).toContain("KNOWN CAST");
		expect(intro).toContain("Mara — woman, early 30s, dark curls");
		expect(intro).toContain("2 frame(s)");
		expect(blocks.slice(1).every((b) => b.type === "image")).toBe(true);
		expect(blocks).toHaveLength(3);
	});

	it("silently drops frames that aren't decodable image data URLs", () => {
		const blocks = buildUnderstandingUserBlocks([PNG, "https://x/y.png"]);
		expect(blocks).toHaveLength(2); // text + one decodable image
		expect(blocks[1].type).toBe("image");
	});

	it("renders no roster block for an empty roster", () => {
		expect(renderPersonaRoster([])).toBe("");
		const blocks = buildUnderstandingUserBlocks([PNG], { personas: [] });
		expect((blocks[0] as { text: string }).text).not.toContain("KNOWN CAST");
	});
});

// ── shot-boundary detection (Palmier §1, reimplemented) ──────────────────────

/** Build fake RGBA pixel data of a solid grey level, for luma-grid tests. */
function solidImage(level: number, size = 8) {
	const data = new Uint8ClampedArray(size * size * 4);
	for (let i = 0; i < size * size; i++) {
		data[i * 4] = level;
		data[i * 4 + 1] = level;
		data[i * 4 + 2] = level;
		data[i * 4 + 3] = 255;
	}
	return { data, width: size, height: size };
}

describe("computeLumaGrid / gridDiff / segmentShots", () => {
	it("computes a normalized mean-luma fingerprint (solid image → uniform cells)", () => {
		const grid = computeLumaGrid(solidImage(255));
		expect(grid).toHaveLength(64);
		expect(grid.every((c) => Math.abs(c - 1) < 1e-6)).toBe(true);
		const black = computeLumaGrid(solidImage(0));
		expect(black.every((c) => c === 0)).toBe(true);
	});

	it("gridDiff is 0 for identical frames and ~1 for black vs white", () => {
		const white = computeLumaGrid(solidImage(255));
		const black = computeLumaGrid(solidImage(0));
		expect(gridDiff(white, white)).toBe(0);
		expect(gridDiff(white, black)).toBeCloseTo(1, 5);
	});

	it("segments a A-A-A-B-B sequence into two shots and picks one rep each", () => {
		const A: LumaGrid = new Array(64).fill(0.1);
		const B: LumaGrid = new Array(64).fill(0.9);
		const shots = segmentShots([A, A, A, B, B], { coverageFloor: 100 });
		expect(shots).toEqual([0, 0, 0, 1, 1]);
		expect(pickShotRepresentatives(shots)).toEqual([0, 3]);
	});

	it("the coverage floor forces a re-sample through a long static shot", () => {
		const A: LumaGrid = new Array(64).fill(0.5);
		// No visual change, but coverageFloor=2 must still cut periodically.
		const shots = segmentShots([A, A, A, A, A], { coverageFloor: 2 });
		expect(new Set(shots).size).toBeGreaterThan(1);
	});

	it("pickShotRepresentatives caps and spreads across many shots", () => {
		const shots = [0, 1, 2, 3, 4, 5, 6, 7]; // 8 shots
		const reps = pickShotRepresentatives(shots, 3);
		expect(reps.length).toBeLessThanOrEqual(3);
		expect(reps[0]).toBe(0);
	});
});
