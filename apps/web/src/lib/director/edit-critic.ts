/**
 * Whole-edit critic — the "judge the ASSEMBLED CUT as a film" sibling of
 * `vision-critic.ts` (which only ever judges ONE take against its own prompt).
 *
 * THE GAP THIS CLOSES: the Director can build a multi-shot timeline but never
 * steps back and asks "does this whole edit WORK?" — is the hook up front, do
 * cuts land on the beat, is there dead air, does shot variety hold, does the
 * emotional arc make sense? This module supplies the pure pieces of that
 * critic:
 *
 *  - {@link planFrameSamples} decides WHICH timeline positions to sample
 *    frames from — spread across the assembled cut, weighted toward the first
 *    {@link DEFAULT_HOOK_WINDOW_SEC} seconds (the "is the hook here?" test),
 *    hard-capped at {@link MAX_EDIT_CRITIC_FRAMES}. Pure position math; actual
 *    frame DECODING happens in `director-api.ts`'s `critiqueEdit` (same
 *    "pure plan, browser-bound decode" split `reviewTake` uses).
 *  - {@link detectVisualGaps} finds DEAD AIR — stretches with no video/image
 *    coverage on any track — from the same digest data, no frames needed.
 *  - {@link formatBeatGridSummary} renders the (already-summarized, no raw
 *    timestamps) beat-grid facts the asset manifest surfaces into one
 *    grounding line.
 *  - {@link formatTranscriptExcerpt} renders a capped, token-lean transcript
 *    excerpt from already-resolved segments.
 *  - {@link formatMixReadSummary} folds a `mix-read.ts` {@link MixRead}
 *    (loudness, speech/music ducking, dead air — the AUDIO half of "the
 *    agent cannot see its own work", `docs/plans/2026-09-18-director-
 *    autonomy-architecture.md` §4) into one grounding line, so the critic's
 *    judgement accounts for the mix, not just the picture: music burying
 *    dialogue, a hard cut landing in dead air, or mid-word.
 *  - {@link CutScoreInput} / {@link formatCutScoreSummary} open the SEAM for
 *    an external cut score (§4's `brain_activity` hook/attention/retention,
 *    plugged in later — no client lives here) alongside the local
 *    `aiClient.engagementScore` this repo already ships. Typed and
 *    documented only; see {@link CutScoreInput}'s own doc comment.
 *  - {@link EDIT_CRITIC_SYSTEM_PROMPT} / {@link buildEditCritiqueUserBlocks}
 *    frame the ONE tool-less "judge this cut" model call, reusing
 *    `dataUrlToImageBlock` from `vision-critic.ts` so real pixels ride to the
 *    model exactly the way `reviewTake`'s critic does.
 *  - {@link parseEditCritique} coerces the model's reply into a structured
 *    {@link EditCritique} the caller can act on — deterministically, and
 *    fail-safe (malformed output ⇒ an empty-issues critique, never a throw).
 *
 * ADVISORY-ONLY (ADR-006, `docs/decisions/ADR-006-advisory-first-critic.md`):
 * every `EditCritiqueIssue.proposedFix` names an EXECUTABLE `DirectorApi` verb
 * call, but this module — and v1 of `critiqueEdit` — NEVER executes it. A fix
 * runs only on an explicit later user action. There is no autonomous
 * critique→fix loop here.
 *
 * PURE LOGIC: no network, no React, no `DirectorApi`, no browser decode. Frame
 * decoding + the actual relay call live in `director-api.ts`'s `critiqueEdit`;
 * everything here is unit-testable without a browser.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { EngagementDiagnostics } from "@/lib/engagement-diagnostics";
import type { MixRead } from "./mix-read";
import { buildCutOnBeatProgram } from "./program/programs/cut-on-beat";
import { buildTightenToLengthProgram } from "./program/programs/tighten-to-length";
import { dataUrlToImageBlock } from "./vision-critic";

// ── EditCritique result shape ────────────────────────────────────────────────

/** The rubric axis an {@link EditCritiqueIssue} is judged on. */
export type EditCritiqueAxis =
	| "pacing"
	| "hook"
	| "variety"
	| "rhythm"
	| "dead-air"
	| "continuity"
	| "arc";

export const EDIT_CRITIQUE_AXES: readonly EditCritiqueAxis[] = [
	"pacing",
	"hook",
	"variety",
	"rhythm",
	"dead-air",
	"continuity",
	"arc",
] as const;

export type EditCritiqueSeverity = "low" | "med" | "high";

export const EDIT_CRITIQUE_SEVERITIES: readonly EditCritiqueSeverity[] = [
	"low",
	"med",
	"high",
] as const;

/** Where an issue lives — a timeline second and/or a specific element id. Both optional; at least one is expected in practice. */
export interface EditCritiqueLocation {
	/** Timeline-absolute seconds, when the critic can point at a moment. */
	sec?: number;
	/** The specific timeline element id (from `getTimeline`) the issue is about. */
	elementRef?: string;
}

/**
 * An EXECUTABLE `DirectorApi` verb call the critic proposes as a fix — e.g.
 * `{ verb: "trim", args: { slotId: "s3", trimEnd: 0.6 } }`. NEVER auto-executed
 * by v1 (ADR-006): surfaced to the user, who runs it (or an equivalent
 * command) explicitly.
 */
export interface ProposedFix {
	/** A real `DirectorApi`/tool-catalog verb name (e.g. "trim", "move", "split", "reorder", "remove", "removeSilence", "applyTransition"). */
	verb: string;
	/** Loose arg bag for that verb — shape mirrors the verb's own tool-catalog schema. */
	args: Record<string, unknown>;
}

/** One thing the critic flagged about the assembled cut. */
export interface EditCritiqueIssue {
	axis: EditCritiqueAxis;
	severity: EditCritiqueSeverity;
	location: EditCritiqueLocation;
	/** One or two sentences, specific enough to act on. */
	note: string;
	/** Present when the critic has a concrete, executable fix in mind. */
	proposedFix?: ProposedFix;
}

/** The critic's structured verdict on the WHOLE assembled cut. */
export interface EditCritique {
	/** One-to-two sentence overall read of the cut. */
	summary: string;
	/** Zero or more flagged issues. Empty ⇒ the critic found nothing worth flagging. */
	issues: EditCritiqueIssue[];
}

/** Hard cap on issues a parsed {@link EditCritique} carries — token/UI economy, same spirit as `CONTEXT_LIST_CAP`. */
export const MAX_EDIT_CRITIQUE_ISSUES = 20;

// ── frame sampling plan (pure position math; decoding happens elsewhere) ────

/** Hard cap on frames sampled per `critiqueEdit` call — non-negotiable (ADR-006 / Step-0 revision #2). */
export const MAX_EDIT_CRITIC_FRAMES = 12;

/** Default width of the "hook" window sample bias — the opening stretch a cold viewer decides to keep watching in. */
export const DEFAULT_HOOK_WINDOW_SEC = 3;

/** One frame-decodable (video/image) element as `planFrameSamples` needs to see it. */
export interface SamplableElement {
	id: string;
	kind: "video" | "image" | "text" | "audio" | "sticker" | "effect";
	/** Timeline start, seconds. */
	startSec: number;
	/** Visible (post-trim) duration, seconds. */
	durationSec: number;
	/** Full media-library asset id backing this element, when it has one. */
	mediaId?: string;
	/** Human label (e.g. from `getTimeline`'s `labelOf`), for the critic prompt. */
	label?: string;
}

/** One planned frame sample: WHICH element, and WHERE in timeline time to sample it. */
export interface FrameSamplePlanItem {
	elementId: string;
	mediaId?: string;
	label?: string;
	/** Timeline-absolute seconds to sample. Caller maps this through the element's trim to a SOURCE time before decoding. */
	atSec: number;
}

/**
 * Decide which timeline positions to sample frames from, spread across the
 * assembled cut and weighted toward the opening hook window — hard-capped at
 * {@link MAX_EDIT_CRITIC_FRAMES} BY CONSTRUCTION (the cap clamps the requested
 * `maxFrames` and the result is always sliced to it, so no caller can exceed
 * it). Only `video`/`image` elements are sample-able (text/audio/sticker/
 * effect elements carry no visual frame — mirrors `extractFrame`'s own
 * video-only restriction).
 *
 * Strategy: every element that starts within the hook window is ALWAYS kept
 * (the hook is the highest-value thing to see); the remaining budget is
 * spread as evenly as possible across the rest of the timeline in start-time
 * order, so a long cut samples representative moments throughout rather than
 * clustering at the start. Each element contributes at most one sample point:
 * the midpoint of its hook-window overlap for a hook element (biased toward
 * its earliest visible instant — "is the hook actually here?"), or its own
 * midpoint otherwise (representative of the whole shot).
 */
export function planFrameSamples(
	elements: SamplableElement[],
	opts: { maxFrames?: number; hookWindowSec?: number } = {},
): FrameSamplePlanItem[] {
	const maxFrames = Math.max(
		1,
		Math.min(
			MAX_EDIT_CRITIC_FRAMES,
			Math.floor(opts.maxFrames ?? MAX_EDIT_CRITIC_FRAMES) ||
				MAX_EDIT_CRITIC_FRAMES,
		),
	);
	const hookWindowSec = Math.max(
		0,
		opts.hookWindowSec ?? DEFAULT_HOOK_WINDOW_SEC,
	);

	const candidates = elements
		.filter(
			(e) =>
				(e.kind === "video" || e.kind === "image") &&
				Number.isFinite(e.durationSec) &&
				e.durationSec > 0,
		)
		.sort((a, b) => a.startSec - b.startSec);

	if (candidates.length === 0) return [];

	const hookEls = candidates.filter((e) => e.startSec < hookWindowSec);
	const restEls = candidates.filter((e) => e.startSec >= hookWindowSec);

	const picks: SamplableElement[] = hookEls.slice(0, maxFrames);

	const remainingBudget = maxFrames - picks.length;
	if (remainingBudget > 0 && restEls.length > 0) {
		if (restEls.length <= remainingBudget) {
			picks.push(...restEls);
		} else {
			// Evenly-spaced index selection across restEls (spread, not cluster).
			const step = restEls.length / remainingBudget;
			const usedIdx = new Set<number>();
			for (let i = 0; i < remainingBudget; i++) {
				let idx = Math.min(restEls.length - 1, Math.floor(i * step));
				while (usedIdx.has(idx) && idx < restEls.length - 1) idx++;
				usedIdx.add(idx);
			}
			for (const idx of [...usedIdx].sort((a, b) => a - b)) {
				picks.push(restEls[idx]);
			}
		}
	}

	picks.sort((a, b) => a.startSec - b.startSec);

	return picks.slice(0, maxFrames).map((e) => {
		const withinHook = e.startSec < hookWindowSec;
		const offsetIntoElement = withinHook
			? Math.min(e.durationSec, Math.max(0, hookWindowSec - e.startSec)) / 2
			: e.durationSec / 2;
		return {
			elementId: e.id,
			mediaId: e.mediaId,
			label: e.label,
			atSec: e.startSec + offsetIntoElement,
		};
	});
}

// ── dead-air detection (pure; no frames needed) ─────────────────────────────

/** One stretch of the timeline with no video/image coverage on any track. */
export interface TimelineGap {
	startSec: number;
	durationSec: number;
}

/** Gaps shorter than this are noise (a frame or two of slop between clips), not reportable dead air. */
export const DEFAULT_MIN_GAP_SEC = 0.5;

/**
 * Find stretches of the timeline with NO video/image element covering them on
 * ANY track — the visual "dead air" the `dead-air` critique axis judges.
 * Merges overlapping/adjacent visual coverage first (a cutaway on a second
 * track fills a gap in the main track), then reports the complement within
 * `[0, totalDurationSec]`. Gaps shorter than `minGapSec` are dropped as noise.
 */
export function detectVisualGaps(
	elements: {
		kind: SamplableElement["kind"];
		startSec: number;
		durationSec: number;
	}[],
	totalDurationSec: number,
	minGapSec = DEFAULT_MIN_GAP_SEC,
): TimelineGap[] {
	const spans = elements
		.filter((e) => e.kind === "video" || e.kind === "image")
		.map((e): [number, number] => [e.startSec, e.startSec + e.durationSec])
		.sort((a, b) => a[0] - b[0]);

	const merged: [number, number][] = [];
	for (const [s, e] of spans) {
		const last = merged[merged.length - 1];
		if (last && s <= last[1]) {
			last[1] = Math.max(last[1], e);
		} else {
			merged.push([s, e]);
		}
	}

	const gaps: TimelineGap[] = [];
	let cursor = 0;
	for (const [s, e] of merged) {
		if (s - cursor >= minGapSec)
			gaps.push({ startSec: cursor, durationSec: s - cursor });
		cursor = Math.max(cursor, e);
	}
	if (totalDurationSec - cursor >= minGapSec) {
		gaps.push({ startSec: cursor, durationSec: totalDurationSec - cursor });
	}
	return gaps;
}

/** Render gaps as a compact grounding line, e.g. `"GAPS (no visual coverage): 0:05–0:07, 0:22–0:24."`. Empty ⇒ `""` (zero bytes added). */
export function formatGapsNote(gaps: TimelineGap[]): string {
	if (gaps.length === 0) return "";
	const parts = gaps.map(
		(g) => `${formatSec(g.startSec)}–${formatSec(g.startSec + g.durationSec)}`,
	);
	return `GAPS (no visual coverage): ${parts.join(", ")}.`;
}

function formatSec(totalSeconds: number): string {
	const whole = Math.max(0, Math.round(totalSeconds));
	const minutes = Math.floor(whole / 60);
	const seconds = whole % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ── beat-grid summary (perception-lite — summary facts only, no raw beats) ──

/**
 * Own local mirror of the manifest's `AssetBeatGrid` facts (bpm/beat-density/
 * energy — never the raw per-beat timestamp array), same "own copy, not
 * import" discipline `asset-manifest.ts` itself uses for the store's
 * `BeatGrid`. Keeps this module decoupled from the manifest's own type shape.
 */
export interface EditCriticBeatGrid {
	bpm?: number;
	beatCount?: number;
	downbeatCount?: number;
	energyClass?: string;
	/** Name of the asset the grid was analyzed from, for a legible clause. */
	assetName?: string;
}

/**
 * Render the beat-grid facts into one grounding line, e.g. `"BEAT GRID: 128bpm,
 * 64 beats/16 downbeats, energetic (from \"song.mp3\")."`. `undefined` (no
 * analyzed grid) ⇒ `""` — zero bytes added, same degrade-to-nothing contract
 * the manifest's own beat-grid facet uses.
 */
export function formatBeatGridSummary(
	grid: EditCriticBeatGrid | undefined,
): string {
	if (!grid) return "";
	const bpmPart = grid.bpm != null ? `${grid.bpm}bpm, ` : "";
	const countsPart =
		grid.beatCount != null
			? `${grid.beatCount} beats${grid.downbeatCount != null ? `/${grid.downbeatCount} downbeats` : ""}, `
			: "";
	const energyPart = grid.energyClass ? `${grid.energyClass}` : "";
	const sourcePart = grid.assetName
		? ` (from ${JSON.stringify(grid.assetName)})`
		: "";
	const body = `${bpmPart}${countsPart}${energyPart}`.replace(/,\s*$/, "");
	if (!body.trim()) return "";
	return `BEAT GRID: ${body}${sourcePart}.`;
}

// ── transcript excerpt (already-resolved segments in) ───────────────────────

/** Minimal shape of an already-resolved transcript segment (from `AssetTranscriptLookup`). */
export interface TranscriptExcerptSegment {
	startSec: number;
	endSec: number;
	text: string;
}

/** Cap on segments folded into the critique prompt's transcript excerpt — token economy. */
export const MAX_TRANSCRIPT_EXCERPT_SEGMENTS = 20;

/**
 * Render a capped, token-lean transcript excerpt, e.g. `"0:00 Hey everyone.
 * 0:02 Welcome back to the channel."`. Truncates to
 * {@link MAX_TRANSCRIPT_EXCERPT_SEGMENTS} segments; empty input ⇒ `""`.
 */
export function formatTranscriptExcerpt(
	segments: TranscriptExcerptSegment[],
	opts: { limit?: number } = {},
): string {
	if (segments.length === 0) return "";
	const limit = Math.max(1, opts.limit ?? MAX_TRANSCRIPT_EXCERPT_SEGMENTS);
	const capped = segments.slice(0, limit);
	const lines = capped.map((s) => `${formatSec(s.startSec)} ${s.text.trim()}`);
	const truncNote = segments.length > capped.length ? " …" : "";
	return `TRANSCRIPT: ${lines.join(" ")}${truncNote}`;
}

// ── mix read (audio grounding — the audio half of ADR-plan §4's "give it eyes") ──

/** Cap on individual overlap/dead-air entries folded into the mix grounding line — token economy, same spirit as this file's other `MAX_*` caps. */
export const MAX_MIX_READ_ITEMS = 8;

/** An overlap is only worth calling out to the model above this `competingDb` — small positive/negative values are normal duck jitter, not a real issue. */
export const MIX_READ_COMPETING_DB_THRESHOLD = 3;

/**
 * Render a `mix-read.ts` {@link MixRead} into one compact grounding line —
 * same "already-summarized facts, never a raw data dump" discipline
 * {@link formatBeatGridSummary} uses for the beat grid. Only the figures a
 * critic call actually needs make it into the prompt: the integrated
 * loudness headline, overlap windows whose `competingDb` clears
 * {@link MIX_READ_COMPETING_DB_THRESHOLD} (i.e. music plausibly burying
 * speech), and dead-air stretches — NOT the full per-point loudness curve
 * (that's for a future numeric/graph consumer, not a token-budgeted prompt
 * line). `undefined` (no mix read run for this call) ⇒ `""`, same
 * degrade-to-nothing contract every other `format*` helper here uses.
 */
export function formatMixReadSummary(mixRead: MixRead | undefined): string {
	if (!mixRead) return "";
	const parts: string[] = [];

	const loud = mixRead.integratedLoudness;
	parts.push(
		`integrated ${loud.integrated} LUFS-style (short-term ${loud.shortTerm}, range ${loud.range}LU)`,
	);

	const competing = mixRead.overlaps
		.filter((o) => o.competingDb > MIX_READ_COMPETING_DB_THRESHOLD)
		.slice(0, MAX_MIX_READ_ITEMS);
	if (competing.length > 0) {
		const items = competing.map(
			(o) =>
				`${formatSec(o.startSec)}–${formatSec(o.endSec)} (+${o.competingDb.toFixed(1)}dB over its own duck target)`,
		);
		parts.push(`music competing with speech: ${items.join(", ")}`);
	}

	const dead = mixRead.deadAir.slice(0, MAX_MIX_READ_ITEMS);
	if (dead.length > 0) {
		const items = dead.map(
			(d) => `${formatSec(d.startSec)}–${formatSec(d.endSec)}`,
		);
		const truncNote = mixRead.deadAir.length > dead.length ? " …" : "";
		parts.push(`audio dead air: ${items.join(", ")}${truncNote}`);
	}

	return `MIX: ${parts.join("; ")}.`;
}

// ── external cut-score seam (typed only — no client wired here) ────────────

/**
 * One named axis of a cut score — e.g. Higgsfield's "hook"/"attention"/
 * "retention", or the local engagement scorer's "curiosity"/"energy"/etc.
 * Deliberately mirrors `lib/ai-client.ts`'s `EngagementSubScore`
 * (`{ composite: number; [key: string]: unknown }`) so either source's
 * per-axis payload drops in without reshaping.
 */
export interface CutScoreAxis {
	composite: number;
	[key: string]: unknown;
}

/**
 * SEAM ONLY — no client is wired here (ADR-plan §4: `brain_activity`
 * hook/attention/retention "will be plugged in later"). This type is shaped
 * to fit BOTH of the two engines named in that plan:
 *  - Higgsfield's `brain_activity` (Virality Predictor) — a finished-clip
 *    score returning hook/attention/retention. `api.higgsfield.ai` is
 *    BLOCKED in this environment, so no client for it exists here; a later
 *    change wires a real caller and produces this shape.
 *  - The LOCAL engagement scorer already in this repo —
 *    `aiClient.engagementScore` (`lib/ai-client.ts`'s `EngagementScoreResult`:
 *    `hook`/`curiosity`/`energy`/`audio_sync`/`face_presence`/
 *    `emotional_arc`/`virality`, each an `EngagementSubScore`, plus a
 *    `composite`/`grade`) — see `components/editor/youtube/engagement-panel.tsx`
 *    for its existing consumer, which already documents "a Higgsfield
 *    model-based video scorer will plug in here later" as the same swap.
 * A caller of EITHER shape maps its own named sub-scores into `axes` (e.g.
 * `{ hook: result.hook, attention: ..., retention: ... }` for Higgsfield, or
 * `{ hook: result.hook, curiosity: result.curiosity, ... }` for the local
 * scorer) and sets `overall` from whichever single figure that source
 * surfaces (`composite` for both).
 */
export interface CutScoreInput {
	/** Which engine produced this score — free-form, but `"higgsfield-brain-activity"` and `"local-engagement-scorer"` are the two named sources this seam is shaped for. */
	source: string;
	/** Named per-axis scores — whichever axes this source supports. */
	axes: Record<string, CutScoreAxis>;
	/** A single overall figure, when the source has one (both named sources do, as `composite`). */
	overall?: number;
	/** A source-supplied letter/label grade, when it has one (the local scorer's `grade`/`grade_label`). */
	grade?: string;
	/** Freeform notes from the scoring engine, if any. */
	notes?: string;
}

/**
 * Render a {@link CutScoreInput} into one compact grounding line for the
 * critic prompt — same "summarized facts, not raw payload" discipline every
 * other `format*` helper in this file uses. `undefined` (no score for this
 * call — the common case until a client is wired) ⇒ `""`.
 */
export function formatCutScoreSummary(
	score: CutScoreInput | undefined,
): string {
	if (!score) return "";
	const axisParts = Object.entries(score.axes).map(
		([name, axis]) => `${name} ${axis.composite}`,
	);
	const overallPart =
		score.overall != null
			? ` (overall ${score.overall}${score.grade ? `, ${score.grade}` : ""})`
			: "";
	const body =
		axisParts.length > 0 ? axisParts.join(", ") : "no per-axis scores";
	return `CUT SCORE (${score.source}): ${body}${overallPart}.`;
}

// ── critic call framing ──────────────────────────────────────────────────────

/**
 * System prompt for the tool-less "judge the whole cut" model call. Judges
 * the assembled edit AS A FILM against the doc's rubric: pacing vs energy,
 * hook in the opening seconds, shot variety, cuts-on-beat rhythm, dead air,
 * continuity breaks, and emotional arc. ADVISORY ONLY (ADR-006) — every
 * proposed fix is a SUGGESTION the user must run themselves; the critic must
 * never imply a fix already happened.
 */
export const EDIT_CRITIC_SYSTEM_PROMPT = [
	"You are a STRICT editorial critic for a short-form video reel/cut. You are shown a compact TIMELINE digest (tracks, elements, durations), optional BEAT GRID, TRANSCRIPT, MIX (loudness/ducking/dead-air) and CUT SCORE grounding, and up to 12 frames SAMPLED across the assembled cut in TIME ORDER, each labeled with its timeline position in seconds.",
	"Judge the cut as a WHOLE FILM, on these axes:",
	'- "pacing": do shot durations match their energy? A slow shot that lingers past its welcome, or a fast cut that never lands, is a pacing issue.',
	'- "hook": is the strongest, most attention-grabbing moment in the FIRST ~2 SECONDS? A cold viewer decides to keep watching (or scroll past) almost immediately — a buried hook is a high-severity issue. When a CUT SCORE is supplied, its "hook"/"attention" figures are another signal for this axis, not a replacement for your own read of the frames.',
	'- "variety": do consecutive or nearby shots look near-identical (same framing/subject/angle, no visual change)? Judge this directly from the sampled frames.',
	'- "rhythm": when a BEAT GRID is supplied, do cuts (element boundaries) land near the beat, or do they fight the music\'s tempo?',
	'- "dead-air": any reported GAPS (no visual coverage), any "audio dead air" reported in MIX, or long silent/empty stretches from the TRANSCRIPT?',
	'- "continuity": do frames near a cut break continuity (lighting, wardrobe, palette, identity) with the shot before it?',
	'- "arc": does the sequence of sampled frames read as a coherent emotional arc (build, peak, resolve), or does it feel flat/random? A CUT SCORE\'s "retention" figure, when supplied, is a signal here too.',
	'A MIX line, when supplied, may report "music competing with speech" windows — a music bed still loud while someone is talking. Treat that as a "pacing" or "dead-air"-adjacent issue in its own right (propose a `duckMusicUnderSpeech`-shaped fix via `animateItem` on the music element, or an `applyTransition`/`trim`, whichever actually addresses it) even if nothing looks wrong in the frames — you cannot SEE a mix problem.',
	"Reply with ONE minified JSON object and nothing else:",
	'{"summary":"<1-2 sentence overall read>","issues":[{"axis":"pacing"|"hook"|"variety"|"rhythm"|"dead-air"|"continuity"|"arc","severity":"low"|"med"|"high","location":{"sec":<number>,"elementRef":"<element id, when you can name one>"},"note":"<one or two sentences, specific>","proposedFix":{"verb":"<a real editing verb: trim, move, split, reorder, remove, removeSilence, applyTransition, animateItem>","args":{<args for that verb>}}}]}',
	"Rules:",
	'- An empty "issues" array is a GOOD, valid outcome — a well-paced cut with nothing to fix. Do not invent issues to fill the list.',
	'- "proposedFix" is a SUGGESTION ONLY. It is NEVER executed automatically — a human must explicitly run it later. Never say or imply the fix already happened. Omit "proposedFix" when you don\'t have a concrete, actionable fix in mind.',
	'- "location" should name whichever of "sec" (a timeline-absolute second) and "elementRef" (an element id from the digest) you can — include both when you can.',
	"Never invent detail the digest/frames/grounding did not show you. When genuinely unsure whether something is an issue, do not report it.",
].join("\n");

/** One already-decoded frame, ready to fold into the critique call. */
export interface CritiqueFrame {
	/** Base64 `data:` image URL. */
	dataUrl: string;
	/** Timeline-absolute seconds this frame was sampled at. */
	atSec: number;
	label?: string;
}

/**
 * Build the user-turn content for a `critiqueEdit` model call: the TIMELINE
 * digest (+ optional gaps/beat-grid/transcript grounding) as text, then the
 * sampled frames as labeled image blocks in time order. Frames that aren't
 * decodable base64 data URLs are silently dropped (mirrors
 * `buildCriticUserBlocks`).
 */
export function buildEditCritiqueUserBlocks(input: {
	digest: string;
	gapsNote?: string;
	beatGridSummary?: string;
	transcriptExcerpt?: string;
	/** Pre-formatted line from {@link formatMixReadSummary} — additive, ADDED AFTER the existing grounding lines so an omitted/undefined value is a pure no-op for every existing caller. */
	mixReadSummary?: string;
	/** Pre-formatted line from {@link formatCutScoreSummary} — the external cut-score seam; additive, same no-op-when-absent contract as `mixReadSummary`. */
	scoreSummary?: string;
	frames: CritiqueFrame[];
}): Anthropic.ContentBlockParam[] {
	const introParts = [`TIMELINE:\n${input.digest || "(no digest)"}`];
	if (input.gapsNote?.trim()) introParts.push(input.gapsNote.trim());
	if (input.beatGridSummary?.trim())
		introParts.push(input.beatGridSummary.trim());
	if (input.transcriptExcerpt?.trim())
		introParts.push(input.transcriptExcerpt.trim());
	if (input.mixReadSummary?.trim())
		introParts.push(input.mixReadSummary.trim());
	if (input.scoreSummary?.trim()) introParts.push(input.scoreSummary.trim());
	introParts.push(
		`${input.frames.length} frame(s) sampled across the cut follow, in time order (each labeled with its timeline position). Judge the whole cut against the rubric and reply with the JSON critique.`,
	);

	const blocks: Anthropic.ContentBlockParam[] = [
		{ type: "text", text: introParts.join("\n\n") },
	];
	for (const frame of input.frames) {
		const block = dataUrlToImageBlock(frame.dataUrl);
		if (!block) continue;
		blocks.push({
			type: "text",
			text: `Frame @ ${frame.atSec.toFixed(1)}s${frame.label ? ` (${frame.label})` : ""}:`,
		});
		blocks.push(block);
	}
	return blocks;
}

/**
 * The relay a `critiqueEdit` call needs: one tool-less vision model
 * round-trip, system prompt + content blocks in, the assistant's raw text
 * reply out. Mirrors `take-critic-adapter.ts`'s `VisionRelay` — injected (not
 * imported) so `director-api.ts` degrades gracefully with none wired, and so
 * this module never imports a network client.
 */
export type EditCriticRelay = (request: {
	system: string;
	content: Anthropic.ContentBlockParam[];
}) => Promise<string>;

// ── verdict parsing (fail-safe, mirrors vision-critic.ts's parseVerdict) ────

/** Extract the first balanced top-level JSON object from arbitrary text. */
function firstJsonObject(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const haystack = fenced ? fenced[1] : text;
	const start = haystack.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < haystack.length; i++) {
		const ch = haystack[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
		} else if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return haystack.slice(start, i + 1);
		}
	}
	return null;
}

function isAxis(v: unknown): v is EditCritiqueAxis {
	return (
		typeof v === "string" &&
		(EDIT_CRITIQUE_AXES as readonly string[]).includes(v)
	);
}

function isSeverity(v: unknown): v is EditCritiqueSeverity {
	return (
		typeof v === "string" &&
		(EDIT_CRITIQUE_SEVERITIES as readonly string[]).includes(v)
	);
}

/** Parse one raw issue object into an {@link EditCritiqueIssue}, or `null` when it's not usable (missing/invalid axis, severity, or note). */
function parseIssue(raw: unknown): EditCritiqueIssue | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;

	if (!isAxis(o.axis) || !isSeverity(o.severity)) return null;
	const note = typeof o.note === "string" ? o.note.trim() : "";
	if (!note) return null;

	const rawLoc = o.location;
	const location: EditCritiqueLocation = {};
	if (rawLoc && typeof rawLoc === "object") {
		const l = rawLoc as Record<string, unknown>;
		if (typeof l.sec === "number" && Number.isFinite(l.sec))
			location.sec = l.sec;
		if (typeof l.elementRef === "string" && l.elementRef.trim())
			location.elementRef = l.elementRef.trim();
	}

	let proposedFix: ProposedFix | undefined;
	const rawFix = o.proposedFix;
	if (rawFix && typeof rawFix === "object") {
		const f = rawFix as Record<string, unknown>;
		if (typeof f.verb === "string" && f.verb.trim()) {
			const args =
				f.args && typeof f.args === "object" && !Array.isArray(f.args)
					? (f.args as Record<string, unknown>)
					: {};
			proposedFix = { verb: f.verb.trim(), args };
		}
	}

	return {
		axis: o.axis,
		severity: o.severity,
		location,
		note,
		...(proposedFix ? { proposedFix } : {}),
	};
}

/**
 * Parse a `critiqueEdit` model reply into an {@link EditCritique}. Fails SAFE:
 * unparseable output, non-object JSON, or a missing/malformed `summary`
 * collapses to a generic summary with an EMPTY issues array (never throws,
 * never fabricates an issue). Individual malformed issue entries are dropped
 * rather than failing the whole parse. Issues are capped at
 * {@link MAX_EDIT_CRITIQUE_ISSUES} by construction.
 */
export function parseEditCritique(text: string): EditCritique {
	const json = firstJsonObject(text);
	if (!json) {
		return {
			summary: "No critique JSON found in the model's reply.",
			issues: [],
		};
	}

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(json) as Record<string, unknown>;
	} catch {
		return { summary: "Critique JSON was malformed.", issues: [] };
	}

	const summary =
		typeof obj.summary === "string" && obj.summary.trim()
			? obj.summary.trim()
			: "The model returned a critique with no summary.";

	const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
	const issues: EditCritiqueIssue[] = [];
	for (const raw of rawIssues) {
		if (issues.length >= MAX_EDIT_CRITIQUE_ISSUES) break;
		const parsed = parseIssue(raw);
		if (parsed) issues.push(parsed);
	}

	return { summary, issues };
}

// ── weak-cut → craft-program routing (closes the score→fix loop) ───────────
//
// `scoreCut` (`lib/director/scoring/score-cut.ts`, wired as `director-api.ts`'s
// `scoreCut` verb) reports a NUMBER — a hook/hold-rate rating is not, on its
// own, something a model or user can act on. This section closes that gap:
// given the `EngagementDiagnostics` `scoreCut` already computed, decide
// whether the cut is weak enough to route to a concrete REMEDY, and if so,
// build it from the SAME craft programs `applyEdit` already exposes
// (`program/programs/tighten-to-length.ts`, `program/programs/cut-on-beat.ts`
// — the exact two programs that subsumed the old `tightenToLength`/
// `cutOnBeat` verbs, see `phase-scope.ts`'s deletion history) rather than
// inventing a third editing mechanism.
//
// ADVISORY-ONLY, same ADR-006 contract every other `ProposedFix` in this file
// uses: a suggestion names an `applyEdit` call with `mode: "dry-run"` (so the
// caller sees `data.ops` before anything runs) — this module NEVER executes
// it, and calling code must not either without an explicit later step.

/** Cut left after tightening, as a fraction of the current runtime — a fixed, honest "trim the slack" ratio, not tuned against any real data (there is none to tune against locally). */
const DEFAULT_TIGHTEN_RATIO = 0.85;

/** One concrete, executable fix a weak `scoreCut` diagnostic routes to. */
export interface CutScoreFixSuggestion {
	/** Which diagnostic axis this fix targets. */
	axis: "hook" | "holdRate";
	/** Why this fix was suggested, in plain language — surfaced to the user, never auto-run. */
	reason: string;
	/** An `applyEdit`-shaped `ProposedFix` — `verb: "applyEdit"`, `args: { program, mode: "dry-run" }`. */
	fix: ProposedFix;
}

/**
 * Route a weak `hook` (and/or weak `holdRate`) diagnostic to a concrete
 * `applyEdit` fix instead of leaving the caller with only a number:
 *  - a weak hook OR a weak hold rate ⇒ a `tightenToLength`-shaped program
 *    targeting {@link DEFAULT_TIGHTEN_RATIO} of the current runtime — trims
 *    the slack a lingering opening (weak hook) or a mid-cut drop-off (weak
 *    hold rate) is bleeding attention at. Same program `readMix`'s own
 *    dead-air coaching note already points the model at.
 *  - a weak hook, WHEN a beat grid has been analyzed ⇒ ALSO a
 *    `cutOnBeat`-shaped program, since a hook that doesn't land on the
 *    music's rhythm is a second, independent fix from "the opening is too
 *    long" — offered alongside, not instead of, the tighten suggestion.
 * A strong/ok cut on both axes ⇒ `[]` — same "an empty result is a good,
 * valid outcome" posture {@link parseEditCritique} uses; this function never
 * invents a fix to fill the list.
 */
export function suggestFixesForCutScore(
	diagnostics: Pick<EngagementDiagnostics, "hook" | "holdRate">,
	ctx: {
		totalDurationSec: number;
		hasBeatGrid: boolean;
		tightenRatio?: number;
	},
): CutScoreFixSuggestion[] {
	const suggestions: CutScoreFixSuggestion[] = [];
	const hookWeak: boolean = diagnostics.hook.rating === "weak";
	const holdWeak: boolean = diagnostics.holdRate.rating === "weak";

	if ((hookWeak || holdWeak) && ctx.totalDurationSec > 0) {
		const ratio = ctx.tightenRatio ?? DEFAULT_TIGHTEN_RATIO;
		const targetDurationSec = Math.max(
			1,
			Math.round(ctx.totalDurationSec * ratio * 100) / 100,
		);
		const reason = hookWeak
			? `Hook scored weak (${diagnostics.hook.score}/100) — tightening the cut to ~${targetDurationSec}s trims slack out of the opening shots so the strongest moment lands sooner.`
			: `Hold rate scored weak (${diagnostics.holdRate.score}/100) with drop-off points on the timeline — tightening the cut to ~${targetDurationSec}s removes the slack those drop-offs are bleeding viewers at.`;
		suggestions.push({
			axis: hookWeak ? "hook" : "holdRate",
			reason,
			fix: {
				verb: "applyEdit",
				args: {
					program: buildTightenToLengthProgram({ targetDurationSec }),
					mode: "dry-run",
				},
			},
		});
	}

	if (hookWeak && ctx.hasBeatGrid) {
		suggestions.push({
			axis: "hook",
			reason:
				"A beat grid is analyzed and the hook scored weak — snapping cuts to the beat can sharpen the opening's rhythm independently of trimming its length.",
			fix: {
				verb: "applyEdit",
				args: { program: buildCutOnBeatProgram(), mode: "dry-run" },
			},
		});
	}

	return suggestions;
}
