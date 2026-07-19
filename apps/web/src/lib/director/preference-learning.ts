/**
 * Preference learning — the BEHAVIORAL sibling of `cross-project-memory.ts`.
 *
 * `cross-project-memory.ts` distills what the user SAYS (styleBible look, tone,
 * dos/donts, marked-persistent brief notes) into `UserBibleDefaults`. This module
 * distills what the user DOES: which takes they keep (`chooseTake`), which they
 * throw away (`reroll`/`discard`), and which backend wins an A/B
 * (`compareTake`'s `compareOutcome`). Same shape of split as that sibling:
 *
 *  - {@link distillPreferences} and {@link appendPreferenceEvent} are PURE
 *    (no editor, no stores, no IndexedDB) so they are directly unit-testable.
 *  - {@link logPreferenceEvent} is the one impure entry point — it takes a plain
 *    {@link PreferenceEvent} (no store/UI coupling) and does the storage
 *    round-trip via `services/storage/user-memory-store.ts`, so a future
 *    call-site hook (Bet 3b, in `director-api.ts`) can call it directly without
 *    knowing anything about IndexedDB.
 *
 * ── WHAT COUNTS AS "HONEST" META ─────────────────────────────────────────────
 * {@link PreferenceEventMeta} carries ONLY fields that actually exist on a take
 * today — grounded against `Take`/`GenerationSpec`/`Provenance` in
 * `@/types/timeline` and the `chooseTake`/`reroll`/`compareTake` verbs in
 * `director-api.ts` (read-only reference, not modified here):
 *  - `backendId`/`vendor`/`safetyTier` ← `Provenance` (or `GenerationSpec.model`
 *    before a take has provenance, e.g. still queued).
 *  - `aspect`/`durationSec`/`mode`/`seedLocked`/`kind` ← `GenerationSpec` fields
 *    of the same name.
 *  - `cameraPreset` ← `GenerationSpec.cameraPreset`, the ONLY field an actual
 *    take carries that resembles a "look/style tag" today. There is no
 *    per-take palette/mood/style-tag field to distill from yet (that lives on
 *    the project-level `StyleBible`, not on `Take`) — so this module does not
 *    invent one.
 *  - `reason` ← an optional free-text reason the caller supplies for a
 *    `reroll`/`discard` (mirrors `chooseTake`'s existing `rationale` param).
 *  - `competingBackendIds`/`wonBackendId` ← `compareTake`'s `backendIds` input
 *    and its resolved winner, mapped from takeId to backendId by the caller
 *    (`compareTake` tracks `{ takeId, backendId }` pairs internally).
 *
 * NO speculative taste vectors, no model calls — deterministic counting rules,
 * exactly like `cross-project-memory.ts`.
 */

import {
	getPreferenceEventLog,
	savePreferenceEventLog,
	saveUserPreferenceModel,
} from "@/services/storage/user-memory-store";
import type { SafetyTier, VideoMode, VideoOrientation } from "@/types/timeline";

/** What kind of behavioral signal a {@link PreferenceEvent} carries. */
export type PreferenceEventType =
	| "chooseTake" // the user kept this take (`chooseTake`)
	| "reroll" // the user asked for alternatives instead of keeping this one
	| "discard" // the user explicitly threw this take away
	| "compareOutcome"; // an A/B (`compareTake`) resolved, auto-picked or user-picked

/**
 * Observable traits of the take/recipe involved in a preference event. See the
 * module doc for exactly where each field is grounded. Every field is
 * optional — callers pass only what the take actually carries.
 */
export interface PreferenceEventMeta {
	/** `Provenance.backendId`, or `GenerationSpec.model`/`.provider` before provenance exists. */
	backendId?: string;
	/** `Provenance.vendor`, when known. */
	vendor?: string;
	/** `GenerationSpec.orientation`. */
	aspect?: VideoOrientation;
	/** `GenerationSpec.duration`, seconds. */
	durationSec?: number;
	/** `GenerationSpec.mode`. */
	mode?: VideoMode;
	/** `GenerationSpec.cameraPreset` — the one recipe field that carries a "look" today. */
	cameraPreset?: string;
	/** `Provenance.safetyTier`, when known. */
	safetyTier?: SafetyTier;
	/** `GenerationSpec.seedLocked` / `Provenance.seedLocked`. */
	seedLocked?: boolean;
	/** `GenerationSpec.kind` — voiceover takes carry no visual aspect/look. */
	kind?: "video" | "voiceover";
	/** Free-text reason attached to a `reroll`/`discard`, when the caller supplied one. */
	reason?: string;
	/** `compareOutcome` only: every backendId that competed (`compareTake`'s `backendIds`). */
	competingBackendIds?: string[];
	/** `compareOutcome` only: the backendId that won, absent when unresolved / left to the user. */
	wonBackendId?: string;
}

/** One behavioral preference signal — a label for the distill rules below. */
export interface PreferenceEvent {
	type: PreferenceEventType;
	/** Epoch ms the event happened. */
	ts: number;
	projectId: string;
	meta: PreferenceEventMeta;
}

/** Cap on the per-user event log so it never grows unbounded (oldest evicted, FIFO). */
export const MAX_PREFERENCE_EVENTS = 500;

/** How many top entries {@link distillPreferences} keeps per ranked list. */
const TOP_K = 5;

/** One tag (aspect ratio, camera-preset "look", …) and how many events carried it. */
export interface TagCount {
	tag: string;
	count: number;
}

/** Per-backend competition tally distilled from `compareOutcome` events. */
export interface BackendWinRate {
	backendId: string;
	wins: number;
	losses: number;
}

/**
 * Minimal, honest, deterministic distillation of behavior — counters + top-k,
 * NEVER an extension of `UserBibleDefaults` (Step-0 revision #5: a smaller,
 * disjoint blast radius). A model with `sampleSize: 0` and every list absent is
 * the well-formed "no preferences yet" value — see {@link emptyUserPreferenceModel}.
 */
export interface UserPreferenceModel {
	/** Total events folded into this model. */
	sampleSize: number;
	/** Aspect ratios of KEPT takes (`chooseTake`), most-picked first. */
	preferredAspects?: TagCount[];
	/** Mean duration (seconds) of KEPT takes that carried a duration. */
	avgKeptDurationSec?: number;
	/** Camera-preset "look" tags of KEPT takes, most-common first (top-k). */
	topChosenLooks?: TagCount[];
	/** Camera-preset "look" tags of REROLLED/DISCARDED takes, most-common first (top-k) — what the user rejects. */
	topRerolledLooks?: TagCount[];
	/** Per-backend win/loss tally from `compareOutcome` events, most-competed first. */
	backendWinRates?: BackendWinRate[];
	/** Epoch ms this model was distilled. */
	updatedAt: number;
}

/** A fresh, empty preference model — the well-formed "no preferences yet" value. */
export function emptyUserPreferenceModel(
	now: number = Date.now(),
): UserPreferenceModel {
	return { sampleSize: 0, updatedAt: now };
}

/**
 * Append one event to a preference-event log, evicting the oldest entries past
 * {@link MAX_PREFERENCE_EVENTS} (FIFO). PURE — the caller owns persistence.
 */
export function appendPreferenceEvent(
	log: readonly PreferenceEvent[],
	event: PreferenceEvent,
	cap: number = MAX_PREFERENCE_EVENTS,
): PreferenceEvent[] {
	const next = [...log, event];
	return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Increment `key` in a running tally map, seeding it at 0 on first sight. */
function bump(tally: Map<string, number>, key: string): void {
	tally.set(key, (tally.get(key) ?? 0) + 1);
}

/**
 * The top `TOP_K` entries of a tally map, most-count first. Ties break by
 * first-seen order (stable sort over the map's insertion-ordered entries), so
 * the result is deterministic for a fixed input event order.
 */
function topTags(tally: Map<string, number>): TagCount[] {
	return [...tally.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, TOP_K);
}

/** Round to 2 decimal places (seconds granularity is finer than any UI shows). */
function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * Distill a preference-event log into a {@link UserPreferenceModel} (PURE, like
 * `promoteBibleToUserDefaults`). Deterministic counting rules only:
 *  - `chooseTake` events feed `preferredAspects`, `avgKeptDurationSec`, and
 *    `topChosenLooks` — what the user KEEPS.
 *  - `reroll`/`discard` events feed `topRerolledLooks` — what the user REJECTS.
 *  - `compareOutcome` events feed `backendWinRates` — every competing backend
 *    gets a loss unless it's the (resolved) winner, which gets a win. An
 *    unresolved comparison (`wonBackendId` absent — left to the user) tallies
 *    no wins/losses, since nothing was actually decided yet.
 * An empty log distills to {@link emptyUserPreferenceModel} — the well-formed
 * "no preferences yet" value, never `undefined`.
 */
export function distillPreferences(
	events: readonly PreferenceEvent[],
	now: number = Date.now(),
): UserPreferenceModel {
	if (events.length === 0) return emptyUserPreferenceModel(now);

	const aspectTally = new Map<string, number>();
	const chosenLookTally = new Map<string, number>();
	const rerolledLookTally = new Map<string, number>();
	const backendTally = new Map<string, { wins: number; losses: number }>();
	let keptDurationSum = 0;
	let keptDurationCount = 0;

	for (const event of events) {
		const { meta } = event;
		switch (event.type) {
			case "chooseTake": {
				if (meta.aspect) bump(aspectTally, meta.aspect);
				if (meta.cameraPreset) bump(chosenLookTally, meta.cameraPreset);
				if (typeof meta.durationSec === "number" && meta.durationSec > 0) {
					keptDurationSum += meta.durationSec;
					keptDurationCount += 1;
				}
				break;
			}
			case "reroll":
			case "discard": {
				if (meta.cameraPreset) bump(rerolledLookTally, meta.cameraPreset);
				break;
			}
			case "compareOutcome": {
				// Unresolved comparison (no winner yet — left to the user): nothing
				// was actually decided, so it contributes no wins/losses at all
				// (not even a zero/zero entry).
				if (!meta.wonBackendId) break;
				const competitors = meta.competingBackendIds ?? [];
				for (const backendId of competitors) {
					if (!backendId) continue;
					const entry = backendTally.get(backendId) ?? {
						wins: 0,
						losses: 0,
					};
					if (backendId === meta.wonBackendId) entry.wins += 1;
					else entry.losses += 1;
					backendTally.set(backendId, entry);
				}
				break;
			}
		}
	}

	const preferredAspects = topTags(aspectTally);
	const topChosenLooks = topTags(chosenLookTally);
	const topRerolledLooks = topTags(rerolledLookTally);
	const backendWinRates = [...backendTally.entries()]
		.map(([backendId, tally]) => ({ backendId, ...tally }))
		.sort((a, b) => b.wins + b.losses - (a.wins + a.losses) || b.wins - a.wins);

	return {
		sampleSize: events.length,
		...(preferredAspects.length ? { preferredAspects } : {}),
		...(keptDurationCount > 0
			? { avgKeptDurationSec: round2(keptDurationSum / keptDurationCount) }
			: {}),
		...(topChosenLooks.length ? { topChosenLooks } : {}),
		...(topRerolledLooks.length ? { topRerolledLooks } : {}),
		...(backendWinRates.length ? { backendWinRates } : {}),
		updatedAt: now,
	};
}

/**
 * Log one behavioral preference event and re-distill the model — the single
 * impure entry point a future call-site hook (Bet 3b) calls with PLAIN data,
 * no store/UI coupling. Reads the current event log via the storage layer
 * (`services/storage/user-memory-store.ts`), appends+caps it (pure,
 * {@link appendPreferenceEvent}), persists the log, re-distills
 * (pure, {@link distillPreferences}), persists the model, and returns it.
 * Best-effort — a persistence hiccup never throws (mirrors
 * `user-memory-store.ts`'s existing fail-soft convention).
 */
export async function logPreferenceEvent(
	event: PreferenceEvent,
	now: number = Date.now(),
): Promise<UserPreferenceModel> {
	const currentLog = await getPreferenceEventLog();
	const nextLog = appendPreferenceEvent(currentLog, event);
	await savePreferenceEventLog(nextLog);

	const model = distillPreferences(nextLog, now);
	await saveUserPreferenceModel(model);
	return model;
}
