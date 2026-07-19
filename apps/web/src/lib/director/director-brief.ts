/**
 * Director brief helpers — pure logic over the persistent, per-project
 * {@link DirectorBrief} (defined on `TProject` in `@/types/project`).
 *
 * The brief is the Director's DURABLE memory of the user's creative intent:
 * goal, audience, tone, a one-line style note, an optional target duration,
 * do/don't constraints, and a running list of learned one-line notes (stated
 * preferences + chosen-take rationale). Each
 * turn the agent folds a summary of it into its system prompt (see
 * `agent.ts`'s `buildBriefBlock`) and writes back to it via the
 * `updateBrief`/`chooseTake` verbs (see `director-api.ts`).
 *
 * This module owns NO storage: it only shapes the plain-object brief. Durability
 * comes from `director-api.ts` routing reads/writes through
 * `editor.project.getDirectorBrief`/`updateDirectorBrief`, which persists the
 * brief on the active `TProject` (serialized by the storage service exactly like
 * project settings) — so a stated preference survives a reload.
 */

import type { DirectorBrief } from "@/types/project";
import type { UserPreferenceModel } from "./preference-learning";

/**
 * Cap on the learned-notes list so the brief never grows without bound across a
 * long session. When exceeded, the OLDEST notes are dropped (newest-last), on
 * the assumption that recent preferences best reflect current intent.
 */
export const MAX_BRIEF_NOTES = 12;

/** How many learned notes the prompt summary surfaces (the freshest ones). */
export const BRIEF_NOTES_IN_SUMMARY = 5;

/** An empty brief — all fields unset. */
export function emptyBrief(): DirectorBrief {
	return {};
}

/** True when the brief carries no meaningful content (nothing worth summarizing). */
export function isBriefEmpty(brief: DirectorBrief | undefined): boolean {
	if (!brief) return true;
	return (
		!brief.goal?.trim() &&
		!brief.audience?.trim() &&
		!brief.tone?.trim() &&
		!brief.styleNote?.trim() &&
		!brief.platform?.trim() &&
		(brief.dos?.length ?? 0) === 0 &&
		(brief.donts?.length ?? 0) === 0 &&
		(brief.mustInclude?.length ?? 0) === 0 &&
		(brief.notes?.length ?? 0) === 0 &&
		brief.durationSec == null
	);
}

/**
 * The pre-rename shape of a persisted brief: the one-line style string used to
 * live under `styleBible`, a key that collided with the STRUCTURED
 * `ProjectBible.styleBible` look (see `lib/director/project-bible.ts`). Briefs
 * are durable (serialized on `TProject`, and inside cross-project user-memory
 * defaults), so old records may still carry the legacy key.
 */
type LegacyBrief = DirectorBrief & { styleBible?: string };

/**
 * One-way, on-read migration for briefs persisted before the `styleBible` →
 * `styleNote` rename. Moves a legacy non-empty `styleBible` string into
 * `styleNote` (an already-set `styleNote` wins) and drops the legacy key.
 * Pure; returns the input unchanged (same reference) when no legacy key exists.
 */
export function migrateLegacyBrief(
	brief: DirectorBrief | undefined,
): DirectorBrief | undefined {
	if (!brief || !("styleBible" in brief)) return brief;
	const { styleBible: legacy, ...rest } = brief as LegacyBrief;
	const migrated = legacy?.trim();
	if (migrated && !rest.styleNote?.trim()) {
		return { ...rest, styleNote: migrated };
	}
	return rest;
}

/** Trim, drop empties, and de-duplicate a string list while preserving order. */
function cleanList(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of values) {
		const v = raw.trim();
		if (!v || seen.has(v)) continue;
		seen.add(v);
		out.push(v);
	}
	return out;
}

/**
 * A patch the agent (or `chooseTake`) applies to the brief. Scalar fields
 * REPLACE when a non-empty string is given; `dos`/`donts` are APPENDED (deduped)
 * to the existing constraints; `notes` are appended as learned one-liners and
 * trimmed to {@link MAX_BRIEF_NOTES}. Passing an empty string for a scalar
 * CLEARS it (lets the user retract a stated preference).
 */
export interface BriefPatch {
	goal?: string;
	audience?: string;
	tone?: string;
	styleNote?: string;
	/** Distribution target — platform and/or format. REPLACES, same as the other scalars. */
	platform?: string;
	/** Constraints to ADD (appended, not replaced). */
	dos?: string[];
	donts?: string[];
	/** Concrete content requirements to ADD (appended, deduped — not replaced). */
	mustInclude?: string[];
	/** Learned one-line notes to append (stated preferences, chosen-take rationale). */
	notes?: string[];
	/**
	 * Target reel length in seconds — REPLACES the current target, same as a
	 * scalar. A non-positive value (0 or less) CLEARS it (lets the user retract
	 * a stated target).
	 */
	durationSec?: number;
}

/** Replace a scalar field: a non-null string wins (empty string clears it). */
function patchScalar(
	current: string | undefined,
	next: string | undefined,
): string | undefined {
	if (next == null) return current;
	const trimmed = next.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Fold a {@link BriefPatch} into `base`, returning a NEW brief (pure). Scalars
 * replace; `dos`/`donts` append+dedupe; `notes` append and cap. `updatedAt` is
 * stamped when anything actually changes.
 */
export function applyBriefPatch(
	base: DirectorBrief | undefined,
	patch: BriefPatch,
	now: number = Date.now(),
): DirectorBrief {
	const current = base ?? {};
	const next: DirectorBrief = { ...current };

	next.goal = patchScalar(current.goal, patch.goal);
	next.audience = patchScalar(current.audience, patch.audience);
	next.tone = patchScalar(current.tone, patch.tone);
	next.styleNote = patchScalar(current.styleNote, patch.styleNote);
	next.platform = patchScalar(current.platform, patch.platform);

	if (patch.dos?.length) {
		next.dos = cleanList([...(current.dos ?? []), ...patch.dos]);
	}
	if (patch.donts?.length) {
		next.donts = cleanList([...(current.donts ?? []), ...patch.donts]);
	}
	if (patch.mustInclude?.length) {
		next.mustInclude = cleanList([
			...(current.mustInclude ?? []),
			...patch.mustInclude,
		]);
	}
	if (patch.notes?.length) {
		const merged = cleanList([...(current.notes ?? []), ...patch.notes]);
		next.notes =
			merged.length > MAX_BRIEF_NOTES
				? merged.slice(merged.length - MAX_BRIEF_NOTES)
				: merged;
	}
	if (patch.durationSec != null) {
		next.durationSec = patch.durationSec > 0 ? patch.durationSec : undefined;
	}

	// Drop cleared-to-empty scalar keys so the object stays compact.
	for (const key of [
		"goal",
		"audience",
		"tone",
		"styleNote",
		"platform",
	] as const) {
		if (next[key] == null) delete next[key];
	}
	if (next.durationSec == null) delete next.durationSec;

	next.updatedAt = now;
	return next;
}

/** Append a single learned note (convenience over {@link applyBriefPatch}). */
export function appendBriefNote(
	base: DirectorBrief | undefined,
	note: string,
	now: number = Date.now(),
): DirectorBrief {
	return applyBriefPatch(base, { notes: [note] }, now);
}

/**
 * Render the brief as the compact DIRECTOR BRIEF block folded into the agent's
 * once-per-turn system prompt. Only set fields appear; the learned notes are
 * capped to the freshest {@link BRIEF_NOTES_IN_SUMMARY}. Returns a single-line
 * "empty" prompt when nothing is set yet, nudging the agent to capture intent.
 */
export function summarizeBrief(brief: DirectorBrief | undefined): string {
	const header =
		"DIRECTOR BRIEF (persistent creative intent — honor it every turn; " +
		"call updateBrief when the user states a preference or you learn one):";

	if (isBriefEmpty(brief)) {
		return `${header}\n  (empty — capture the user's goal, audience, tone, and style with updateBrief as you learn them.)`;
	}

	const b = brief as DirectorBrief;
	const lines: string[] = [header];
	if (b.goal?.trim()) lines.push(`  GOAL: ${b.goal.trim()}`);
	if (b.audience?.trim()) lines.push(`  AUDIENCE: ${b.audience.trim()}`);
	if (b.tone?.trim()) lines.push(`  TONE: ${b.tone.trim()}`);
	if (b.styleNote?.trim()) lines.push(`  STYLE: ${b.styleNote.trim()}`);
	if (b.platform?.trim()) lines.push(`  PLATFORM: ${b.platform.trim()}`);
	if (b.durationSec != null) {
		lines.push(`  TARGET DURATION: ${b.durationSec}s`);
	}
	if (b.dos?.length) lines.push(`  DO: ${b.dos.join("; ")}`);
	if (b.donts?.length) lines.push(`  DON'T: ${b.donts.join("; ")}`);
	if (b.mustInclude?.length) {
		lines.push(`  MUST INCLUDE: ${b.mustInclude.join("; ")}`);
	}
	if (b.notes?.length) {
		const recent = b.notes.slice(-BRIEF_NOTES_IN_SUMMARY);
		lines.push("  LEARNED:");
		for (const note of recent) lines.push(`   - ${note}`);
	}
	return lines.join("\n");
}

// ── P1 digest + preference-defaults hook ────────────────────────────────────
//
// `summarizeBrief` above is the FULL, always-rendered block (honors the whole
// brief every turn). The digest below is a SEPARATE, much smaller line meant
// for `agent.ts`'s `buildContextBlock` — the same "cheap glance in the
// standing-awareness block, full detail behind a verb" pattern already used
// for the LIBRARY manifest and the TIMELINE (see `formatTimelineDigest` in
// `director-api.ts`). It is ABSENT (empty string) whenever the brief itself
// has nothing set, so a brand-new project's context block is byte-identical
// to before this fold — only a project with a stated brief gets the extra
// line.

/** First `max` chars of `s`, ellipsized; unchanged if already short enough. */
function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Compact "learned defaults" clause distilled from a {@link UserPreferenceModel}
 * — the user's most-picked aspect ratio and the mean duration of takes they've
 * kept, e.g. `"learned: 9:16, ~24s avg"`. Empty string when the model carries
 * no signal yet (fresh account, or nothing kept long enough to distill) —
 * NEVER invents a default from an empty model.
 */
export function preferenceHintClause(
	model: UserPreferenceModel | undefined,
): string {
	if (!model || model.sampleSize === 0) return "";
	const parts: string[] = [];
	const topAspect = model.preferredAspects?.[0]?.tag;
	if (topAspect) parts.push(topAspect);
	if (model.avgKeptDurationSec != null) {
		parts.push(`~${Math.round(model.avgKeptDurationSec)}s avg`);
	}
	return parts.length ? `learned: ${parts.join(", ")}` : "";
}

/**
 * One-line BRIEF digest for `buildContextBlock`'s PROJECT/PERSONAS/LIBRARY/
 * TIMELINE standing-awareness block (`agent.ts`) — mirrors the TIMELINE
 * digest's terse `"LABEL: seg · seg · seg."` shape, capped to roughly the
 * same ~25-token budget. Returns `""` (⇒ omitted entirely by the caller)
 * when the brief has nothing set — a brief with only unreadable content
 * (e.g. just `notes`, no goal/audience/platform/tone/duration/mustInclude)
 * also degrades to `""` since there is nothing concrete to digest.
 *
 * `preferenceModel`, when it carries signal (P1's preference-defaults hook —
 * see the north-star doc's P1/P6 seam), appends a `learned:` clause ONLY when
 * the brief hasn't already pinned a target duration itself — a stated
 * preference always wins over a learned default, never gets overridden by it.
 */
export function briefDigest(
	brief: DirectorBrief | undefined,
	preferenceModel?: UserPreferenceModel,
): string {
	if (isBriefEmpty(brief)) return "";
	const b = brief as DirectorBrief;

	const segments: string[] = [];
	if (b.goal?.trim()) segments.push(truncate(b.goal.trim(), 40));
	if (b.audience?.trim()) segments.push(`for ${b.audience.trim()}`);
	if (b.platform?.trim()) segments.push(b.platform.trim());
	if (b.tone?.trim()) segments.push(b.tone.trim());
	if (b.durationSec != null) {
		segments.push(`${b.durationSec}s target`);
	} else {
		const hint = preferenceHintClause(preferenceModel);
		if (hint) segments.push(hint);
	}
	if (b.mustInclude?.length) {
		segments.push(`must: ${b.mustInclude.slice(0, 2).join("; ")}`);
	}

	return segments.length ? `BRIEF: ${segments.join(" · ")}.` : "";
}
