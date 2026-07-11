/**
 * Cross-project memory — the PURE promotion + seeding rules for Flow E.
 *
 * Two directions, both side-effect free (no editor, no stores, no IndexedDB) so
 * they are directly unit-testable; the async storage glue lives in
 * `services/storage/user-memory-store.ts`:
 *
 *  - PROMOTION (up): {@link promoteBibleToUserDefaults} distills the DURABLE slice
 *    of a per-project {@link ProjectBible} into {@link UserBibleDefaults}. This is
 *    DISTILLATION, not a blind copy — see the rule below.
 *  - SEEDING (down): {@link seedBibleFromUserDefaults} turns those defaults back
 *    into a fresh, clearly-overridable {@link ProjectBible} for a NEW project.
 *
 * ── THE PROMOTION RULE (what flows up) ───────────────────────────────────────
 * ALWAYS carried (durable, recurring preferences):
 *   • `styleBible` — the recurring reel LOOK (palette / lens+mood / setting),
 *     merged field-by-field, newest non-empty wins. The `characters` cast is
 *     DROPPED (project-specific; personas are user-scoped server-side).
 *   • `brief.tone` and `brief.styleBible` (the style line) — newest non-empty wins.
 *   • `brief.dos` / `brief.donts` — reusable constraints, unioned + deduped +
 *     bounded (they accumulate across projects).
 *   • `brief.notes` that are EXPLICITLY marked persistent — a note whose text
 *     begins with a {@link PERSIST_NOTE_MARKERS persistence marker}
 *     ("remember:", "[remember]", or "★"). The marker is stripped on promotion.
 *
 * NEVER carried (project-specific facts):
 *   • `brief.goal`, `brief.audience` — this reel's objective / this reel's viewer.
 *   • `consistencyContext`, `plan`, `personaRosterSummary`, `decisions`,
 *     `history`, `assetManifest`, `understanding` — reel-scoped or held elsewhere.
 *
 * The rule is intentionally the simplest honest version: "always-carry style
 * defaults + Director-marked remember-notes", both tested here.
 */

import type { DirectorBrief, ProjectBible } from "@/types/project";
import type { StyleBible } from "@/lib/director/storyboard-plan";
import type { UserBibleDefaults } from "@/types/user-memory";

/** Cap on the promoted dos/donts/notes lists so user defaults never grow unbounded. */
export const MAX_USER_DEFAULT_LIST = 20;

/**
 * Case-insensitive prefixes that mark a learned brief note as "remember this
 * ACROSS projects". A Director (or the user) prefixes a note with one of these to
 * promote it; anything else stays project-local. The marker is stripped from the
 * promoted text.
 */
export const PERSIST_NOTE_MARKERS: readonly string[] = [
	"remember:",
	"[remember]",
	"★",
];

/** Trim, drop empties, de-duplicate (order preserved), and cap a string list. */
function cleanBoundedList(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of values) {
		const v = (raw ?? "").trim();
		if (!v) continue;
		const key = v.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(v);
	}
	return out.length > MAX_USER_DEFAULT_LIST
		? out.slice(out.length - MAX_USER_DEFAULT_LIST)
		: out;
}

/** Newest non-empty string wins; falls back to the prior value. */
function preferNewer(
	prev: string | undefined,
	next: string | undefined,
): string | undefined {
	const t = next?.trim();
	if (t) return t;
	return prev?.trim() || undefined;
}

/**
 * If `raw` begins with a persistence marker, return the note text with the marker
 * stripped and trimmed; otherwise return `null` (the note stays project-local).
 */
export function extractPersistentNote(raw: string): string | null {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	for (const marker of PERSIST_NOTE_MARKERS) {
		if (lower.startsWith(marker)) {
			const stripped = trimmed.slice(marker.length).trim();
			return stripped || null;
		}
	}
	return null;
}

/** True when a StyleBible carries no promotable look (palette/lensMood/setting). */
function isStyleBibleEmpty(s: StyleBible | undefined): boolean {
	if (!s) return true;
	return !s.palette?.trim() && !s.lensMood?.trim() && !s.setting?.trim();
}

/**
 * Merge a project's look into the prior default look, newest non-empty wins per
 * field. Drops `characters` (project-specific secondary cast). Returns `undefined`
 * when neither side carries anything.
 */
function mergeStyleBible(
	prev: StyleBible | undefined,
	next: StyleBible | undefined,
): StyleBible | undefined {
	const palette = preferNewer(prev?.palette, next?.palette);
	const lensMood = preferNewer(prev?.lensMood, next?.lensMood);
	const setting = preferNewer(prev?.setting, next?.setting);
	if (!palette && !lensMood && !setting) return undefined;
	return {
		...(palette ? { palette } : {}),
		...(lensMood ? { lensMood } : {}),
		...(setting ? { setting } : {}),
	};
}

/**
 * Distill the durable, recurring slice of `brief` into the prior default brief.
 * Only tone + style line + dos/donts + persistent notes flow; goal/audience never
 * do. Returns `undefined` when nothing durable exists on either side.
 */
function promoteBrief(
	prev: DirectorBrief | undefined,
	next: DirectorBrief | undefined,
	now: number,
): DirectorBrief | undefined {
	const tone = preferNewer(prev?.tone, next?.tone);
	const styleBible = preferNewer(prev?.styleBible, next?.styleBible);
	const dos = cleanBoundedList([...(prev?.dos ?? []), ...(next?.dos ?? [])]);
	const donts = cleanBoundedList([
		...(prev?.donts ?? []),
		...(next?.donts ?? []),
	]);
	// Only notes the Director explicitly marked persistent flow up (marker stripped).
	const promotedNext = (next?.notes ?? [])
		.map(extractPersistentNote)
		.filter((n): n is string => n !== null);
	const notes = cleanBoundedList([...(prev?.notes ?? []), ...promotedNext]);

	if (
		!tone &&
		!styleBible &&
		dos.length === 0 &&
		donts.length === 0 &&
		notes.length === 0
	) {
		return undefined;
	}
	return {
		...(tone ? { tone } : {}),
		...(styleBible ? { styleBible } : {}),
		...(dos.length ? { dos } : {}),
		...(donts.length ? { donts } : {}),
		...(notes.length ? { notes } : {}),
		updatedAt: now,
	};
}

/**
 * Promote a per-project {@link ProjectBible} into {@link UserBibleDefaults} (pure).
 * Folds the DURABLE slice onto `prev` (accumulating dos/donts/notes, newest-wins
 * scalars/look). Returns `prev` UNCHANGED when the bible distills to nothing new,
 * so promoting an empty/absent bible is a safe no-op. `prev` absent ⇒ start fresh.
 */
export function promoteBibleToUserDefaults(
	prev: UserBibleDefaults | undefined,
	bible: ProjectBible | undefined,
	now: number = Date.now(),
): UserBibleDefaults | undefined {
	const styleBible = mergeStyleBible(
		prev?.styleBible,
		isStyleBibleEmpty(bible?.styleBible) ? undefined : bible?.styleBible,
	);
	const brief = promoteBrief(prev?.brief, bible?.brief, now);

	if (!styleBible && !brief) return prev;

	// Nothing actually changed vs. prior defaults ⇒ return prev (stable identity).
	const changed =
		JSON.stringify(styleBible) !== JSON.stringify(prev?.styleBible) ||
		JSON.stringify(stripUpdatedAt(brief)) !==
			JSON.stringify(stripUpdatedAt(prev?.brief));
	if (!changed && prev) return prev;

	return {
		...(styleBible ? { styleBible } : {}),
		...(brief ? { brief } : {}),
		updatedAt: now,
	};
}

/** Drop `updatedAt` so brief equality ignores the timestamp. */
function stripUpdatedAt(
	b: DirectorBrief | undefined,
): Omit<DirectorBrief, "updatedAt"> | undefined {
	if (!b) return undefined;
	const { updatedAt: _drop, ...rest } = b;
	return rest;
}

/** True when the user defaults carry nothing worth seeding a new project with. */
export function isUserBibleDefaultsEmpty(
	defaults: UserBibleDefaults | undefined,
): boolean {
	if (!defaults) return true;
	if (!isStyleBibleEmpty(defaults.styleBible)) return false;
	const b = defaults.brief;
	if (!b) return true;
	return (
		!b.tone?.trim() &&
		!b.styleBible?.trim() &&
		(b.dos?.length ?? 0) === 0 &&
		(b.donts?.length ?? 0) === 0 &&
		(b.notes?.length ?? 0) === 0
	);
}

/** The decision-log note stamped on a seeded bible so the seeding is VISIBLE and clearly overridable. */
export const SEED_DECISION_NOTE =
	"Seeded from your cross-project defaults (recurring look + tone) — edit freely; this project's Bible overrides it.";

/**
 * Build a fresh, SEEDED {@link ProjectBible} from the user defaults (pure). The
 * seed is `version: 0` initial content — the per-project Bible is the source of
 * truth, so any Director write-through checkpoints and overrides it. Non-destructive
 * by construction: it carries only the durable look + brief, plus a decision-log
 * note that makes the seeding visible. Returns `undefined` when the defaults are
 * empty/absent (⇒ a new project simply has no bible, exactly as before Flow E).
 */
export function seedBibleFromUserDefaults(
	defaults: UserBibleDefaults | undefined,
	now: number = Date.now(),
): ProjectBible | undefined {
	if (isUserBibleDefaultsEmpty(defaults)) return undefined;
	const d = defaults as UserBibleDefaults;

	const brief: DirectorBrief | undefined = d.brief
		? {
				...(d.brief.tone?.trim() ? { tone: d.brief.tone.trim() } : {}),
				...(d.brief.styleBible?.trim()
					? { styleBible: d.brief.styleBible.trim() }
					: {}),
				...(d.brief.dos?.length ? { dos: [...d.brief.dos] } : {}),
				...(d.brief.donts?.length ? { donts: [...d.brief.donts] } : {}),
				...(d.brief.notes?.length ? { notes: [...d.brief.notes] } : {}),
				updatedAt: now,
			}
		: undefined;
	// A brief with only `updatedAt` carries nothing — drop it.
	const briefHasContent =
		brief &&
		(brief.tone ||
			brief.styleBible ||
			brief.dos?.length ||
			brief.donts?.length ||
			brief.notes?.length);

	return {
		version: 0,
		updatedAt: now,
		...(isStyleBibleEmpty(d.styleBible) ? {} : { styleBible: d.styleBible }),
		...(briefHasContent ? { brief } : {}),
		decisions: [{ at: now, note: SEED_DECISION_NOTE }],
	};
}
