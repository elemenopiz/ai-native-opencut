import { describe, expect, it } from "bun:test";
import type { CraftOp } from "../craft/types";
import type { EditCritique } from "../edit-critic";
import type {
	AssemblyPlan,
	AssemblyStrategy,
	ExecutionReport,
	FootageInventory,
	FootageInventoryAsset,
	InventoryMediaAsset,
	MarkedGap,
	StoryBrief,
	StoryRunArtifacts,
	TargetDurationResolution,
	TargetDurationSource,
	Treatment,
	TreatmentSection,
} from "./types";

/**
 * Compile-time exercises for the Story Engine's frozen artifact shapes
 * (`docs/plans/2026-07-20-story-engine-design.md`, "Build partition" table —
 * these types freeze in SE-1 so SE-2/3/4 build against them). Every test here
 * is really a TYPE assertion: if a field is renamed/removed/retyped, these
 * literals stop compiling. The runtime `expect` calls just give `bun test`
 * something to report so a broken build shows up as a red test, not a silent
 * `tsc` failure elsewhere.
 */
describe("story/types.ts — artifact shapes", () => {
	it("StoryBrief: every field, minimal and fully-populated", () => {
		const minimal: StoryBrief = { instruction: "make me a 45s recap" };
		expect(minimal.instruction).toBe("make me a 45s recap");

		const resolution: TargetDurationResolution = {
			sec: 45,
			source: "user-instruction",
			note: "user said '45 seconds'",
		};
		const sources: TargetDurationSource[] = [
			"user-instruction",
			"director-brief",
			"preference-default",
			"unset",
		];
		expect(sources).toContain(resolution.source);

		const full: StoryBrief = {
			instruction: "make me a 45s recap for TikTok",
			goal: "drive signups",
			audience: "Gen-Z skateboarders",
			tone: "warm, playful",
			format: "TikTok",
			aspect: "9:16",
			targetDuration: resolution,
			mustInclude: ["show the logo"],
			sourceBrief: { goal: "drive signups", platform: "TikTok" },
		};
		expect(full.targetDuration?.sec).toBe(45);
		expect(full.sourceBrief?.platform).toBe("TikTok");
	});

	it("InventoryMediaAsset + FootageInventoryAsset: input vs. produced shape", () => {
		const inputAsset: InventoryMediaAsset = {
			id: "m1",
			kind: "video",
			durationSec: 12.5,
		};
		const inputNoDuration: InventoryMediaAsset = { id: "m2", kind: "image" };
		expect(inputAsset.kind).toBe("video");
		expect(inputNoDuration.durationSec).toBeUndefined();

		const produced: FootageInventoryAsset = {
			id: "m1",
			kind: "video",
			durationSec: 12.5,
			hasTranscriptSegments: true,
			hasBeatGrid: false,
			hasUnderstanding: true,
			hasDeepUnderstanding: false,
			hasSilenceMap: false,
			possiblyUntranscribed: false,
		};
		expect(produced.hasTranscriptSegments).toBe(true);

		// hasTranscriptSegments is a real tri-state: true | false | undefined.
		const untranscribed: FootageInventoryAsset = {
			...produced,
			hasTranscriptSegments: undefined,
			possiblyUntranscribed: true,
		};
		expect(untranscribed.hasTranscriptSegments).toBeUndefined();
	});

	it("FootageInventory: aggregate shape", () => {
		const inv: FootageInventory = {
			assets: [],
			totalDurationSec: 0,
			speechShare: 0,
			untranscribedCount: 0,
		};
		expect(inv.speechShare).toBe(0);
	});

	it("Treatment + TreatmentSection", () => {
		const section: TreatmentSection = {
			intent: "hook",
			targetSec: 3,
			materialRefs: ["m1", "m1#seg0"],
			order: 0,
		};
		const treatment: Treatment = {
			logline: "A founder's day, told in one breath.",
			sections: [section],
		};
		expect(treatment.sections[0].intent).toBe("hook");
	});

	it("AssemblyPlan + MarkedGap + AssemblyStrategy, reusing CraftOp", () => {
		const strategies: AssemblyStrategy[] = ["radio-cut", "beat-cut"];
		const op: CraftOp = { verb: "addClip", args: { mediaId: "m1" } };
		const gap: MarkedGap = {
			startSec: 5,
			durationSec: 1.2,
			note: "cutaway here — no matching b-roll found",
		};
		const plan: AssemblyPlan = {
			strategy: strategies[0],
			ops: [op],
			markedGaps: [gap],
		};
		expect(plan.ops[0].verb).toBe("addClip");
		expect(plan.markedGaps[0].note).toContain("cutaway");
	});

	it("ExecutionReport: success and partial-failure shapes", () => {
		const ok: ExecutionReport = {
			success: true,
			appliedOps: [{ verb: "trim", args: {} }],
			resultDurationSec: 47,
		};
		const failed: ExecutionReport = {
			success: false,
			appliedOps: [],
			error: { opIndex: 2, message: "slot not found" },
		};
		expect(ok.success).toBe(true);
		expect(failed.error?.opIndex).toBe(2);
	});

	it("StoryRunArtifacts: partial (mid-pipeline) and full envelopes", () => {
		const brief: StoryBrief = { instruction: "cut it" };
		const inventory: FootageInventory = {
			assets: [],
			totalDurationSec: 0,
			speechShare: 0,
			untranscribedCount: 0,
		};

		const midPipeline: StoryRunArtifacts = {
			stage: "inventory",
			brief,
			inventory,
		};
		expect(midPipeline.treatment).toBeUndefined();

		const critique: EditCritique = { summary: "solid cut", issues: [] };
		const full: StoryRunArtifacts = {
			stage: "present",
			brief,
			inventory,
			treatment: { logline: "x", sections: [] },
			assemblyPlan: { strategy: "radio-cut", ops: [], markedGaps: [] },
			execution: { success: true, appliedOps: [] },
			critique,
			summary: "Cut a 47s draft from 9 clips.",
		};
		expect(full.critique?.issues).toHaveLength(0);
		expect(full.summary).toContain("47s");
	});
});
