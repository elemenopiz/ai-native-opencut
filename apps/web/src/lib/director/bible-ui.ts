/**
 * Project Bible — UI-facing view model + human edit glue.
 *
 * The persistence layer (`project-bible.ts`) and the Director's write-through
 * verbs (`director-api.ts`) are shipped and tested; this module is the thin,
 * React-free seam the human-facing Bible panel reads and writes through. It does
 * NOT own storage: it folds the live Director state into one renderable
 * {@link BibleDocument}, and routes human edits through the SAME
 * write-through/checkpoint path the Director uses ({@link syncProjectBible}), so
 * an edit like "grade is now colder" lands on the durable, versioned bible AND
 * the session WeakMap that `studio-executor.ts` reads via
 * `getStoredConsistencyContext` → `withConsistencyContext` on every future
 * provider call. Mirrors how `director-api.ts`'s `updateBrief` /
 * `setConsistencyContext` verbs write, but with no DirectorApi instance required.
 *
 * Split so the pure view-model builder and the editor-glue edit helpers are
 * independently unit-testable against `fake-editor.ts` (see `bible-ui.test.ts`).
 */

import type { EditorCore } from "@/core";
import type {
	BibleCheckpoint,
	BibleDecision,
	DirectorBrief,
	PersonaRosterEntry,
	ProjectBible,
} from "@/types/project";
import { usePersonaStore } from "@/stores/persona-store";
import {
	applyBriefPatch,
	isBriefEmpty,
	type BriefPatch,
} from "./director-brief";
import {
	getStoredConsistencyContext,
	storeConsistencyContext,
	type ConsistencyContext,
} from "./consistency-prompt";
import {
	getStoredPlan,
	type StoryboardPlan,
	type StyleBible,
} from "./storyboard-plan";
import {
	revertProjectBible,
	syncProjectBible,
	type RevertResult,
} from "./project-bible";

/** Labels stamped on checkpoints/decisions produced by a HUMAN edit (vs a Director verb). */
export const HUMAN_BRIEF_LABEL = "human:brief";
export const HUMAN_LOOK_LABEL = "human:look";

/**
 * The whole Bible folded into one renderable document. Assembled from the LIVE
 * Director state (durable brief + the session WeakMaps the bible hydrates on
 * mount) so both human edits and Director writes are reflected the moment the
 * panel re-renders — not just from the last persisted snapshot.
 */
export interface BibleDocument {
	/** True when nothing is authored yet — drives the invite-to-fill empty state. */
	isEmpty: boolean;
	/** Durable creative intent (goal/audience/tone/style/dos/donts/notes). */
	brief: DirectorBrief;
	/** Reel-level STYLE/CHARACTERS/SETTING block prepended to every provider call. */
	consistency?: ConsistencyContext;
	/** Structured reel look (palette/lens-mood/cast/setting) — the Understanding-Pass seam. */
	styleBible?: StyleBible;
	/** The active multi-shot storyboard plan. */
	plan?: StoryboardPlan;
	/** Durable snapshot of the reusable cast. */
	personaRoster: PersonaRosterEntry[];
	/** Running decision log, NEWEST FIRST for display. */
	decisions: BibleDecision[];
	/** Checkpoint history, NEWEST FIRST for the version panel (one-click restore). */
	history: BibleCheckpoint[];
	/** Monotonic bible revision. */
	version: number;
	/** Epoch ms of the last write, for provenance. */
	updatedAt?: number;
}

/**
 * Fold the live Director state into a {@link BibleDocument} (pure). The brief,
 * consistency context, and plan are read LIVE (the WeakMaps the bible hydrated
 * on mount + the durable brief); `bible` supplies the durable-only extras
 * (styleBible, roster, decisions, history, version).
 */
export function buildBibleDocument(input: {
	bible: ProjectBible | undefined;
	brief: DirectorBrief;
	consistency: ConsistencyContext | undefined;
	plan: StoryboardPlan | undefined;
}): BibleDocument {
	const { bible, brief, consistency, plan } = input;
	const styleBible = bible?.styleBible;
	const personaRoster = bible?.personaRosterSummary ?? [];
	// Newest-first copies for display (the persisted arrays are newest-LAST).
	const decisions = [...(bible?.decisions ?? [])].reverse();
	const history = [...(bible?.history ?? [])].reverse();

	const hasConsistency = Boolean(
		consistency &&
			(consistency.style?.trim() ||
				consistency.setting?.trim() ||
				consistency.characters.length > 0),
	);
	const hasStyleBible = Boolean(
		styleBible &&
			(styleBible.palette?.trim() ||
				styleBible.lensMood?.trim() ||
				styleBible.setting?.trim() ||
				(styleBible.characters?.length ?? 0) > 0),
	);

	const isEmpty =
		isBriefEmpty(brief) &&
		!hasConsistency &&
		!hasStyleBible &&
		!plan &&
		personaRoster.length === 0 &&
		history.length === 0 &&
		decisions.length === 0;

	return {
		isEmpty,
		brief,
		...(hasConsistency ? { consistency } : {}),
		...(hasStyleBible ? { styleBible } : {}),
		...(plan ? { plan } : {}),
		personaRoster,
		decisions,
		history,
		version: bible?.version ?? 0,
		...(bible?.updatedAt != null ? { updatedAt: bible.updatedAt } : {}),
	};
}

/** Compact, durable snapshot of the reusable persona roster (mirrors director-api). */
function currentPersonaRoster(): PersonaRosterEntry[] {
	try {
		return usePersonaStore.getState().personas.map((p) => ({
			id: p.id,
			name: p.name,
			descriptor: p.descriptor,
		}));
	} catch {
		return [];
	}
}

/**
 * Apply a HUMAN edit to the durable {@link DirectorBrief} and write it through
 * the persisted, versioned bible — the exact path the Director's `updateBrief`
 * verb takes, minus the DirectorApi. Scalars replace, dos/donts append+dedupe,
 * notes append+cap (see {@link applyBriefPatch}). Returns the merged brief.
 */
export function editBrief(
	editor: EditorCore,
	patch: BriefPatch,
	opts: { note?: string } = {},
): DirectorBrief {
	const next = applyBriefPatch(editor.project.getDirectorBrief(), patch);
	editor.project.setDirectorBrief({ brief: next });
	syncProjectBible(editor, {
		label: HUMAN_BRIEF_LABEL,
		note: opts.note ?? "Edited brief",
		personas: currentPersonaRoster(),
	});
	return next;
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
 * REPLACE the durable brief's `dos` / `donts` lists wholesale (human list edit —
 * add/edit/remove a constraint), unlike {@link editBrief}'s append-only patch
 * semantics which suit the Director. An emptied list is dropped so the brief
 * stays compact. Only the passed fields change; the rest of the brief is
 * untouched. Writes through the versioned bible like every other human edit.
 */
export function replaceBriefLists(
	editor: EditorCore,
	lists: { dos?: string[]; donts?: string[] },
	opts: { note?: string } = {},
): DirectorBrief {
	const current = editor.project.getDirectorBrief();
	const next: DirectorBrief = { ...current };
	if (lists.dos !== undefined) {
		const cleaned = cleanList(lists.dos);
		if (cleaned.length) next.dos = cleaned;
		else delete next.dos;
	}
	if (lists.donts !== undefined) {
		const cleaned = cleanList(lists.donts);
		if (cleaned.length) next.donts = cleaned;
		else delete next.donts;
	}
	next.updatedAt = Date.now();
	editor.project.setDirectorBrief({ brief: next });
	syncProjectBible(editor, {
		label: HUMAN_BRIEF_LABEL,
		note: opts.note ?? "Edited constraints",
		personas: currentPersonaRoster(),
	});
	return next;
}

/**
 * Apply a HUMAN edit to the reel-level {@link ConsistencyContext} — the STYLE and
 * SETTING the panel exposes — preserving the existing cast, then write it through
 * the persisted bible. Updates the session WeakMap FIRST (via
 * {@link storeConsistencyContext}) so the edit takes effect on the very next
 * provider call through `studio-executor.ts`'s `withConsistencyContext`, then
 * {@link syncProjectBible} persists + checkpoints it so it survives a reload.
 * Returns the new context.
 */
export function editConsistency(
	editor: EditorCore,
	patch: { style?: string; setting?: string },
	opts: { note?: string } = {},
): ConsistencyContext {
	const current = getStoredConsistencyContext(editor);
	const next: ConsistencyContext = {
		style:
			patch.style !== undefined ? patch.style.trim() : (current?.style ?? ""),
		setting:
			patch.setting !== undefined
				? patch.setting.trim()
				: (current?.setting ?? ""),
		characters: current?.characters ?? [],
	};
	storeConsistencyContext(editor, next);
	syncProjectBible(editor, {
		label: HUMAN_LOOK_LABEL,
		note: opts.note ?? "Edited reel look",
		personas: currentPersonaRoster(),
	});
	return next;
}

/**
 * Restore the bible to a prior checkpoint and re-hydrate the live Director state
 * (brief + consistency/plan WeakMaps) from it — the panel's one-click "go back to
 * Tuesday's look". Thin wrapper over the shipped {@link revertProjectBible} so
 * the panel never re-implements the revert. `reverted: false` ⇒ nothing to
 * restore (unknown version / no history).
 */
export function restoreCheckpoint(
	editor: EditorCore,
	toVersion?: number,
): RevertResult {
	return revertProjectBible(editor, toVersion != null ? { toVersion } : {});
}

/** Read the live Bible document straight off an editor (convenience for the panel). */
export function readBibleDocument(editor: EditorCore): BibleDocument {
	return buildBibleDocument({
		bible: editor.project.getProjectBible(),
		brief: editor.project.getDirectorBrief(),
		consistency: getStoredConsistencyContext(editor),
		plan: getStoredPlan(editor),
	});
}
