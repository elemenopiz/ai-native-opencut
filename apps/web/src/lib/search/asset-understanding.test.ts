import { describe, expect, it } from "bun:test";
import {
	type AssetUnderstanding,
	ASSET_ROLES,
	ASSET_UNDERSTANDING_RESPONSE_SCHEMA,
	ASSET_UNDERSTANDING_SYSTEM_PROMPT,
	anchorFrameTime,
	applyRoleSignal,
	chooseUnderstandingFrames,
	findTranscriptCues,
	type FrameCandidate,
	type FrameReason,
	summarizeShots,
	classifyAudioEnergy,
	buildUnderstandingGeminiParts,
	buildUnderstandingUserBlocks,
	computeLumaGrid,
	configuredUnderstandingModel,
	dataUrlToInlineDataPart,
	degradedUnderstanding,
	effectiveRole,
	estimateMotion,
	geminiUnderstandAsset,
	gridDiff,
	isCreditGateError,
	isDeepUnderstanding,
	isGeminiModel,
	type LumaGrid,
	MOTION_CLASSES,
	type MotionSample,
	normalizeMotion,
	normalizeRole,
	normalizeShotType,
	parseAssetUnderstanding,
	type PersonaRef,
	pickShotRepresentatives,
	relayUnderstandAsset,
	SHOT_DIFF_THRESHOLD,
	renderPersonaRoster,
	segmentShots,
	selectUnderstandAssetFn,
	SHOT_TYPES,
	UnderstandingRelayError,
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

describe("parseAssetUnderstanding — deepened perception (Bet 1)", () => {
	it("parses shotType/composition/emotion/continuity when present", () => {
		const u = parseAssetUnderstanding(
			JSON.stringify({
				caption: "founder pacing while talking",
				role: "face-anchor",
				roleConfidence: 0.7,
				tags: ["founder"],
				shotType: "medium",
				composition: {
					subjectPosition: "center",
					headroom: "normal",
					ruleOfThirds: true,
				},
				emotion: "energetic",
				continuity: {
					lighting: "soft key, warm backlight",
					whiteBalance: "warm/tungsten",
					wardrobe: "navy blazer",
					colorSignature: "warm amber grade",
				},
			}),
			CTX(),
		);
		expect(u.shotType).toBe("medium");
		expect(u.composition).toEqual({
			subjectPosition: "center",
			headroom: "normal",
			ruleOfThirds: true,
		});
		expect(u.emotion).toBe("energetic");
		expect(u.continuityFingerprint).toEqual({
			lighting: "soft key, warm backlight",
			whiteBalance: "warm/tungsten",
			wardrobe: "navy blazer",
			colorSignature: "warm amber grade",
		});
		expect(isDeepUnderstanding(u)).toBe(true);
	});

	it("DROPS motion/audio even when the model volunteers them — it has no evidence for either", () => {
		const u = parseAssetUnderstanding(
			JSON.stringify({
				caption: "founder pacing while talking",
				role: "face-anchor",
				roleConfidence: 0.7,
				tags: ["founder"],
				shotType: "medium",
				// A model that ignores the prompt and emits these anyway: the frames
				// are stills seconds apart and carry no audio, so both are invention.
				// The parser is the gate that keeps them out of the record.
				motion: "handheld",
				audio: { hasSpeech: true, energy: "high" },
			}),
			CTX(),
		);
		expect(u.motion).toBeUndefined();
		expect(u.audio).toBeUndefined();
		// The facets it CAN see still land.
		expect(u.shotType).toBe("medium");
		expect(u.caption).toBe("founder pacing while talking");
	});

	it("neither motion nor audio appears in the extraction prompt", () => {
		const prompt = ASSET_UNDERSTANDING_SYSTEM_PROMPT;
		expect(prompt).not.toContain('"motion"');
		expect(prompt).not.toContain('"audio"');
		expect(prompt).not.toContain("hasSpeech");
		// And the forcing instruction that caused the fabrication is gone.
		expect(prompt).not.toContain("never omit these two");
		expect(prompt).toContain("Do NOT report camera motion");
	});

	it("degrades silently: a reply with none of the deep fields omits them all, isDeepUnderstanding false", () => {
		const u = parseAssetUnderstanding(
			JSON.stringify({ role: "b-roll", tags: ["sky"] }),
			CTX(),
		);
		expect(u.motion).toBeUndefined();
		expect(u.shotType).toBeUndefined();
		expect(u.composition).toBeUndefined();
		expect(u.emotion).toBeUndefined();
		expect(u.audio).toBeUndefined();
		expect(u.continuityFingerprint).toBeUndefined();
		expect(isDeepUnderstanding(u)).toBe(false);
	});

	it("a SHALLOW old-shape record (no new fields, e.g. from before this widening) round-trips through JSON and isDeepUnderstanding", () => {
		const shallow: AssetUnderstanding = {
			mediaId: "m1",
			caption: "product on marble",
			role: "product",
			roleConfidence: 0.6,
			tags: ["product", "marble"],
			faces: [],
			modelName: "vlm-v1",
			createdAt: 42,
		};
		const roundTripped = JSON.parse(
			JSON.stringify(shallow),
		) as AssetUnderstanding;
		expect(roundTripped).toEqual(shallow);
		expect(isDeepUnderstanding(roundTripped)).toBe(false);
	});

	it("normalizeMotion collapses the legacy four-class vocabulary onto the measured three", () => {
		// The READ-path migration for records already in the schema-less store:
		// `pan` and `handheld` were the pair the frames could never distinguish.
		expect(normalizeMotion("pan")).toBe("moving");
		expect(normalizeMotion("handheld")).toBe("moving");
		expect(normalizeMotion("shaky cam")).toBe("moving");
		expect(normalizeMotion("slow dolly")).toBe("moving");
		expect(normalizeMotion("locked off tripod")).toBe("static");
		expect(normalizeMotion("whip pan cuts")).toBe("fast-cut");
		expect(normalizeMotion("nonsense")).toBeNull();
		expect(normalizeMotion(undefined)).toBeNull();
		for (const m of MOTION_CLASSES) expect(normalizeMotion(m)).toBe(m);
	});

	it("normalizes shot-type synonyms (ECU before CU, insert, medium, wide/establishing)", () => {
		expect(normalizeShotType("extreme close up on the eyes")).toBe(
			"extreme-close-up",
		);
		expect(normalizeShotType("tight close-up")).toBe("close-up");
		expect(normalizeShotType("product detail shot")).toBe("insert");
		expect(normalizeShotType("mid shot")).toBe("medium");
		expect(normalizeShotType("establishing wide")).toBe("wide");
		expect(normalizeShotType("nonsense")).toBeNull();
		for (const s of SHOT_TYPES) expect(normalizeShotType(s)).toBe(s);
	});

	it("shotType is REQUIRED in the Gemini response schema (the isDeepUnderstanding signal)", () => {
		expect(ASSET_UNDERSTANDING_RESPONSE_SCHEMA.required).toContain("shotType");
		expect(
			ASSET_UNDERSTANDING_RESPONSE_SCHEMA.properties.shotType.enum,
		).toEqual([...SHOT_TYPES]);
	});

	it("motion/audio are absent from the Gemini schema ENTIRELY, not merely optional", () => {
		// A structured-output schema is an instruction: listing a field the model
		// has no evidence for is how the fabrication started, so neither key
		// appears as a property, in `required`, or in `propertyOrdering`.
		const schema = ASSET_UNDERSTANDING_RESPONSE_SCHEMA;
		const props = Object.keys(schema.properties);
		expect(props).not.toContain("motion");
		expect(props).not.toContain("audio");
		expect([...schema.required]).not.toContain("motion");
		expect([...schema.required]).not.toContain("audio");
		expect([...schema.propertyOrdering]).not.toContain("motion");
		expect([...schema.propertyOrdering]).not.toContain("audio");
	});
});

describe("estimateMotion — measured from the luma fingerprints", () => {
	/** A flat grid at a uniform luma, so diffs between two are exactly predictable. */
	const flat = (luma: number): LumaGrid => new Array(64).fill(luma);

	const samples = (lumas: number[], intervalSec = 2): MotionSample[] =>
		lumas.map((luma, i) => ({
			grid: flat(luma),
			timestampSec: i * intervalSec,
		}));

	it("returns null for fewer than two frames — a still image has no motion to measure", () => {
		expect(estimateMotion([])).toBeNull();
		expect(estimateMotion(samples([0.5]))).toBeNull();
	});

	it("a locked-off framing reads static", () => {
		// Consecutive fingerprints barely move: below MOTION_STATIC_DIFF.
		expect(estimateMotion(samples([0.5, 0.505, 0.5, 0.503, 0.5]))).toBe(
			"static",
		);
	});

	it("a framing that drifts between samples reads moving", () => {
		// Well above the static line, well below the cut line.
		expect(estimateMotion(samples([0.5, 0.55, 0.6, 0.65, 0.7]))).toBe("moving");
	});

	it("cut after cut at a dense cadence reads fast-cut", () => {
		// Each step exceeds SHOT_DIFF_THRESHOLD, so every pair is a cut.
		const step = SHOT_DIFF_THRESHOLD + 0.1;
		const lumas = [0, step, 0, step, 0, step];
		expect(estimateMotion(samples(lumas, 2))).toBe("fast-cut");
	});

	it("does NOT call fast-cut when the sampler was too sparse to tell a fast edit from a slow one", () => {
		// The same all-cuts pattern, but sampled 12 s apart (what a long video
		// gets): ordinary footage looks like this, so the honest answer is null.
		const step = SHOT_DIFF_THRESHOLD + 0.1;
		expect(estimateMotion(samples([0, step, 0, step, 0, step], 12))).toBeNull();
	});

	it("one stray cut does not make a clip fast-cut", () => {
		const lumas = [0.5, 0.5, 0.5, 0.5, SHOT_DIFF_THRESHOLD + 0.7];
		expect(estimateMotion(samples(lumas))).toBe("static");
	});
});

describe("classifyAudioEnergy — banded from a real loudness curve", () => {
	it("returns null for an empty curve (absent, never a default)", () => {
		expect(classifyAudioEnergy([])).toBeNull();
		expect(classifyAudioEnergy(new Float32Array(0))).toBeNull();
	});

	it("digital silence is a real measurement: low", () => {
		expect(classifyAudioEnergy(new Float32Array(100))).toBe("low");
	});

	it("bands a hot, a conversational and a near-silent curve", () => {
		// ~-1.9 dBFS, ~-20 dBFS, ~-46 dBFS.
		expect(classifyAudioEnergy(new Array(50).fill(0.8))).toBe("high");
		expect(classifyAudioEnergy(new Array(50).fill(0.1))).toBe("medium");
		expect(classifyAudioEnergy(new Array(50).fill(0.005))).toBe("low");
	});

	it("ignores non-finite samples instead of poisoning the RMS", () => {
		expect(
			classifyAudioEnergy([0.8, Number.NaN, 0.8, Number.POSITIVE_INFINITY]),
		).toBe("high");
		expect(classifyAudioEnergy([Number.NaN])).toBeNull();
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

// ── model config + seam selection (NEXT_PUBLIC_UNDERSTANDING_MODEL) ──────────

/**
 * Run `fn` with NEXT_PUBLIC_UNDERSTANDING_MODEL set (or deleted for undefined),
 * restoring the previous value afterwards. The config is read PER CALL, so a
 * plain env assignment is enough — no module-reload tricks (the known bun-test
 * env-mock gotcha).
 */
async function withEnvModel<T>(
	value: string | undefined,
	fn: () => T | Promise<T>,
): Promise<T> {
	const prev = process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL;
	if (value === undefined) delete process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL;
	else process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL = value;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL;
		else process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL = prev;
	}
}

/**
 * Stub `globalThis.fetch` for the duration of `fn`, restoring the ORIGINAL by
 * direct reassignment (mock.restore does not undo property assignment — the
 * known global-fetch-leak gotcha).
 */
async function withFetchStub<T>(
	stub: typeof fetch,
	fn: () => T | Promise<T>,
): Promise<T> {
	const real = globalThis.fetch;
	globalThis.fetch = stub;
	try {
		return await fn();
	} finally {
		globalThis.fetch = real;
	}
}

/** A minimal OK Anthropic-relay response whose text is a parseable record. */
function anthropicOkResponse(): Response {
	return new Response(
		JSON.stringify({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						caption: "a clip",
						role: "b-roll",
						roleConfidence: 0.5,
						tags: ["clip"],
					}),
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/** A minimal OK NATIVE-Gemini response (raw generateContent shape). */
function geminiOkResponse(): Response {
	return new Response(
		JSON.stringify({
			candidates: [
				{
					content: {
						parts: [
							{
								text: JSON.stringify({
									caption: "a gemini-read clip",
									role: "hero",
									roleConfidence: 0.7,
									tags: ["clip"],
								}),
							},
						],
					},
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("configuredUnderstandingModel / isGeminiModel / selectUnderstandAssetFn", () => {
	it("reads the env per call: unset/blank → undefined, value → trimmed", async () => {
		await withEnvModel(undefined, () => {
			expect(configuredUnderstandingModel()).toBeUndefined();
		});
		await withEnvModel("   ", () => {
			expect(configuredUnderstandingModel()).toBeUndefined();
		});
		await withEnvModel(" gemini-3.5-flash ", () => {
			expect(configuredUnderstandingModel()).toBe("gemini-3.5-flash");
		});
	});

	it("classifies gemini-* models and routes them to the native seam", () => {
		expect(isGeminiModel("gemini-3.5-flash")).toBe(true);
		expect(isGeminiModel("Gemini-3.5-Pro")).toBe(true);
		expect(isGeminiModel("vlm-v1")).toBe(false);
		expect(isGeminiModel(undefined)).toBe(false);
		expect(selectUnderstandAssetFn("gemini-3.5-flash")).toBe(
			geminiUnderstandAsset,
		);
		expect(selectUnderstandAssetFn("vlm-v1")).toBe(relayUnderstandAsset);
		expect(selectUnderstandAssetFn("claude-opus-4-8")).toBe(
			relayUnderstandAsset,
		);
	});
});

describe("relayUnderstandAsset — request body vs. the model config", () => {
	const RELAY_CTX = {
		mediaId: "m1",
		personas: ROSTER,
		modelName: "vlm-v1",
	};

	it("default config: sends NO model field (byte-identical to today) and records ctx.modelName", async () => {
		let captured: { url: string; body: Record<string, unknown> } | null = null;
		const stub = (async (url: unknown, init?: RequestInit) => {
			captured = {
				url: String(url),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			};
			return anthropicOkResponse();
		}) as typeof fetch;

		const u = await withEnvModel(undefined, () =>
			withFetchStub(stub, () => relayUnderstandAsset([PNG], RELAY_CTX)),
		);
		expect(captured!.url).toBe("/api/llm/agent");
		expect("model" in captured!.body).toBe(false);
		expect(Object.keys(captured!.body).sort()).toEqual([
			"messages",
			"stream",
			"system",
			"tools",
		]);
		expect(u.modelName).toBe("vlm-v1");
		expect(u.caption).toBe("a clip");
	});

	it("a configured NON-gemini model rides the body as `model`", async () => {
		let captured: Record<string, unknown> | null = null;
		const stub = (async (_url: unknown, init?: RequestInit) => {
			captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return anthropicOkResponse();
		}) as typeof fetch;

		await withEnvModel("claude-haiku-4-5", () =>
			withFetchStub(stub, () =>
				relayUnderstandAsset([PNG], {
					...RELAY_CTX,
					modelName: "claude-haiku-4-5",
				}),
			),
		);
		expect(captured!.model).toBe("claude-haiku-4-5");
	});
});

describe("geminiUnderstandAsset — the native seam", () => {
	const GEMINI_CTX = {
		mediaId: "m1",
		personas: ROSTER,
		modelName: "gemini-3.5-flash",
		hint: "brand reel",
	};

	it("posts a Gemini-native body (inlineData parts + responseSchema) and records the model honestly", async () => {
		let captured: { url: string; body: Record<string, unknown> } | null = null;
		const stub = (async (url: unknown, init?: RequestInit) => {
			captured = {
				url: String(url),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			};
			return geminiOkResponse();
		}) as typeof fetch;

		const u = await withFetchStub(stub, () =>
			geminiUnderstandAsset([PNG, "not-a-data-url"], GEMINI_CTX),
		);

		expect(captured!.url).toBe("/api/llm/gemini");
		expect(captured!.body.model).toBe("gemini-3.5-flash");

		// contents: ONE user turn — intro text part, then the decodable frame as
		// inlineData (the junk frame silently dropped).
		const contents = captured!.body.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;
		expect(contents).toHaveLength(1);
		expect(contents[0].role).toBe("user");
		const parts = contents[0].parts;
		expect(parts).toHaveLength(2);
		expect(String(parts[0].text)).toContain("HINT (what the user is doing)");
		expect(String(parts[0].text)).toContain("KNOWN CAST");
		expect(parts[1].inlineData).toEqual({
			mimeType: "image/png",
			data: PNG.slice("data:image/png;base64,".length),
		});

		// System prompt rides as systemInstruction; structured output is native.
		const sys = captured!.body.systemInstruction as {
			parts: Array<{ text: string }>;
		};
		expect(sys.parts[0].text).toContain("ingest EYE");
		const gen = captured!.body.generationConfig as Record<string, unknown>;
		expect(gen.responseMimeType).toBe("application/json");
		expect(gen.responseSchema).toEqual(ASSET_UNDERSTANDING_RESPONSE_SCHEMA);

		// The requested model IS the stored modelName (invalidation honesty).
		expect(u.modelName).toBe("gemini-3.5-flash");
		expect(u.mediaId).toBe("m1");
		expect(u.role).toBe("hero");
		expect(u.caption).toBe("a gemini-read clip");
	});

	it("a 402 throws an UnderstandingRelayError whose un-consumed response feeds the credit gate", async () => {
		const stub = (async () =>
			new Response(
				JSON.stringify({ error: "insufficient_credits", needed: 5 }),
				{ status: 402 },
			)) as unknown as typeof fetch;

		const err = await withFetchStub(stub, () =>
			geminiUnderstandAsset([PNG], GEMINI_CTX).then(
				() => null,
				(e: unknown) => e,
			),
		);
		expect(err).toBeInstanceOf(UnderstandingRelayError);
		expect(isCreditGateError(err)).toBe(true);
		// gateOn402 needs the ORIGINAL body still readable.
		const body = await (err as UnderstandingRelayError).response.clone().json();
		expect(body).toEqual({ error: "insufficient_credits", needed: 5 });
	});

	it("an unusable Gemini reply fails safe to a degraded record (never throws on parse)", async () => {
		const stub = (async () =>
			new Response(JSON.stringify({ candidates: [] }), {
				status: 200,
			})) as unknown as typeof fetch;
		const u = await withFetchStub(stub, () =>
			geminiUnderstandAsset([PNG], GEMINI_CTX),
		);
		expect(u.role).toBe("b-roll");
		expect(u.roleConfidence).toBe(0);
		expect(u.modelName).toBe("gemini-3.5-flash");
	});
});

describe("buildUnderstandingGeminiParts / dataUrlToInlineDataPart", () => {
	it("mirrors the Anthropic builder's intro and frame order", () => {
		const parts = buildUnderstandingGeminiParts([PNG, PNG], {
			personas: ROSTER,
			hint: "demo",
		});
		const blocks = buildUnderstandingUserBlocks([PNG, PNG], {
			personas: ROSTER,
			hint: "demo",
		});
		// Identical intro text (one shared helper — the dialects can't drift).
		expect((parts[0] as { text: string }).text).toBe(
			(blocks[0] as { text: string }).text,
		);
		expect(parts).toHaveLength(3); // intro + 2 frames
	});

	it("normalizes image/jpg → image/jpeg and rejects non-image data URLs", () => {
		expect(
			dataUrlToInlineDataPart("data:image/jpg;base64,AAAA")?.inlineData
				.mimeType,
		).toBe("image/jpeg");
		expect(dataUrlToInlineDataPart("data:text/plain;base64,AAAA")).toBeNull();
		expect(dataUrlToInlineDataPart("https://example.com/a.png")).toBeNull();
	});
});

describe("summarizeShots — cuts, not coverage-floor segments", () => {
	const flat = (luma: number): LumaGrid => new Array(64).fill(luma);
	const samples = (lumas: number[], intervalSec = 2): MotionSample[] =>
		lumas.map((luma, i) => ({
			grid: flat(luma),
			timestampSec: i * intervalSec,
		}));

	it("returns null under two samples — a still image has no shot structure", () => {
		expect(summarizeShots([])).toBeNull();
		expect(summarizeShots(samples([0.5]))).toBeNull();
	});

	it("a long locked-off take is ONE shot, however many samples it spans", () => {
		// THE regression this function exists to prevent: segmentShots advances
		// its index every SHOT_COVERAGE_FLOOR frames so a static take still gets
		// re-sampled, so reading a shot count off it would report this 20-sample
		// interview as six "shots".
		const s = summarizeShots(samples(new Array(20).fill(0.5)));
		expect(s?.count).toBe(1);
		expect(s?.cutsAtSec).toEqual([]);
		expect(
			segmentShots(samples(new Array(20).fill(0.5)).map((x) => x.grid)).at(-1),
		).toBeGreaterThan(0); // the floor DID fire — and summarizeShots ignored it
	});

	it("counts real cuts and reports when each happened", () => {
		const step = SHOT_DIFF_THRESHOLD + 0.2;
		// luma: 0,0,step,step,0 → cuts entering index 2 (t=4) and index 4 (t=8).
		const s = summarizeShots(samples([0, 0, step, step, 0]));
		expect(s?.count).toBe(3);
		expect(s?.cutsAtSec).toEqual([4, 8]);
	});

	it("mean shot length divides the sampled span by the shot count", () => {
		const step = SHOT_DIFF_THRESHOLD + 0.2;
		const s = summarizeShots(samples([0, step], 2)); // span 2 s, 2 shots
		expect(s?.meanShotSec).toBe(1);
	});

	it("flags a sparse sampling cadence instead of pretending the count is exact", () => {
		const step = SHOT_DIFF_THRESHOLD + 0.2;
		expect(summarizeShots(samples([0, step, 0], 2))?.sparse).toBe(false);
		expect(summarizeShots(samples([0, step, 0], 12))?.sparse).toBe(true);
	});
});

describe("anchorFrameTime — resolving a face's anchor to a real timestamp", () => {
	const base = (): AssetUnderstanding => ({
		mediaId: "m1",
		caption: "c",
		role: "face-anchor",
		roleConfidence: 0.8,
		tags: [],
		faces: [],
		modelName: "vlm-v2",
		createdAt: 1,
	});

	it("maps the anchor index through framesSeen", () => {
		const u: AssetUnderstanding = {
			...base(),
			framesSeen: [
				{ t: 1, reason: "shot" },
				{ t: 4.5, reason: "transcript-cue" },
				{ t: 9, reason: "shot" },
			],
		};
		expect(
			anchorFrameTime(u, { score: 0.9, isNew: true, anchorFrame: 1 }),
		).toBe(4.5);
	});

	it("returns undefined — never 0 — when the anchor can't be resolved", () => {
		// 0 is a real timestamp ("the first frame"), so a miss must be distinct
		// from it or callers will seed a persona lock from the wrong frame.
		const withFrames: AssetUnderstanding = {
			...base(),
			framesSeen: [{ t: 3, reason: "shot" }],
		};
		const face = { score: 0.9, isNew: true };
		expect(anchorFrameTime(withFrames, face)).toBeUndefined(); // no anchor
		expect(
			anchorFrameTime(withFrames, { ...face, anchorFrame: 5 }),
		).toBeUndefined();
		expect(
			anchorFrameTime(withFrames, { ...face, anchorFrame: -1 }),
		).toBeUndefined();
		// A record written before frame provenance existed.
		expect(
			anchorFrameTime(base(), { ...face, anchorFrame: 0 }),
		).toBeUndefined();
	});
});

describe("findTranscriptCues — frames the speaker asks for", () => {
	const seg = (
		start: number,
		end: number,
		text: string,
		words?: { word: string; start: number; end: number }[],
	) => ({ start, end, text, ...(words ? { words } : {}) });

	it("returns nothing for an empty transcript", () => {
		expect(findTranscriptCues([])).toEqual([]);
	});

	it("anchors to the END of the cue phrase's last word when words are timed", () => {
		const words = [
			{ word: "now", start: 10, end: 10.3 },
			{ word: "look", start: 10.3, end: 10.6 },
			{ word: "at", start: 10.6, end: 10.7 },
			{ word: "this", start: 10.7, end: 11.0 },
			{ word: "chart", start: 11.0, end: 11.4 },
		];
		const cues = findTranscriptCues(
			[seg(10, 11.4, "now look at this chart", words)],
			{ leadSec: 0.4 },
		);
		// "look at this" ends at 11.0; +0.4 lead lands on the reveal, not the setup.
		expect(cues).toEqual([{ t: 11.4, phrase: "look at this" }]);
	});

	it("falls back to the segment start when the engine gave no word timings", () => {
		// Interpolating a position inside the sentence would be invented
		// precision; a whole-segment anchor is a worse frame, not a wrong claim.
		const cues = findTranscriptCues([seg(30, 34, "as you can see the total")], {
			leadSec: 0.4,
		});
		expect(cues).toEqual([{ t: 30.4, phrase: "as you can see" }]);
	});

	it("ignores rhetorical uses that point at nothing on screen", () => {
		expect(
			findTranscriptCues([
				seg(0, 3, "look, the point is that nobody reads it"),
				seg(4, 7, "I see what you mean about the pricing"),
				seg(8, 11, "we should watch the competition closely"),
			]),
		).toEqual([]);
	});

	it("collapses cues that describe one moment", () => {
		const cues = findTranscriptCues(
			[seg(0, 2, "look at this"), seg(2, 4, "notice how it moves")],
			{ minGapSec: 5 },
		);
		expect(cues).toHaveLength(1);
	});

	it("subsamples EVENLY over the asset rather than truncating the first few", () => {
		const segs = Array.from({ length: 12 }, (_, i) =>
			seg(i * 10, i * 10 + 3, "look at this"),
		);
		const cues = findTranscriptCues(segs, { maxCues: 3 });
		expect(cues).toHaveLength(3);
		// Spread across the whole asset, not clustered at the head.
		expect(cues[2].t).toBeGreaterThan(60);
	});

	it("clamps a cue that the lead would push past the end of the asset", () => {
		const cues = findTranscriptCues([seg(9.9, 10, "look at this")], {
			durationSec: 10,
			leadSec: 0.4,
		});
		expect(cues[0].t).toBeLessThan(10);
	});

	it("respects a zero budget", () => {
		expect(
			findTranscriptCues([seg(0, 2, "look at this")], { maxCues: 0 }),
		).toEqual([]);
	});
});

describe("chooseUnderstandingFrames — cues are pinned, coverage gets the rest", () => {
	const flat = (luma: number): LumaGrid => new Array(64).fill(luma);
	const cand = (
		timestampSec: number,
		luma: number,
		reason: FrameReason = "shot",
	): FrameCandidate => ({ timestampSec, grid: flat(luma), reason });

	it("keeps a cue frame that the visual selector would never pick", () => {
		// A locked-off talking head: every uniform sample is identical, so shot
		// selection has no reason to reach frame 5. The cue is why it's there.
		const candidates = [
			...[0, 2, 4, 6, 8, 10, 12, 14, 16, 18].map((t) => cand(t, 0.5)),
			cand(9.3, 0.5, "transcript-cue"),
		];
		const picked = chooseUnderstandingFrames(candidates, 8);
		const times = picked.map((i) => candidates[i].timestampSec);
		expect(times).toContain(9.3);
		expect(times).toEqual([...times].sort((a, b) => a - b)); // time order
	});

	it("never exceeds the budget, and never spends all of it on cues", () => {
		const candidates = [
			...[0, 2, 4, 6, 8, 10].map((t) => cand(t, 0.5)),
			...[1, 3, 5, 7, 9, 11, 13].map((t) => cand(t, 0.5, "transcript-cue")),
		];
		const picked = chooseUnderstandingFrames(candidates, 4);
		expect(picked.length).toBeLessThanOrEqual(4);
		// At least one non-cue frame survives: the model still has to be able to
		// say what the asset IS, not just what was pointed at.
		expect(picked.some((i) => candidates[i].reason !== "transcript-cue")).toBe(
			true,
		);
	});

	it("a cue's off-grid timestamp cannot invent a shot boundary", () => {
		// Shot structure is read from the uniform candidates only, so adding a cue
		// must not change which uniform frames are chosen.
		const step = SHOT_DIFF_THRESHOLD + 0.2;
		const uniform = [
			cand(0, 0),
			cand(2, 0),
			cand(4, step),
			cand(6, step),
			cand(8, 0),
		];
		const withoutCue = chooseUnderstandingFrames(uniform, 8).map(
			(i) => uniform[i].timestampSec,
		);
		const withCue = [...uniform, cand(5.1, step, "transcript-cue")];
		const after = chooseUnderstandingFrames(withCue, 8)
			.map((i) => withCue[i])
			.filter((c) => c.reason !== "transcript-cue")
			.map((c) => c.timestampSec);
		expect(after).toEqual(withoutCue);
	});

	it("degenerate inputs stay degenerate", () => {
		expect(chooseUnderstandingFrames([], 8)).toEqual([]);
		expect(chooseUnderstandingFrames([cand(0, 0.5)], 8)).toEqual([0]);
		expect(chooseUnderstandingFrames([cand(0, 0.5), cand(2, 0.5)], 0)).toEqual(
			[],
		);
	});
});
