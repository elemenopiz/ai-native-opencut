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
	"You are a STRICT editorial critic for a short-form video reel/cut. You are shown a compact TIMELINE digest (tracks, elements, durations), optional BEAT GRID and TRANSCRIPT grounding, and up to 12 frames SAMPLED across the assembled cut in TIME ORDER, each labeled with its timeline position in seconds.",
	"Judge the cut as a WHOLE FILM, on these axes:",
	'- "pacing": do shot durations match their energy? A slow shot that lingers past its welcome, or a fast cut that never lands, is a pacing issue.',
	'- "hook": is the strongest, most attention-grabbing moment in the FIRST ~2 SECONDS? A cold viewer decides to keep watching (or scroll past) almost immediately — a buried hook is a high-severity issue.',
	'- "variety": do consecutive or nearby shots look near-identical (same framing/subject/angle, no visual change)? Judge this directly from the sampled frames.',
	'- "rhythm": when a BEAT GRID is supplied, do cuts (element boundaries) land near the beat, or do they fight the music\'s tempo?',
	'- "dead-air": any reported GAPS (no visual coverage) or, from the TRANSCRIPT, long silent/empty stretches?',
	'- "continuity": do frames near a cut break continuity (lighting, wardrobe, palette, identity) with the shot before it?',
	'- "arc": does the sequence of sampled frames read as a coherent emotional arc (build, peak, resolve), or does it feel flat/random?',
	"Reply with ONE minified JSON object and nothing else:",
	'{"summary":"<1-2 sentence overall read>","issues":[{"axis":"pacing"|"hook"|"variety"|"rhythm"|"dead-air"|"continuity"|"arc","severity":"low"|"med"|"high","location":{"sec":<number>,"elementRef":"<element id, when you can name one>"},"note":"<one or two sentences, specific>","proposedFix":{"verb":"<a real editing verb: trim, move, split, reorder, remove, removeSilence, applyTransition>","args":{<args for that verb>}}}]}',
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
	frames: CritiqueFrame[];
}): Anthropic.ContentBlockParam[] {
	const introParts = [`TIMELINE:\n${input.digest || "(no digest)"}`];
	if (input.gapsNote?.trim()) introParts.push(input.gapsNote.trim());
	if (input.beatGridSummary?.trim())
		introParts.push(input.beatGridSummary.trim());
	if (input.transcriptExcerpt?.trim())
		introParts.push(input.transcriptExcerpt.trim());
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
