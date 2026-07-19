import { describe, expect, it } from "bun:test";
import type { AssetTranscript } from "@/lib/search/asset-transcript";
import type { DirectorBrief } from "@/types/project";
import type { EditCritique } from "../edit-critic";
import type { DirectorResult } from "../types";
import type { UserPreferenceModel } from "../preference-learning";
import type { InventoryMediaAsset } from "./types";
import {
	FORBIDDEN_GENERATION_VERBS,
	buildDraftCutSummary,
	buildStoryBrief,
	resolveTargetDuration,
	runStoryEngine,
	type RunStoryEngineDeps,
	type RunStoryEngineInput,
	type StoryPlanExecutionResult,
} from "./run";

/**
 * SE-4 — `runStoryEngine`'s orchestration tests. Every dep is a hand-written
 * fake (per the design doc's "fully testable with fakes" requirement): no
 * `EditorCore`, no store, no network, NO real model call anywhere in this
 * file — `deps.relay`/`deps.critiqueEdit` are scripted functions standing in
 * for a model round-trip, exactly like `treatment.test.ts`'s parse-only
 * fixtures stand in for a Treatment reply.
 */

// ── fixtures ─────────────────────────────────────────────────────────────

const ASSET_A: InventoryMediaAsset = {
	id: "a1",
	kind: "video",
	durationSec: 30,
};
const ASSET_B: InventoryMediaAsset = {
	id: "a2",
	kind: "video",
	durationSec: 20,
};

const TRANSCRIPTS: Record<string, AssetTranscript> = {
	a1: {
		mediaId: "a1",
		segments: [{ start: 0, end: 30, text: "intro pitch about the product" }],
		language: "en",
		durationSec: 30,
		engine: "whisper-local",
		createdAt: 0,
	},
	a2: {
		mediaId: "a2",
		segments: [{ start: 0, end: 20, text: "closing thoughts and thanks" }],
		language: "en",
		durationSec: 20,
		engine: "whisper-local",
		createdAt: 0,
	},
};

const VALID_TREATMENT_JSON = JSON.stringify({
	logline: "A quick recap of the launch.",
	sections: [
		{ intent: "hook", targetSec: 30, materialRefs: ["a1"], order: 0 },
		{ intent: "wrap-up", targetSec: 20, materialRefs: ["a2"], order: 1 },
	],
});

/** An `executePlan` fake that always "applies" every op cleanly — most tests don't care about real editor mutation, only that `runStoryEngine` reads the count back correctly. */
function alwaysSucceeds(ops: readonly unknown[]): StoryPlanExecutionResult {
	return {
		ok: true,
		message: `Applied ${ops.length} operation(s) in one undo step.`,
		opsApplied: ops.length,
	};
}

function baseDeps(
	overrides: Partial<RunStoryEngineDeps> = {},
): RunStoryEngineDeps {
	return {
		getDirectorBrief: () => undefined,
		listAssets: () => [ASSET_A, ASSET_B],
		transcripts: (mediaId) => TRANSCRIPTS[mediaId],
		executePlan: alwaysSucceeds,
		...overrides,
	};
}

const BASE_INPUT: RunStoryEngineInput = {
	instruction: "make me a quick recap",
};

// ── stage 1: brief resolution ───────────────────────────────────────────

describe("resolveTargetDuration — TargetDurationSource precedence", () => {
	it("user-instruction wins over everything else", () => {
		const brief: DirectorBrief = { durationSec: 90 };
		const pref: UserPreferenceModel = {
			sampleSize: 5,
			avgKeptDurationSec: 15,
			updatedAt: 0,
		};
		const resolution = resolveTargetDuration(
			{ instruction: "x", targetSec: 45 },
			brief,
			pref,
		);
		expect(resolution).toEqual({
			sec: 45,
			source: "user-instruction",
			note: "user asked for 45s this turn",
		});
	});

	it("director-brief wins over the preference default when no explicit targetSec", () => {
		const brief: DirectorBrief = { durationSec: 60 };
		const pref: UserPreferenceModel = {
			sampleSize: 5,
			avgKeptDurationSec: 15,
			updatedAt: 0,
		};
		const resolution = resolveTargetDuration({ instruction: "x" }, brief, pref);
		expect(resolution?.source).toBe("director-brief");
		expect(resolution?.sec).toBe(60);
	});

	it("falls to the learned preference default when neither instruction nor brief has one", () => {
		const pref: UserPreferenceModel = {
			sampleSize: 5,
			avgKeptDurationSec: 24.4,
			updatedAt: 0,
		};
		const resolution = resolveTargetDuration(
			{ instruction: "x" },
			undefined,
			pref,
		);
		expect(resolution?.source).toBe("preference-default");
		expect(resolution?.sec).toBe(24);
	});

	it("resolves to undefined ('unset') when nothing resolves", () => {
		expect(
			resolveTargetDuration({ instruction: "x" }, undefined, undefined),
		).toBeUndefined();
	});

	it("ignores a non-positive brief duration and falls through", () => {
		const brief: DirectorBrief = { durationSec: 0 };
		expect(
			resolveTargetDuration({ instruction: "x" }, brief, undefined),
		).toBeUndefined();
	});
});

describe("buildStoryBrief", () => {
	it("mirrors DirectorBrief fields and carries sourceBrief for provenance", () => {
		const brief: DirectorBrief = {
			goal: "drive signups",
			audience: "Gen-Z",
			tone: "warm",
			platform: "TikTok",
			mustInclude: ["logo"],
		};
		const storyBrief = buildStoryBrief(
			{ instruction: "cut it" },
			brief,
			undefined,
		);
		expect(storyBrief.instruction).toBe("cut it");
		expect(storyBrief.goal).toBe("drive signups");
		expect(storyBrief.audience).toBe("Gen-Z");
		expect(storyBrief.tone).toBe("warm");
		expect(storyBrief.format).toBe("TikTok");
		expect(storyBrief.mustInclude).toEqual(["logo"]);
		expect(storyBrief.sourceBrief).toBe(brief);
	});

	it("omits fields the source brief doesn't carry, rather than defaulting them", () => {
		const storyBrief = buildStoryBrief(
			{ instruction: "cut it" },
			undefined,
			undefined,
		);
		expect(storyBrief).toEqual({ instruction: "cut it" });
	});

	it("falls back to the preference model's top aspect when the brief has none", () => {
		const pref: UserPreferenceModel = {
			sampleSize: 3,
			preferredAspects: [{ tag: "9:16", count: 3 }],
			updatedAt: 0,
		};
		const storyBrief = buildStoryBrief(
			{ instruction: "cut it" },
			undefined,
			pref,
		);
		expect(storyBrief.aspect).toBe("9:16");
	});
});

// ── stage 3+: orchestration ──────────────────────────────────────────────

describe("runStoryEngine — relay absent", () => {
	it("fails gracefully after inventory, never throws", async () => {
		const outcome = await runStoryEngine(
			baseDeps({ relay: undefined }),
			BASE_INPUT,
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.message).toContain("not configured");
		expect(outcome.artifacts.stage).toBe("inventory");
		expect(outcome.artifacts.treatment).toBeUndefined();
	});
});

describe("runStoryEngine — treatment retry path", () => {
	it("retries once on a bad reply and succeeds on the coached second attempt", async () => {
		const replies = ["not json at all", VALID_TREATMENT_JSON];
		let calls = 0;
		const relay = async () => {
			const reply = replies[calls];
			calls++;
			return reply;
		};

		const outcome = await runStoryEngine(baseDeps({ relay }), BASE_INPUT);

		expect(calls).toBe(2);
		expect(outcome.ok).toBe(true);
		expect(outcome.artifacts.treatment?.sections.length).toBe(2);
		expect(outcome.artifacts.stage).toBe("present");
	});

	it("fails gracefully (never throws) when both attempts are bad, stopping at exactly 2 relay calls", async () => {
		let calls = 0;
		const relay = async () => {
			calls++;
			return "still not json";
		};

		const outcome = await runStoryEngine(baseDeps({ relay }), BASE_INPUT);

		expect(calls).toBe(2);
		expect(outcome.ok).toBe(false);
		expect(outcome.artifacts.stage).toBe("inventory");
		expect(outcome.artifacts.treatment).toBeUndefined();
	});

	it("a relay call that throws is reported gracefully, not re-thrown", async () => {
		const relay = async () => {
			throw new Error("network down");
		};
		const outcome = await runStoryEngine(baseDeps({ relay }), BASE_INPUT);
		expect(outcome.ok).toBe(false);
		expect(outcome.message).toContain("network down");
	});
});

describe("runStoryEngine — model-call ceiling (design doc: <=3 per run)", () => {
	it("never exceeds 2 treatment calls + 1 critique call, even on the success path", async () => {
		let relayCalls = 0;
		let critiqueCalls = 0;
		const relay = async () => {
			relayCalls++;
			return VALID_TREATMENT_JSON;
		};
		const critique: EditCritique = { summary: "solid cut", issues: [] };
		const critiqueEdit = async (): Promise<DirectorResult<EditCritique>> => {
			critiqueCalls++;
			return { ok: true, message: "ok", data: critique };
		};

		const outcome = await runStoryEngine(
			baseDeps({ relay, critiqueEdit }),
			BASE_INPUT,
		);

		expect(relayCalls).toBe(1);
		expect(critiqueCalls).toBe(1);
		expect(relayCalls + critiqueCalls).toBeLessThanOrEqual(3);
		expect(outcome.ok).toBe(true);
		expect(outcome.artifacts.critique).toEqual(critique);
		expect(outcome.artifacts.stage).toBe("present");
	});

	it("the worst case (one retry + a critique) still lands at exactly 3 model calls total", async () => {
		const replies = ["bad", VALID_TREATMENT_JSON];
		let relayCalls = 0;
		const relay = async () => {
			const reply = replies[relayCalls];
			relayCalls++;
			return reply;
		};
		let critiqueCalls = 0;
		const critiqueEdit = async (): Promise<DirectorResult<EditCritique>> => {
			critiqueCalls++;
			return { ok: true, message: "ok", data: { summary: "fine", issues: [] } };
		};

		const outcome = await runStoryEngine(
			baseDeps({ relay, critiqueEdit }),
			BASE_INPUT,
		);

		expect(relayCalls).toBe(2);
		expect(critiqueCalls).toBe(1);
		expect(relayCalls + critiqueCalls).toBe(3);
		expect(outcome.ok).toBe(true);
	});

	it("critiqueEdit absent ⇒ stage 5 never runs, stage jumps straight from execution to present", async () => {
		const outcome = await runStoryEngine(
			baseDeps({ relay: async () => VALID_TREATMENT_JSON }),
			BASE_INPUT,
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.artifacts.critique).toBeUndefined();
		expect(outcome.artifacts.stage).toBe("present");
	});

	it("a critique call that fails/throws is swallowed — advisory only, never fails the run", async () => {
		const outcome = await runStoryEngine(
			baseDeps({
				relay: async () => VALID_TREATMENT_JSON,
				critiqueEdit: async () => {
					throw new Error("vision relay down");
				},
			}),
			BASE_INPUT,
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.artifacts.critique).toBeUndefined();
	});
});

describe("runStoryEngine — execution failure", () => {
	it("reports a failed execution as ok:false, stage stops at 'execution'", async () => {
		const executePlan = (_ops: unknown[]): StoryPlanExecutionResult => ({
			ok: false,
			message: 'Craft plan stopped at step 1/2 ("addClip" on "a1"): boom.',
			opsApplied: 0,
		});
		const outcome = await runStoryEngine(
			baseDeps({ relay: async () => VALID_TREATMENT_JSON, executePlan }),
			BASE_INPUT,
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.artifacts.stage).toBe("execution");
		expect(outcome.artifacts.execution?.success).toBe(false);
		expect(outcome.artifacts.execution?.error?.opIndex).toBe(0);
		expect(outcome.artifacts.summary).toBeUndefined();
	});
});

// ── defense in depth (ADR-007) ───────────────────────────────────────────

describe("FORBIDDEN_GENERATION_VERBS — defense in depth", () => {
	it("names exactly the three generation verbs the design doc forbids", () => {
		expect([...FORBIDDEN_GENERATION_VERBS].sort()).toEqual([
			"generate",
			"remix",
			"reroll",
		]);
	});

	it("addClip/trim/move/split — the only verbs planAssembly is documented to emit — are never forbidden", () => {
		for (const verb of ["addClip", "trim", "move", "split"]) {
			expect(FORBIDDEN_GENERATION_VERBS.has(verb)).toBe(false);
		}
	});
});

// ── stage 6: present ─────────────────────────────────────────────────────

describe("buildDraftCutSummary", () => {
	it("matches the design doc's chat-register example shape", () => {
		const summary = buildDraftCutSummary({
			treatment: {
				logline: "x",
				sections: [
					{ intent: "demo", targetSec: 47, materialRefs: ["a1"], order: 0 },
				],
			},
			assemblyPlan: {
				strategy: "radio-cut",
				ops: Array.from({ length: 9 }, () => ({
					verb: "addClip",
					args: {},
				})),
				markedGaps: [
					{ startSec: 0, durationSec: 5, note: "gap 1" },
					{ startSec: 10, durationSec: 5, note: "gap 2" },
				],
				projectedDurationSec: 47,
				sectionBreakdown: [],
				strategyRationale: "test",
			},
			executionReport: { success: true, appliedOps: [], resultDurationSec: 47 },
		});
		expect(summary).toBe(
			"Cut a 47s draft from 9 clips — led with the demo. 2 gaps marked for cutaways.",
		);
	});

	it("appends a review-notes tail when a critique is present", () => {
		const summary = buildDraftCutSummary({
			treatment: {
				logline: "x",
				sections: [
					{ intent: "hook", targetSec: 10, materialRefs: [], order: 0 },
				],
			},
			assemblyPlan: {
				strategy: "radio-cut",
				ops: [{ verb: "addClip", args: {} }],
				markedGaps: [],
				projectedDurationSec: 10,
				sectionBreakdown: [],
				strategyRationale: "test",
			},
			executionReport: { success: true, appliedOps: [], resultDurationSec: 10 },
			critique: {
				summary: "nice cut",
				issues: [
					{
						axis: "pacing",
						severity: "low",
						location: { sec: 3 },
						note: "a bit slow",
					},
				],
			},
		});
		expect(summary).toContain("1 note from review, want them?");
	});
});
