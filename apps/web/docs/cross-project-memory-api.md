# Cross-Project Memory (Flow E) — API & Contract

Compounding, user-level creative memory that sits **above** the per-project
Project Bible. Project #10 opens already knowing "your" recurring look, tone, and
reusable rules; re-importing the same library media in a new project reuses the
understanding instead of paying for it again. Each project makes the next faster.

Everything here is **local-first** (IndexedDB, this browser) — nothing leaves the
machine. Absence of the layer is a valid state everywhere: a machine that has
never distilled a Bible behaves exactly like the pre-Flow-E app.

---

## 1. Layers & where things live

| Concern | Scope | Where |
|---|---|---|
| Per-project creative state (style, cast, plan, decisions, history) | **project** | `ProjectBible` on `TProject` (`types/project.ts`, `lib/director/project-bible.ts`) — unchanged |
| Persona roster (cast, seed-locks, ref images, voice) | **user** (already) | server-backed per `userId` at `/api/studio/personas` (`stores/persona-store.ts`) — **not duplicated** |
| Distilled Bible defaults (recurring look + durable brief) | **user** | `UserBibleDefaults` in IndexedDB `byorn-user-memory` / `kv` store |
| Reusable-media understanding cache | **user** | `UserMediaMemoryEntry` in IndexedDB `byorn-user-memory` / `media` store, keyed by content identity |

### Persona-store scoping — verified, not rebuilt

`usePersonaStore` is **server-backed and already user-scoped**: it reads/writes
`/api/studio/personas`, and the route stamps `userId` from the auth session and
persists `seed` + `refImageUrls`. A persona created in one project is therefore
already visible (with its seed-lock and reference images) in every other project
for that user. Flow E deliberately does **not** duplicate the roster into the
local user-memory layer — that would create a second, divergent source of truth.
Voice profiles ride on personas / consistency characters, which inherit the same
user scope. Deliverable 1(b) is satisfied by the existing design.

---

## 2. User-layer schema

`types/user-memory.ts`:

```ts
UserMemory {
  schemaVersion: number;          // USER_MEMORY_SCHEMA_VERSION = 1
  bibleDefaults?: UserBibleDefaults;
  updatedAt: number;
}

UserBibleDefaults {
  styleBible?: StyleBible;         // recurring look: palette / lensMood / setting (NO characters)
  brief?: DirectorBrief;           // durable slice only: tone, styleBible line, dos, donts, persistent notes
  updatedAt: number;
}

UserMediaMemoryEntry {
  contentHash: string;             // stable content identity (primary key)
  understanding: AssetUnderstanding;
  name?: string;
  updatedAt: number;
}
```

Persisted by `services/storage/user-memory-store.ts` — a **global** IndexedDB DB
`byorn-user-memory` (sibling to the saved-sounds store), with a `kv` store for the
`UserMemory` root blob and a keyed `media` store (keyPath `contentHash`,
`updatedAt` index, capped at `MAX_USER_MEDIA_MEMORY = 500`, oldest evicted). Every
read fails soft to "nothing yet"; every write is best-effort and no-ops when
IndexedDB is unavailable (SSR / private mode / tests).

---

## 3. The promotion rule (distillation, not blind copy)

Pure, tested in `lib/director/cross-project-memory.ts`
(`promoteBibleToUserDefaults`). On project close/save the active Bible is distilled
into the user defaults.

**Flows UP (durable, recurring preferences):**

- `styleBible` — the recurring **look** (`palette` / `lensMood` / `setting`),
  field-merged **newest non-empty wins**. The `characters` cast is **dropped**
  (project-specific; personas are user-scoped elsewhere).
- `brief.tone` and `brief.styleBible` (the style line) — newest non-empty wins.
- `brief.dos` / `brief.donts` — reusable constraints, **unioned + deduped +
  bounded** (`MAX_USER_DEFAULT_LIST = 20`); they accumulate across projects.
- `brief.notes` that are **explicitly marked persistent** — a note whose text
  begins with a marker in `PERSIST_NOTE_MARKERS` (`remember:`, `[remember]`, `★`,
  case-insensitive). The marker is stripped on promotion.

**Never flows up (project-specific facts):**

- `brief.goal`, `brief.audience` — this reel's objective / this reel's viewer.
- `consistencyContext`, `plan`, `personaRosterSummary`, `decisions`, `history`,
  `assetManifest`, `understanding`.

The rule is the simplest honest version: **always-carry style defaults +
Director-marked remember-notes**. Promoting an empty/absent Bible returns the
prior defaults unchanged (`===`), so it is a safe no-op.

> **How a note gets marked persistent:** the Director (or the user, via the brief)
> prefixes a learned note with `remember:` (or `[remember]` / `★`). Example:
> `updateBrief({ notes: ["remember: user prefers warm, handheld footage"] })`.
> Unmarked notes stay project-local.

---

## 4. The seeding contract

Pure, tested (`seedBibleFromUserDefaults`). Wired into
`ProjectManager.createNewProject`.

- Creating a project calls `seedProjectBibleFromUserMemory()`. If user defaults
  exist, the new project's `projectBible` is a **fresh, seeded** `ProjectBible`
  (`version: 0`) carrying only the durable look + brief, plus a decision-log note
  (`SEED_DECISION_NOTE`) that makes the seeding **visible**.
- **Non-destructive & overridable:** the seed is initial content only. The
  per-project Bible remains the source of truth — the first Director write-through
  (`syncProjectBible`) checkpoints and overrides it, and `version: 0` means the
  seed is the revertable baseline.
- **Migration-safe:** empty/absent defaults ⇒ `undefined` ⇒ the new project has no
  bible, exactly as before Flow E.

**Round-trip (tested):** project A Bible → `promoteBibleToUserDefaults` → user
defaults → `seedBibleFromUserDefaults` → project B pre-seeded with A's durable
look/tone/rules/persistent-notes, but **not** A's goal, audience, plan,
consistency context, cast snapshot, or history.

---

## 5. Reusable-media understanding

- **Stable identity** (`lib/search/media-identity.ts`): `computeMediaIdentity`
  returns `sha256:<hex>` of the file bytes, falling back to a namespaced
  `sig:<name>:<size>:<mtime>` signature when subtle-crypto or the bytes are
  unavailable. This is needed because `MediaAsset.id` is a fresh UUID per import,
  so the same file re-imported into a new project would otherwise re-run the pass.
- **Reuse** (`services/search/asset-understanding-service.ts` → `understandAsset`):
  before the paid VLM pass, the asset's content identity is looked up in the
  user-media cache; a hit for the **same model** is re-keyed to the new asset's id
  (persona ids on faces are user-scoped, so they stay valid) and persisted into the
  per-project store — no paid call. After a real pass, the understanding is cached
  under its content identity for the next project. Degraded "nothing usable"
  records are **not** cached (so a retry elsewhere can try again).
  Injectable via `options.crossProject` (`identify` / `lookup` / `save`), or set
  `crossProject: false` to disable reuse.

---

## 6. Consent / control

`getUserMemorySummary()` + `clearAllUserMemory()` drive a **Cross-Project Memory**
section in the editor Settings panel
(`components/editor/panels/assets/views/settings.tsx`). It shows whether style/tone
defaults are remembered and how many library clips are understood, and offers a
one-click **Clear cross-project memory** (wipes both the bible defaults and the
media cache). Finer-grained clears exist in the store: `clearUserBibleDefaults`,
`clearUserMediaMemory`.

---

## 7. Files

New:
- `types/user-memory.ts` — user-layer schema.
- `lib/director/cross-project-memory.ts` — pure promotion + seeding rules.
- `lib/search/media-identity.ts` — stable content identity.
- `services/storage/user-memory-store.ts` — IndexedDB store + promotion/seeding glue.
- Tests: `cross-project-memory.test.ts`, `media-identity.test.ts`,
  `user-memory-store.test.ts`.

Touched (additive only):
- `core/managers/project-manager.ts` — seed on `createNewProject`; promote on
  `closeProject` / `prepareExit`.
- `services/search/asset-understanding-service.ts` — content-identity reuse in
  `understandAsset`.
- `components/editor/panels/assets/views/settings.tsx` — consent surface.

The per-project Bible API (`project-bible.ts`, `ProjectBible` on `TProject`) is
**unchanged** — a sibling UI work package builds on it in parallel.
