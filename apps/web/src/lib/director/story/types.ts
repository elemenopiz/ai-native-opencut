/**
 * Story Engine — typed pipeline artifacts.
 *
 * `docs/plans/2026-07-20-story-engine-design.md` ("Story Engine — design (P3,
 * the 'make me a cut' pipeline)") is the spec. The engine is a STAGED PIPELINE,
 * not a long agent run — every arrow between stages hands over one typed,
 * persistable artifact defined in this file:
 *
 * ```
 * brief ──▶ inventory ──▶ treatment ──▶ assembly plan ──▶ execution ──▶ self-check ──▶ present
 * (user +   (determin-    (MODEL #1)    (MODEL #2 when     (determin-    (MODEL #3,     (proposal
 *  1 Q max)  istic)                      needed; else       istic verbs)  critic, iff    + markers)
 *                                        deterministic)                   flag on)
 * ```
 *
 * Build partition (design doc's "Build partition" table) — every type below is
 * frozen HERE in SE-1 so SE-2/SE-3/SE-4 build against a stable contract:
 *   - SE-1 (this file + `inventory.ts`): {@link StoryBrief}, {@link FootageInventory}
 *     shapes + the deterministic inventory builder. No model calls.
 *   - SE-2: produces {@link Treatment} via model call #1 (structured output,
 *     grounded against a `FootageInventory` digest — `materialRefs` must
 *     resolve against it, validate + one retry with a coaching error).
 *   - SE-3: produces {@link AssemblyPlan} (radio-cut or beat-cut strategy,
 *     chosen from `FootageInventory.speechShare`) and executes it into an
 *     {@link ExecutionReport}, through the existing `DirectorApi` verbs only,
 *     as ONE undoable batch.
 *   - SE-4: registers the `draftCut` verb, wires stages 1/3/5/6 end to end
 *     (brief resolution, execution, the optional self-check critique, and the
 *     one chat-summary presentation), and owns the eval scenario.
 *
 * v1 keeps every artifact IN-MEMORY, attached to the run result (no
 * persistence/versioning — that is P1 Creative Brief's job for the brief, and
 * the Proposals pillar P7's job for making each stage user-editable). This
 * file only defines shapes; nothing here calls a model, touches a store, or
 * imports React/network/browser APIs — see `inventory.ts` for the one stage
 * SE-1 also implements.
 */

import type { CraftOp } from "../craft/types";
import type { EditCritique } from "../edit-critic";
import type { DirectorBrief } from "@/types/project";
import type { MediaType } from "@/types/assets";

// ── stage 1: Brief ───────────────────────────────────────────────────────────

/**
 * Where a resolved {@link StoryBrief.targetDuration} number came from, in the
 * priority order the brief stage follows: an explicit statement IN THIS
 * instruction always wins over the persistent `DirectorBrief`'s standing
 * target, which in turn wins over a learned preference-model default.
 * `"unset"` ⇒ no target could be resolved from any source (assembly is free
 * to pick a natural length within the cost/latency envelope).
 */
export type TargetDurationSource =
	| "user-instruction"
	| "director-brief"
	| "preference-default"
	| "unset";

/**
 * A resolved target duration + WHY that number was picked — the "resolution
 * notes" the brief stage must keep, since three different sources
 * (this turn's instruction, the standing `DirectorBrief.durationSec`, and
 * `UserPreferenceModel.avgKeptDurationSec`) can each produce a number and only
 * one should win per {@link TargetDurationSource}'s priority order.
 */
export interface TargetDurationResolution {
	/** The resolved target length, seconds. */
	sec: number;
	source: TargetDurationSource;
	/**
	 * Free-text explaining how `sec` was picked, e.g. `"user said '45
	 * seconds'"`, `"matches the standing DirectorBrief target"`, or `"learned:
	 * kept takes average ~24s"`. Present whenever `source` isn't `"unset"`.
	 */
	note?: string;
}

/**
 * PRODUCED by stage 1 (Brief); CONSUMED by stage 3 (Treatment, model call #1 —
 * folded into its prompt alongside the inventory digest) and stage 5
 * (self-check, to verify `mustInclude` landed in the assembled cut).
 *
 * A lightweight, IN-MEMORY, per-run brief — NOT the persistent `DirectorBrief`
 * itself. `draftCut` (SE-4) builds one from: the user's one-line instruction +
 * Part C's clarify policy (at most one friendly question, defaults packed in)
 * + the project's standing {@link DirectorBrief} (read for `goal`/`audience`/
 * `tone`/`platform`/`mustInclude` — this type's fields mirror those exactly,
 * see each field's doc comment) + a `UserPreferenceModel` read for defaults
 * the user keeps choosing (aspect, pacing). v1 note (design doc, stage 1):
 * this is intentionally a throwaway inline brief; P1's Creative Brief work
 * later persists/versions a richer one.
 */
export interface StoryBrief {
	/** The user's instruction for this run, verbatim (e.g. "make me a 45s recap"). */
	instruction: string;
	/** What this cut is for. Mirrors `DirectorBrief.goal` when resolved from it. */
	goal?: string;
	/** Who it's for. Mirrors `DirectorBrief.audience`. */
	audience?: string;
	/** Desired mood/voice. Mirrors `DirectorBrief.tone`. */
	tone?: string;
	/**
	 * Distribution target (platform and/or format), e.g. `"TikTok"`, `"16:9
	 * YouTube"`. Mirrors `DirectorBrief.platform` — the STATED intent, distinct
	 * from `aspect` below (the resolved pixel-dimension bucket).
	 */
	format?: string;
	/**
	 * Resolved aspect-ratio tag (e.g. `"9:16"`), when known or inferable from
	 * the project canvas / a learned preference. Distinct from `format`: this
	 * is the concrete ratio assembly should cut against, not the stated
	 * platform name.
	 */
	aspect?: string;
	/**
	 * Resolved target length for this run, with provenance. `undefined` ⇒ no
	 * target resolved from any source (equivalent to `source: "unset"` — kept
	 * as `undefined` rather than a sentinel object so "no target" has one
	 * obvious falsy representation).
	 */
	targetDuration?: TargetDurationResolution;
	/**
	 * Concrete content requirements that MUST appear in the finished cut.
	 * Mirrors `DirectorBrief.mustInclude` — literal inclusion checks the
	 * assembly stage (and the stage-5 self-check) can verify against, not
	 * style guidance.
	 */
	mustInclude?: string[];
	/**
	 * Read-only mirror of the persistent `DirectorBrief` this run was resolved
	 * from, when one existed — kept for provenance/debugging/presentation
	 * (stage 6 can explain "why" a default was chosen). Never mutated by the
	 * pipeline; writes back to the real brief (if any) happen through the
	 * existing `updateBrief` verb, outside this pipeline.
	 */
	sourceBrief?: DirectorBrief;
}

// ── stage 2: Inventory ───────────────────────────────────────────────────────

/**
 * One project media asset as the Story Engine's inventory sees it — the
 * MINIMAL shape `buildFootageInventory` needs (id/kind/duration), decoupled
 * from the richer `ManifestAsset`/`MediaAssetData` shapes other Director
 * modules read (same "own copy, not import" discipline `asset-manifest.ts`
 * and `edit-critic.ts` use for their own minimal mirrors).
 */
export interface InventoryMediaAsset {
	id: string;
	kind: MediaType;
	/**
	 * Duration in seconds, when known. `undefined` (unprobed metadata) is
	 * treated as `0` by `buildFootageInventory`'s aggregate math — never
	 * causes a crash or a `NaN` to propagate into `FootageInventory`.
	 */
	durationSec?: number;
}

/** PRODUCED by stage 2 (Inventory) for one project media asset. */
export interface FootageInventoryAsset {
	id: string;
	kind: MediaType;
	/** Resolved duration, seconds. `0` when the source asset's duration was unknown. */
	durationSec: number;
	/**
	 * `true` ⇒ this asset has a transcript record with at least one non-empty
	 * segment (real speech present — mirrors `hasSpeech()` in
	 * `@/lib/search/asset-transcript`). `false` ⇒ transcribed but silent
	 * (an empty-segments record is a real, distinct answer — see
	 * `AssetTranscript`'s own doc comment). `undefined` ⇒ not transcribed at
	 * all yet.
	 */
	hasTranscriptSegments?: boolean;
	/** `true` ⇒ an analyzed beat grid exists for this asset (today's store holds at most one, project-wide). */
	hasBeatGrid: boolean;
	/** `true` ⇒ an `AssetUnderstanding` record exists for this asset, at ANY depth (shallow or deep). */
	hasUnderstanding: boolean;
	/**
	 * `true` ⇒ the understanding record carries the DEEPENED perception
	 * fields (`isDeepUnderstanding` from `@/lib/search/asset-understanding` —
	 * motion + shotType). Always `false` when `hasUnderstanding` is `false`.
	 */
	hasDeepUnderstanding: boolean;
	/**
	 * `true` ⇒ a silence/filler analysis (the `lib/auto-cut` engines' output)
	 * is available for this asset, letting assembly dedupe filler/false-starts
	 * and snap cuts to silence boundaries. These analyses are computed
	 * on-demand from decoded audio (no persisted per-asset store today, same
	 * "deliberately sparse" posture as the beat grid) — `false`/absent is the
	 * common case, not an error.
	 */
	hasSilenceMap: boolean;
	/**
	 * `true` ⇒ this is a speech-bearing media kind (`"video"` or `"audio"` —
	 * mirrors `selectTranscriptionCandidates`'s own kind filter in
	 * `@/lib/search/asset-transcript`) with NO transcript record at all
	 * (`hasTranscriptSegments === undefined`). Flags footage that PROBABLY
	 * carries speech nobody's transcribed yet, so `speechShare` doesn't
	 * silently undercount it — see {@link FootageInventory.speechShare}'s doc
	 * comment for the full formula/edge-case contract. Always `false` for
	 * `"image"` assets (never speech-bearing) and for any asset that already
	 * has a transcript record, transcribed-silent included.
	 */
	possiblyUntranscribed: boolean;
}

/**
 * PRODUCED by stage 2 (Inventory, deterministic — `buildFootageInventory` in
 * `inventory.ts`, NO model calls anywhere in its path). CONSUMED by stage 3
 * (Treatment, folded into the model prompt as a compact digest — building
 * that digest is SE-2's job, not this file's) and stage 4 (Assembly, whose
 * radio-cut-vs-beat-cut strategy choice is driven by `speechShare`).
 */
export interface FootageInventory {
	assets: FootageInventoryAsset[];
	/** Sum of every asset's `durationSec`. `0` for an empty library. */
	totalDurationSec: number;
	/**
	 * Fraction in `[0, 1]` of `totalDurationSec` carried by assets with real
	 * transcribed speech (`hasTranscriptSegments === true`) — the metric the
	 * assembly stage (SE-3) uses to pick radio-cut-first (speech-dominant)
	 * vs. beat-cut (music-dominant).
	 *
	 * FORMULA: `sum(durationSec of assets where hasTranscriptSegments ===
	 * true) / totalDurationSec`.
	 *
	 * EDGE CASES:
	 *   - Empty library (`totalDurationSec === 0`) ⇒ `speechShare = 0` BY
	 *     DEFINITION, not a `0/0` fallback — there is no speech to share.
	 *   - An asset with NO transcript record (`hasTranscriptSegments ===
	 *     undefined`) contributes ZERO to the speech-duration sum, even when
	 *     it's speech-bearing media that likely carries untranscribed speech
	 *     — it is conservatively counted as non-speech rather than guessed.
	 *     Those assets are separately flagged via each row's
	 *     `possiblyUntranscribed` and rolled up into `untranscribedCount`, so
	 *     a caller can tell "genuinely no speech" apart from "maybe speech,
	 *     nobody's checked" instead of the metric silently conflating them.
	 *   - A transcribed-but-silent asset (`hasTranscriptSegments === false`)
	 *     also contributes zero — a real, checked answer, not a guess.
	 */
	speechShare: number;
	/**
	 * Count of assets flagged `possiblyUntranscribed` — surfaced so a caller
	 * (stage 6's presentation, or SE-4's `draftCut`) can nudge "transcribe N
	 * more clips before I cut" when this is non-zero and `speechShare` looks
	 * low, instead of silently assuming those clips carry no speech.
	 */
	untranscribedCount: number;
}

// ── stage 3: Treatment (model call #1) ───────────────────────────────────────

/**
 * One narrative beat of a {@link Treatment} — what it's FOR, how long it
 * should run, and which inventory material it can draw from.
 */
export interface TreatmentSection {
	/** What this section is for narratively, e.g. `"hook"`, `"problem"`, `"demo"`, `"cta"`. Free text — the model's own vocabulary, not a closed enum. */
	intent: string;
	/** Planned length of this section, seconds. */
	targetSec: number;
	/**
	 * Candidate asset/segment ids this section can draw from. MUST resolve
	 * against the `FootageInventory` that grounded the model call producing
	 * this treatment (SE-2's job to validate — one retry with a coaching
	 * error on a dangling ref, per the design doc's Vyra-style error-contract
	 * pattern; this type makes no validation guarantee on its own).
	 */
	materialRefs: string[];
	/** 0-based position in the final sequence. */
	order: number;
}

/**
 * PRODUCED by stage 3 (Treatment — model call #1, structured output,
 * grounded on `StoryBrief` + a compact `FootageInventory` digest). CONSUMED
 * by stage 4 (Assembly), which sequences each section's `materialRefs` into
 * concrete `CraftOp`s.
 *
 * The creative leap of the whole pipeline: story order, what to lead with
 * (the hook), what to drop.
 */
export interface Treatment {
	/** One-sentence overall pitch for the cut. */
	logline: string;
	sections: TreatmentSection[];
}

// ── stage 4: Assembly plan → execution ───────────────────────────────────────

/**
 * Which assembly path a `Treatment` is realized through, chosen (by SE-3)
 * from `FootageInventory.speechShare`: `"radio-cut"` when speech-dominant
 * (sequence transcript segments on the audio spine, lay picture after —
 * segment-level transcripts are SUFFICIENT here, cuts land on segment
 * boundaries ± silence-map snapping; true word-level in-sentence cuts wait on
 * the word-alignment prerequisite, design doc §4), `"beat-cut"` when
 * music-dominant (allocate shots to beat-grid positions, shot changes on
 * beats).
 */
export type AssemblyStrategy = "radio-cut" | "beat-cut";

/**
 * A stretch of the timeline v1 deliberately leaves UNFILLED rather than
 * generating (ADR-007, "zero generation in v1") — a b-roll/cutaway slot with
 * no matching library clip. Annotated, never silently dropped.
 */
export interface MarkedGap {
	/** Timeline-absolute start, seconds. */
	startSec: number;
	durationSec: number;
	/** Human-readable annotation, e.g. `"cutaway here — no matching b-roll found"`. */
	note: string;
}

/**
 * PRODUCED by stage 4 (Assembly — model call #2 ONLY when the deterministic
 * shot-matching heuristics need an assist; otherwise built deterministically
 * from the `Treatment` + `FootageInventory`). CONSUMED by stage 4's own
 * execution half, which applies `ops` through the existing `DirectorApi`
 * verbs (`addClip`, `trim`, `split`, `move`, `removeSilence`, transitions —
 * NEVER a new verb) as ONE undoable batch, producing an {@link ExecutionReport}.
 */
export interface AssemblyPlan {
	strategy: AssemblyStrategy;
	/**
	 * Ordered, executable verb calls. `CraftOp` (imported from
	 * `../craft/types`, NOT redefined here — see this repo's "own copy, not
	 * import" discipline note on `CraftOp` itself for when duplication IS
	 * warranted; this is the opposite case, a same-package canonical shape)
	 * is a planner output only — nothing in this file executes it.
	 */
	ops: CraftOp[];
	/** Sections/spans intentionally left as gaps rather than generated (ADR-007). */
	markedGaps: MarkedGap[];
}

/** PRODUCED by stage 4's execution half after applying an {@link AssemblyPlan}'s `ops`. */
export interface ExecutionReport {
	/** `true` ⇒ every op applied cleanly, as one undo batch. */
	success: boolean;
	/**
	 * Ops actually applied, in order. Equal to the `AssemblyPlan.ops` it was
	 * built from on full success; a strict prefix of it when `error` is set
	 * (execution stopped at `error.opIndex`).
	 */
	appliedOps: CraftOp[];
	/** Present ⇒ execution stopped before completing every op. */
	error?: { opIndex: number; message: string };
	/** The assembled cut's resulting total duration, seconds, when execution completed (fully or partially). */
	resultDurationSec?: number;
}

// ── stage 5: Self-check (model call #3, optional) ───────────────────────────
//
// Reuses `EditCritique` (imported from `../edit-critic`, NOT redefined — same
// "canonical shape already exists in-package" reasoning as the `CraftOp`
// import above). PRODUCED by stage 5, iff
// `NEXT_PUBLIC_FEATURE_EDIT_CRITIC=true` (design doc §5); its issues ride the
// run as ADVISORY notes only (ADR-006) — a fix is NEVER auto-applied by this
// pipeline. CONSUMED by stage 6 (Present).

// ── stage 6: Present ─────────────────────────────────────────────────────────

/**
 * The run envelope carrying every stage's artifact for presentation and
 * inspection — "typed, persistable" per the design doc, even though v1 keeps
 * it in-memory only (no store, no versioning — P7's Proposals pillar later
 * makes each stage user-editable between stages). `stage` marks the
 * FURTHEST-COMPLETED stage; every artifact for a stage at or before it is
 * populated, later ones are `undefined` (a run inspected mid-pipeline, or one
 * that never reached self-check because the critic flag is off, is a normal,
 * fully-typed partial envelope — never a sentinel/error state).
 */
export interface StoryRunArtifacts {
	stage:
		| "brief"
		| "inventory"
		| "treatment"
		| "assembly"
		| "execution"
		| "self-check"
		| "present";
	brief: StoryBrief;
	inventory: FootageInventory;
	treatment?: Treatment;
	assemblyPlan?: AssemblyPlan;
	execution?: ExecutionReport;
	/** Present only when the critic flag was on for this run and stage 5 ran. */
	critique?: EditCritique;
	/**
	 * The one chat-summary line stage 6 renders, e.g. `"Cut a 47s draft from 9
	 * clips — led with the demo, trimmed 14s of filler. Two notes from
	 * review, want them?"`. `undefined` until stage 6 runs.
	 */
	summary?: string;
}
