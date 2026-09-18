import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { createDirectorApi } from "./director-api";
import {
	buildEditCritiqueUserBlocks,
	type CutScoreInput,
	DEFAULT_HOOK_WINDOW_SEC,
	detectVisualGaps,
	EDIT_CRITIQUE_AXES,
	formatBeatGridSummary,
	formatCutScoreSummary,
	formatGapsNote,
	formatMixReadSummary,
	formatTranscriptExcerpt,
	MAX_EDIT_CRITIC_FRAMES,
	MAX_EDIT_CRITIQUE_ISSUES,
	parseEditCritique,
	planFrameSamples,
	type SamplableElement,
} from "./edit-critic";
import type { MixRead } from "./mix-read";
import { editCriticEnabled, toolCatalog } from "./tool-catalog";

// ── planFrameSamples ─────────────────────────────────────────────────────────

/** Build N sequential 2s video elements starting at t=0, back to back. */
function sequentialVideoElements(
	count: number,
	durationSec = 2,
): SamplableElement[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `el${i}`,
		kind: "video" as const,
		startSec: i * durationSec,
		durationSec,
		mediaId: `media${i}`,
		label: `Clip ${i}`,
	}));
}

describe("planFrameSamples", () => {
	it("returns one sample per element when under the cap", () => {
		const els = sequentialVideoElements(5);
		const plan = planFrameSamples(els);
		expect(plan).toHaveLength(5);
		expect(plan.map((p) => p.elementId)).toEqual([
			"el0",
			"el1",
			"el2",
			"el3",
			"el4",
		]);
	});

	it("never exceeds MAX_EDIT_CRITIC_FRAMES even with far more elements", () => {
		const els = sequentialVideoElements(40);
		const plan = planFrameSamples(els);
		expect(plan.length).toBeLessThanOrEqual(MAX_EDIT_CRITIC_FRAMES);
		expect(plan.length).toBe(MAX_EDIT_CRITIC_FRAMES);
	});

	it("clamps a caller-supplied maxFrames above the hard cap", () => {
		const els = sequentialVideoElements(40);
		const plan = planFrameSamples(els, { maxFrames: 999 });
		expect(plan.length).toBeLessThanOrEqual(MAX_EDIT_CRITIC_FRAMES);
	});

	it("respects a caller-supplied maxFrames below the hard cap", () => {
		const els = sequentialVideoElements(40);
		const plan = planFrameSamples(els, { maxFrames: 4 });
		expect(plan).toHaveLength(4);
	});

	it("always keeps every element that starts within the hook window", () => {
		// 4 short elements packed into the first 3s (hook window), plus 20 more
		// after it — the hook elements must all survive the cap.
		const hookEls: SamplableElement[] = [
			{ id: "h0", kind: "video", startSec: 0, durationSec: 0.75 },
			{ id: "h1", kind: "video", startSec: 0.75, durationSec: 0.75 },
			{ id: "h2", kind: "video", startSec: 1.5, durationSec: 0.75 },
			{ id: "h3", kind: "video", startSec: 2.25, durationSec: 0.75 },
		];
		const restEls = sequentialVideoElements(20, 2).map((e, i) => ({
			...e,
			id: `r${i}`,
			startSec: 3 + i * 2,
		}));
		const plan = planFrameSamples([...hookEls, ...restEls]);
		const ids = plan.map((p) => p.elementId);
		for (const h of hookEls) expect(ids).toContain(h.id);
		expect(plan.length).toBe(MAX_EDIT_CRITIC_FRAMES);
	});

	it("spreads the remaining budget across the whole rest of the timeline, not just the start", () => {
		const els = sequentialVideoElements(24, 2); // spans 0..48s
		const plan = planFrameSamples(els);
		const lastAt = plan[plan.length - 1].atSec;
		// The picks should reach well into the back half of the timeline, not
		// cluster only near t=0.
		expect(lastAt).toBeGreaterThan(30);
	});

	it("returns results sorted by timeline position", () => {
		const els = sequentialVideoElements(10);
		const plan = planFrameSamples(els);
		const secs = plan.map((p) => p.atSec);
		expect([...secs].sort((a, b) => a - b)).toEqual(secs);
	});

	it("ignores non-visual elements (text/audio) entirely", () => {
		const els: SamplableElement[] = [
			{ id: "v0", kind: "video", startSec: 0, durationSec: 2, mediaId: "m0" },
			{ id: "t0", kind: "text", startSec: 0, durationSec: 2 },
			{ id: "a0", kind: "audio", startSec: 0, durationSec: 2 },
		];
		const plan = planFrameSamples(els);
		expect(plan).toHaveLength(1);
		expect(plan[0].elementId).toBe("v0");
	});

	it("drops zero/invalid-duration elements", () => {
		const els: SamplableElement[] = [
			{ id: "v0", kind: "video", startSec: 0, durationSec: 0 },
			{ id: "v1", kind: "video", startSec: 2, durationSec: Number.NaN },
			{ id: "v2", kind: "video", startSec: 4, durationSec: 2 },
		];
		const plan = planFrameSamples(els);
		expect(plan).toHaveLength(1);
		expect(plan[0].elementId).toBe("v2");
	});

	it("returns [] for an empty timeline", () => {
		expect(planFrameSamples([])).toEqual([]);
	});

	it("samples a hook-window element toward its own start, not its midpoint", () => {
		const els: SamplableElement[] = [
			{ id: "h0", kind: "video", startSec: 0, durationSec: 3 },
		];
		const plan = planFrameSamples(els, {
			hookWindowSec: DEFAULT_HOOK_WINDOW_SEC,
		});
		// hookWindowSec(3) - startSec(0) = 3, clamped to durationSec(3); /2 = 1.5.
		expect(plan[0].atSec).toBeCloseTo(1.5, 5);
	});

	it("samples a post-hook element at its own midpoint", () => {
		const els: SamplableElement[] = [
			{ id: "r0", kind: "video", startSec: 10, durationSec: 4 },
		];
		const plan = planFrameSamples(els);
		expect(plan[0].atSec).toBeCloseTo(12, 5);
	});
});

// ── detectVisualGaps ──────────────────────────────────────────────────────────

describe("detectVisualGaps", () => {
	it("finds no gaps for back-to-back coverage", () => {
		const els = [
			{ kind: "video" as const, startSec: 0, durationSec: 5 },
			{ kind: "video" as const, startSec: 5, durationSec: 5 },
		];
		expect(detectVisualGaps(els, 10)).toEqual([]);
	});

	it("finds a gap between two clips", () => {
		const els = [
			{ kind: "video" as const, startSec: 0, durationSec: 5 },
			{ kind: "video" as const, startSec: 7, durationSec: 3 },
		];
		expect(detectVisualGaps(els, 10)).toEqual([
			{ startSec: 5, durationSec: 2 },
		]);
	});

	it("finds a trailing gap when coverage ends before the timeline does", () => {
		const els = [{ kind: "video" as const, startSec: 0, durationSec: 5 }];
		expect(detectVisualGaps(els, 8)).toEqual([{ startSec: 5, durationSec: 3 }]);
	});

	it("drops gaps shorter than minGapSec as noise", () => {
		const els = [
			{ kind: "video" as const, startSec: 0, durationSec: 5 },
			{ kind: "video" as const, startSec: 5.1, durationSec: 3 },
		];
		expect(detectVisualGaps(els, 8, 0.5)).toEqual([]);
	});

	it("treats an overlapping second-track clip as filling a gap", () => {
		const els = [
			{ kind: "video" as const, startSec: 0, durationSec: 5 },
			{ kind: "video" as const, startSec: 4, durationSec: 6 }, // second track, overlaps + extends coverage
		];
		expect(detectVisualGaps(els, 10)).toEqual([]);
	});

	it("ignores non-visual elements when computing coverage", () => {
		const els = [
			{ kind: "video" as const, startSec: 0, durationSec: 3 },
			{ kind: "audio" as const, startSec: 3, durationSec: 5 }, // audio doesn't fill a visual gap
		];
		expect(detectVisualGaps(els, 8)).toEqual([{ startSec: 3, durationSec: 5 }]);
	});
});

describe("formatGapsNote", () => {
	it("renders nothing for no gaps", () => {
		expect(formatGapsNote([])).toBe("");
	});

	it("renders a compact clause for gaps", () => {
		expect(formatGapsNote([{ startSec: 5, durationSec: 2 }])).toBe(
			"GAPS (no visual coverage): 0:05–0:07.",
		);
	});
});

// ── formatBeatGridSummary ─────────────────────────────────────────────────────

describe("formatBeatGridSummary", () => {
	it("renders nothing for undefined", () => {
		expect(formatBeatGridSummary(undefined)).toBe("");
	});

	it("renders a full clause", () => {
		expect(
			formatBeatGridSummary({
				bpm: 128,
				beatCount: 64,
				downbeatCount: 16,
				energyClass: "energetic",
				assetName: "song.mp3",
			}),
		).toBe(
			'BEAT GRID: 128bpm, 64 beats/16 downbeats, energetic (from "song.mp3").',
		);
	});

	it("degrades gracefully with only some facts present", () => {
		expect(formatBeatGridSummary({ bpm: 90 })).toBe("BEAT GRID: 90bpm.");
	});
});

// ── formatTranscriptExcerpt ───────────────────────────────────────────────────

describe("formatTranscriptExcerpt", () => {
	it("renders nothing for no segments", () => {
		expect(formatTranscriptExcerpt([])).toBe("");
	});

	it("renders timestamped lines", () => {
		expect(
			formatTranscriptExcerpt([
				{ startSec: 0, endSec: 2, text: "Hey everyone." },
				{ startSec: 2, endSec: 5, text: "Welcome back." },
			]),
		).toBe("TRANSCRIPT: 0:00 Hey everyone. 0:02 Welcome back.");
	});

	it("caps at the given limit and marks truncation", () => {
		const segments = Array.from({ length: 5 }, (_, i) => ({
			startSec: i,
			endSec: i + 1,
			text: `seg${i}`,
		}));
		const out = formatTranscriptExcerpt(segments, { limit: 2 });
		expect(out).toBe("TRANSCRIPT: 0:00 seg0 0:01 seg1 …");
	});
});

// ── formatMixReadSummary ──────────────────────────────────────────────────────

function makeMixRead(overrides: Partial<MixRead> = {}): MixRead {
	return {
		loudnessCurve: [],
		loudnessSampleIntervalSec: 0.5,
		integratedLoudness: {
			integrated: -16,
			shortTerm: -15,
			momentary: -12,
			truePeak: -1,
			range: 6,
		},
		overlaps: [],
		deadAir: [],
		...overrides,
	};
}

describe("formatMixReadSummary", () => {
	it("renders nothing for undefined", () => {
		expect(formatMixReadSummary(undefined)).toBe("");
	});

	it("always renders the integrated loudness headline", () => {
		expect(formatMixReadSummary(makeMixRead())).toBe(
			"MIX: integrated -16 LUFS-style (short-term -15, range 6LU).",
		);
	});

	it("flags overlaps whose competingDb clears the threshold", () => {
		const out = formatMixReadSummary(
			makeMixRead({
				overlaps: [
					{
						musicElementId: "m1",
						startSec: 5,
						endSec: 8,
						durationSec: 3,
						avgLevelDb: -10,
						musicBaselineDb: -20,
						competingDb: 8, // well above the default threshold
					},
					{
						musicElementId: "m1",
						startSec: 20,
						endSec: 22,
						durationSec: 2,
						avgLevelDb: -18,
						musicBaselineDb: -20,
						competingDb: 0.5, // below the default threshold — not flagged
					},
				],
			}),
		);
		expect(out).toContain("music competing with speech");
		expect(out).toContain("0:05–0:08");
		expect(out).toContain("+8.0dB over its own duck target");
		expect(out).not.toContain("0:20–0:22");
	});

	it("renders dead-air stretches", () => {
		const out = formatMixReadSummary(
			makeMixRead({
				deadAir: [{ startSec: 12, endSec: 14, durationSec: 2 }],
			}),
		);
		expect(out).toContain("audio dead air: 0:12–0:14");
	});
});

// ── formatCutScoreSummary ────────────────────────────────────────────────────

describe("formatCutScoreSummary", () => {
	it("renders nothing for undefined", () => {
		expect(formatCutScoreSummary(undefined)).toBe("");
	});

	it("renders per-axis scores and an overall figure — Higgsfield brain_activity shape", () => {
		const score: CutScoreInput = {
			source: "higgsfield-brain-activity",
			axes: {
				hook: { composite: 82 },
				attention: { composite: 71 },
				retention: { composite: 65 },
			},
			overall: 74,
		};
		expect(formatCutScoreSummary(score)).toBe(
			"CUT SCORE (higgsfield-brain-activity): hook 82, attention 71, retention 65 (overall 74).",
		);
	});

	it("renders the local engagement scorer's shape, grade included", () => {
		const score: CutScoreInput = {
			source: "local-engagement-scorer",
			axes: {
				hook: { composite: 60 },
				curiosity: { composite: 55 },
				energy: { composite: 70 },
			},
			overall: 62,
			grade: "B",
		};
		const out = formatCutScoreSummary(score);
		expect(out).toContain("CUT SCORE (local-engagement-scorer):");
		expect(out).toContain("hook 60, curiosity 55, energy 70");
		expect(out).toContain("(overall 62, B)");
	});

	it("degrades gracefully with no per-axis scores", () => {
		expect(formatCutScoreSummary({ source: "unknown", axes: {} })).toBe(
			"CUT SCORE (unknown): no per-axis scores.",
		);
	});
});

// ── buildEditCritiqueUserBlocks ───────────────────────────────────────────────

describe("buildEditCritiqueUserBlocks", () => {
	const IMG = "data:image/jpeg;base64,AAAA";

	it("folds digest + grounding + frames into content blocks", () => {
		const blocks = buildEditCritiqueUserBlocks({
			digest: "TIMELINE: 1 track · 2 clips · 0:10 total.",
			gapsNote: "GAPS (no visual coverage): 0:05–0:07.",
			beatGridSummary: "BEAT GRID: 120bpm.",
			transcriptExcerpt: "TRANSCRIPT: 0:00 hi.",
			frames: [
				{ dataUrl: IMG, atSec: 0.5, label: "Clip 0" },
				{ dataUrl: IMG, atSec: 6, label: "Clip 1" },
			],
		});
		expect(blocks[0]).toMatchObject({ type: "text" });
		const introText = (blocks[0] as { text: string }).text;
		expect(introText).toContain("TIMELINE:");
		expect(introText).toContain("GAPS (no visual coverage)");
		expect(introText).toContain("BEAT GRID: 120bpm.");
		expect(introText).toContain("TRANSCRIPT: 0:00 hi.");
		// intro + (marker+image) * 2 frames
		expect(blocks).toHaveLength(1 + 2 * 2);
		expect(blocks[1]).toMatchObject({
			type: "text",
			text: "Frame @ 0.5s (Clip 0):",
		});
		expect(blocks[2]).toMatchObject({ type: "image" });
	});

	it("drops undecodable frames silently", () => {
		const blocks = buildEditCritiqueUserBlocks({
			digest: "TIMELINE: empty.",
			frames: [{ dataUrl: "not-a-data-url", atSec: 1 }],
		});
		expect(blocks).toHaveLength(1); // only the intro text block
	});

	it("omits absent grounding lines instead of rendering empty clauses", () => {
		const blocks = buildEditCritiqueUserBlocks({
			digest: "TIMELINE: empty.",
			frames: [],
		});
		const introText = (blocks[0] as { text: string }).text;
		expect(introText).not.toContain("GAPS");
		expect(introText).not.toContain("BEAT GRID");
		expect(introText).not.toContain("TRANSCRIPT");
	});
});

// ── parseEditCritique ─────────────────────────────────────────────────────────

describe("parseEditCritique", () => {
	it("parses a well-formed critique with issues", () => {
		const text = JSON.stringify({
			summary: "Strong open, drags in the middle.",
			issues: [
				{
					axis: "hook",
					severity: "high",
					location: { sec: 0.5, elementRef: "el0" },
					note: "The strongest shot is buried at 0:08.",
					proposedFix: {
						verb: "move",
						args: { slotId: "el3", newStartTime: 0 },
					},
				},
				{
					axis: "dead-air",
					severity: "low",
					location: { sec: 22 },
					note: "2s silent gap.",
				},
			],
		});
		const critique = parseEditCritique(text);
		expect(critique.summary).toBe("Strong open, drags in the middle.");
		expect(critique.issues).toHaveLength(2);
		expect(critique.issues[0]).toEqual({
			axis: "hook",
			severity: "high",
			location: { sec: 0.5, elementRef: "el0" },
			note: "The strongest shot is buried at 0:08.",
			proposedFix: { verb: "move", args: { slotId: "el3", newStartTime: 0 } },
		});
		expect(critique.issues[1]).toEqual({
			axis: "dead-air",
			severity: "low",
			location: { sec: 22 },
			note: "2s silent gap.",
		});
	});

	it("parses a clean critique with an empty issues array", () => {
		const critique = parseEditCritique(
			'{"summary":"Well-paced, nothing to flag.","issues":[]}',
		);
		expect(critique).toEqual({
			summary: "Well-paced, nothing to flag.",
			issues: [],
		});
	});

	it("fails safe to empty issues when there is no JSON at all", () => {
		const critique = parseEditCritique("I dunno, looks fine I guess.");
		expect(critique.issues).toEqual([]);
		expect(critique.summary.length).toBeGreaterThan(0);
	});

	it("fails safe on malformed JSON", () => {
		const critique = parseEditCritique('{"summary": "oops", "issues": [');
		expect(critique.issues).toEqual([]);
	});

	it("extracts JSON from a fenced code block", () => {
		const critique = parseEditCritique(
			'Here you go:\n```json\n{"summary":"ok","issues":[]}\n```',
		);
		expect(critique.summary).toBe("ok");
	});

	it("drops individual malformed issues without failing the whole parse", () => {
		const text = JSON.stringify({
			summary: "Mixed bag.",
			issues: [
				{ axis: "not-a-real-axis", severity: "high", note: "bad axis" },
				{
					axis: "pacing",
					severity: "not-a-real-severity",
					note: "bad severity",
				},
				{ axis: "pacing", severity: "low", note: "" }, // empty note
				{ axis: "pacing", severity: "low" }, // missing note entirely
				{ axis: "pacing", severity: "med", note: "this one is fine" },
			],
		});
		const critique = parseEditCritique(text);
		expect(critique.issues).toHaveLength(1);
		expect(critique.issues[0].note).toBe("this one is fine");
	});

	it("drops a proposedFix with no verb but keeps the issue", () => {
		const text = JSON.stringify({
			summary: "x",
			issues: [
				{
					axis: "variety",
					severity: "med",
					location: {},
					note: "shots 3 and 4 are near-identical",
					proposedFix: { args: { foo: "bar" } }, // no verb
				},
			],
		});
		const critique = parseEditCritique(text);
		expect(critique.issues).toHaveLength(1);
		expect(critique.issues[0].proposedFix).toBeUndefined();
	});

	it("defaults proposedFix.args to {} when args is missing or not an object", () => {
		const text = JSON.stringify({
			summary: "x",
			issues: [
				{
					axis: "arc",
					severity: "low",
					location: {},
					note: "flat arc",
					proposedFix: { verb: "reorder" },
				},
			],
		});
		const critique = parseEditCritique(text);
		expect(critique.issues[0].proposedFix).toEqual({
			verb: "reorder",
			args: {},
		});
	});

	it("caps issues at MAX_EDIT_CRITIQUE_ISSUES even when the model returns more", () => {
		const issues = Array.from(
			{ length: MAX_EDIT_CRITIQUE_ISSUES + 15 },
			(_, i) => ({
				axis: "pacing",
				severity: "low",
				location: { sec: i },
				note: `issue ${i}`,
			}),
		);
		const critique = parseEditCritique(
			JSON.stringify({ summary: "many issues", issues }),
		);
		expect(critique.issues).toHaveLength(MAX_EDIT_CRITIQUE_ISSUES);
	});

	it("ignores a non-array issues field", () => {
		const critique = parseEditCritique(
			'{"summary":"x","issues":"not an array"}',
		);
		expect(critique.issues).toEqual([]);
	});

	it("covers every documented axis", () => {
		expect(EDIT_CRITIQUE_AXES).toEqual([
			"pacing",
			"hook",
			"variety",
			"rhythm",
			"dead-air",
			"continuity",
			"arc",
		]);
	});
});

// ── flag gate (Step-0 revision #2: flag-gated, default OFF) ─────────────────

describe("editCriticEnabled (critiqueEdit feature gate)", () => {
	it("is OFF when the value is undefined (unset — default)", () => {
		expect(editCriticEnabled(undefined)).toBe(false);
	});

	it('is OFF for any non-"true" value', () => {
		expect(editCriticEnabled("false")).toBe(false);
		expect(editCriticEnabled("1")).toBe(false);
		expect(editCriticEnabled("TRUE")).toBe(false);
	});

	it('is ON only for the exact string "true"', () => {
		expect(editCriticEnabled("true")).toBe(true);
	});
});

describe("toolCatalog — critiqueEdit registration is flag-gated", () => {
	it("is ABSENT from the catalog with the flag off (current/default env) — zero behavior change", () => {
		const names = toolCatalog().map((t) => t.name);
		expect(names).not.toContain("critiqueEdit");
	});
});

// ── critiqueEdit end-to-end (DirectorApi verb; mocked relay, no paid calls) ──
//
// The tool-catalog flag only gates whether the TOOL is exposed to the agent/
// MCP; the underlying DirectorApi verb (what a catalog-dispatched call would
// actually invoke — see tool-catalog.ts's `handler: (d) => d.critiqueEdit()`)
// is always present. These tests exercise that verb directly with an injected
// mock relay + frame decoder — the "flag ON" path, without a live model call
// or a module-level env-var flip (NEXT_PUBLIC_* flags are inlined at import
// time, so toggling them per-test isn't reliable across a shared test run;
// see feature-flags.test.ts for the same convention on the sibling flags).

interface FakeAsset {
	id: string;
	name: string;
	type: string;
	file?: File;
	url?: string;
}

/** Minimal in-memory `EditorCore` stub, extending `director-timeline.test.ts`'s `makeEditor` with asset `type`/`file`/`url` (needed for frame decode). */
function makeEditor(
	tracks: Array<{
		id: string;
		type: string;
		elements: Array<Record<string, unknown>>;
	}>,
	assets: FakeAsset[] = [],
	totalDuration = 0,
): EditorCore {
	return {
		timeline: {
			getTotalDuration: () => totalDuration,
			getTracks: () => tracks,
		},
		command: new CommandManager(),
		media: {
			getAssetById: (id: string) => assets.find((a) => a.id === id),
			getAssets: () => assets,
		},
		project: {
			getActiveOrNull: () => null,
		},
	} as unknown as EditorCore;
}

const TWO_CLIP_TRACKS = [
	{
		id: "track_video",
		type: "video",
		elements: [
			{
				id: "el_a",
				type: "video",
				name: "clip-a.mp4",
				mediaId: "m1",
				startTime: 0,
				duration: 4,
				trimStart: 0,
				trimEnd: 0,
			},
			{
				id: "el_b",
				type: "video",
				name: "clip-b.mp4",
				mediaId: "m2",
				startTime: 4,
				duration: 4,
				trimStart: 0,
				trimEnd: 0,
			},
		],
	},
];
const TWO_CLIP_ASSETS: FakeAsset[] = [
	{ id: "m1", name: "clip-a.mp4", type: "video", url: "blob:clip-a" },
	{ id: "m2", name: "clip-b.mp4", type: "video", url: "blob:clip-b" },
];

const FAKE_FRAME = {
	dataUrl: "data:image/jpeg;base64,AAAA",
	width: 100,
	height: 100,
};

describe("createDirectorApi(...).critiqueEdit — advisory-only, single relay call, capped frames", () => {
	it("fails gracefully when no relay is wired (no editCritic option)", async () => {
		const editor = makeEditor(TWO_CLIP_TRACKS, TWO_CLIP_ASSETS, 8);
		const director = createDirectorApi(editor);
		const res = await director.critiqueEdit();
		expect(res.ok).toBe(false);
		expect(res.message).toContain("not configured");
	});

	it("fails gracefully on a timeline with no video/image content", async () => {
		const editor = makeEditor(
			[
				{
					id: "track_text",
					type: "text",
					elements: [
						{
							id: "el_text",
							type: "text",
							name: "Text",
							content: "hi",
							startTime: 0,
							duration: 2,
						},
					],
				},
			],
			[],
			2,
		);
		const director = createDirectorApi(editor, {
			editCritic: { relay: async () => '{"summary":"x","issues":[]}' },
		});
		const res = await director.critiqueEdit();
		expect(res.ok).toBe(false);
		expect(res.message).toContain("no video/image content");
	});

	it("returns a well-formed EditCritique on a seeded timeline, calling the relay exactly once", async () => {
		const editor = makeEditor(TWO_CLIP_TRACKS, TWO_CLIP_ASSETS, 8);
		let relayCalls = 0;
		let lastSystem = "";
		const director = createDirectorApi(editor, {
			frames: { decode: async () => FAKE_FRAME },
			editCritic: {
				relay: async ({ system }) => {
					relayCalls++;
					lastSystem = system;
					return JSON.stringify({
						summary: "Decent pacing; hook could be stronger.",
						issues: [
							{
								axis: "hook",
								severity: "med",
								location: { sec: 0.5, elementRef: "el_a" },
								note: "Opening shot is calm; consider leading with clip-b.",
								proposedFix: {
									verb: "reorder",
									args: { slotIds: ["el_b", "el_a"] },
								},
							},
						],
					});
				},
			},
		});

		const res = await director.critiqueEdit();
		expect(res.ok).toBe(true);
		expect(relayCalls).toBe(1); // single model call per invocation, non-negotiable
		expect(lastSystem.length).toBeGreaterThan(0);
		expect(res.data).toBeDefined();
		if (!res.data) return;
		expect(res.data.summary).toBe("Decent pacing; hook could be stronger.");
		expect(res.data.issues).toHaveLength(1);
		expect(res.data.issues[0].proposedFix).toEqual({
			verb: "reorder",
			args: { slotIds: ["el_b", "el_a"] },
		});
		// delta is absent — critiqueEdit is read-only, nothing mutated.
		expect(res.delta).toBeUndefined();
	});

	it("never decodes more than MAX_EDIT_CRITIC_FRAMES frames even with many clips", async () => {
		const manyTracks = [
			{
				id: "track_video",
				type: "video",
				elements: Array.from({ length: 40 }, (_, i) => ({
					id: `el_${i}`,
					type: "video",
					name: `clip-${i}.mp4`,
					mediaId: `m${i}`,
					startTime: i * 2,
					duration: 2,
					trimStart: 0,
					trimEnd: 0,
				})),
			},
		];
		const manyAssets: FakeAsset[] = Array.from({ length: 40 }, (_, i) => ({
			id: `m${i}`,
			name: `clip-${i}.mp4`,
			type: "video",
			url: `blob:clip-${i}`,
		}));
		let decodeCalls = 0;
		const editor = makeEditor(manyTracks, manyAssets, 80);
		const director = createDirectorApi(editor, {
			frames: {
				decode: async () => {
					decodeCalls++;
					return FAKE_FRAME;
				},
			},
			editCritic: {
				relay: async () => '{"summary":"fine","issues":[]}',
			},
		});

		const res = await director.critiqueEdit();
		expect(res.ok).toBe(true);
		expect(decodeCalls).toBeLessThanOrEqual(MAX_EDIT_CRITIC_FRAMES);
		expect(decodeCalls).toBe(MAX_EDIT_CRITIC_FRAMES);
	});

	it("fails safe (ok, empty issues) when the relay returns malformed JSON — never throws", async () => {
		const editor = makeEditor(TWO_CLIP_TRACKS, TWO_CLIP_ASSETS, 8);
		const director = createDirectorApi(editor, {
			frames: { decode: async () => FAKE_FRAME },
			editCritic: { relay: async () => "not json at all" },
		});
		const res = await director.critiqueEdit();
		expect(res.ok).toBe(true);
		expect(res.data?.issues).toEqual([]);
	});

	it("fails gracefully (does not throw) when the relay call itself rejects", async () => {
		const editor = makeEditor(TWO_CLIP_TRACKS, TWO_CLIP_ASSETS, 8);
		const director = createDirectorApi(editor, {
			frames: { decode: async () => FAKE_FRAME },
			editCritic: {
				relay: async () => {
					throw new Error("network down");
				},
			},
		});
		const res = await director.critiqueEdit();
		expect(res.ok).toBe(false);
		expect(res.message).toContain("network down");
	});

	it("fails gracefully when no frame could be decoded (decode always resolves undefined)", async () => {
		const editor = makeEditor(TWO_CLIP_TRACKS, TWO_CLIP_ASSETS, 8);
		const director = createDirectorApi(editor, {
			frames: { decode: async () => undefined },
			editCritic: { relay: async () => '{"summary":"x","issues":[]}' },
		});
		const res = await director.critiqueEdit();
		expect(res.ok).toBe(false);
		expect(res.message).toContain("Couldn't decode");
	});

	it("never mutates the timeline — a read before and after critiqueEdit is identical", async () => {
		const editor = makeEditor(TWO_CLIP_TRACKS, TWO_CLIP_ASSETS, 8);
		const director = createDirectorApi(editor, {
			frames: { decode: async () => FAKE_FRAME },
			editCritic: { relay: async () => '{"summary":"x","issues":[]}' },
		});
		const before = director.getTimeline();
		await director.critiqueEdit();
		const after = director.getTimeline();
		expect(after).toEqual(before);
	});
});
