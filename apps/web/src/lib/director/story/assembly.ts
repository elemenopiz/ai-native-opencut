/**
 * Story Engine, stage 4 — the deterministic Assembly stage (SE-3).
 * `docs/plans/2026-07-20-story-engine-design.md` §4 is the spec: turn a
 * {@link Treatment} + {@link FootageInventory} into an {@link AssemblyPlan}
 * (ordered `CraftOp`s + marked gaps), picking radio-cut vs beat-cut from
 * `FootageInventory.speechShare`.
 *
 * PURE / DETERMINISTIC, same discipline `inventory.ts`/`edit-critic.ts`/
 * `craft/*` use for their planning cores: no React, no store, no IndexedDB,
 * no network, NO MODEL CALL anywhere in this file. Every external fact
 * (transcripts, filler/silence ranges, the beat grid) arrives through an
 * INJECTED lookup on `opts` — same "own copy, not import" / "sync
 * read-through" pattern `inventory.ts` uses. Same input twice ⇒ deep-equal
 * output (no `Math.random`, no wall-clock reads, stable sorts throughout).
 *
 * VERB GROUNDING — every `CraftOp` this file emits is one of the four verbs
 * the design doc allows for v1 assembly (`addClip`, `trim`, `move`, `split`),
 * with args shaped EXACTLY against their real `tool-catalog.ts` schemas
 * (read-only; cited at each call site below):
 *   - `addClip`  → tool-catalog.ts:2167-2198  `{ mediaId, startTime?, duration?, trackId? }`
 *   - `trim`     → tool-catalog.ts:1818-1840  `{ slotId, trimStart?, trimEnd?, startTime?, duration? }`
 *   - `move`     → tool-catalog.ts:1842-1864  `{ slotId, newStartTime, targetTrackId? }` (beat-cut re-sequencing, via `cutOnBeat`'s own `trim`-only merge — `move` is reserved for a future increment, see `runBeatCutAssembly`'s doc note)
 *   - `split`    → tool-catalog.ts:1866-1879  `{ slotId, atTime }` (not needed by v1's segment/beat granularity — every cut lands on a real segment/shot boundary already, so no clip is ever divided after being placed)
 *
 * ONE HARD CONSTRAINT grounded on `addClip`'s own handler
 * (`director-api.ts:2103-2148`, specifically the `asset.type === "audio"`
 * check at :2112-2116): **`addClip` refuses audio-kind assets outright** —
 * v1 has no audio-placement verb. Combined with `isSpeechBearingKind`
 * (`inventory.ts`, speech lives on `"video"`/`"audio"`), the only `MediaType`
 * that is BOTH speech-bearing AND placeable is `"video"` — so every
 * radio-cut candidate this file selects is filtered to `kind === "video"`.
 * An asset whose real speech only exists as a bare audio file is a legitimate
 * v1 gap (`MarkedGap`), not a bug: there is no verb to place it.
 *
 * THE "PENDING REF" PROBLEM — `addClip`'s handler returns a FRESH
 * `elementId` only once EXECUTED (`director-api.ts:2135-2147`); a plan built
 * here, before execution, cannot know that id yet. Every later op in this
 * SAME plan that needs to touch the clip an earlier `addClip` op is about to
 * create (a `trim` re-windowing it onto a transcript segment, or a
 * beat-snap `trim` from `cutOnBeat`) addresses it via a PENDING REF token
 * (see {@link pendingElementRef}) instead of a real id. SE-4 (execution,
 * not built here — "you just keep ops ordered + self-consistent" per the
 * design doc's build-partition table) MUST resolve every pending ref to the
 * real `elementId` its addClip op returned before applying the op that
 * carries it. This is this file's one deliberate extension beyond a literal
 * reading of `CraftOp`'s `args: Record<string, unknown>` — the shape is
 * still schema-legal (`slotId` is just a string), only the VALUE carries a
 * plan-local convention. Flagged as frozen-type friction in the SE-3 report.
 */

import type { AssetTranscript } from "@/lib/search/asset-transcript";
import {
	CRAFT_EPSILON,
	CUT_ON_BEAT_DEFAULT_MIN_CLIP_DURATION_SEC,
	type CraftBeatMarker,
	type CraftClip,
	type CraftOp,
	type CutOnBeatOptions,
	cutOnBeat,
	roundSec,
	type TrimmableSegment,
} from "../craft";
import type { AssetTranscriptLookup } from "../transcript-lookup";
import type {
	AssemblyPlan,
	AssemblyStrategy,
	FootageInventory,
	FootageInventoryAsset,
	MarkedGap,
	StoryBrief,
	Treatment,
	TreatmentSection,
} from "./types";

// ── strategy selection ───────────────────────────────────────────────────────

/**
 * Speech-duration share (see `FootageInventory.speechShare`'s doc comment in
 * `types.ts` for the exact formula) at or above which the assembly is
 * considered speech-dominant ⇒ `"radio-cut"`. ~0.5 (half the library's
 * runtime carries real transcribed speech) per the design doc §4's
 * "radio-cut-first" framing — chosen as the simplest symmetric split with
 * `{@link BEAT_CUT_DOMINANCE_THRESHOLD}` rather than a tuned value; both are
 * revisitable once the eval harness (SE-4) has real corpora to tune against.
 */
export const RADIO_CUT_SPEECH_SHARE_THRESHOLD = 0.5;

/**
 * Share of the library's total runtime (assets flagged `hasBeatGrid`) at or
 * above which the assembly is considered music-dominant ⇒ `"beat-cut"` —
 * ONLY consulted once `speechShare` has already missed the radio-cut
 * threshold above (design doc §4: radio-cut is checked FIRST). Symmetric
 * with {@link RADIO_CUT_SPEECH_SHARE_THRESHOLD} for the same reason.
 */
export const BEAT_CUT_DOMINANCE_THRESHOLD = 0.5;

/**
 * Free-text cues in a {@link StoryBrief} that pre-empt the inventory-derived
 * thresholds below — an explicit user ask ("cut this interview...",
 * "...synced to the beat") should win over a borderline inventory signal.
 * Checked against `instruction`/`goal`/`tone`/`format`, lowercased,
 * substring match. Speech cues are checked first (mirrors "radio-cut-first").
 */
const BRIEF_SPEECH_KEYWORDS = [
	"interview",
	"talking head",
	"speech",
	"voiceover",
	"voice-over",
	"podcast",
	"dialogue",
	"testimonial",
];
const BRIEF_MUSIC_KEYWORDS = ["music video", "beat", "montage", "music-synced"];

function briefHint(brief?: StoryBrief): "speech" | "music" | undefined {
	if (!brief) return undefined;
	const haystack = [brief.instruction, brief.goal, brief.tone, brief.format]
		.filter((v): v is string => !!v)
		.join(" ")
		.toLowerCase();
	if (!haystack) return undefined;
	if (BRIEF_SPEECH_KEYWORDS.some((k) => haystack.includes(k))) return "speech";
	if (BRIEF_MUSIC_KEYWORDS.some((k) => haystack.includes(k))) return "music";
	return undefined;
}

function beatGridDurationShare(inventory: FootageInventory): number {
	if (inventory.totalDurationSec <= 0) return 0;
	const beatSec = inventory.assets
		.filter((a) => a.hasBeatGrid)
		.reduce((sum, a) => sum + a.durationSec, 0);
	return beatSec / inventory.totalDurationSec;
}

/** Which signal actually decided a {@link selectAssemblyStrategy} call — distinct from `strategy` itself since BOTH `"fallback-sequential"` and a confident `"speech-dominant"` read produce `strategy: "radio-cut"` (the frozen `AssemblyStrategy` enum has no third value) but drive DIFFERENT behavior in `planAssembly` (see its dispatch). */
export type AssemblyStrategyBasis =
	| "brief-speech"
	| "brief-music"
	| "speech-dominant"
	| "beat-dominant"
	| "fallback-sequential"
	| "forced";

export interface AssemblyStrategyDecision {
	strategy: AssemblyStrategy;
	basis: AssemblyStrategyBasis;
	/** Free-text explanation, for `planAssembly`'s result / stage 6 presentation. */
	rationale: string;
}

/**
 * Pick radio-cut vs beat-cut for a `Treatment`. Pure: reads only `inventory`
 * (`FootageInventory.speechShare` + per-asset `hasBeatGrid`) and `brief`'s
 * free-text fields — never a store, never a model call.
 *
 * DECISION ORDER (design doc §4, "radio-cut-first"):
 *   1. An explicit brief cue ({@link briefHint}) wins outright.
 *   2. `speechShare >= {@link RADIO_CUT_SPEECH_SHARE_THRESHOLD}` ⇒ radio-cut.
 *   3. Else, beat-grid coverage `>= {@link BEAT_CUT_DOMINANCE_THRESHOLD}` AND
 *      it exceeds `speechShare` ⇒ beat-cut.
 *   4. FALLBACK (documented): neither signal is strong ⇒ `"radio-cut"`
 *      (the only structurally available default — beat-cut needs an actual
 *      beat grid to allocate against, which a weak `hasBeatGrid` coverage
 *      number doesn't guarantee), but `basis: "fallback-sequential"` tells
 *      `planAssembly` to skip transcript-segment-level selection and lay
 *      whole clips back-to-back instead (see `gatherFallbackUnits`) — the
 *      "simple sequential assembly" the spec calls for.
 */
export function selectAssemblyStrategy(
	inventory: FootageInventory,
	brief?: StoryBrief,
): AssemblyStrategyDecision {
	const hint = briefHint(brief);
	if (hint === "speech") {
		return {
			strategy: "radio-cut",
			basis: "brief-speech",
			rationale:
				"brief mentions speech-led content (interview/voiceover/podcast/...) — radio-cut regardless of inventory signal",
		};
	}
	if (hint === "music") {
		return {
			strategy: "beat-cut",
			basis: "brief-music",
			rationale:
				"brief mentions music/beat-led content (music video/montage/...) — beat-cut regardless of inventory signal",
		};
	}

	const speechShare = inventory.speechShare;
	if (speechShare >= RADIO_CUT_SPEECH_SHARE_THRESHOLD) {
		return {
			strategy: "radio-cut",
			basis: "speech-dominant",
			rationale: `speechShare ${speechShare.toFixed(2)} >= ${RADIO_CUT_SPEECH_SHARE_THRESHOLD} — speech-dominant footage`,
		};
	}

	const beatShare = beatGridDurationShare(inventory);
	if (beatShare >= BEAT_CUT_DOMINANCE_THRESHOLD && beatShare > speechShare) {
		return {
			strategy: "beat-cut",
			basis: "beat-dominant",
			rationale: `beat-grid coverage ${beatShare.toFixed(2)} >= ${BEAT_CUT_DOMINANCE_THRESHOLD} and exceeds speechShare (${speechShare.toFixed(2)}) — music-dominant footage`,
		};
	}

	return {
		strategy: "radio-cut",
		basis: "fallback-sequential",
		rationale: `fallback: neither speechShare (${speechShare.toFixed(2)}) nor beat-grid coverage (${beatShare.toFixed(2)}) is dominant — defaulting to a simple sequential assembly`,
	};
}

// ── pending-ref convention (see module doc) ─────────────────────────────────

export const PENDING_REF_PREFIX = "@pending:";

/** The token a later op in THIS plan uses to address the element `ops[addClipOpIndex]` (an `addClip`) is about to create. See the module doc's "PENDING REF" section. */
export function pendingElementRef(addClipOpIndex: number): string {
	return `${PENDING_REF_PREFIX}${addClipOpIndex}`;
}

export function isPendingElementRef(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(PENDING_REF_PREFIX);
}

function pendingRefIndex(value: string): number | undefined {
	if (!isPendingElementRef(value)) return undefined;
	const n = Number(value.slice(PENDING_REF_PREFIX.length));
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// ── shared "closest-fit" sequencing (radio-cut + its sequential fallback) ──

/** A candidate span of real source material a section can draw one clip from — SOURCE-relative, mirrors `craft/tighten-to-length.ts`'s `TrimmableSegment` shape. */
interface UsableUnit {
	assetId: string;
	start: number;
	end: number;
}

/**
 * Segment/shot-fitting tolerance (seconds): once the running total is within
 * this of a section's `targetSec`, stop growing. Also the tie-break window
 * for the boundary decision (see {@link selectClosestFitUnits}). 0.75s ≈ one
 * or two words at speaking pace — tight enough that a radio-cut section
 * reads as intentional, loose enough that real segment boundaries (which
 * rarely land exactly on a duration) almost always converge in one pass.
 */
export const DEFAULT_SEGMENT_FIT_TOLERANCE_SEC = 0.75;

/**
 * Greedily walk `units` (already in deterministic candidate order), taking
 * each one as long as it gets the running total CLOSER to `targetSec` than
 * stopping would — i.e. "closest-fit under/over": the boundary unit is only
 * included when doing so reduces `|total - target|`. Always takes at least
 * one unit when `units` is non-empty and `targetSec` is outside the
 * tolerance band from zero (never returns empty just because the very first
 * candidate overshoots hugely — that's a legitimate "best available fit",
 * not a gap; `MarkedGap` is reserved for genuinely NO usable material).
 * Non-backtracking (same documented-approximation posture as
 * `tightenToLength`'s budget phase) — a later, better-fitting unit past one
 * that was rejected is never reconsidered.
 */
function selectClosestFitUnits(
	units: UsableUnit[],
	targetSec: number,
	toleranceSec: number,
): UsableUnit[] {
	const chosen: UsableUnit[] = [];
	let cumulative = 0;
	for (const unit of units) {
		const len = roundSec(unit.end - unit.start);
		if (len <= CRAFT_EPSILON) continue;
		if (Math.abs(cumulative - targetSec) <= toleranceSec) break;
		const distWithout = Math.abs(cumulative - targetSec);
		const distWith = Math.abs(cumulative + len - targetSec);
		if (chosen.length > 0 && distWith >= distWithout) break;
		chosen.push(unit);
		cumulative = roundSec(cumulative + len);
	}
	return chosen;
}

/**
 * When the closest-fit walk above still leaves the total overshooting past
 * `targetSec + toleranceSec`, shave the TAIL of the last chosen unit (mirrors
 * `tightenToLength`'s tail-only trim scope) down to `minClipDurationSec`,
 * never below it. Mutates `chosen`'s last entry in place — callers pass a
 * fresh clone (never the caller's own `units` array) to keep this module's
 * "pure" discipline intact from the outside.
 */
function capLastUnitToFit(
	chosen: UsableUnit[],
	cumulative: number,
	targetSec: number,
	toleranceSec: number,
	minClipDurationSec: number,
): void {
	if (chosen.length === 0) return;
	const overshoot = cumulative - targetSec;
	if (overshoot <= toleranceSec) return;
	const last = chosen[chosen.length - 1];
	const lastLen = last.end - last.start;
	const maxShave = Math.max(0, lastLen - minClipDurationSec);
	const shave = Math.min(overshoot, maxShave);
	if (shave <= CRAFT_EPSILON) return;
	last.end = roundSec(last.end - shave);
}

interface SequentialSectionResult {
	ops: CraftOp[];
	projectedSec: number;
	gap: boolean;
	note?: string;
}

/**
 * Sequence `units` (already section-scoped candidates, in deterministic
 * order) onto the spine starting at `cursorSec`, closest-fitting
 * `section.targetSec`. Shared by BOTH radio-cut's confident path (units =
 * real transcript segments) and its "simple sequential" fallback (units =
 * whole clips) — see `gatherRadioCutUnits`/`gatherFallbackUnits`.
 *
 * Emits, per chosen unit: one `addClip` (grounded: tool-catalog.ts:2167-2198)
 * placing the FULL clip at `localCursor` for the unit's own length, then —
 * ONLY when `unit.start > 0` (a real in-point offset within the source) —
 * one `trim` (grounded: tool-catalog.ts:1818-1840) re-windowing that SAME
 * just-added clip onto `[unit.start, unit.end)` via a
 * {@link pendingElementRef}, since `addClip`'s own schema has no `trimStart`
 * param (it always plays from the source's own top). A whole-clip unit
 * (`start === 0`, the common fallback case) never needs this second op.
 */
function assembleSequentialSection(
	units: UsableUnit[],
	section: TreatmentSection,
	cursorSec: number,
	opsLengthSoFar: number,
	toleranceSec: number,
	minClipDurationSec: number,
	noMaterialNote: string,
): SequentialSectionResult {
	if (units.length === 0) {
		return { ops: [], projectedSec: 0, gap: true, note: noMaterialNote };
	}

	const picked = selectClosestFitUnits(
		units,
		section.targetSec,
		toleranceSec,
	).map((u) => ({ ...u }));
	if (picked.length === 0) {
		// Only reachable when targetSec itself is within tolerance of zero —
		// a legitimately empty section, not a material gap.
		return { ops: [], projectedSec: 0, gap: false };
	}

	let cumulative = picked.reduce((sum, u) => sum + (u.end - u.start), 0);
	capLastUnitToFit(
		picked,
		cumulative,
		section.targetSec,
		toleranceSec,
		minClipDurationSec,
	);
	cumulative = picked.reduce((sum, u) => sum + (u.end - u.start), 0);

	const ops: CraftOp[] = [];
	let localCursor = cursorSec;
	for (const unit of picked) {
		const durationSec = roundSec(unit.end - unit.start);
		if (durationSec <= CRAFT_EPSILON) continue;
		const addClipIndex = opsLengthSoFar + ops.length;
		ops.push({
			verb: "addClip",
			args: {
				mediaId: unit.assetId,
				startTime: roundSec(localCursor),
				duration: durationSec,
			},
		});
		if (unit.start > CRAFT_EPSILON) {
			ops.push({
				verb: "trim",
				args: {
					slotId: pendingElementRef(addClipIndex),
					trimStart: roundSec(unit.start),
					trimEnd: roundSec(unit.end),
					duration: durationSec,
				},
			});
		}
		localCursor = roundSec(localCursor + durationSec);
	}

	return { ops, projectedSec: roundSec(cumulative), gap: false };
}

// ── radio-cut candidate gathering ───────────────────────────────────────────

/**
 * Injected per-asset transcript lookup (see `transcript-lookup.ts`'s
 * `AssetTranscriptLookup`) — same shape `inventory.ts`'s `buildFootageInventory`
 * accepts, so a caller that already has one (SE-4, tests) reuses it verbatim.
 */
export type { AssetTranscriptLookup };

/** Per-asset SOURCE-relative filler/silence ranges to EXCLUDE from segment selection — mirrors `craft/tighten-to-length.ts`'s `trimmableSegments` input contract exactly (`TrimmableSegment[]`, source-relative). Only ever consulted for an asset the inventory already flags `hasSilenceMap: true`; this module never invents ranges of its own. */
export type SilenceRangesLookup = (
	mediaId: string,
) => TrimmableSegment[] | undefined;

export interface PlanAssemblyOptions {
	/** Grounds `StoryBrief`-driven strategy hints — see `selectAssemblyStrategy`. */
	brief?: StoryBrief;
	/** Bypasses `selectAssemblyStrategy` entirely (tests, or a caller that already decided). */
	forceStrategy?: AssemblyStrategy;
	/** Radio-cut path: real transcript segments per asset. Absent ⇒ every section becomes a `MarkedGap` (no usable speech can be found). */
	transcripts?: AssetTranscriptLookup;
	/** Radio-cut path: filler/silence ranges to dedupe, per {@link SilenceRangesLookup}. */
	silenceRanges?: SilenceRangesLookup;
	/** Beat-cut path: the project's beat grid, ALREADY projected onto TIMELINE-relative time (mirrors `craft/cut-on-beat.ts`'s own `CraftBeatMarker` input contract — this module never derives timeline positions from raw `BeatGrid.beats` itself, same "caller resolves, macro reasons in timeline time" discipline `cutOnBeat` documents). Absent ⇒ beat-cut still allocates shots per section (sequential, evenly split — see `runBeatCutAssembly`) but skips the join-snapping pass. */
	beats?: CraftBeatMarker[];
	/** Passthrough tuning for the `cutOnBeat` snap pass (tolerance/min-duration). Omit for `cutOnBeat`'s own defaults. */
	beatSnap?: CutOnBeatOptions;
	/** Overrides {@link DEFAULT_SEGMENT_FIT_TOLERANCE_SEC} for the radio-cut/fallback closest-fit walk. */
	segmentFitToleranceSec?: number;
	/** Overrides the shared min-clip-duration floor (default: `craft/cut-on-beat.ts`'s `DEFAULT_MIN_CLIP_DURATION_SEC`, the "0.5s constant family" the spec calls for). */
	minClipDurationSec?: number;
}

/** `true` when `seg` sits ENTIRELY inside one of `ranges` (a filler/silence span this section should never draw from). Partial overlap is deliberately NOT excluded (v1 approximation, same posture as `tightenToLength`'s budget phase) — only a segment that is nothing BUT filler is dropped. */
function isFullyWithinAnyRange(
	seg: { start: number; end: number },
	ranges: TrimmableSegment[],
): boolean {
	return ranges.some(
		(r) =>
			seg.start >= r.start - CRAFT_EPSILON && seg.end <= r.end + CRAFT_EPSILON,
	);
}

/**
 * Radio-cut candidates for one section: real transcript segments off its
 * `materialRefs`, filtered to `kind === "video"` (see module doc's
 * addClip/audio grounding), assets with `hasTranscriptSegments === true`,
 * non-empty segment text, and NOT fully inside an excluded filler/silence
 * range (only consulted when the inventory flags `hasSilenceMap: true` for
 * that asset — this module never guesses at filler it wasn't told about).
 * Order is deterministic: `materialRefs` order, then transcript segment
 * order (already time-ordered, `AssetTranscript`'s own contract).
 *
 * KNOWN v1 SCOPE: this looks at ONE section's `materialRefs` in isolation —
 * it does not track which segments an EARLIER section already consumed, so
 * two sections that both list the same asset in their `materialRefs` (which
 * SE-2's Treatment generally shouldn't do, but this module doesn't enforce
 * it) can pick the same transcript segment twice. Cross-section dedup is a
 * documented future increment, not silently assumed here.
 */
function gatherRadioCutUnits(
	section: TreatmentSection,
	assetsById: Map<string, FootageInventoryAsset>,
	opts: PlanAssemblyOptions,
): UsableUnit[] {
	const out: UsableUnit[] = [];
	for (const ref of section.materialRefs) {
		const asset = assetsById.get(ref);
		if (!asset || asset.kind !== "video") continue;
		if (asset.hasTranscriptSegments !== true) continue;
		const transcript: AssetTranscript | undefined = opts.transcripts?.(ref);
		if (!transcript) continue;
		const fillerRanges = asset.hasSilenceMap
			? (opts.silenceRanges?.(ref) ?? [])
			: [];
		for (const seg of transcript.segments) {
			if (!seg.text.trim()) continue;
			if (seg.end - seg.start <= CRAFT_EPSILON) continue;
			if (isFullyWithinAnyRange(seg, fillerRanges)) continue;
			out.push({ assetId: ref, start: seg.start, end: seg.end });
		}
	}
	return out;
}

/**
 * The "simple sequential assembly" fallback's candidates: WHOLE clips
 * (`[0, asset.durationSec)`) off a section's `materialRefs`, no transcript
 * involved — `kind === "video" | "image"` (both `addClip`-placeable per the
 * module doc), skipping any asset with an unresolved/zero duration (never
 * guess a length — same ADR-007 "don't invent" spirit applied to durations,
 * not just content).
 */
function gatherFallbackUnits(
	section: TreatmentSection,
	assetsById: Map<string, FootageInventoryAsset>,
): UsableUnit[] {
	const out: UsableUnit[] = [];
	for (const ref of section.materialRefs) {
		const asset = assetsById.get(ref);
		if (!asset) continue;
		if (asset.kind !== "video" && asset.kind !== "image") continue;
		if (asset.durationSec <= CRAFT_EPSILON) continue;
		out.push({ assetId: ref, start: 0, end: asset.durationSec });
	}
	return out;
}

// ── section breakdown / result envelope ─────────────────────────────────────

export interface AssemblySectionBreakdown {
	intent: string;
	order: number;
	targetSec: number;
	/** Actual sequenced duration for this section (0 for a `MarkedGap` section). */
	projectedSec: number;
	/** `true` ⇒ this section produced a `MarkedGap` instead of ops (no usable material — ADR-007). */
	gap: boolean;
}

/**
 * `planAssembly`'s return type: a real {@link AssemblyPlan} (structurally —
 * every `AssemblyPlan` field is present and correctly shaped) PLUS the
 * duration-convergence summary the spec asks for
 * (`projectedDurationSec`/`sectionBreakdown`), which `types.ts`'s frozen
 * `AssemblyPlan` has no field for. Extending rather than redefining keeps
 * this a drop-in `AssemblyPlan` for any caller that only wants the frozen
 * shape, while giving SE-4/the critic the convergence data without
 * re-simulating the plan. See the module-level report note on frozen-type
 * friction — `types.ts` itself was not touched.
 */
export interface AssemblyPlanResult extends AssemblyPlan {
	/** Sum of every section's `projectedSec` (0 for an empty treatment). */
	projectedDurationSec: number;
	sectionBreakdown: AssemblySectionBreakdown[];
	strategyRationale: string;
	/** Present for an empty treatment, or when `projectedDurationSec` drifts from the treatment's total `targetSec` beyond the aggregate tolerance (see `findAssemblyPlanInvariantViolations`). */
	note?: string;
}

function aggregateDurationToleranceSec(
	sectionCount: number,
	perSectionToleranceSec: number = DEFAULT_SEGMENT_FIT_TOLERANCE_SEC,
): number {
	// Each section can independently drift by up to its own fit tolerance;
	// scale gently with section count (half-weight) rather than summing the
	// full tolerance per section, since under/overshoots partially cancel in
	// practice. Floored at one section's tolerance so a 1-2 section plan
	// isn't held to an unreasonably tight aggregate bound.
	return Math.max(
		perSectionToleranceSec,
		sectionCount * perSectionToleranceSec * 0.5,
	);
}

// ── radio-cut / fallback dispatcher ─────────────────────────────────────────

function runSequentialAssembly(
	sortedSections: TreatmentSection[],
	assetsById: Map<string, FootageInventoryAsset>,
	toleranceSec: number,
	minClipDurationSec: number,
	gatherUnits: (
		section: TreatmentSection,
		assetsById: Map<string, FootageInventoryAsset>,
	) => UsableUnit[],
	modeLabel: string,
): {
	ops: CraftOp[];
	markedGaps: MarkedGap[];
	sectionBreakdown: AssemblySectionBreakdown[];
} {
	const ops: CraftOp[] = [];
	const markedGaps: MarkedGap[] = [];
	const sectionBreakdown: AssemblySectionBreakdown[] = [];
	let cursor = 0;

	for (const section of sortedSections) {
		const units = gatherUnits(section, assetsById);
		const result = assembleSequentialSection(
			units,
			section,
			cursor,
			ops.length,
			toleranceSec,
			minClipDurationSec,
			`${modeLabel}: section "${section.intent}" has no usable material in its materialRefs — never inventing material (ADR-007).`,
		);
		ops.push(...result.ops);
		if (result.gap) {
			markedGaps.push({
				startSec: roundSec(cursor),
				durationSec: roundSec(section.targetSec),
				note:
					result.note ??
					`${modeLabel}: no usable material for section "${section.intent}".`,
			});
		}
		sectionBreakdown.push({
			intent: section.intent,
			order: section.order,
			targetSec: section.targetSec,
			projectedSec: result.projectedSec,
			gap: result.gap,
		});
		cursor = roundSec(
			cursor + (result.gap ? section.targetSec : result.projectedSec),
		);
	}

	return { ops, markedGaps, sectionBreakdown };
}

// ── beat-cut path ────────────────────────────────────────────────────────────

/**
 * Fallback pacing (seconds/shot) used ONLY when `opts.beats` is absent — an
 * "average shot length" v1 approximation (documented, same posture as
 * `tightenToLength`'s own approximation note) so a beat-cut section still
 * gets multiple shot changes instead of one static clip when no real beat
 * grid was injected.
 */
export const DEFAULT_BEAT_CUT_SHOT_LEN_SEC = 3;

/**
 * Beat-cut path (design doc §4): allocate `materialRefs` across beat-grid
 * positions per section, shot changes on beats, respecting the shared
 * min-clip-duration floor. Two phases:
 *
 *  1. INITIAL ALLOCATION (this function's main loop) — per section, pick a
 *     shot count (from real beats within the section's span when
 *     `opts.beats` is supplied, else {@link DEFAULT_BEAT_CUT_SHOT_LEN_SEC}),
 *     clamp it so no shot falls below `minClipDurationSec`, then round-robin
 *     through the section's placeable (`video`/`image`) `materialRefs` —
 *     REUSING a candidate when `shotCount` exceeds the material available is
 *     a deliberate, bounded choice (real footage shown twice, e.g. a
 *     repeated cutaway — never generated, so ADR-007 is untouched). Each
 *     shot is one `addClip` (tool-catalog.ts:2167-2198), capped to the
 *     asset's own `durationSec` (never fabricating more source than exists).
 *  2. JOIN-SNAPPING (only when `opts.beats` is non-empty) — feeds every
 *     placed clip, across the WHOLE plan (sections are contiguous, so
 *     section-to-section joins are real joins too), into `cutOnBeat`
 *     (`craft/cut-on-beat.ts`, imported READ-ONLY, not redefined) so every
 *     cut point lands on the nearest beat within tolerance. `cutOnBeat`
 *     already merges a clip's two joins into ONE `trim` op — the exact
 *     "no two ops trim the same element to conflicting values" precedent
 *     the cross-cutting invariants ask for, reused rather than
 *     reimplemented.
 *
 * `move` is NOT used here: `cutOnBeat`'s snap adjusts each side of a join via
 * `trim` (`startTime`/`trimStart`/`duration` together, one call) rather than
 * a separate reposition, so no `CraftOp` in this path ever needs `move`'s
 * `newStartTime` reshuffle — a future increment that re-orders shots (rather
 * than only nudging existing joins) would be the first to need it.
 */
function runBeatCutAssembly(
	sortedSections: TreatmentSection[],
	assetsById: Map<string, FootageInventoryAsset>,
	opts: PlanAssemblyOptions,
	minClipDurationSec: number,
): {
	ops: CraftOp[];
	markedGaps: MarkedGap[];
	sectionBreakdown: AssemblySectionBreakdown[];
} {
	const ops: CraftOp[] = [];
	const markedGaps: MarkedGap[] = [];
	const sectionBreakdown: AssemblySectionBreakdown[] = [];
	const beatCutClips: CraftClip[] = [];
	const beats = opts.beats ?? [];
	let cursor = 0;

	for (const section of sortedSections) {
		const candidates = section.materialRefs
			.map((ref) => assetsById.get(ref))
			.filter(
				(a): a is FootageInventoryAsset =>
					!!a &&
					(a.kind === "video" || a.kind === "image") &&
					a.durationSec > CRAFT_EPSILON,
			);

		if (candidates.length === 0) {
			markedGaps.push({
				startSec: roundSec(cursor),
				durationSec: roundSec(section.targetSec),
				note: `beat-cut: section "${section.intent}" has no placeable video/image materialRefs with a known duration — never inventing material (ADR-007).`,
			});
			sectionBreakdown.push({
				intent: section.intent,
				order: section.order,
				targetSec: section.targetSec,
				projectedSec: 0,
				gap: true,
			});
			cursor = roundSec(cursor + section.targetSec);
			continue;
		}

		const beatsInSpan = beats.filter(
			(b) =>
				b.time > cursor + CRAFT_EPSILON &&
				b.time < cursor + section.targetSec - CRAFT_EPSILON,
		).length;
		const desiredShotCount =
			beats.length > 0
				? beatsInSpan + 1
				: Math.max(
						1,
						Math.round(section.targetSec / DEFAULT_BEAT_CUT_SHOT_LEN_SEC),
					);
		const maxShotsForMinDuration = Math.max(
			1,
			Math.floor(section.targetSec / minClipDurationSec),
		);
		const shotCount = Math.min(desiredShotCount, maxShotsForMinDuration);
		const shareLen = section.targetSec / shotCount;

		let localCursor = cursor;
		let sectionProjected = 0;
		for (let i = 0; i < shotCount; i++) {
			const asset = candidates[i % candidates.length];
			const durationSec = roundSec(Math.min(shareLen, asset.durationSec));
			if (durationSec <= CRAFT_EPSILON) continue;
			const addClipIndex = ops.length;
			ops.push({
				verb: "addClip",
				args: {
					mediaId: asset.id,
					startTime: roundSec(localCursor),
					duration: durationSec,
				},
			});
			const elementRef = pendingElementRef(addClipIndex);
			beatCutClips.push({
				elementId: elementRef,
				startSec: roundSec(localCursor),
				durationSec,
				trimStart: 0,
			});
			localCursor = roundSec(localCursor + durationSec);
			sectionProjected = roundSec(sectionProjected + durationSec);
		}

		sectionBreakdown.push({
			intent: section.intent,
			order: section.order,
			targetSec: section.targetSec,
			projectedSec: sectionProjected,
			gap: false,
		});
		cursor = roundSec(cursor + sectionProjected);
	}

	if (beats.length > 0 && beatCutClips.length >= 2) {
		const snap = cutOnBeat(beatCutClips, beats, {
			toleranceSec: opts.beatSnap?.toleranceSec,
			minClipDurationSec:
				opts.beatSnap?.minClipDurationSec ?? minClipDurationSec,
		});
		ops.push(...snap.ops);
	}

	return { ops, markedGaps, sectionBreakdown };
}

// ── top-level entry point ───────────────────────────────────────────────────

/**
 * Turn a `Treatment` + `FootageInventory` into an {@link AssemblyPlanResult}
 * (a real `AssemblyPlan`, plus the duration-convergence summary — see that
 * type's doc comment). Dispatches on `selectAssemblyStrategy` (or
 * `opts.forceStrategy`):
 *   - `strategy: "beat-cut"` ⇒ `runBeatCutAssembly`.
 *   - `strategy: "radio-cut"`, `basis !== "fallback-sequential"` ⇒
 *     `runSequentialAssembly` with real transcript segments
 *     (`gatherRadioCutUnits`).
 *   - `strategy: "radio-cut"`, `basis === "fallback-sequential"` ⇒ the same
 *     sequencer with WHOLE clips (`gatherFallbackUnits`) — the "simple
 *     sequential assembly" fallback the spec calls for.
 *
 * Deterministic: sections are stable-sorted by `order` first (a `Treatment`
 * makes no ordering guarantee on its `sections` array itself), every
 * downstream walk is index-order over already-sorted/looked-up data, no
 * `Math.random`, no wall-clock read.
 *
 * Empty treatment (`treatment.sections.length === 0`) ⇒ empty plan
 * (`ops: []`, `markedGaps: []`) + a `note` explaining why, per the
 * cross-cutting invariants.
 */
export function planAssembly(
	treatment: Treatment,
	inventory: FootageInventory,
	opts: PlanAssemblyOptions = {},
): AssemblyPlanResult {
	const decision: AssemblyStrategyDecision = opts.forceStrategy
		? {
				strategy: opts.forceStrategy,
				basis: "forced",
				rationale: `forced via opts.forceStrategy ("${opts.forceStrategy}")`,
			}
		: selectAssemblyStrategy(inventory, opts.brief);

	if (treatment.sections.length === 0) {
		return {
			strategy: decision.strategy,
			ops: [],
			markedGaps: [],
			projectedDurationSec: 0,
			sectionBreakdown: [],
			strategyRationale: decision.rationale,
			note: "empty treatment — no sections to assemble",
		};
	}

	const sortedSections = treatment.sections
		.map((section, index) => ({ section, index }))
		.sort((a, b) => a.section.order - b.section.order || a.index - b.index)
		.map(({ section }) => section);

	const assetsById = new Map(inventory.assets.map((a) => [a.id, a]));
	const minClipDurationSec =
		opts.minClipDurationSec ?? CUT_ON_BEAT_DEFAULT_MIN_CLIP_DURATION_SEC;
	const toleranceSec =
		opts.segmentFitToleranceSec ?? DEFAULT_SEGMENT_FIT_TOLERANCE_SEC;

	let built: {
		ops: CraftOp[];
		markedGaps: MarkedGap[];
		sectionBreakdown: AssemblySectionBreakdown[];
	};

	if (decision.strategy === "beat-cut") {
		built = runBeatCutAssembly(
			sortedSections,
			assetsById,
			opts,
			minClipDurationSec,
		);
	} else if (decision.basis === "fallback-sequential") {
		built = runSequentialAssembly(
			sortedSections,
			assetsById,
			toleranceSec,
			minClipDurationSec,
			gatherFallbackUnits,
			"simple sequential fallback",
		);
	} else {
		built = runSequentialAssembly(
			sortedSections,
			assetsById,
			toleranceSec,
			minClipDurationSec,
			(section, byId) => gatherRadioCutUnits(section, byId, opts),
			"radio-cut",
		);
	}

	const projectedDurationSec = roundSec(
		built.sectionBreakdown.reduce((sum, b) => sum + b.projectedSec, 0),
	);
	const treatmentTotalSec = sortedSections.reduce(
		(sum, s) => sum + s.targetSec,
		0,
	);
	const aggregateToleranceSec = aggregateDurationToleranceSec(
		sortedSections.length,
		toleranceSec,
	);
	const drift = roundSec(projectedDurationSec - treatmentTotalSec);
	const note =
		Math.abs(drift) > aggregateToleranceSec
			? `projected ${projectedDurationSec}s vs treatment total ${roundSec(treatmentTotalSec)}s — shortfall ${drift}s (outside ${roundSec(aggregateToleranceSec)}s tolerance)`
			: undefined;

	return {
		strategy: decision.strategy,
		ops: built.ops,
		markedGaps: built.markedGaps,
		projectedDurationSec,
		sectionBreakdown: built.sectionBreakdown,
		strategyRationale: decision.rationale,
		note,
	};
}

// ── cross-cutting invariants (exported for tests) ──────────────────────────

/**
 * Checks the four cross-cutting invariants the spec calls for against an
 * already-built {@link AssemblyPlanResult}. Returns a list of violation
 * strings (empty ⇒ clean). Pure — no execution, no re-simulation, just a
 * structural pass over the plan `planAssembly` already produced:
 *   1. Every `addClip.args.mediaId` resolves against `inventory.assets`.
 *   2. Every `trim`/`move`/`split` op's `slotId` is a {@link pendingElementRef}
 *      pointing at an EARLIER `addClip` op in this SAME `ops` array (v1 never
 *      references a pre-existing timeline element — every placement goes
 *      through a fresh `addClip`, per ADR-007's zero-generation posture
 *      applied to "zero reuse of clips this plan didn't itself create").
 *   3. No element is the target of more than one `trim` op (the "merge, the
 *      cut-on-beat precedent" rule — a second trim on the same element would
 *      silently clobber the first at execution).
 *   4. `projectedDurationSec` is within the aggregate tolerance of the
 *      treatment's total `targetSec`, OR the plan carries a `note`
 *      explaining the shortfall (checked here for both the empty-treatment
 *      case and the general case).
 */
export function findAssemblyPlanInvariantViolations(
	result: AssemblyPlanResult,
	treatment: Treatment,
	inventory: FootageInventory,
): string[] {
	const violations: string[] = [];

	if (treatment.sections.length === 0) {
		if (result.ops.length !== 0 || result.markedGaps.length !== 0) {
			violations.push(
				"empty treatment must produce an empty plan (no ops, no markedGaps).",
			);
		}
		if (!result.note) {
			violations.push(
				"empty treatment must carry a `note` explaining the empty plan.",
			);
		}
		return violations;
	}

	const assetIds = new Set(inventory.assets.map((a) => a.id));
	const trimTouchCount = new Map<string, number>();

	result.ops.forEach((op, i) => {
		if (op.verb === "addClip") {
			const mediaId = op.args.mediaId;
			if (typeof mediaId !== "string" || !assetIds.has(mediaId)) {
				violations.push(
					`ops[${i}] (addClip) references mediaId "${String(mediaId)}", not present in the inventory.`,
				);
			}
			return;
		}
		if (op.verb === "trim" || op.verb === "move" || op.verb === "split") {
			const slotId = op.args.slotId;
			if (typeof slotId !== "string" || !isPendingElementRef(slotId)) {
				violations.push(
					`ops[${i}] (${op.verb}) has a non-pending-ref slotId "${String(slotId)}" — every op this planner emits targets a clip it JUST created via addClip.`,
				);
				return;
			}
			const refIndex = pendingRefIndex(slotId);
			if (
				refIndex === undefined ||
				refIndex >= i ||
				result.ops[refIndex]?.verb !== "addClip"
			) {
				violations.push(
					`ops[${i}] (${op.verb}) references "${slotId}", which is not an EARLIER addClip op in this same plan.`,
				);
			}
			if (op.verb === "trim") {
				trimTouchCount.set(slotId, (trimTouchCount.get(slotId) ?? 0) + 1);
			}
		}
	});

	for (const [slotId, count] of trimTouchCount) {
		if (count > 1) {
			violations.push(
				`element "${slotId}" is trimmed by ${count} separate ops — must be merged into one trim (cut-on-beat precedent).`,
			);
		}
	}

	const treatmentTotalSec = treatment.sections.reduce(
		(sum, s) => sum + s.targetSec,
		0,
	);
	const diff = Math.abs(result.projectedDurationSec - treatmentTotalSec);
	const toleranceSec = aggregateDurationToleranceSec(treatment.sections.length);
	if (diff > toleranceSec && !result.note) {
		violations.push(
			`projectedDurationSec (${result.projectedDurationSec}) drifts ${diff}s from the treatment total (${treatmentTotalSec}) beyond tolerance (${toleranceSec}) with no shortfall note recorded.`,
		);
	}

	return violations;
}
