/**
 * Cross-project (user-level) memory — the layer ABOVE the per-project
 * {@link import("./project").ProjectBible}.
 *
 * FLOW E ("compounding cross-project memory"): the per-project Bible, persona
 * roster, and asset-understanding records already persist WITHIN a project. This
 * layer promotes the DURABLE, reusable slice of that memory to the USER so that
 * project #10 opens already knowing "your" recurring look, tone, and reusable
 * rules, and so re-importing the same library media in a new project reuses the
 * understanding instead of paying for it again. Each project makes the next
 * faster; the memory compounds.
 *
 * This is a plain, JSON-serializable shape (like `ProjectBible`) persisted
 * LOCAL-FIRST in IndexedDB (`services/storage/user-memory-store.ts`, a global
 * store sibling to saved-sounds — NOT per project). Nothing here leaves the
 * machine.
 *
 * SCOPING NOTES (what this layer deliberately does NOT hold):
 *  - The PERSONA ROSTER (cast, seed-locks, ref images) is ALREADY user-scoped —
 *    it is server-backed per authenticated user (`/api/studio/personas`, keyed by
 *    `userId`), so a persona created in one project is visible in every project.
 *    We do not duplicate it here; see `cross-project-memory-api.md`.
 *  - PROJECT-SPECIFIC facts (this reel's goal, this reel's audience, the storyboard
 *    plan, the live consistency context, decision/checkpoint history) never flow
 *    up — see the promotion rule in `lib/director/cross-project-memory.ts`.
 *
 * Every field is optional and absence is a valid state everywhere: a machine that
 * has never distilled a Bible simply has no user memory, and every consumer treats
 * that exactly like the pre-Flow-E world.
 */

import type { DirectorBrief } from "./project";
import type { StyleBible } from "@/lib/director/storyboard-plan";
import type { AssetUnderstanding } from "@/lib/search/asset-understanding";

/** Current on-disk schema version for {@link UserMemory}; bump on breaking shape changes. */
export const USER_MEMORY_SCHEMA_VERSION = 1;

/**
 * The DISTILLED, always-carry creative defaults promoted up from per-project
 * Bibles — the recurring look/tone/style that seeds every NEW project's Bible.
 * Deliberately a SUBSET of the per-project state: only the durable preferences,
 * never project-specific facts.
 */
export interface UserBibleDefaults {
	/**
	 * The recurring reel LOOK (palette / lens+mood / setting) distilled from the
	 * Bibles' `styleBible`. Field-merged newest-wins; the project-specific
	 * secondary `characters` cast is dropped on promotion (personas are user-scoped
	 * elsewhere).
	 */
	styleBible?: StyleBible;
	/**
	 * The durable slice of the {@link DirectorBrief} that recurs across reels:
	 * `tone`, the `styleNote` style line, reusable `dos`/`donts`, and the notes a
	 * Director explicitly marked as persistent. The project-specific `goal` and
	 * `audience` are intentionally never promoted.
	 */
	brief?: DirectorBrief;
	/** Epoch ms of the last promotion that touched these defaults. */
	updatedAt: number;
}

/**
 * One reusable-media understanding record, keyed by STABLE content identity (see
 * `lib/search/media-identity.ts`) rather than the ephemeral per-project
 * `MediaAsset.id`. Lets a new project reuse the understanding of media it has seen
 * before instead of re-running the (paid) Understanding Pass.
 */
export interface UserMediaMemoryEntry {
	/** Stable content identity (SHA-256 of the bytes, or a name:size:mtime signature fallback). */
	contentHash: string;
	/**
	 * The cached understanding. `mediaId` on it is whatever project first produced
	 * it — consumers RE-KEY it to the new asset's id before persisting it into a
	 * project's understanding store, so this stale id is never trusted directly.
	 */
	understanding: AssetUnderstanding;
	/** The media file name at promotion time (provenance / the consent UI listing). */
	name?: string;
	/** Epoch ms this entry was written. */
	updatedAt: number;
}

/**
 * The root user-memory record. Persisted as a single small blob (`bibleDefaults`)
 * plus a keyed media library; see the store. Absence of the whole thing — or of
 * any field — is a valid, migration-safe state.
 */
export interface UserMemory {
	/** Schema version of this record (see {@link USER_MEMORY_SCHEMA_VERSION}). */
	schemaVersion: number;
	/** Distilled cross-project creative defaults, if any have been promoted yet. */
	bibleDefaults?: UserBibleDefaults;
	/** Epoch ms of the last write to any part of the user memory. */
	updatedAt: number;
}
