import { describe, expect, it } from "bun:test";
import type { AssetTranscript } from "@/lib/search/asset-transcript";
import type { CraftBeatMarker } from "../craft";
import type { AssetBeatGrid } from "../asset-manifest";
import type { AssetTranscriptLookup } from "../transcript-lookup";
import { buildFootageInventory } from "./inventory";
import type { FootageInventory, InventoryMediaAsset, Treatment } from "./types";
import {
	BEAT_CUT_DOMINANCE_THRESHOLD,
	DEFAULT_SEGMENT_FIT_TOLERANCE_SEC,
	findAssemblyPlanInvariantViolations,
	isPendingElementRef,
	pendingElementRef,
	planAssembly,
	RADIO_CUT_SPEECH_SHARE_THRESHOLD,
	selectAssemblyStrategy,
	type SilenceRangesLookup,
} from "./assembly";

/**
 * SE-3 tests: `selectAssemblyStrategy` boundaries, both `planAssembly` paths
 * (radio-cut confident + its sequential fallback, beat-cut), determinism, and
 * the cross-cutting invariants. Fixtures build real `FootageInventory`s via
 * `buildFootageInventory` (SE-1, already tested in `inventory.test.ts`)
 * rather than hand-rolling one, so `speechShare`/`hasBeatGrid` stay faithful
 * to the real formula.
 */

function mediaAsset(
	id: string,
	kind: InventoryMediaAsset["kind"],
	durationSec: number,
): InventoryMediaAsset {
	return { id, kind, durationSec };
}

function transcript(
	segments: { start: number; end: number; text: string }[],
): AssetTranscript {
	return {
		mediaId: "unused",
		segments,
		language: "en",
		durationSec: 0,
		engine: "test",
		createdAt: 0,
	};
}

function lookupFrom<T>(
	byId: Record<string, T | undefined>,
): (id: string) => T | undefined {
	return (id: string) => byId[id];
}

function beatGrid(overrides: Partial<AssetBeatGrid> = {}): AssetBeatGrid {
	return { beatCount: 40, downbeatCount: 10, bpm: 120, ...overrides };
}

/**
 * The radio-cut path reads real transcript CONTENT via `opts.transcripts`
 * (the inventory itself only carries the boolean `hasTranscriptSegments`
 * flag) — this builds a `FootageInventory` and hands back the SAME
 * `AssetTranscriptLookup` so a test can pass it to both `buildFootageInventory`
 * (for the flag) and `planAssembly`'s `opts.transcripts` (for the content),
 * the same way SE-4 would wire the two together from one real store.
 */
function speechFixture(
	entries: Record<
		string,
		{
			durationSec: number;
			segments: { start: number; end: number; text: string }[];
		}
	>,
): { inventory: FootageInventory; transcripts: AssetTranscriptLookup } {
	const assets = Object.entries(entries).map(([id, e]) =>
		mediaAsset(id, "video", e.durationSec),
	);
	const byId: Record<string, AssetTranscript> = {};
	for (const [id, e] of Object.entries(entries))
		byId[id] = transcript(e.segments);
	const transcripts = lookupFrom(byId);
	const inventory = buildFootageInventory({ assets, transcripts });
	return { inventory, transcripts };
}

/** A section-free treatment builder — `sections` supplied per test. */
function treatmentOf(
	sections: Treatment["sections"],
	logline = "test treatment",
): Treatment {
	return { logline, sections };
}

describe("selectAssemblyStrategy", () => {
	it("speechShare exactly at the threshold ⇒ radio-cut (speech-dominant)", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("a", "video", 10), mediaAsset("b", "video", 10)],
			transcripts: lookupFrom({
				a: transcript([{ start: 0, end: 5, text: "hi" }]),
			}),
		});
		expect(inv.speechShare).toBe(0.5);
		expect(inv.speechShare).toBeGreaterThanOrEqual(
			RADIO_CUT_SPEECH_SHARE_THRESHOLD,
		);
		const decision = selectAssemblyStrategy(inv);
		expect(decision).toEqual({
			strategy: "radio-cut",
			basis: "speech-dominant",
			rationale: expect.stringContaining("speechShare"),
		});
	});

	it("speechShare just under threshold + beat-grid coverage at threshold ⇒ beat-cut", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("a", "video", 51), mediaAsset("b", "video", 49)],
			transcripts: lookupFrom({
				a: transcript([{ start: 0, end: 5, text: "hi" }]),
			}),
			beatGrid: lookupFrom({ b: beatGrid() }),
		});
		expect(inv.speechShare).toBeCloseTo(0.51, 5);
		// speechShare 0.51 is ABOVE the radio threshold here, so nudge it under
		// by using a 3rd non-speech asset to dilute — rebuild explicitly.
		const inv2 = buildFootageInventory({
			assets: [mediaAsset("a", "video", 49), mediaAsset("b", "video", 51)],
			transcripts: lookupFrom({
				a: transcript([{ start: 0, end: 5, text: "hi" }]),
			}),
			beatGrid: lookupFrom({ b: beatGrid() }),
		});
		expect(inv2.speechShare).toBeCloseTo(0.49, 5);
		const beatShare = 51 / 100;
		expect(beatShare).toBeGreaterThanOrEqual(BEAT_CUT_DOMINANCE_THRESHOLD);
		const decision = selectAssemblyStrategy(inv2);
		expect(decision.strategy).toBe("beat-cut");
		expect(decision.basis).toBe("beat-dominant");
	});

	it("neither signal strong ⇒ documented fallback (still radio-cut, basis fallback-sequential)", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("a", "video", 100)],
			// No transcript, no beat grid at all.
		});
		expect(inv.speechShare).toBe(0);
		const decision = selectAssemblyStrategy(inv);
		expect(decision).toEqual({
			strategy: "radio-cut",
			basis: "fallback-sequential",
			rationale: expect.stringContaining("fallback"),
		});
	});

	it("empty inventory ⇒ fallback (speechShare = 0 by definition, no beat coverage)", () => {
		const inv = buildFootageInventory({ assets: [] });
		const decision = selectAssemblyStrategy(inv);
		expect(decision.basis).toBe("fallback-sequential");
	});

	it("brief speech cue overrides a beat-dominant inventory", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("a", "video", 100)],
			beatGrid: lookupFrom({ a: beatGrid() }),
		});
		const decision = selectAssemblyStrategy(inv, {
			instruction: "cut together this podcast interview",
		});
		expect(decision).toEqual({
			strategy: "radio-cut",
			basis: "brief-speech",
			rationale: expect.stringContaining("brief mentions speech-led"),
		});
	});

	it("brief music cue overrides a speech-dominant inventory", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("a", "video", 100)],
			transcripts: lookupFrom({
				a: transcript([{ start: 0, end: 100, text: "lots of speech" }]),
			}),
		});
		const decision = selectAssemblyStrategy(inv, {
			instruction: "make me a music video montage",
		});
		expect(decision).toEqual({
			strategy: "beat-cut",
			basis: "brief-music",
			rationale: expect.stringContaining("brief mentions music/beat-led"),
		});
	});
});

describe("planAssembly — radio-cut (confident)", () => {
	function speechInventoryFixture() {
		return speechFixture({
			clipA: {
				durationSec: 30,
				segments: [
					{ start: 0, end: 10, text: "hello there" },
					{ start: 10, end: 20, text: "this is the middle" },
				],
			},
		});
	}

	it("exact fit: two adjacent segments sum exactly to targetSec", () => {
		const { inventory: inv, transcripts } = speechInventoryFixture();
		const treatment = treatmentOf([
			{ intent: "hook", targetSec: 20, materialRefs: ["clipA"], order: 0 },
		]);
		const result = planAssembly(treatment, inv, {
			forceStrategy: "radio-cut",
			transcripts,
		});

		expect(result.strategy).toBe("radio-cut");
		expect(result.markedGaps).toEqual([]);
		expect(result.projectedDurationSec).toBe(20);
		expect(result.sectionBreakdown).toEqual([
			{ intent: "hook", order: 0, targetSec: 20, projectedSec: 20, gap: false },
		]);

		// ops[0]/[1] = addClip for each segment; ops[2] = trim re-windowing the
		// SECOND segment onto [10,20) (its start > 0) via a pending ref to
		// ops[1]. The first segment starts at 0, so it needs no trim.
		expect(result.ops).toEqual([
			{
				verb: "addClip",
				args: { mediaId: "clipA", startTime: 0, duration: 10 },
			},
			{
				verb: "addClip",
				args: { mediaId: "clipA", startTime: 10, duration: 10 },
			},
			{
				verb: "trim",
				args: {
					slotId: pendingElementRef(1),
					trimStart: 10,
					trimEnd: 20,
					duration: 10,
				},
			},
		]);
		expect(findAssemblyPlanInvariantViolations(result, treatment, inv)).toEqual(
			[],
		);
	});

	it("overshoot: a single long segment is tail-capped to the target (min-duration respected)", () => {
		const { inventory: inv, transcripts } = speechFixture({
			clipB: {
				durationSec: 30,
				segments: [{ start: 5, end: 25, text: "a long take" }],
			},
		});
		const treatment = treatmentOf([
			{ intent: "b-roll", targetSec: 15, materialRefs: ["clipB"], order: 0 },
		]);
		const result = planAssembly(treatment, inv, {
			forceStrategy: "radio-cut",
			transcripts,
		});

		expect(result.ops).toEqual([
			{
				verb: "addClip",
				args: { mediaId: "clipB", startTime: 0, duration: 15 },
			},
			{
				verb: "trim",
				args: {
					slotId: pendingElementRef(0),
					trimStart: 5,
					trimEnd: 20,
					duration: 15,
				},
			},
		]);
		expect(result.projectedDurationSec).toBe(15);
		expect(findAssemblyPlanInvariantViolations(result, treatment, inv)).toEqual(
			[],
		);
	});

	it("undershoot preferred over a large overshoot (closest-fit)", () => {
		const { inventory: inv, transcripts } = speechFixture({
			clipC: {
				durationSec: 35,
				segments: [
					{ start: 0, end: 10, text: "one" },
					{ start: 10, end: 20, text: "two" },
					{ start: 20, end: 35, text: "three" },
				],
			},
		});
		const treatment = treatmentOf([
			{ intent: "demo", targetSec: 25, materialRefs: ["clipC"], order: 0 },
		]);
		const result = planAssembly(treatment, inv, {
			forceStrategy: "radio-cut",
			transcripts,
		});
		// |20-25|=5 vs |35-25|=10 → stop at 20, don't take the third segment.
		expect(result.projectedDurationSec).toBe(20);
		expect(result.ops.filter((o) => o.verb === "addClip")).toHaveLength(2);
	});

	it("no usable speech in materialRefs ⇒ MarkedGap, never invented material", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("silent", "video", 20)],
			transcripts: lookupFrom({ silent: transcript([]) }), // transcribed, silent
		});
		const treatment = treatmentOf([
			{ intent: "cta", targetSec: 10, materialRefs: ["silent"], order: 0 },
		]);
		const result = planAssembly(treatment, inv, { forceStrategy: "radio-cut" });

		expect(result.ops).toEqual([]);
		expect(result.markedGaps).toEqual([
			{
				startSec: 0,
				durationSec: 10,
				note: expect.stringContaining("no usable material"),
			},
		]);
		expect(result.sectionBreakdown).toEqual([
			{ intent: "cta", order: 0, targetSec: 10, projectedSec: 0, gap: true },
		]);
		expect(findAssemblyPlanInvariantViolations(result, treatment, inv)).toEqual(
			[],
		);
	});

	it("a materialRef dangling outside the inventory is skipped, not a crash", () => {
		const { inventory: inv, transcripts } = speechInventoryFixture();
		const treatment = treatmentOf([
			{
				intent: "hook",
				targetSec: 5,
				materialRefs: ["does-not-exist"],
				order: 0,
			},
		]);
		const result = planAssembly(treatment, inv, {
			forceStrategy: "radio-cut",
			transcripts,
		});
		expect(result.ops).toEqual([]);
		expect(result.markedGaps).toHaveLength(1);
	});

	it("filler/silence ranges exclude a fully-contained segment", () => {
		const transcripts = lookupFrom({
			clipD: transcript([
				{ start: 0, end: 5, text: "um uh filler" },
				{ start: 5, end: 15, text: "the real content" },
			]),
		});
		const inv = buildFootageInventory({
			assets: [mediaAsset("clipD", "video", 30)],
			transcripts,
			silenceMap: lookupFrom({ clipD: true }),
		});
		const silenceRanges: SilenceRangesLookup = lookupFrom({
			clipD: [{ start: 0, end: 5 }],
		});
		const treatment = treatmentOf([
			{ intent: "hook", targetSec: 10, materialRefs: ["clipD"], order: 0 },
		]);
		const result = planAssembly(treatment, inv, {
			forceStrategy: "radio-cut",
			transcripts,
			silenceRanges,
		});

		// Only the second segment [5,15) survives; it starts > 0 so it needs a trim.
		expect(result.ops).toEqual([
			{
				verb: "addClip",
				args: { mediaId: "clipD", startTime: 0, duration: 10 },
			},
			{
				verb: "trim",
				args: {
					slotId: pendingElementRef(0),
					trimStart: 5,
					trimEnd: 15,
					duration: 10,
				},
			},
		]);
	});

	it("filler ranges are ignored when the inventory doesn't flag hasSilenceMap for that asset", () => {
		const transcripts = lookupFrom({
			clipE: transcript([{ start: 0, end: 5, text: "um uh filler" }]),
		});
		const inv = buildFootageInventory({
			assets: [mediaAsset("clipE", "video", 30)],
			transcripts,
			// silenceMap lookup omitted ⇒ hasSilenceMap === false for clipE.
		});
		const silenceRanges: SilenceRangesLookup = lookupFrom({
			clipE: [{ start: 0, end: 5 }],
		});
		const treatment = treatmentOf([
			{ intent: "hook", targetSec: 5, materialRefs: ["clipE"], order: 0 },
		]);
		const result = planAssembly(treatment, inv, {
			forceStrategy: "radio-cut",
			transcripts,
			silenceRanges,
		});
		// hasSilenceMap is false, so the "filler" range is never consulted —
		// the segment is used.
		expect(result.ops).toEqual([
			{
				verb: "addClip",
				args: { mediaId: "clipE", startTime: 0, duration: 5 },
			},
		]);
	});

	it("multi-section treatment sequences sections back-to-back on the spine, respecting `order` (not array position)", () => {
		const transcripts = lookupFrom({
			clipF: transcript([
				{ start: 0, end: 10, text: "second beat" },
				{ start: 10, end: 20, text: "first beat" },
			]),
		});
		const inv = buildFootageInventory({
			assets: [mediaAsset("clipF", "video", 40)],
			transcripts,
		});
		// Sections given OUT of order; `order` decides sequencing.
		const treatment = treatmentOf([
			{ intent: "second", targetSec: 10, materialRefs: ["clipF"], order: 1 },
			{ intent: "first", targetSec: 10, materialRefs: ["clipF"], order: 0 },
		]);
		const result = planAssembly(treatment, inv, {
			forceStrategy: "radio-cut",
			transcripts,
		});
		expect(result.sectionBreakdown.map((b) => b.intent)).toEqual([
			"first",
			"second",
		]);
		expect(result.ops[0]).toEqual({
			verb: "addClip",
			args: { mediaId: "clipF", startTime: 0, duration: 10 },
		});
	});
});

describe("planAssembly — radio-cut fallback (simple sequential)", () => {
	it("lays whole clips back-to-back when neither speech nor beat signal is strong", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("v1", "video", 8), mediaAsset("v2", "video", 8)],
		});
		const decision = selectAssemblyStrategy(inv);
		expect(decision.basis).toBe("fallback-sequential");

		const treatment = treatmentOf([
			{
				intent: "montage",
				targetSec: 16,
				materialRefs: ["v1", "v2"],
				order: 0,
			},
		]);
		const result = planAssembly(treatment, inv);
		expect(result.strategy).toBe("radio-cut");
		expect(result.ops).toEqual([
			{ verb: "addClip", args: { mediaId: "v1", startTime: 0, duration: 8 } },
			{ verb: "addClip", args: { mediaId: "v2", startTime: 8, duration: 8 } },
		]);
		expect(result.projectedDurationSec).toBe(16);
		expect(findAssemblyPlanInvariantViolations(result, treatment, inv)).toEqual(
			[],
		);
	});

	it("audio-kind assets are never placed (addClip has no audio-placement verb)", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("podcast", "audio", 30)],
		});
		const treatment = treatmentOf([
			{
				intent: "montage",
				targetSec: 10,
				materialRefs: ["podcast"],
				order: 0,
			},
		]);
		const result = planAssembly(treatment, inv);
		expect(result.ops).toEqual([]);
		expect(result.markedGaps).toHaveLength(1);
	});
});

describe("planAssembly — beat-cut", () => {
	function beatInventory(): FootageInventory {
		return buildFootageInventory({
			assets: [
				mediaAsset("shotA", "video", 30),
				mediaAsset("shotB", "video", 30),
			],
			beatGrid: lookupFrom({ shotA: beatGrid() }),
		});
	}

	it("allocates one shot per beat-grid subdivision and snaps joins via cutOnBeat", () => {
		const inv = beatInventory();
		const treatment = treatmentOf([
			{
				intent: "energy",
				targetSec: 6,
				materialRefs: ["shotA", "shotB"],
				order: 0,
			},
		]);
		// Beats at 2s and 4s ⇒ 3 subdivisions inside (0,6): [0,2) [2,4) [4,6).
		const beats: CraftBeatMarker[] = [
			{ time: 2, isDownbeat: true },
			{ time: 4, isDownbeat: false },
		];
		const result = planAssembly(treatment, inv, {
			forceStrategy: "beat-cut",
			beats,
		});

		const addClipOps = result.ops.filter((o) => o.verb === "addClip");
		expect(addClipOps).toHaveLength(3);
		expect(addClipOps.map((o) => o.args.duration)).toEqual([2, 2, 2]);
		// Round-robins shotA/shotB/shotA — real footage reused, never invented.
		expect(addClipOps.map((o) => o.args.mediaId)).toEqual([
			"shotA",
			"shotB",
			"shotA",
		]);
		expect(result.projectedDurationSec).toBe(6);
		expect(findAssemblyPlanInvariantViolations(result, treatment, inv)).toEqual(
			[],
		);
	});

	it("clamps the shot count so no shot falls below the min-clip-duration floor", () => {
		const inv = beatInventory();
		const treatment = treatmentOf([
			{
				intent: "quick",
				targetSec: 1,
				materialRefs: ["shotA", "shotB"],
				order: 0,
			},
		]);
		// Without clamping, 4 beats inside a 1s span would demand 5 shots of
		// 0.2s each — below the 0.5s floor. Clamped to 1s / 0.5s = 2 shots.
		const beats: CraftBeatMarker[] = [
			{ time: 0.2, isDownbeat: true },
			{ time: 0.4, isDownbeat: false },
			{ time: 0.6, isDownbeat: true },
			{ time: 0.8, isDownbeat: false },
		];
		const result = planAssembly(treatment, inv, {
			forceStrategy: "beat-cut",
			beats,
		});
		const addClipOps = result.ops.filter((o) => o.verb === "addClip");
		expect(addClipOps).toHaveLength(2);
		expect(addClipOps.every((o) => (o.args.duration as number) >= 0.5)).toBe(
			true,
		);
	});

	it("degrades gracefully to evenly-split sequential shots when no beat grid is injected", () => {
		const inv = beatInventory();
		const treatment = treatmentOf([
			{
				intent: "b-roll",
				targetSec: 6,
				materialRefs: ["shotA", "shotB"],
				order: 0,
			},
		]);
		const result = planAssembly(treatment, inv, { forceStrategy: "beat-cut" }); // no opts.beats
		const addClipOps = result.ops.filter((o) => o.verb === "addClip");
		expect(addClipOps.length).toBeGreaterThan(0);
		expect(result.ops.some((o) => o.verb === "trim")).toBe(false); // no cutOnBeat pass without a beat grid
		expect(findAssemblyPlanInvariantViolations(result, treatment, inv)).toEqual(
			[],
		);
	});

	it("no placeable materialRefs ⇒ MarkedGap", () => {
		const inv = beatInventory();
		const treatment = treatmentOf([
			{ intent: "empty", targetSec: 5, materialRefs: [], order: 0 },
		]);
		const result = planAssembly(treatment, inv, { forceStrategy: "beat-cut" });
		expect(result.ops).toEqual([]);
		expect(result.markedGaps).toHaveLength(1);
	});
});

describe("planAssembly — determinism", () => {
	it("radio-cut: identical input twice ⇒ deep-equal output", () => {
		const transcripts = lookupFrom({
			x: transcript([
				{ start: 0, end: 8, text: "one" },
				{ start: 8, end: 16, text: "two" },
			]),
		});
		const inv = buildFootageInventory({
			assets: [mediaAsset("x", "video", 20)],
			transcripts,
		});
		const treatment = treatmentOf([
			{ intent: "hook", targetSec: 16, materialRefs: ["x"], order: 0 },
		]);
		const r1 = planAssembly(treatment, inv, {
			forceStrategy: "radio-cut",
			transcripts,
		});
		const r2 = planAssembly(treatment, inv, {
			forceStrategy: "radio-cut",
			transcripts,
		});
		expect(r1).toEqual(r2);
	});

	it("beat-cut: identical input twice ⇒ deep-equal output", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("x", "video", 20), mediaAsset("y", "video", 20)],
			beatGrid: lookupFrom({ x: beatGrid() }),
		});
		const treatment = treatmentOf([
			{ intent: "energy", targetSec: 8, materialRefs: ["x", "y"], order: 0 },
		]);
		const beats: CraftBeatMarker[] = [
			{ time: 2, isDownbeat: true },
			{ time: 5, isDownbeat: false },
		];
		const r1 = planAssembly(treatment, inv, {
			forceStrategy: "beat-cut",
			beats,
		});
		const r2 = planAssembly(treatment, inv, {
			forceStrategy: "beat-cut",
			beats,
		});
		expect(r1).toEqual(r2);
	});
});

describe("empty treatment", () => {
	it("empty sections ⇒ empty plan + note", () => {
		const inv = buildFootageInventory({ assets: [] });
		const treatment = treatmentOf([]);
		const result = planAssembly(treatment, inv);
		expect(result.ops).toEqual([]);
		expect(result.markedGaps).toEqual([]);
		expect(result.projectedDurationSec).toBe(0);
		expect(result.sectionBreakdown).toEqual([]);
		expect(result.note).toBe("empty treatment — no sections to assemble");
		expect(findAssemblyPlanInvariantViolations(result, treatment, inv)).toEqual(
			[],
		);
	});
});

describe("cross-cutting invariants (findAssemblyPlanInvariantViolations)", () => {
	it("flags an addClip whose mediaId isn't in the inventory", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("a", "video", 10)],
		});
		const treatment = treatmentOf([
			{ intent: "hook", targetSec: 5, materialRefs: ["a"], order: 0 },
		]);
		const bad = {
			strategy: "radio-cut" as const,
			ops: [
				{
					verb: "addClip",
					args: { mediaId: "ghost-asset", startTime: 0, duration: 5 },
				},
			],
			markedGaps: [],
			projectedDurationSec: 5,
			sectionBreakdown: [
				{ intent: "hook", order: 0, targetSec: 5, projectedSec: 5, gap: false },
			],
			strategyRationale: "test",
		};
		const violations = findAssemblyPlanInvariantViolations(bad, treatment, inv);
		expect(violations.some((v) => v.includes("ghost-asset"))).toBe(true);
	});

	it("flags a trim that references a slotId which isn't an earlier addClip's pending ref", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("a", "video", 10)],
		});
		const treatment = treatmentOf([
			{ intent: "hook", targetSec: 5, materialRefs: ["a"], order: 0 },
		]);
		const bad = {
			strategy: "radio-cut" as const,
			ops: [
				{ verb: "addClip", args: { mediaId: "a", startTime: 0, duration: 5 } },
				{
					verb: "trim",
					args: { slotId: "some-real-timeline-id", trimStart: 1 },
				},
			],
			markedGaps: [],
			projectedDurationSec: 5,
			sectionBreakdown: [
				{ intent: "hook", order: 0, targetSec: 5, projectedSec: 5, gap: false },
			],
			strategyRationale: "test",
		};
		const violations = findAssemblyPlanInvariantViolations(bad, treatment, inv);
		expect(violations.some((v) => v.includes("non-pending-ref slotId"))).toBe(
			true,
		);
	});

	it("flags two trims touching the same element", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("a", "video", 10)],
		});
		const treatment = treatmentOf([
			{ intent: "hook", targetSec: 5, materialRefs: ["a"], order: 0 },
		]);
		const ref = pendingElementRef(0);
		const bad = {
			strategy: "radio-cut" as const,
			ops: [
				{ verb: "addClip", args: { mediaId: "a", startTime: 0, duration: 5 } },
				{ verb: "trim", args: { slotId: ref, trimEnd: 4 } },
				{ verb: "trim", args: { slotId: ref, trimEnd: 3 } },
			],
			markedGaps: [],
			projectedDurationSec: 5,
			sectionBreakdown: [
				{ intent: "hook", order: 0, targetSec: 5, projectedSec: 5, gap: false },
			],
			strategyRationale: "test",
		};
		const violations = findAssemblyPlanInvariantViolations(bad, treatment, inv);
		expect(violations.some((v) => v.includes("must be merged"))).toBe(true);
	});

	it("flags a duration drift beyond tolerance with no shortfall note", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("a", "video", 10)],
		});
		const treatment = treatmentOf([
			{ intent: "hook", targetSec: 50, materialRefs: ["a"], order: 0 },
		]);
		const bad = {
			strategy: "radio-cut" as const,
			ops: [],
			markedGaps: [],
			projectedDurationSec: 5, // way off from targetSec 50, no note attached
			sectionBreakdown: [
				{
					intent: "hook",
					order: 0,
					targetSec: 50,
					projectedSec: 5,
					gap: false,
				},
			],
			strategyRationale: "test",
		};
		const violations = findAssemblyPlanInvariantViolations(bad, treatment, inv);
		expect(violations.some((v) => v.includes("drifts"))).toBe(true);
	});

	it("does not flag a duration drift when the plan carries a shortfall note", () => {
		const inv = buildFootageInventory({
			assets: [mediaAsset("a", "video", 10)],
		});
		const treatment = treatmentOf([
			{ intent: "hook", targetSec: 50, materialRefs: ["a"], order: 0 },
		]);
		const ok = {
			strategy: "radio-cut" as const,
			ops: [],
			markedGaps: [
				{ startSec: 0, durationSec: 50, note: "no usable material" },
			],
			projectedDurationSec: 0,
			sectionBreakdown: [
				{ intent: "hook", order: 0, targetSec: 50, projectedSec: 0, gap: true },
			],
			strategyRationale: "test",
			note: "shortfall: 50s not covered",
		};
		const violations = findAssemblyPlanInvariantViolations(ok, treatment, inv);
		expect(violations.some((v) => v.includes("drifts"))).toBe(false);
	});

	it("isPendingElementRef distinguishes plan-local refs from real ids", () => {
		expect(isPendingElementRef(pendingElementRef(0))).toBe(true);
		expect(isPendingElementRef(pendingElementRef(3))).toBe(true);
		expect(isPendingElementRef("el_abc123")).toBe(false);
		expect(isPendingElementRef(undefined)).toBe(false);
	});
});

describe("options", () => {
	it("DEFAULT_SEGMENT_FIT_TOLERANCE_SEC is exported and used as the default", () => {
		expect(DEFAULT_SEGMENT_FIT_TOLERANCE_SEC).toBeGreaterThan(0);
	});
});
