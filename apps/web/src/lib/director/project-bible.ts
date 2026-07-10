/**
 * Project Bible — the Director's DURABLE, VERSIONED creative memory.
 *
 * The reel-level creative state (STYLE/CHARACTERS/SETTING consistency context and
 * the multi-shot storyboard plan) has always lived in WeakMaps keyed by the
 * `EditorCore` instance (`consistency-prompt.ts`, `storyboard-plan.ts`). Those
 * are session state: garbage-collected when the editor unmounts, so the look, the
 * cast, and the plan EVAPORATE between sessions — only the one-line brief survived.
 *
 * This module promotes that state into a persistent {@link ProjectBible} that
 * rides on the durable project record next to {@link DirectorBrief} (see
 * `types/project.ts`, serialized by `services/storage/service.ts`). The bible is
 * the SOURCE OF TRUTH; the WeakMap caches stay the fast read path and are
 * HYDRATED from the bible on editor mount ({@link hydrateDirectorStateFromBible}).
 * Every write-through ({@link syncProjectBible}) snapshots the PRIOR state into a
 * bounded checkpoint history and bumps `version`, so "revert the look to before
 * the last change" is a real operation ({@link revertProjectBible}) — Descript's
 * per-turn checkpoint pattern (`docs/poach/descript-underlord-poaches.md` §4 #3),
 * made turn-level rather than a single linear undo because our slots/takes are
 * already versioned objects.
 *
 * Split for testability, mirroring `director-brief.ts`:
 *  - PURE core (no editor, no stores): {@link pushCheckpoint}/{@link revertBible}
 *    and the empties — directly unit-testable.
 *  - EDITOR glue: {@link captureBibleState}/{@link syncProjectBible}/
 *    {@link hydrateDirectorStateFromBible}/{@link revertProjectBible} — exercised
 *    against the headless `fake-editor.ts`.
 */

import type { EditorCore } from "@/core";
import type {
	BibleApproval,
	BibleCheckpoint,
	DirectorBrief,
	PersonaRosterEntry,
	ProjectBible,
	ProjectBibleState,
} from "@/types/project";
import type { StyleProbe } from "@/lib/search/asset-understanding";
import { isBriefEmpty } from "./director-brief";
import {
	getStoredConsistencyContext,
	storeConsistencyContext,
} from "./consistency-prompt";
import { getStoredPlan, storePlan } from "./storyboard-plan";
import type { StyleBible } from "./storyboard-plan";

/**
 * Cap on the checkpoint history so the bible never grows without bound across a
 * long session. When exceeded, the OLDEST checkpoints are dropped (newest-last),
 * matching {@link import("./director-brief").MAX_BRIEF_NOTES}'s convention.
 */
export const MAX_BIBLE_HISTORY = 20;

/** Cap on the running decision log (newest-last, oldest dropped). */
export const MAX_BIBLE_DECISIONS = 30;

/** Cap on the running approvals ledger (newest-last, oldest dropped). */
export const MAX_BIBLE_APPROVALS = 30;

/** A fresh, empty bible — version 0, nothing captured yet. */
export function emptyProjectBible(now: number = Date.now()): ProjectBible {
	return { version: 0, updatedAt: now };
}

/** Pull just the revertable {@link ProjectBibleState} subset out of a bible. */
export function extractBibleState(bible: ProjectBible): ProjectBibleState {
	const state: ProjectBibleState = {};
	if (bible.brief) state.brief = bible.brief;
	if (bible.styleBible) state.styleBible = bible.styleBible;
	if (bible.consistencyContext)
		state.consistencyContext = bible.consistencyContext;
	if (bible.plan) state.plan = bible.plan;
	if (bible.personaRosterSummary?.length)
		state.personaRosterSummary = bible.personaRosterSummary;
	return state;
}

/** True when a state carries nothing worth checkpointing. */
export function isBibleStateEmpty(state: ProjectBibleState): boolean {
	return (
		isBriefEmpty(state.brief) &&
		!state.styleBible &&
		!state.consistencyContext &&
		!state.plan &&
		(state.personaRosterSummary?.length ?? 0) === 0
	);
}

function capHistory(history: BibleCheckpoint[]): BibleCheckpoint[] {
	return history.length > MAX_BIBLE_HISTORY
		? history.slice(history.length - MAX_BIBLE_HISTORY)
		: history;
}

/**
 * Fold a new {@link ProjectBibleState} onto `bible`, returning a NEW bible (pure).
 * The PRIOR state is pushed onto `history` (unless it was empty — nothing to
 * revert to) so the change is reversible, `version` bumps monotonically, and an
 * optional `note` is appended to the bounded decision log. `assetManifest` /
 * `understanding` (the sibling-agent seams) pass straight through untouched.
 */
export function pushCheckpoint(
	bible: ProjectBible,
	nextState: ProjectBibleState,
	opts: { label?: string; note?: string; now?: number } = {},
): ProjectBible {
	const now = opts.now ?? Date.now();
	const priorState = extractBibleState(bible);

	const history = [...(bible.history ?? [])];
	if (!isBibleStateEmpty(priorState)) {
		history.push({
			version: bible.version,
			at: bible.updatedAt,
			...(opts.label ? { label: opts.label } : {}),
			state: priorState,
		});
	}

	const decisions = opts.note
		? [...(bible.decisions ?? []), { at: now, note: opts.note }].slice(
				-MAX_BIBLE_DECISIONS,
			)
		: bible.decisions;

	return {
		...nextState,
		version: bible.version + 1,
		updatedAt: now,
		...(history.length ? { history: capHistory(history) } : {}),
		...(decisions?.length ? { decisions } : {}),
		...(bible.approvals?.length ? { approvals: bible.approvals } : {}),
		...(bible.assetManifest !== undefined
			? { assetManifest: bible.assetManifest }
			: {}),
		...(bible.understanding !== undefined
			? { understanding: bible.understanding }
			: {}),
	};
}

/** Outcome of a {@link revertBible} call. `reverted: false` ⇒ nothing to revert to. */
export interface RevertResult {
	bible: ProjectBible;
	reverted: boolean;
	/** The checkpoint version that was restored (present only when `reverted`). */
	toVersion?: number;
}

/**
 * Revert a bible to a prior checkpoint (pure). With `toVersion` set, restores the
 * matching history entry; otherwise restores the MOST RECENT one ("revert the last
 * change"). The current (pre-revert) state is itself pushed onto history, so a
 * revert is undoable, and `version` still bumps monotonically — richer than a
 * linear undo stack. A no-op (no history / unknown version) returns the bible
 * unchanged with `reverted: false`.
 */
export function revertBible(
	bible: ProjectBible,
	opts: { toVersion?: number; now?: number } = {},
): RevertResult {
	const history = bible.history ?? [];
	if (history.length === 0) return { bible, reverted: false };

	const target =
		opts.toVersion != null
			? history.find((h) => h.version === opts.toVersion)
			: history[history.length - 1];
	if (!target) return { bible, reverted: false };

	const now = opts.now ?? Date.now();
	const currentState = extractBibleState(bible);
	const nextHistory = capHistory([
		...history,
		{
			version: bible.version,
			at: bible.updatedAt,
			label: "pre-revert",
			state: currentState,
		},
	]);
	const decisions = [
		...(bible.decisions ?? []),
		{ at: now, note: `Reverted to checkpoint v${target.version}` },
	].slice(-MAX_BIBLE_DECISIONS);

	return {
		reverted: true,
		toVersion: target.version,
		bible: {
			...target.state,
			version: bible.version + 1,
			updatedAt: now,
			history: nextHistory,
			decisions,
			...(bible.approvals?.length ? { approvals: bible.approvals } : {}),
			...(bible.assetManifest !== undefined
				? { assetManifest: bible.assetManifest }
				: {}),
			...(bible.understanding !== undefined
				? { understanding: bible.understanding }
				: {}),
		},
	};
}

// ── Editor glue ──────────────────────────────────────────────────────────────

/**
 * Read the current live Director state off an editor into a {@link ProjectBibleState}:
 * the durable brief (empty ⇒ omitted), the consistency-context and storyboard-plan
 * WeakMap caches, the style bible (the plan's bible, else a previously-set one so
 * an Understanding-Pass seed survives), and the supplied persona roster snapshot.
 */
export function captureBibleState(
	editor: EditorCore,
	opts: {
		personas?: PersonaRosterEntry[];
		/** Preserve an externally-set style bible when no plan supplies one. */
		prevStyleBible?: ProjectBibleState["styleBible"];
	} = {},
): ProjectBibleState {
	const briefRaw = editor.project.getDirectorBrief();
	const brief: DirectorBrief | undefined = isBriefEmpty(briefRaw)
		? undefined
		: briefRaw;
	const consistencyContext = getStoredConsistencyContext(editor);
	const plan = getStoredPlan(editor);
	const styleBible = plan?.bible ?? opts.prevStyleBible;
	const personas = opts.personas ?? [];

	const state: ProjectBibleState = {};
	if (brief) state.brief = brief;
	if (styleBible) state.styleBible = styleBible;
	if (consistencyContext) state.consistencyContext = consistencyContext;
	if (plan) state.plan = plan;
	if (personas.length) state.personaRosterSummary = personas;
	return state;
}

/**
 * Write-through: capture the editor's current Director state, checkpoint the
 * PRIOR persisted bible, and persist the new one on the active project (which
 * marks it dirty so the SaveManager flushes it to storage). Returns the new
 * bible. Best-effort by contract — callers should not let a persistence hiccup
 * break the verb that triggered it.
 */
export function syncProjectBible(
	editor: EditorCore,
	opts: {
		label?: string;
		note?: string;
		personas?: PersonaRosterEntry[];
		now?: number;
	} = {},
): ProjectBible {
	const prev = editor.project.getProjectBible() ?? emptyProjectBible(opts.now);
	const nextState = captureBibleState(editor, {
		personas: opts.personas,
		prevStyleBible: prev.styleBible,
	});
	const next = pushCheckpoint(prev, nextState, {
		label: opts.label,
		note: opts.note,
		now: opts.now,
	});
	editor.project.setProjectBible({ bible: next });
	return next;
}

/**
 * Hydrate the session WeakMap caches from the persisted bible on editor mount.
 * ALWAYS clears first so switching projects on a reused `EditorCore` never leaks
 * the prior reel's context, then repopulates the consistency-context and plan
 * caches from the bible (absent ⇒ left cleared). The brief already loads with the
 * project record (it is read straight off `project.directorBrief`), so it needs
 * no WeakMap; `styleBible`/`personaRosterSummary` are durable read-only fields.
 * Returns the hydrated bible (or `undefined` when the project has none).
 */
export function hydrateDirectorStateFromBible(
	editor: EditorCore,
): ProjectBible | undefined {
	const bible = editor.project.getProjectBible();
	storeConsistencyContext(editor, bible?.consistencyContext);
	storePlan(editor, bible?.plan);
	return bible;
}

/**
 * Revert the persisted bible to a prior checkpoint and re-hydrate the live
 * Director state from it: restore the brief onto the project and repopulate the
 * consistency/plan WeakMaps. No-op (returns `reverted: false`) when there is no
 * history or the requested version is unknown.
 */
export function revertProjectBible(
	editor: EditorCore,
	opts: { toVersion?: number; now?: number } = {},
): RevertResult {
	const current = editor.project.getProjectBible();
	if (!current) return { bible: emptyProjectBible(opts.now), reverted: false };

	const result = revertBible(current, opts);
	if (!result.reverted) return result;

	editor.project.setProjectBible({ bible: result.bible });
	// Restore the brief (a full checkpoint restore, not just the look) so the
	// durable brief matches the reverted state, then sync the WeakMaps.
	editor.project.setDirectorBrief({ brief: result.bible.brief ?? {} });
	hydrateDirectorStateFromBible(editor);
	return result;
}

// ── Flow D: approval ledger ──────────────────────────────────────────────────
//
// The three human gates (voice-consent, hero-shot, final-cut) write their
// rationale into the bible so decisions COMPOUND. Consent lives in its own
// sensitive store; the two creative gates append to this bounded ledger AND
// checkpoint the current creative state, so an approval is both a recorded fact
// and a revertable point in the bible's history.

/** Append a {@link BibleApproval} to a bible's ledger (pure), bounded newest-last. */
export function appendApproval(
	bible: ProjectBible,
	approval: BibleApproval,
): ProjectBible {
	const approvals = [...(bible.approvals ?? []), approval].slice(
		-MAX_BIBLE_APPROVALS,
	);
	return { ...bible, approvals };
}

/**
 * Record a human approval on the persisted bible AND checkpoint the current
 * creative state with a decision note — the durable write-through the hero-shot
 * and final-cut gates use. Best-effort by contract: a persistence hiccup must
 * never break the verb that triggered it (the caller wraps this in try/catch).
 * Returns the new bible.
 */
export function recordBibleApproval(
	editor: EditorCore,
	approval: BibleApproval,
	opts: {
		label?: string;
		note?: string;
		personas?: PersonaRosterEntry[];
		now?: number;
	} = {},
): ProjectBible {
	const prev = editor.project.getProjectBible() ?? emptyProjectBible(opts.now);
	// Attach the approval to the ledger first so the checkpoint below carries it
	// through (pushCheckpoint passes `approvals` through untouched).
	editor.project.setProjectBible({ bible: appendApproval(prev, approval) });
	return syncProjectBible(editor, {
		label: opts.label,
		note: opts.note,
		personas: opts.personas,
		now: opts.now,
	});
}

// ── Flow D follow-up B: Understanding style probe → styleBible seam ───────────

/** Project a {@link StyleProbe} onto a {@link StyleBible} (pure); undefined when empty. */
export function styleProbeToStyleBible(
	probe: StyleProbe | undefined,
): StyleBible | undefined {
	if (!probe) return undefined;
	const palette = probe.palette?.trim();
	const lensMood = probe.lensMood?.trim();
	const setting = probe.setting?.trim();
	if (!palette && !lensMood && !setting) return undefined;
	return {
		...(palette ? { palette } : {}),
		...(lensMood ? { lensMood } : {}),
		...(setting ? { setting } : {}),
	};
}

/** A compact one-line summary of a derived style bible, for the decision log. */
function summarizeStyleBible(bible: StyleBible): string {
	return (
		[
			bible.palette && `palette: ${bible.palette}`,
			bible.lensMood && `lens/mood: ${bible.lensMood}`,
			bible.setting && `setting: ${bible.setting}`,
		]
			.filter(Boolean)
			.join("; ") || "(empty)"
	);
}

/** Outcome of {@link seedStyleBibleFromProbe}. */
export interface StyleProbeSeedResult {
	/** True ⇒ the probe was applied as the bible's styleBible. */
	seeded: boolean;
	/** True ⇒ a human/existing styleBible was preserved; the read was logged as a note instead. */
	noted?: boolean;
	/** Why nothing was applied (when `seeded` is false and `noted` is false). */
	reason?: "empty-probe";
	/** The resulting persisted bible (undefined only when nothing was written). */
	bible?: ProjectBible;
}

/**
 * Route an Understanding-Pass {@link StyleProbe} into the Project Bible's
 * `styleBible` seam — ADDITIVE and CHECKPOINTED, and NEVER silently clobbering a
 * human-set look. When the bible has no `styleBible` yet (or `force` is set), the
 * probe is applied and checkpointed. When a `styleBible` already exists and
 * `force` is not set, the look is PRESERVED and the read is recorded as a decision
 * note instead — so the human's intent wins and the observation still lands in
 * the durable log. Best-effort; the caller wraps it.
 */
export function seedStyleBibleFromProbe(
	editor: EditorCore,
	probe: StyleProbe | undefined,
	opts: { force?: boolean; now?: number } = {},
): StyleProbeSeedResult {
	const derived = styleProbeToStyleBible(probe);
	if (!derived) return { seeded: false, reason: "empty-probe" };

	const now = opts.now ?? Date.now();
	const prev = editor.project.getProjectBible() ?? emptyProjectBible(now);
	const summary = summarizeStyleBible(derived);

	if (prev.styleBible && !opts.force) {
		// Do NOT clobber a human/existing look — record the read as a note only.
		const next = pushCheckpoint(prev, extractBibleState(prev), {
			label: "styleProbe",
			note: `Understanding style read available but styleBible already set — not applied: ${summary}`,
			now,
		});
		editor.project.setProjectBible({ bible: next });
		return { seeded: false, noted: true, bible: next };
	}

	const nextState = { ...extractBibleState(prev), styleBible: derived };
	const next = pushCheckpoint(prev, nextState, {
		label: "styleProbe",
		note: `Seeded styleBible from understanding style read: ${summary}`,
		now,
	});
	editor.project.setProjectBible({ bible: next });
	return { seeded: true, bible: next };
}
