/**
 * Director brief helpers — pure logic over the persistent, per-project
 * {@link DirectorBrief} (defined on `TProject` in `@/types/project`).
 *
 * The brief is the Director's DURABLE memory of the user's creative intent:
 * goal, audience, tone, a style bible, do/don't constraints, and a running list
 * of learned one-line notes (stated preferences + chosen-take rationale). Each
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
		!brief.styleBible?.trim() &&
		(brief.dos?.length ?? 0) === 0 &&
		(brief.donts?.length ?? 0) === 0 &&
		(brief.notes?.length ?? 0) === 0
	);
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
	styleBible?: string;
	/** Constraints to ADD (appended, not replaced). */
	dos?: string[];
	donts?: string[];
	/** Learned one-line notes to append (stated preferences, chosen-take rationale). */
	notes?: string[];
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
	next.styleBible = patchScalar(current.styleBible, patch.styleBible);

	if (patch.dos?.length) {
		next.dos = cleanList([...(current.dos ?? []), ...patch.dos]);
	}
	if (patch.donts?.length) {
		next.donts = cleanList([...(current.donts ?? []), ...patch.donts]);
	}
	if (patch.notes?.length) {
		const merged = cleanList([...(current.notes ?? []), ...patch.notes]);
		next.notes =
			merged.length > MAX_BRIEF_NOTES
				? merged.slice(merged.length - MAX_BRIEF_NOTES)
				: merged;
	}

	// Drop cleared-to-empty scalar keys so the object stays compact.
	for (const key of ["goal", "audience", "tone", "styleBible"] as const) {
		if (next[key] == null) delete next[key];
	}

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
	if (b.styleBible?.trim()) lines.push(`  STYLE: ${b.styleBible.trim()}`);
	if (b.dos?.length) lines.push(`  DO: ${b.dos.join("; ")}`);
	if (b.donts?.length) lines.push(`  DON'T: ${b.donts.join("; ")}`);
	if (b.notes?.length) {
		const recent = b.notes.slice(-BRIEF_NOTES_IN_SUMMARY);
		lines.push("  LEARNED:");
		for (const note of recent) lines.push(`   - ${note}`);
	}
	return lines.join("\n");
}
