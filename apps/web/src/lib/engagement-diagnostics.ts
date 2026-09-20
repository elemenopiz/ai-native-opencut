/**
 * Engagement diagnostics — reframe the blended engagement/reach score into
 * three independently-actionable dimensions plus a per-moment attention heatmap.
 *
 * A single "reach score" tells a creator *whether* a clip is good, not *what*
 * to fix. This module maps the backend's seven raw signals (hook, curiosity,
 * energy, audio_sync, face_presence, emotional_arc, reach) — combined with
 * the transcript's per-segment text — into:
 *
 *   1. HOOK        — do the first ~3s grab attention?
 *   2. HOLD RATE   — do viewers keep watching? (estimated retention curve + drop-offs)
 *   3. ATTENTION   — a per-moment attention estimate across the timeline (heatmap)
 *
 * It is a pure, backward-compatible derivation: the backend response and every
 * existing caller of `EngagementScoreResult` are untouched. When no transcript
 * segments are available it falls back to a phase-based synthetic curve derived
 * from the emotional-arc signal so the heatmap still renders.
 */

import type { EngagementScoreResult, EngagementSubScore } from "@/lib/ai-client";
import type { TranscriptionSegment } from "@/types/ai";

// ── Public types ────────────────────────────────────────────────────

export type DimensionRating = "strong" | "ok" | "weak";

export interface HookDiagnostic {
	/** 0-100 hook strength for the opening ~3s. */
	score: number;
	rating: DimensionRating;
	/** Short human verdict, e.g. "Weak opening — nothing stops the scroll". */
	verdict: string;
	/** Concrete issues found in the opening. */
	issues: string[];
	/** The opening text that was analysed (may be empty). */
	openingText: string;
}

export interface DropoffPoint {
	/** Timestamp (seconds) where a likely drop-off begins. */
	time: number;
	/** Retention at that point, 0-100. */
	retention: number;
	/** How sharp the local drop is, 0-100 (percentage points lost in the segment). */
	severity: number;
	/** Human reason, e.g. "energy dips / long monologue". */
	reason: string;
}

export interface HoldRateDiagnostic {
	/** 0-100 estimated retention strength. */
	score: number;
	rating: DimensionRating;
	verdict: string;
	/** Estimated % of viewers still watching at the end. */
	estimatedEndRetention: number;
	/** Estimated retention curve, one sample per heatmap segment (0-100). */
	curve: { time: number; retention: number }[];
	/** Moments where viewers are most likely to leave. */
	dropoffs: DropoffPoint[];
}

export interface AttentionSegment {
	start: number;
	end: number;
	/** 0-100 estimated attention held during this moment. */
	attention: number;
	/** Snippet of the transcript for this moment (may be empty). */
	label: string;
}

export interface AttentionHeatmap {
	segments: AttentionSegment[];
	/** Total analysed duration in seconds. */
	duration: number;
	/** Timestamp of the strongest moment. */
	peakTime: number;
	/** Timestamp of the weakest moment. */
	valleyTime: number;
	/** True when the timeline is real (absolute seconds), false when relative/synthetic. */
	timed: boolean;
}

export interface EngagementDiagnostics {
	hook: HookDiagnostic;
	holdRate: HoldRateDiagnostic;
	heatmap: AttentionHeatmap;
	/** Passed through from the backend so the overall grade can still be shown. */
	overall: number;
	grade: string;
	gradeLabel: string;
}

export interface DiagnosticsInput {
	result: EngagementScoreResult;
	segments?: TranscriptionSegment[];
	/** Total duration in seconds. Inferred from segments when omitted. */
	duration?: number;
}

// ── Signal helpers ──────────────────────────────────────────────────

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

/** Read the composite of a sub-score, tolerating missing/NaN values. */
function comp(sub: EngagementSubScore | undefined, fallback = 50): number {
	const v = sub?.composite;
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Read an arbitrary numeric field off a sub-score. */
function num(sub: EngagementSubScore | undefined, key: string, fallback: number): number {
	const v = sub?.[key];
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function boolField(sub: EngagementSubScore | undefined, key: string): boolean {
	return sub?.[key] === true;
}

function rate(score: number): DimensionRating {
	if (score >= 65) return "strong";
	if (score >= 45) return "ok";
	return "weak";
}

const CURIOSITY_WORDS = [
	"never", "always", "everyone", "nobody", "secret", "mistake", "wrong",
	"truth", "myth", "actually", "the real", "nobody tells you", "stop",
];
const OPEN_LOOP_PHRASES = [
	"here's why", "here's what", "here's how", "let me tell you", "wait until",
	"you won't believe", "the thing is", "but first", "by the end", "keep watching",
];

function textSignals(text: string): {
	question: boolean;
	boldClaim: boolean;
	openLoop: boolean;
	hasNumber: boolean;
} {
	const t = text.toLowerCase();
	return {
		question: text.includes("?"),
		boldClaim: CURIOSITY_WORDS.some((w) => t.includes(w)),
		openLoop: OPEN_LOOP_PHRASES.some((w) => t.includes(w)),
		hasNumber: /\d/.test(text),
	};
}

// ── Hook ────────────────────────────────────────────────────────────

function deriveHook(
	result: EngagementScoreResult,
	openingSegments: TranscriptionSegment[],
): HookDiagnostic {
	const hookSignal = comp(result.hook, 50);
	const curiosity = comp(result.curiosity, 50);
	// reach carries a 0-25 hook_strength sub-signal — scale to 0-100.
	const reachHook = clamp(num(result.reach, "hook_strength", 12) * 4);
	const earlyFace = boolField(result.hook, "early_face_present");

	const openingText = openingSegments.map((s) => s.text).join(" ").trim();
	const sig = textSignals(openingText);

	// Blend the three hook-relevant signals; nudge on opening text cues.
	let score = hookSignal * 0.55 + curiosity * 0.2 + reachHook * 0.25;
	if (openingText) {
		if (sig.question) score += 6;
		if (sig.openLoop) score += 6;
		if (sig.boldClaim) score += 4;
		if (!sig.question && !sig.openLoop && !sig.boldClaim) score -= 8;
	}
	if (earlyFace) score += 4;
	score = clamp(Math.round(score));

	const issues: string[] = [];
	if (hookSignal < 60) issues.push("No text hook in the first ~1.5s to stop the scroll.");
	if (!earlyFace) issues.push("Speaker's face isn't visible in the opening frames.");
	if (openingText && !sig.question && !sig.openLoop && !sig.boldClaim) {
		issues.push("Opening line makes no bold claim, question, or open loop.");
	}
	if (!openingText) issues.push("No spoken words in the first few seconds to hook the viewer.");

	const verdict =
		score >= 65
			? "Strong opening — likely to stop the scroll."
			: score >= 45
				? "Opening is okay but not gripping."
				: "Weak hook — viewers may swipe past in the first 3s.";

	return { score, rating: rate(score), verdict, issues: issues.slice(0, 3), openingText };
}

// ── Attention heatmap (per-moment) ──────────────────────────────────

function attentionForSegment(
	seg: { start: number; end: number; text: string },
	duration: number,
	baseline: number,
	hookScore: number,
	peakTime: number,
	fatigue: number,
): number {
	const mid = (seg.start + seg.end) / 2;
	const posFrac = duration > 0 ? clamp(mid / duration, 0, 1) : 0;

	const sig = textSignals(seg.text);
	let textScore = 50;
	if (sig.question) textScore += 18;
	if (sig.boldClaim) textScore += 15;
	if (sig.openLoop) textScore += 15;
	if (sig.hasNumber) textScore += 8;

	const dur = seg.end - seg.start;
	const wordCount = seg.text.trim() ? seg.text.trim().split(/\s+/).length : 0;
	if (dur > 12) textScore -= 12; // long monologue drag
	if (dur > 0 && dur < 1.5 && wordCount < 4) textScore -= 10; // dead air / filler
	textScore = clamp(textScore);

	let attention = baseline * 0.45 + textScore * 0.3 + 25;

	// Opening ~3s is governed by the hook.
	if (mid <= 3) attention += (hookScore - attention) * 0.6;

	// Boost the emotional peak region.
	if (peakTime > 0 && Math.abs(mid - peakTime) <= duration * 0.12) attention += 12;

	// Viewer fatigue accumulates over time, scaled by how weak the hold is.
	attention -= fatigue * posFrac;

	return clamp(Math.round(attention), 5, 100);
}

function buildHeatmap(input: DiagnosticsInput): AttentionHeatmap {
	const { result } = input;
	const segments = input.segments ?? [];
	const baseline =
		(comp(result.energy, 50) + comp(result.curiosity, 50) + comp(result.emotional_arc, 50)) / 3;
	const hookScore = comp(result.hook, 50);
	const hold =
		comp(result.energy, 50) * 0.3 + comp(result.emotional_arc, 50) * 0.4 + comp(result.curiosity, 50) * 0.3;
	const fatigue = (100 - hold) * 0.4;

	const timed = segments.length > 0;
	const duration =
		input.duration ??
		(timed ? Math.max(...segments.map((s) => s.end)) : Math.max(30, num(result.emotional_arc, "peak_timestamp", 0) * 1.3));
	const peakTimestamp = num(result.emotional_arc, "peak_timestamp", duration * 0.5);

	let moments: { start: number; end: number; text: string }[];
	if (timed) {
		// Bucket segments so a very long transcript still renders cleanly.
		const MAX_BUCKETS = 24;
		if (segments.length <= MAX_BUCKETS) {
			moments = segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
		} else {
			const per = Math.ceil(segments.length / MAX_BUCKETS);
			moments = [];
			for (let i = 0; i < segments.length; i += per) {
				const chunk = segments.slice(i, i + per);
				moments.push({
					start: chunk[0].start,
					end: chunk[chunk.length - 1].end,
					text: chunk.map((c) => c.text).join(" "),
				});
			}
		}
	} else {
		// Synthetic phase-based buckets driven by the emotional-arc signal.
		const N = 10;
		const strongOpen = boolField(result.emotional_arc, "has_strong_open");
		const buildup = boolField(result.emotional_arc, "has_buildup");
		const peak = boolField(result.emotional_arc, "has_peak");
		moments = Array.from({ length: N }, (_, i) => {
			const start = (duration * i) / N;
			const end = (duration * (i + 1)) / N;
			const frac = (i + 0.5) / N;
			// Encode arc shape as pseudo-text cues so the shared scorer reacts.
			let text = "";
			if (i === 0 && strongOpen) text = "hook";
			else if (frac > 0.6 && frac < 0.85 && peak) text = "the real payoff";
			else if (frac > 0.25 && frac < 0.6 && buildup) text = "here's why";
			return { start, end, text };
		});
	}

	const heatSegments: AttentionSegment[] = moments.map((m) => ({
		start: m.start,
		end: m.end,
		attention: attentionForSegment(m, duration, baseline, hookScore, peakTimestamp, fatigue),
		label: m.text.trim().slice(0, 80),
	}));

	let peakTime = 0;
	let valleyTime = 0;
	let hi = -1;
	let lo = 101;
	for (const s of heatSegments) {
		const mid = (s.start + s.end) / 2;
		if (s.attention > hi) { hi = s.attention; peakTime = mid; }
		if (s.attention < lo) { lo = s.attention; valleyTime = mid; }
	}

	return { segments: heatSegments, duration, peakTime, valleyTime, timed };
}

// ── Hold rate (retention curve + drop-offs) ─────────────────────────

function deriveHoldRate(
	result: EngagementScoreResult,
	heatmap: AttentionHeatmap,
): HoldRateDiagnostic {
	const score = clamp(
		Math.round(
			comp(result.energy, 50) * 0.25 +
				comp(result.emotional_arc, 50) * 0.3 +
				comp(result.curiosity, 50) * 0.2 +
				comp(result.audio_sync, 50) * 0.15 +
				comp(result.face_presence, 50) * 0.1,
		),
	);

	// Target end retention scales with the hold score (20%..80%).
	const estimatedEndRetention = Math.round(20 + (score / 100) * 60);
	const totalDrop = 100 - estimatedEndRetention;

	const segs = heatmap.segments;
	// Distribute the total audience loss across moments, weighting low-attention
	// moments more heavily so drop-offs land where attention actually dips.
	const weights = segs.map((s) => Math.pow(1 - s.attention / 100, 1.5) + 0.05);
	const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

	const curve: { time: number; retention: number }[] = [];
	const perSegDrop: number[] = [];
	let retention = 100;
	for (let i = 0; i < segs.length; i++) {
		const drop = totalDrop * (weights[i] / weightSum);
		perSegDrop.push(drop);
		retention = clamp(retention - drop, estimatedEndRetention - 2, 100);
		curve.push({ time: (segs[i].start + segs[i].end) / 2, retention: Math.round(retention) });
	}

	// Flag drop-offs: sharp local losses at low-attention moments.
	const meanDrop = perSegDrop.reduce((a, b) => a + b, 0) / (perSegDrop.length || 1);
	const dropoffs: DropoffPoint[] = [];
	for (let i = 0; i < segs.length; i++) {
		const sharp = perSegDrop[i] > meanDrop * 1.5;
		if (sharp && segs[i].attention < 50) {
			dropoffs.push({
				time: segs[i].start,
				retention: curve[i].retention,
				severity: Math.round(perSegDrop[i]),
				reason: dropReason(segs[i]),
			});
		}
	}
	dropoffs.sort((a, b) => b.severity - a.severity);

	const verdict =
		score >= 65
			? "Good retention — most viewers should stay to the end."
			: score >= 45
				? "Moderate retention — a few moments bleed viewers."
				: "Weak retention — likely heavy drop-off partway through.";

	return {
		score,
		rating: rate(score),
		verdict,
		estimatedEndRetention,
		curve,
		dropoffs: dropoffs.slice(0, 3),
	};
}

function dropReason(seg: AttentionSegment): string {
	const dur = seg.end - seg.start;
	if (dur > 12) return "long monologue — pacing drags here";
	if (!seg.label) return "dead air / low energy moment";
	return "attention dips — weak hook to keep watching";
}

// ── Entry point ─────────────────────────────────────────────────────

/**
 * Derive the three diagnostic dimensions + attention heatmap from a raw
 * engagement score result and (optionally) the transcript segments.
 */
export function deriveDiagnostics(input: DiagnosticsInput): EngagementDiagnostics {
	const { result } = input;
	const segments = input.segments ?? [];

	// Opening = segments overlapping the first 3 seconds (at least the first one).
	const opening = segments.filter((s) => s.start < 3);
	if (opening.length === 0 && segments.length > 0) opening.push(segments[0]);

	const heatmap = buildHeatmap(input);
	const hook = deriveHook(result, opening);
	const holdRate = deriveHoldRate(result, heatmap);

	return {
		hook,
		holdRate,
		heatmap,
		overall: Math.round(result.composite),
		grade: result.grade,
		gradeLabel: result.grade_label,
	};
}

/** Format seconds as m:ss for drop-off callouts. */
export function formatTimecode(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return `${m}:${rem.toString().padStart(2, "0")}`;
}
