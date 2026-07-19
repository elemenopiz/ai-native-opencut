/**
 * Story Engine, stage orchestrator (SE-4) —
 * `docs/plans/2026-07-20-story-engine-design.md` is the spec; this module is
 * the arrows in its diagram:
 *
 * ```
 * brief ──▶ inventory ──▶ treatment ──▶ assembly plan ──▶ execution ──▶ self-check ──▶ present
 * ```
 *
 * {@link runStoryEngine} is PURE ORCHESTRATION over an injected {@link
 * RunStoryEngineDeps} bag — every side effect (reading the project brief,
 * listing media, calling a model, mutating the timeline) is a function the
 * caller hands in, so this file never imports React, a store, `EditorCore`,
 * or a network client, and is fully testable with fakes (see `run.test.ts`).
 * `director-api.ts`'s `draftCut` verb is the one real caller — it wires every
 * dep to the live editor/relay and converts the returned {@link
 * StoryRunOutcome} into a `DirectorResult`.
 *
 * STAGE 1 (brief) and STAGE 2 (inventory) never call a model. STAGE 3
 * (treatment) calls the model at most twice (one call + one coached retry —
 * see `story/treatment.ts`'s `parseTreatment`). STAGE 4 (assembly +
 * execution) is deterministic (`story/assembly.ts`'s `planAssembly` +ONE
 * `executePlan` transaction). STAGE 5 (self-check) calls the model at most
 * once, ONLY when `deps.critiqueEdit` is wired (the caller's job to gate on
 * the edit-critic flag + a configured relay — see `director-api.ts`). STAGE 6
 * (present) never calls a model. Hard envelope, per the design doc's "Cost &
 * latency envelope": AT MOST 3 model calls per run (2 treatment + 1
 * critique), enforced structurally by this file's control flow, not by a
 * runtime counter that could drift from the code.
 *
 * DEFENSE IN DEPTH (ADR-007, "zero generation in v1"): even though
 * `planAssembly` is documented to only ever emit `addClip`/`trim`/`move`/
 * `split` ops, this module independently rejects any op whose verb is a
 * generation verb (`generate`/`remix`/`reroll`) before executing — see
 * {@link FORBIDDEN_GENERATION_VERBS}. This should never trigger; if it does,
 * the run fails loudly rather than silently generating.
 */

import type { CraftBeatMarker } from "../craft";
import type { CraftOp } from "../craft/types";
import type { EditCritique } from "../edit-critic";
import type { DirectorResult } from "../types";
import type { AssetBeatGridLookup } from "../asset-manifest";
import type { UserPreferenceModel } from "../preference-learning";
import type { AssetTranscriptLookup } from "../transcript-lookup";
import type { DirectorBrief } from "@/types/project";
import {
	buildFootageInventory,
	type AssetUnderstandingCanonicalLookup,
	type SilenceMapLookup,
} from "./inventory";
import {
	buildTreatmentPrompt,
	parseTreatment,
	type TreatmentPrompt,
} from "./treatment";
import {
	planAssembly,
	type AssemblyPlanResult,
	type SilenceRangesLookup,
} from "./assembly";
import type {
	ExecutionReport,
	InventoryMediaAsset,
	StoryBrief,
	StoryRunArtifacts,
	TargetDurationResolution,
	Treatment,
} from "./types";

// ── model transport ──────────────────────────────────────────────────────

/**
 * The relay a `draftCut` treatment call needs: one tool-less, TEXT-ONLY model
 * round-trip, system prompt + a single user-content string in, the
 * assistant's raw text reply out. Shaped exactly like `edit-critic.ts`'s
 * `EditCriticRelay` (`{ system, content } → Promise<string>`), except
 * `content` is plain text (the treatment prompt is never multimodal) rather
 * than vision content blocks — own local type, not a redefinition of
 * `EditCriticRelay` (different content shape), matching this package's "own
 * copy, not import" discipline. Injected (not imported) so this module never
 * imports a network client; ABSENT ⇒ `runStoryEngine` fails gracefully after
 * stage 2 (inventory) with a "not configured" outcome, never a throw — same
 * contract `director-api.ts`'s `critiqueEdit` already uses for its own
 * relay.
 */
export type StoryEngineRelay = (request: {
	system: string;
	content: string;
}) => Promise<string>;

// ── execution seam ───────────────────────────────────────────────────────

/**
 * The result `deps.executePlan` must report back — a caller-agnostic
 * flattening of whatever `DirectorResult` shape the real executor
 * (`director-api.ts`'s `executeCraftPlan`) returns, so this module never
 * needs to import `DirectorResult`'s generic-payload machinery just to read
 * "how many ops actually applied." `opsApplied` is populated on BOTH success
 * (== `ops.length`) and failure (a strict prefix — the count that applied
 * before the failing op) — mirrors `ExecutionReport.appliedOps`' own "full
 * array on success, strict prefix on failure" contract in `types.ts`.
 */
export interface StoryPlanExecutionResult {
	ok: boolean;
	/** Plain-language explanation — success message or the failure's bare fact, ready to fold into `runStoryEngine`'s coaching failure message. */
	message: string;
	opsApplied: number;
}

// ── deps ─────────────────────────────────────────────────────────────────

/**
 * Every side effect `runStoryEngine` needs, injected. `director-api.ts`'s
 * `draftCut` wires every field to the live editor/relay; `run.test.ts` wires
 * plain fakes. Every field beyond `listAssets`/`executePlan` is OPTIONAL —
 * same "injected seam, absent ⇒ degrade gracefully, never throw" contract
 * every other Director module in this package follows (see
 * `inventory.ts`/`assembly.ts`'s own lookups).
 */
export interface RunStoryEngineDeps {
	// stage 1: brief
	/** Sync read of the project's standing `DirectorBrief` (mirrors `editor.project.getDirectorBrief()`). No project/brief yet ⇒ `undefined`. */
	getDirectorBrief: () => DirectorBrief | undefined;
	/** P1 preference-defaults READ seam (mirrors `options.preferenceLearning.getModel`). Absent, or a rejected read, ⇒ the preference-default target-duration source is simply never resolved — best-effort, never blocks the run. */
	getPreferenceModel?: () => Promise<UserPreferenceModel | undefined>;

	// stage 2: inventory (all forwarded verbatim to `buildFootageInventory`)
	listAssets: () => InventoryMediaAsset[];
	transcripts?: AssetTranscriptLookup;
	understanding?: AssetUnderstandingCanonicalLookup;
	beatGrid?: AssetBeatGridLookup;
	silenceMap?: SilenceMapLookup;

	// stage 3: treatment
	relay?: StoryEngineRelay;

	// stage 4: assembly + execution
	/** Timeline-relative beat markers (mirrors `director-api.ts`'s `cutOnBeat` gatherer — `getTimelineBeatMarkers`). Absent/empty ⇒ beat-cut still allocates shots per section, sequential, evenly split (see `assembly.ts`'s `runBeatCutAssembly`). */
	beats?: CraftBeatMarker[];
	silenceRanges?: SilenceRangesLookup;
	/** Applies an `AssemblyPlanResult`'s `ops` as ONE undo transaction, resolving `@pending:<index>` refs itself (see `director-api.ts`'s extended `executeCraftPlan`). */
	executePlan: (ops: CraftOp[]) => StoryPlanExecutionResult;
	/** Post-execution total timeline duration read (mirrors `editor.timeline.getTotalDuration()`). Absent ⇒ `ExecutionReport.resultDurationSec` falls back to the assembly plan's own `projectedDurationSec` estimate. */
	getTimelineDurationSec?: () => number;

	// stage 5: self-check (optional, advisory only — ADR-006)
	/**
	 * Present ONLY when the caller has already decided this run's self-check
	 * should run (edit-critic flag on AND a relay wired — `director-api.ts`'s
	 * job, not this module's). Absent ⇒ stage 5 never runs, `stage` stops at
	 * `"execution"` before jumping straight to `"present"`. A critique call
	 * that itself fails (`ok:false`, or a thrown rejection) is swallowed —
	 * advisory only, NEVER fails the run.
	 */
	critiqueEdit?: () => Promise<DirectorResult<EditCritique>>;
}

export interface RunStoryEngineInput {
	/** The user's own words for this run, verbatim — folds into `StoryBrief.instruction`. */
	instruction: string;
	/** Explicit target length IF the user stated one THIS turn — the `"user-instruction"` `TargetDurationSource`. Omit to fall through the brief/preference-default waterfall. */
	targetSec?: number;
}

/** `runStoryEngine`'s return: a `DirectorResult`-friendly `{ok, message}` envelope PLUS the full `StoryRunArtifacts` (populated up to whichever stage the run actually reached — see `types.ts`'s `StoryRunArtifacts.stage` doc comment). Defined here (not in the frozen `story/types.ts`) since it's this orchestrator's own contract, not a pipeline artifact. */
export interface StoryRunOutcome {
	ok: boolean;
	/** Coaching-style failure message on `ok:false`; the stage-6 chat summary on `ok:true` (same string as `artifacts.summary`). */
	message: string;
	artifacts: StoryRunArtifacts;
}

// ── stage 1: brief resolution ───────────────────────────────────────────

/**
 * Resolve `StoryBrief.targetDuration`, per `story/types.ts`'s
 * `TargetDurationSource` priority order: an explicit `input.targetSec`
 * stated THIS turn always wins over the standing `DirectorBrief.durationSec`,
 * which wins over a learned `UserPreferenceModel.avgKeptDurationSec` default.
 * `undefined` ⇒ `"unset"` (no sentinel object — see that type's doc comment).
 */
export function resolveTargetDuration(
	input: RunStoryEngineInput,
	sourceBrief: DirectorBrief | undefined,
	preferenceModel: UserPreferenceModel | undefined,
): TargetDurationResolution | undefined {
	if (
		input.targetSec != null &&
		Number.isFinite(input.targetSec) &&
		input.targetSec > 0
	) {
		return {
			sec: input.targetSec,
			source: "user-instruction",
			note: `user asked for ${input.targetSec}s this turn`,
		};
	}
	if (
		sourceBrief?.durationSec != null &&
		Number.isFinite(sourceBrief.durationSec) &&
		sourceBrief.durationSec > 0
	) {
		return {
			sec: sourceBrief.durationSec,
			source: "director-brief",
			note: "matches the standing DirectorBrief target",
		};
	}
	const avg = preferenceModel?.avgKeptDurationSec;
	if (avg != null && Number.isFinite(avg) && avg > 0) {
		return {
			sec: Math.round(avg),
			source: "preference-default",
			note: `learned: kept takes average ~${Math.round(avg)}s`,
		};
	}
	return undefined;
}

/**
 * Compose a {@link StoryBrief} from this turn's input + the project's
 * standing `DirectorBrief` (when one exists) + a learned preference model
 * (when one resolved) — pure, given the already-resolved
 * `sourceBrief`/`preferenceModel` (the async reads are `runStoryEngine`'s
 * job). Every `StoryBrief` field beyond `instruction`/`targetDuration`
 * mirrors the matching `DirectorBrief` field verbatim (per each field's own
 * doc comment in `types.ts`) — omitted, not defaulted, when the source brief
 * doesn't carry it. `aspect` additionally falls back to the preference
 * model's top `preferredAspects` tag (most-picked first) when the source
 * brief has no aspect concept of its own (`DirectorBrief` only carries
 * `platform`, the stated distribution intent, not a resolved ratio).
 */
export function buildStoryBrief(
	input: RunStoryEngineInput,
	sourceBrief: DirectorBrief | undefined,
	preferenceModel: UserPreferenceModel | undefined,
): StoryBrief {
	const targetDuration = resolveTargetDuration(
		input,
		sourceBrief,
		preferenceModel,
	);
	const aspect = preferenceModel?.preferredAspects?.[0]?.tag;

	return {
		instruction: input.instruction,
		...(sourceBrief?.goal ? { goal: sourceBrief.goal } : {}),
		...(sourceBrief?.audience ? { audience: sourceBrief.audience } : {}),
		...(sourceBrief?.tone ? { tone: sourceBrief.tone } : {}),
		...(sourceBrief?.platform ? { format: sourceBrief.platform } : {}),
		...(aspect ? { aspect } : {}),
		...(targetDuration ? { targetDuration } : {}),
		...(sourceBrief?.mustInclude?.length
			? { mustInclude: sourceBrief.mustInclude }
			: {}),
		...(sourceBrief ? { sourceBrief } : {}),
	};
}

// ── defense in depth (ADR-007) ──────────────────────────────────────────

/** Verb names `runStoryEngine` refuses to execute, regardless of what `planAssembly` produced — see this module's header. */
export const FORBIDDEN_GENERATION_VERBS: ReadonlySet<string> = new Set([
	"generate",
	"remix",
	"reroll",
]);

function findForbiddenOps(ops: readonly CraftOp[]): CraftOp[] {
	return ops.filter((op) => FORBIDDEN_GENERATION_VERBS.has(op.verb));
}

// ── stage 6: present ─────────────────────────────────────────────────────

/**
 * The one chat-summary line stage 6 renders, e.g. `"Cut a 47s draft from 9
 * clips — led with the demo. 2 gaps marked for cutaways."` (+ a review-notes
 * tail when `critique` is present) — see `types.ts`'s `StoryRunArtifacts.summary`
 * doc comment, which this function is the one implementation of.
 */
export function buildDraftCutSummary(input: {
	treatment: Treatment;
	assemblyPlan: AssemblyPlanResult;
	executionReport: ExecutionReport;
	critique?: EditCritique;
}): string {
	const { treatment, assemblyPlan, executionReport, critique } = input;
	const durationSec = Math.round(
		executionReport.resultDurationSec ?? assemblyPlan.projectedDurationSec,
	);
	const clipCount = assemblyPlan.ops.filter(
		(op) => op.verb === "addClip",
	).length;
	const hook = [...treatment.sections].sort((a, b) => a.order - b.order)[0];
	const gapCount = assemblyPlan.markedGaps.length;

	let msg = `Cut a ${durationSec}s draft from ${clipCount} clip${clipCount === 1 ? "" : "s"}`;
	if (hook?.intent) msg += ` — led with the ${hook.intent}`;
	msg += ".";
	if (gapCount > 0) {
		msg += ` ${gapCount} gap${gapCount === 1 ? "" : "s"} marked for cutaways.`;
	}
	if (critique) {
		msg +=
			critique.issues.length > 0
				? ` ${critique.issues.length} note${critique.issues.length === 1 ? "" : "s"} from review, want them?`
				: " Review found nothing to flag.";
	}
	return msg;
}

// ── the orchestrator ─────────────────────────────────────────────────────

/** Hard cap on treatment model calls per run: one call + one coached retry — see `story/treatment.ts`'s `parseTreatment` doc comment and this module's header envelope note. */
export const MAX_TREATMENT_MODEL_CALLS = 2;

/**
 * Run the whole Story Engine pipeline: brief → inventory → treatment (+1
 * retry) → assembly → execution → optional self-check → present. See this
 * module's header for the full stage/model-call contract. Never throws —
 * every failure path (relay absent, treatment parse failure after the
 * retry, a forbidden op, a failed execution) returns a `StoryRunOutcome`
 * with `ok: false` and a coaching `message`, plus whatever `StoryRunArtifacts`
 * the run reached before stopping.
 */
export async function runStoryEngine(
	deps: RunStoryEngineDeps,
	input: RunStoryEngineInput,
): Promise<StoryRunOutcome> {
	// ── stage 1: brief ──
	const sourceBrief = deps.getDirectorBrief();
	let preferenceModel: UserPreferenceModel | undefined;
	if (deps.getPreferenceModel) {
		try {
			preferenceModel = await deps.getPreferenceModel();
		} catch {
			preferenceModel = undefined; // best-effort — never blocks the run
		}
	}
	const brief = buildStoryBrief(input, sourceBrief, preferenceModel);

	// ── stage 2: inventory ──
	const inventory = buildFootageInventory({
		assets: deps.listAssets(),
		transcripts: deps.transcripts,
		understanding: deps.understanding,
		beatGrid: deps.beatGrid,
		silenceMap: deps.silenceMap,
	});

	const afterInventory: StoryRunArtifacts = {
		stage: "inventory",
		brief,
		inventory,
	};

	if (!deps.relay) {
		return {
			ok: false,
			message:
				"draftCut needs a model relay wired in this context — not configured.",
			artifacts: afterInventory,
		};
	}

	// ── stage 3: treatment (model call #1, +1 coached retry) ──
	const prompt: TreatmentPrompt = buildTreatmentPrompt(brief, inventory);
	const targetDurationSec = brief.targetDuration?.sec;

	let treatment: Treatment | undefined;
	let lastRetryHint = "";
	for (let attempt = 0; attempt < MAX_TREATMENT_MODEL_CALLS; attempt++) {
		let replyText: string;
		try {
			replyText = await deps.relay({
				system: prompt.system,
				content:
					attempt === 0 ? prompt.user : `${prompt.user}\n\n${lastRetryHint}`,
			});
		} catch (err) {
			return {
				ok: false,
				message: `draftCut's treatment call failed: ${
					err instanceof Error ? err.message : "unknown error"
				}.`,
				artifacts: afterInventory,
			};
		}

		const parsed = parseTreatment(replyText, inventory, { targetDurationSec });
		if (parsed.ok) {
			treatment = parsed.treatment;
			break;
		}
		lastRetryHint = parsed.retryHint;
	}

	if (!treatment) {
		return {
			ok: false,
			message: `Treatment couldn't be produced after ${MAX_TREATMENT_MODEL_CALLS} attempt(s): ${lastRetryHint}`,
			artifacts: afterInventory,
		};
	}

	const afterTreatment: StoryRunArtifacts = {
		...afterInventory,
		stage: "treatment",
		treatment,
	};

	// ── stage 4: assembly plan ──
	const assemblyPlan = planAssembly(treatment, inventory, {
		brief,
		transcripts: deps.transcripts,
		silenceRanges: deps.silenceRanges,
		beats: deps.beats,
	});

	const forbidden = findForbiddenOps(assemblyPlan.ops);
	if (forbidden.length > 0) {
		return {
			ok: false,
			message: `draftCut aborted: the assembly plan produced a forbidden generation-verb op ("${forbidden[0].verb}") — zero-generation is a hard rule (ADR-007). This should never happen from planAssembly; please report it.`,
			artifacts: { ...afterTreatment, stage: "assembly", assemblyPlan },
		};
	}

	const afterAssembly: StoryRunArtifacts = {
		...afterTreatment,
		stage: "assembly",
		assemblyPlan,
	};

	// ── stage 4b: execution (ONE transaction) ──
	const execResult = deps.executePlan(assemblyPlan.ops);
	const appliedOps = assemblyPlan.ops.slice(0, execResult.opsApplied);
	const executionReport: ExecutionReport = execResult.ok
		? {
				success: true,
				appliedOps,
				resultDurationSec:
					deps.getTimelineDurationSec?.() ?? assemblyPlan.projectedDurationSec,
			}
		: {
				success: false,
				appliedOps,
				error: { opIndex: execResult.opsApplied, message: execResult.message },
				...(appliedOps.length > 0 && deps.getTimelineDurationSec
					? { resultDurationSec: deps.getTimelineDurationSec() }
					: {}),
			};

	const afterExecution: StoryRunArtifacts = {
		...afterAssembly,
		stage: "execution",
		execution: executionReport,
	};

	if (!executionReport.success) {
		return {
			ok: false,
			message: `draftCut couldn't finish assembling the cut: ${execResult.message}`,
			artifacts: afterExecution,
		};
	}

	// ── stage 5: self-check (optional, advisory only — ADR-006) ──
	let critique: EditCritique | undefined;
	let afterCritique = afterExecution;
	if (deps.critiqueEdit) {
		try {
			const critiqueResult = await deps.critiqueEdit();
			if (critiqueResult.ok && critiqueResult.data)
				critique = critiqueResult.data;
		} catch {
			// advisory only — a failed/rejected critique never fails the run.
		}
		afterCritique = {
			...afterExecution,
			stage: "self-check",
			...(critique ? { critique } : {}),
		};
	}

	// ── stage 6: present ──
	const summary = buildDraftCutSummary({
		treatment,
		assemblyPlan,
		executionReport,
		critique,
	});

	return {
		ok: true,
		message: summary,
		artifacts: { ...afterCritique, stage: "present", summary },
	};
}
