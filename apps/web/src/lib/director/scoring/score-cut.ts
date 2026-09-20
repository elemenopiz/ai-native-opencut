/**
 * Local "Engagement Score" for the assembled cut — the data path behind the
 * Director's `scoreCut` verb (`director-api.ts`), Wave 2 "scoreCut".
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, INSTEAD OF CALLING A MODEL/BACKEND
 * ──────────────────────────────────────────────────────────────────────────
 * Two things killed the "call an external scorer" plan (see
 * `apps/web/docs/higgsfield/REST-CATALOG.md` §4A for the Higgsfield dead
 * end, and `docs/decisions/ADR-004*` for why the Python ai-backend
 * `aiClient.engagementScore` talks to isn't deployed):
 *  1. Higgsfield's `brain_activity` ("Virality Predictor") is not reachable
 *     over their public REST API — every spelling 404s.
 *  2. This repo's OWN existing scorer
 *     (`components/editor/youtube/engagement-panel.tsx`'s `defaultScoreFn`,
 *     `aiClient.engagementScore`) calls a Python backend that is not
 *     deployed to production, so it only ever works in local dev.
 *
 * But the INTERPRETATION half of that scorer — turning seven raw signals
 * into a hook diagnostic, a hold-rate/retention curve with drop-off points,
 * and an attention heatmap — already lives in this repo as a PURE,
 * backend-free function: `@/lib/engagement-diagnostics`'s `deriveDiagnostics`.
 * It just needs an `EngagementScoreResult`-shaped input (the seven
 * `hook`/`curiosity`/`energy`/`audio_sync`/`face_presence`/`emotional_arc`/
 * `virality` composites the backend used to compute from video+audio ML).
 *
 * This module supplies that input WITHOUT a backend, by deriving each
 * composite from data the Director already has and already exposes as
 * read-only accessors (`program/derived-data.ts`'s `clips()`/`speech()`/
 * `beats()`, and `readMix()`'s measured loudness curve when a mixdown
 * decodes) — REUSE, never reimplement, same discipline `derived-data.ts`'s
 * own header states. See {@link scoreCut}'s doc comment for exactly which
 * accessor feeds which composite.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HONESTY ABOUT WHAT CANNOT BE MEASURED
 * ──────────────────────────────────────────────────────────────────────────
 * `face_presence` — "is a face visible in the opening frames?" — needs a
 * vision/face-detection pass this repo does not have (the closest thing,
 * `vision-critic.ts`, judges a single take's frames against its OWN prompt
 * via a model call; there is no local, backend-free face detector). Rather
 * than inventing a plausible-looking number, `scoreCut` sets this composite
 * to the SAME neutral fallback `engagement-diagnostics.ts` already uses for
 * any signal it doesn't have (`comp()`'s `fallback = 50`) and reports it in
 * {@link ScoreCutResult.unmeasuredSignals} so a caller can see, in plain
 * language, that this one axis is not a real reading. `audio_sync` and
 * `emotional_arc` degrade the SAME honest way when their real inputs (a
 * beat grid, a decoded mix) are absent — see {@link computeAudioSyncSignal}
 * and {@link computeEmotionalArcSignal}'s own doc comments.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PLUGGABLE, LIKE THE PANEL'S OWN SCORER SEAM
 * ──────────────────────────────────────────────────────────────────────────
 * `engagement-panel.tsx` already treats its scorer as swappable (the
 * `EngagementScoreFn` prop, currently defaulted to `aiClient.engagementScore`
 * — see that file's own doc comment: "A Higgsfield model-based video scorer
 * will plug in here later"). This module does not touch that panel or that
 * seam. Instead it gives the DIRECTOR side of the app the exact same shape
 * of seam: {@link scoreCut} is a plain, swappable function from a
 * {@link ScoreCutInput} to a {@link ScoreCutResult} — nothing about
 * `director-api.ts`'s `scoreCut` verb (which calls this) or `edit-critic.ts`
 * (which reads its `diagnostics`) depends on the computation being LOCAL. A
 * later model-based scorer drops in by producing the same
 * `EngagementScoreResult` shape and skipping straight to `deriveDiagnostics`
 * — this module's compute* helpers are not part of that contract.
 *
 * NOT a `GenerationBackend`: this returns a score, never media, so it does
 * not implement (or pretend to implement) that interface — it is its own
 * small module, imported directly by `director-api.ts`.
 */

import type {
	EngagementScoreResult,
	EngagementSubScore,
} from "@/lib/ai-client";
import {
	deriveDiagnostics,
	type EngagementDiagnostics,
} from "@/lib/engagement-diagnostics";
import type { TranscriptionSegment } from "@/types/ai";
import type { CutScoreAxis, CutScoreInput } from "../edit-critic";

// ── input shape: the raw materials the Director already has ────────────────

/** One timeline clip, as `program/derived-data.ts`'s `clips()` projects it — only the fields this module's signals need. */
export interface ScoreCutClip {
	id: string;
	/** `TimelineElement.type` — "video" | "image" | "text" | "audio" | "sticker" | "effect". */
	kind: string;
	startSec: number;
	durationSec: number;
}

/** One speech span, as `program/derived-data.ts`'s `speech()` projects it — already TIMELINE-absolute (see that accessor's own doc comment), so it drops straight into `TranscriptionSegment.start`/`.end`. */
export interface ScoreCutSpeechSpan {
	startSec: number;
	endSec: number;
	text: string;
}

/** One beat marker, as `program/derived-data.ts`'s `beats()` projects it — already TIMELINE-absolute. */
export interface ScoreCutBeat {
	time: number;
	isDownbeat: boolean;
}

/** One loudness sample, as `readMix()`'s `MixReadData.loudnessCurve` reports it (dBFS). */
export interface ScoreCutLoudnessPoint {
	atSec: number;
	levelDb: number;
}

export interface ScoreCutInput {
	/** Every clip on every track, any kind — used for structural pacing/hook signals. */
	clips: ScoreCutClip[];
	/** Projected speech spans (voiceover + transcript-derived) — `[]` when the cut has no dialogue. */
	speech: ScoreCutSpeechSpan[];
	/** Beat markers, when a beat grid has been analyzed. `undefined` (not `[]`) means "not analyzed" — see {@link computeAudioSyncSignal}. */
	beats?: ScoreCutBeat[];
	/** Total assembled-cut duration, seconds. */
	totalDurationSec: number;
	/** The measured loudness curve from a successful `readMix()` call, when one was run. `undefined` means "no mix was decoded" — see {@link computeEnergySignal}/{@link computeEmotionalArcSignal}. */
	loudnessCurveDb?: ScoreCutLoudnessPoint[];
}

export interface ScoreCutResult {
	/** The synthesized `EngagementScoreResult` — same shape `aiClient.engagementScore` used to return, so `deriveDiagnostics` and every existing consumer of that shape (e.g. `score-breakdown.tsx`) work unmodified. */
	score: EngagementScoreResult;
	/** `deriveDiagnostics(score, …)` — the hook/hold-rate/heatmap breakdown. */
	diagnostics: EngagementDiagnostics;
	/** The same score, reshaped for `edit-critic.ts`'s `formatCutScoreSummary`/`CutScoreInput` seam (the "external cut-score seam" that module's header already documents as fitting this exact source). */
	cutScore: CutScoreInput;
	/** Plain-language notes on which signals are NOT real local measurements and what stood in for them — never silently absorbed into a number that looks measured. */
	unmeasuredSignals: string[];
}

/** {@link CutScoreInput.source} for a `scoreCut` result — named in `edit-critic.ts`'s own doc comment as one of the two sources that seam is shaped for. */
export const LOCAL_ENGAGEMENT_SCORER_SOURCE = "local-engagement-scorer";

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

function isVisual(kind: string): boolean {
	return kind === "video" || kind === "image";
}

function visualClipsSorted(clips: ScoreCutClip[]): ScoreCutClip[] {
	return clips
		.filter((c) => isVisual(c.kind))
		.sort((a, b) => a.startSec - b.startSec);
}

// ── hook (opening ~3s) ───────────────────────────────────────────────────────

/** Width of the "does the opening grab attention" window — mirrors `edit-critic.ts`'s `DEFAULT_HOOK_WINDOW_SEC`. */
const HOOK_WINDOW_SEC = 3;

/**
 * Structural proxy for the backend's `hook` composite — NO vision model, so
 * this cannot judge what the opening frame actually LOOKS like. What it can
 * measure, honestly, from the timeline alone:
 *  - is there visual content at all at the very start (a hook needs
 *    something on screen), and does it start punctually or after a gap;
 *  - is the opening shot short (a tight, punchy cut) or does it linger
 *    (long static shots read as a weak hook regardless of content);
 *  - does someone start talking within the first couple of seconds (an
 *    engaged, immediate opening line vs. a slow build-up).
 * Deliberately does NOT re-score the opening TEXT (question/bold-claim/
 * open-loop phrasing) here — `deriveDiagnostics`'s own `deriveHook` already
 * applies that nudge from `input.segments`, so doing it again here would
 * double-count the same signal.
 */
function computeHookSignal(
	clips: ScoreCutClip[],
	speech: ScoreCutSpeechSpan[],
): number {
	const visual = visualClipsSorted(clips);
	const first = visual[0];
	if (!first) return 20; // nothing on screen at all — there is no hook to judge

	let score = 50;
	if (first.startSec <= 0.15) score += 15;
	else if (first.startSec < HOOK_WINDOW_SEC) score += 5;
	else score -= 20; // dead air before anything is even visible

	if (first.durationSec <= 3) score += 15;
	else if (first.durationSec <= 6) score += 6;
	else if (first.durationSec > 12) score -= 12;

	const earlyLine = speech.some(
		(s) => s.startSec < 2 && s.text.trim().length > 0,
	);
	score += earlyLine ? 10 : -5;

	return clamp(Math.round(score));
}

// ── curiosity (whole-transcript density) ────────────────────────────────────

/**
 * Small, independent marker list for a curiosity-gap density scan across the
 * WHOLE transcript (as opposed to `deriveHook`'s own opening-only check).
 * Deliberately NOT imported from `engagement-diagnostics.ts` — that module's
 * `CURIOSITY_WORDS`/`OPEN_LOOP_PHRASES` are private (unexported), and this
 * module must not edit that file (it's live code other surfaces depend on).
 * A smaller independent list is an honest, separate heuristic, not a
 * reimplementation of that module's internals.
 */
const CURIOSITY_MARKERS = [
	"?",
	"never",
	"always",
	"secret",
	"mistake",
	"wrong",
	"truth",
	"actually",
	"here's why",
	"here's what",
	"here's how",
	"wait until",
	"you won't believe",
	"the thing is",
	"keep watching",
	"nobody tells you",
];

function computeCuriositySignal(fullText: string): number {
	const t = fullText.trim();
	if (!t) return 35; // no dialogue at all to build curiosity with
	const lower = t.toLowerCase();
	const wordCount = t.split(/\s+/).length || 1;
	let hits = 0;
	for (const marker of CURIOSITY_MARKERS) {
		if (lower.includes(marker)) hits++;
	}
	const perHundredWords = (hits / wordCount) * 100;
	return clamp(Math.round(30 + perHundredWords * 18));
}

// ── energy ───────────────────────────────────────────────────────────────────

/**
 * `energy` composite. Prefers a REAL measurement — the dynamic range/spread
 * of the actual mixed-down loudness curve (`readMix()`'s output, when a
 * mixdown decoded) — over a structural proxy. Without a decoded mix, falls
 * back to cutting pace (cuts/minute): more frequent cuts read as higher
 * energy, which is a legitimate, if coarse, PACING signal — not a fabricated
 * constant, but explicitly weaker than a real loudness reading, hence the
 * caller reports it as such (see {@link scoreCut}'s `unmeasuredSignals`).
 */
function computeEnergySignal(
	clips: ScoreCutClip[],
	totalDurationSec: number,
	loudnessCurveDb: ScoreCutLoudnessPoint[] | undefined,
): number {
	if (loudnessCurveDb && loudnessCurveDb.length > 1) {
		const levels = loudnessCurveDb
			.map((p) => p.levelDb)
			.filter((v) => Number.isFinite(v));
		if (levels.length > 1) {
			const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
			const variance =
				levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length;
			const spreadDb = Math.sqrt(variance);
			// Louder average + more dynamic variation reads as more energetic.
			return clamp(Math.round(45 + spreadDb * 6 + (mean + 40) * 0.7));
		}
	}
	const visual = visualClipsSorted(clips);
	if (visual.length === 0 || !(totalDurationSec > 0)) return 40;
	const cutsPerMin = (visual.length / totalDurationSec) * 60;
	return clamp(Math.round(35 + cutsPerMin * 4));
}

// ── audio_sync (cuts landing on the beat) ───────────────────────────────────

/** A cut must land within this many seconds of an actual join to be scored — mirrors `program/programs/cut-on-beat.ts`'s own join detection (`abs(starts[i+1]-leftEnd) <= EPSILON`, loosened here since these are already-placed clips, not the program's working copy). */
const JOIN_EPSILON_SEC = 0.05;
/** A cut this far (or farther) from the nearest beat scores 0 for that join. */
const AUDIO_SYNC_WORST_OFFSET_SEC = 0.5;

/**
 * `audio_sync` composite: how closely do cuts between adjacent visual clips
 * land on an analyzed beat? Reuses the SAME beat data `applyEdit`'s
 * `cutOnBeat`-shaped programs read (`program/derived-data.ts`'s `beats()`),
 * not a re-detection.
 *
 * `beats === undefined` means no beat grid has been analyzed for this
 * project at all — genuinely unmeasurable, not merely "quiet" — so this
 * returns the same neutral 50 `engagement-diagnostics.ts`'s own `comp()`
 * fallback uses for a missing signal, and the caller lists it in
 * `unmeasuredSignals`. `beats === []` (analyzed, but no beats in view) is
 * treated the same way: there is nothing to snap to either way.
 */
function computeAudioSyncSignal(
	clips: ScoreCutClip[],
	beats: ScoreCutBeat[] | undefined,
): number {
	if (!beats || beats.length === 0) return 50;
	const visual = visualClipsSorted(clips);
	if (visual.length < 2) return 50;

	const times = beats.map((b) => b.time);
	let totalOffset = 0;
	let joins = 0;
	for (let i = 1; i < visual.length; i++) {
		const prevEnd = visual[i - 1].startSec + visual[i - 1].durationSec;
		const cutAt = visual[i].startSec;
		if (Math.abs(cutAt - prevEnd) > JOIN_EPSILON_SEC) continue; // a gap, not a real join
		let nearest = Number.POSITIVE_INFINITY;
		for (const t of times) nearest = Math.min(nearest, Math.abs(t - cutAt));
		totalOffset += nearest;
		joins++;
	}
	if (joins === 0) return 50; // no back-to-back joins to judge (e.g. every clip has a gap after it)

	const avgOffsetSec = totalOffset / joins;
	return clamp(
		Math.round(100 - (avgOffsetSec / AUDIO_SYNC_WORST_OFFSET_SEC) * 100),
	);
}

// ── emotional_arc ────────────────────────────────────────────────────────────

interface EmotionalArcSignal {
	composite: number;
	has_strong_open?: boolean;
	has_buildup?: boolean;
	has_peak?: boolean;
	peak_timestamp?: number;
}

/**
 * `emotional_arc` composite + the boolean facets `engagement-diagnostics.ts`'s
 * synthetic-heatmap fallback reads (`has_strong_open`/`has_buildup`/
 * `has_peak`/`peak_timestamp` — see that module's `buildHeatmap`). Prefers
 * the REAL measured loudness curve (a genuine build/peak shape); without one,
 * falls back to a shot-PACING proxy (does the cut tighten its shots later
 * on, the classic build-to-a-faster-payoff shape) — again a real, if coarse,
 * structural signal, not a fabricated constant, and reported as a fallback
 * in `unmeasuredSignals`.
 */
function computeEmotionalArcSignal(
	clips: ScoreCutClip[],
	loudnessCurveDb: ScoreCutLoudnessPoint[] | undefined,
): EmotionalArcSignal {
	if (loudnessCurveDb && loudnessCurveDb.length > 2) {
		let peakIdx = 0;
		for (let i = 1; i < loudnessCurveDb.length; i++) {
			if (loudnessCurveDb[i].levelDb > loudnessCurveDb[peakIdx].levelDb)
				peakIdx = i;
		}
		const levels = loudnessCurveDb.map((p) => p.levelDb);
		const spreadDb = Math.max(...levels) - Math.min(...levels);
		const hasStrongOpen = loudnessCurveDb[0].levelDb > -24;
		const hasPeak = peakIdx > 0 && peakIdx < loudnessCurveDb.length - 1;
		const hasBuildup = peakIdx >= Math.floor(loudnessCurveDb.length * 0.15);
		const composite = clamp(
			Math.round(
				40 + spreadDb * 3 + (hasPeak ? 10 : 0) + (hasBuildup ? 10 : 0),
			),
		);
		return {
			composite,
			has_strong_open: hasStrongOpen,
			has_buildup: hasBuildup,
			has_peak: hasPeak,
			peak_timestamp: loudnessCurveDb[peakIdx].atSec,
		};
	}

	const visual = visualClipsSorted(clips);
	if (visual.length < 3) return { composite: 45 };
	const mid = Math.floor(visual.length / 2);
	const avgDur = (list: ScoreCutClip[]) =>
		list.reduce((sum, c) => sum + c.durationSec, 0) / (list.length || 1);
	const earlyAvg = avgDur(visual.slice(0, mid));
	const lateAvg = avgDur(visual.slice(mid));
	const buildup = lateAvg < earlyAvg;
	return {
		composite: clamp(Math.round(45 + (buildup ? 15 : -5))),
		has_buildup: buildup,
	};
}

// ── virality (only `hook_strength` is read downstream) ──────────────────────

/**
 * `deriveDiagnostics`'s `deriveHook` reads exactly ONE field off `virality`:
 * `hook_strength` (a 0-25 sub-signal, scaled ×4 back to 0-100 — see that
 * module's `deriveHook`). Deriving it from the SAME hook signal this module
 * already computed keeps the two numbers consistent instead of guessing a
 * second, independent "viral hook" figure this repo has no data for.
 */
function computeViralitySignal(hookScore: number): {
	composite: number;
	hook_strength: number;
} {
	return { composite: hookScore, hook_strength: Math.round(hookScore / 4) };
}

// ── overall composite + grade ────────────────────────────────────────────────

/**
 * Blend weights for the overall composite. Own choice (the retired backend's
 * own weighting is not recoverable), leaning on `hook` — the axis this
 * product's engagement work has consistently prioritized (see
 * `docs/beat_launch_directives`/the "hook" emphasis throughout
 * `engagement-diagnostics.ts` and `edit-critic.ts`'s own critic prompt) —
 * with `face_presence` weighted lowest since it is never a real
 * measurement here (see this module's header).
 */
const COMPOSITE_WEIGHTS: Record<string, number> = {
	hook: 0.25,
	curiosity: 0.15,
	energy: 0.15,
	audio_sync: 0.15,
	face_presence: 0.05,
	emotional_arc: 0.15,
	virality: 0.1,
};

function overallComposite(subs: Record<string, EngagementSubScore>): number {
	let sum = 0;
	for (const [key, weight] of Object.entries(COMPOSITE_WEIGHTS)) {
		sum += (subs[key]?.composite ?? 50) * weight;
	}
	return clamp(Math.round(sum));
}

/**
 * Letter grade + label from the composite. Engagement/craft language only —
 * NO "viral"/"virality"/"hook score" wording anywhere in a user-facing
 * string (standing product directive: Byorn is a serious editor, "Virality
 * Score" was deliberately removed from the app — see git history around
 * @8161be45).
 */
function gradeFor(composite: number): { grade: string; gradeLabel: string } {
	if (composite >= 85) return { grade: "A", gradeLabel: "Strong cut" };
	if (composite >= 70) return { grade: "B", gradeLabel: "Solid cut" };
	if (composite >= 55) return { grade: "C", gradeLabel: "Needs polish" };
	if (composite >= 40) return { grade: "D", gradeLabel: "Weak cut" };
	return { grade: "F", gradeLabel: "Rough cut" };
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Score the assembled cut, entirely locally: no network call, no backend, no
 * key. Synthesizes an `EngagementScoreResult` from real, available signals
 * (see each `compute*Signal` helper above for exactly which one and how it
 * degrades when its real input is absent), then hands it to
 * `@/lib/engagement-diagnostics`'s `deriveDiagnostics` — UNCHANGED, exactly
 * the same pure function `engagement-panel.tsx`'s consumer would eventually
 * call with a backend-sourced result — to get the hook/hold-rate/heatmap
 * breakdown other surfaces already know how to read.
 */
export function scoreCut(input: ScoreCutInput): ScoreCutResult {
	const fullSpeechText = input.speech.map((s) => s.text).join(" ");

	const hookScore = computeHookSignal(input.clips, input.speech);
	const curiosityScore = computeCuriositySignal(fullSpeechText);
	const energyScore = computeEnergySignal(
		input.clips,
		input.totalDurationSec,
		input.loudnessCurveDb,
	);
	const audioSyncScore = computeAudioSyncSignal(input.clips, input.beats);
	const arc = computeEmotionalArcSignal(input.clips, input.loudnessCurveDb);
	const virality = computeViralitySignal(hookScore);

	const hook: EngagementSubScore = { composite: hookScore };
	const curiosity: EngagementSubScore = { composite: curiosityScore };
	const energy: EngagementSubScore = { composite: energyScore };
	const audio_sync: EngagementSubScore = { composite: audioSyncScore };
	// See this module's header — genuinely unmeasurable locally; neutral by
	// the same convention `engagement-diagnostics.ts`'s own `comp()` uses.
	const face_presence: EngagementSubScore = { composite: 50 };
	const emotional_arc: EngagementSubScore = {
		composite: arc.composite,
		...(arc.has_strong_open !== undefined
			? { has_strong_open: arc.has_strong_open }
			: {}),
		...(arc.has_buildup !== undefined ? { has_buildup: arc.has_buildup } : {}),
		...(arc.has_peak !== undefined ? { has_peak: arc.has_peak } : {}),
		...(arc.peak_timestamp !== undefined
			? { peak_timestamp: arc.peak_timestamp }
			: {}),
	};
	const viralitySub: EngagementSubScore = {
		composite: virality.composite,
		hook_strength: virality.hook_strength,
	};

	const subs: Record<string, EngagementSubScore> = {
		hook,
		curiosity,
		energy,
		audio_sync,
		face_presence,
		emotional_arc,
		virality: viralitySub,
	};
	const composite = overallComposite(subs);
	const { grade, gradeLabel } = gradeFor(composite);

	const result: EngagementScoreResult = {
		hook,
		curiosity,
		energy,
		audio_sync,
		face_presence,
		emotional_arc,
		virality: viralitySub,
		// Grounded, actionable remedies belong to `edit-critic.ts`'s
		// `suggestFixesForCutScore` (routes a weak hook/hold-rate to a real
		// `applyEdit`-shaped fix) — kept out of this raw result so there is
		// exactly one place that decides "what to do about it".
		suggestions: [],
		composite,
		grade,
		grade_label: gradeLabel,
	};

	const segments: TranscriptionSegment[] = input.speech.map((s, i) => ({
		id: i,
		text: s.text,
		start: s.startSec,
		end: s.endSec,
		words: [],
	}));

	const diagnostics = deriveDiagnostics({
		result,
		segments,
		duration: input.totalDurationSec > 0 ? input.totalDurationSec : undefined,
	});

	const axes: Record<string, CutScoreAxis> = subs;
	const cutScore: CutScoreInput = {
		source: LOCAL_ENGAGEMENT_SCORER_SOURCE,
		axes,
		overall: composite,
		grade,
		notes:
			"Derived locally from timeline structure, projected transcript, and (when analyzed) beat grid / measured mix loudness — no network call, no backend.",
	};

	const unmeasuredSignals: string[] = [
		"face_presence: no vision/face-detection backend available locally — neutral fallback (50) used, not a real measurement.",
	];
	if (!input.beats || input.beats.length === 0) {
		unmeasuredSignals.push(
			"audio_sync: no beat grid analyzed for this project — neutral fallback (50) used instead of a real cut-to-beat measurement.",
		);
	}
	if (!input.loudnessCurveDb || input.loudnessCurveDb.length <= 1) {
		unmeasuredSignals.push(
			"energy/emotional_arc: no mix could be decoded (readMix) — using cutting-pace/shot-duration structural proxies instead of measured loudness.",
		);
	}

	return { score: result, diagnostics, cutScore, unmeasuredSignals };
}
