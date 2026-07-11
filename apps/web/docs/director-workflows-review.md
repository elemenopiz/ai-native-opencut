# Director Workflows — Final Integration Review

**Branch:** `feat/director-context` (tip `6d59f48`, "merge: Flow D approval gates")
**Baseline:** `main` @ `43f40b8` (untouched)
**Reviewer:** final integration pass (single reviewer, post-parallel-build)
**Spec audited:** `apps/web/docs/reimagined-director-workflows.md`
**Date:** 2026-07-10
**Decisions:** the dormant items below were decided 2026-07-11 — see `director-dormant-decisions.md`.

---

## TL;DR — ship-readiness call

**SHIP** the merge of `feat/director-context` → `main`.

- The one standing **HIGH-risk flag is discharged**: the Project Bible hydration hook in the
  central project-load path is **fail-safe by construction** — it does zero parsing and cannot
  throw on corrupt/legacy/missing bible data. Verified by hand and now by a targeted test.
- Spec deliverables §2.1–2.3, Flows A–E, and build items 1–6 are **SHIPPED or intentionally
  DORMANT** (billing/consent guards), with file-path evidence below. No MISSING items.
- The cross-package seam hunt found **no correctness defects** — only one **dormant latent gap**
  (role-mutator cache refresh) with no live caller, reported not fixed.
- Verification gate is green: **671 tests pass / 0 fail**, typecheck clean (except the known
  pre-existing content-collections codegen errors), biome clean on the touched file.

The gitnexus compare-vs-`main` "critical" risk read is the **expected** blast radius of promoting
session state into the shared load path; every changed symbol maps to a documented seam and the
behaviour is verified fail-safe. Details in the HIGH-risk section.

---

## Task 1 — HIGH-risk verdict: LOAD PATH IS SAFE TO SHIP

**The flag:** an earlier `detect_changes()` (against a 177-commit-stale index) flagged HIGH risk on
`hydrateDirectorStateFromBible` sitting in the central `loadProject`/`serializeProject` path.

**Re-indexed clean:** `npx gitnexus analyze` rebuilt the index on the worktree tip
(12,292 nodes / 33,375 edges / 300 flows, 17.7s). Impact analysis on `loadProject`
(`project-manager.ts`) confirms it is a **hub** (HIGH structural risk *to modify* — 3 modules,
the `Editor` process, 8 downstream steps). That is exactly *why* the original flag fired:
structural centrality, not behavioural danger.

**Behavioural review — hydration cannot throw:**

Trace of the load path (`editor-provider.tsx:42-85` → `project-manager.loadProject` →
`storageService.loadProject` → `deserializeProject` → `hydrateDirectorStateFromBible`):

1. `deserializeProject` (`services/storage/service.ts:143`) restores `projectBible` **verbatim**
   — no parse, no validate, no iterate. Missing field ⇒ `undefined` (old projects load
   unchanged). Corrupt field ⇒ carried as-is.
2. `hydrateDirectorStateFromBible` (`project-bible.ts:281`) does only:
   `getProjectBible()` (a plain `this.active?.projectBible` property read) →
   `storeConsistencyContext(editor, bible?.consistencyContext)` →
   `storePlan(editor, bible?.plan)`.
3. Both stores (`consistency-prompt.ts:169`, `storyboard-plan.ts:255`) are trivial
   `WeakMap.set`/`delete`. No parsing, no iteration — **no throw path regardless of bible shape**.

So a corrupt/legacy/missing bible degrades the Director's *creative memory* but **never breaks
project load**. Even the one residual concern — hydration runs *inside* the `editor-provider` try
block, so a throw would surface as "Failed to load project" — is moot because the hook has no
throw path. Any real defect in bible content surfaces lazily at a *consumer*
(`withConsistencyContext`, plan rendering), not at load, and those consumers are already
null/shape-tolerant.

**Test added** (was missing): `project-bible.test.ts` →
*"hydration is FAIL-SAFE on corrupt/legacy bible data (never throws → project still loads)"* —
feeds a structurally-wrong bible (string where object expected, numeric `plan`, junk keys) and an
entirely-missing bible through the hook, asserting no throw and correct cache clear. Green.

**Verdict: SAFE.** The hydration hook is a fail-safe cache-behind. The HIGH flag was a stale-index
structural false-positive.

---

## Task 2 — Spec audit

Grades: **SHIPPED** / **PARTIAL** / **DORMANT** (built, gated off deliberately) / **MISSING**.

### §2 — The three enabling artifacts

| Deliverable | Grade | Evidence |
|---|---|---|
| §2.1 Understanding Pass (caption/role/face/style/dedup/shot-split) | **SHIPPED (DORMANT autorun)** | `lib/search/asset-understanding.ts` (726 L), `services/search/asset-understanding-service.ts`, `asset-understanding-store.ts`. Autorun gated `NEXT_PUBLIC_UNDERSTANDING_AUTORUN==="1"` (`asset-understanding-service.ts:57`) — OFF by default (billing guard). |
| §2.2 Asset Manifest (faceted self-describing library) | **SHIPPED** | `lib/director/asset-manifest.ts` (354 L); `buildManifest()` folded into `getProjectInfo` (`director-api.ts:851`) + `getLibraryManifest` verb (`:863`). Degrades to media-type counts when understanding absent. |
| §2.3 Project Bible (durable, versioned, human+AI doc) | **SHIPPED** | `lib/director/project-bible.ts` (445 L) — promotes `ConsistencyContext`+`StoryboardPlan` off the WeakMaps onto `TProject.projectBible`; `MAX_BIBLE_HISTORY=20` checkpoints; serialized in `service.ts:132/183`. |

### §3 — The five workflows

| Flow | Grade | Evidence |
|---|---|---|
| A — Ingest IS understanding | **SHIPPED (DORMANT autorun)** | `hooks/use-embedding-indexer.ts` background index + understanding hook (gated as above). Cache primed on mount (`use-director.ts:58`). |
| B — Propose-first | **SHIPPED** | `lib/director/reel-proposal.ts` (658 L); verbs `proposeReel`/`reviseProposal`/`acceptProposal`/`getProposal` (`director-api.ts:1427+`); retrieve-vs-generate + citation validation + `generate-to-match` omni-ref. |
| C — Living Bible as interface | **SHIPPED** | Panel `components/editor/panels/bible/{index,inline-edit}.tsx`; view-model `lib/director/bible-ui.ts`; one-click checkpoint restore; reactive via `project.subscribe`. |
| D — Taste in loop (EXPRESS/REACT/APPROVE) | **SHIPPED** | Gates `approveHeroShot`/`approveFinalCut` (`director-api.ts:2807/2890`) → append-only approvals ledger + brief note. Voice-clone **consent gate enforced** in Director path (`addVoiceover` refuses unconsented clone, `:3152-3165`); GRANT is UI-only by design. Final-cut is a **soft** gate (manual Export = approval) — as specified. |
| E — Compounding cross-project memory | **SHIPPED (opt-in)** | `lib/director/cross-project-memory.ts`, `services/storage/user-memory-store.ts`; seed on `createNewProject` (`project-manager.ts:117`), promote on `closeProject` (`:314`); consent surface in Settings. |

### §6 — Build sequencing items

| Item | Grade | Evidence |
|---|---|---|
| 1. Bible persistence + version snapshots | **SHIPPED** | `project-bible.ts` + `project-manager.getProjectBible/setProjectBible` (`:661/671`). |
| 2. Understanding Pass (widened indexer, VLM caption/role, face pass) | **SHIPPED (DORMANT autorun)** | as §2.1; face identity is **VLM-descriptor-based** (`AssetFace.descriptor`, `asset-understanding.ts:81-96`), not embeddings — documented seam. |
| 3. Asset Manifest replacing the `CONTEXT_LIST_CAP=5` keyhole | **SHIPPED** | `getProjectInfo` now emits `manifest` (`director-api.ts:851`); legacy 5-name lists retained as fallback. |
| 4. Flow B propose-first | **SHIPPED** | as Flow B. |
| 5. Flow D gates (consent + hero/final-cut) | **SHIPPED** | as Flow D. `verifySpeakerSimilarity` is an **explicit stub** (`voice-consent.ts:243`); consent = Whisper phrase-verification only — as specified. |
| 6. Flow E cross-project memory | **SHIPPED (opt-in)** | as Flow E. |

**No MISSING deliverables.** All five "known deliberate" items were verified as intended design,
not gaps: Flow A autorun flag, VLM-descriptor faces, speaker-similarity stub, phrase-only consent,
soft final-cut gate.

---

## Task 3 — Cross-package seam hunt

Six seams probed. **No correctness defect found; nothing fixed. One dormant gap + several
by-design nuances reported.**

### 1. `director-api.ts` verb registration coherence — CLEAN
- `createDirectorApi` options (`:267-338`): 8 distinct optional seams (`executor`, `backends`,
  `critic`, `recovery`, `audio`, `references`, `understanding`, `styleProbe`) — no duplicate or
  shadowed keys.
- **Every tool-catalog verb (48) maps to a real returned API verb** — 0 "registered-but-missing".
- The 5 API verbs *not* in the catalog (`briefPromptBlock`, `estimateGenerateCost`,
  `evaluateSpend`, `recordSpend`, `recordFinalSpend`) are internal helpers, correctly not exposed
  as agent tools.
- agent.ts DATA-echo whitelist (`:492-505`) includes all data-returning reads whose payload isn't
  self-describing. `getProposal`/`getBudgetStatus` are *absent by design* — their `message`
  already embeds the full content (`formatProposalDraft`, budget summary), so the agent sees them.
- App call-site (`use-director.ts:63`) wires `understanding`/`styleProbe`/`critic`/`executor`/
  `backends`; `references`/`audio` use their browser-bound defaults. Coherent.

### 2. Proposal / approval / revert consistency — CLEAN
- The **approvals ledger is genuinely append-only**: `extractBibleState` omits `approvals`, and
  both `pushCheckpoint` and `revertBible` pass `bible.approvals` through untouched
  (`project-bible.ts:133,197`). Accepting a proposal → approving a hero shot → reverting a
  checkpoint leaves consistent state; approvals survive reverts, plan/look/brief roll back.
- **By-design nuance (report):** `revertBibleCheckpoint` reverts *creative memory* (plan/look/
  brief) but **not the timeline edits** placed by `acceptProposal` — timeline has its own
  command-stack undo/redo. This matches the doc's Bible-vs-edit-state separation; worth a UX note
  so users aren't surprised that reverting the Bible doesn't remove placed clips.

### 3. Cross-project memory hooks vs notify vs Flow D writes — CLEAN
- **No race** in `closeProject`: `promoteActiveBibleToUserMemory` reads `this.active?.projectBible`
  *synchronously* (before its first `await`), so `bible` is captured before `this.active = null`
  runs.
- **No notify loop:** `setProjectBible`→`notify()`→Bible panel re-render→`readBibleDocument`
  (pure read). Panel writes only fire in user `onCommit`/`onChange` handlers, never at render.
- **Minor (report):** `recordBibleApproval` calls `setProjectBible` twice (append ledger, then
  `syncProjectBible`), i.e. two `notify()` per approval. Idempotent re-render; harmless.

### 4. understanding-lookup cache — CLEAN on live path, one DORMANT gap
- Live write path is correct: `asset-understanding-service.ts` calls `cacheUnderstanding` right
  after `saveUnderstanding` (`:318/321`, `:354/357`), so a freshly-understood asset shows in the
  manifest without a re-prime. `cache` and `probeCache` are maintained in lockstep, consumed by
  both the manifest and the styleProbe seam. Flow E's understanding reuse rides the same
  `primeUnderstandingCache` on mount.
- **DORMANT gap (reported, not fixed):** the store role-mutators `confirmRole`,
  `clearRoleConfirmation`, `reinforceRole` (`asset-understanding-store.ts:112/124/147`) call
  `saveUnderstanding` but **not** `cacheUnderstanding` — so a role override wouldn't reflect in the
  sync cache until the next prime. **These three have zero live callers** (grep: only tests + a doc
  comment; `reinforceRole`'s emitter is explicitly a documented follow-up). No live staleness bug.
  When these are wired to UI/emitters, they must call `cacheUnderstanding` (or the manifest will
  serve a stale role until remount).

### 5. Zero-state walk — CLEAN
- New project, empty library, no user memory: seams degrade rather than throw. Flow E seed and
  Bible promotion are `try/catch` best-effort (`project-manager.ts:117-122,332-336`); manifest
  degrades to media-type counts; every Flow-B/D verb returns `fail(...)` (never throws) on empty
  state. Covered by existing tests (`flow-d-gates.test.ts` "refuses empty timeline"/"no take to
  approve", `director-proposal`/`director-manifest` empty cases) plus the new corrupt-bible test.

### 6. styleBible three-writer precedence — COHERENT
Three write paths touch the reel look, and precedence is consistent:
- `seedStyleBibleFromProbe` (`project-bible.ts:414`) — **no-clobber**: preserves an existing
  `styleBible`, records the probe read as a decision note unless `force`.
- `storyboard` (via `plan.bible`) — explicit authorship; `captureBibleState` resolves
  `plan?.bible ?? prevStyleBible` (`:230`), so an authored plan look wins, else the prior look is
  preserved. Not a "silent" clobber.
- Human Bible panel — edits the **brief's one-line `styleBible` string** (`editBrief`), a *distinct
  field* from the structured `ProjectBible.styleBible`. **Report/UX nuance:** the two same-named
  fields (durable-brief one-liner vs structured palette/lens/setting) can confuse; the panel's
  "styleBible" input does not overwrite the structured look. No defect, but a naming clean-up
  candidate.

---

## Task 4 — Verification gate

| Check | Result |
|---|---|
| `bun test` (apps/web) | **671 pass / 0 fail** (1900 expect calls, 75 files). Baseline 670 + 1 new corrupt-bible test. |
| `bun run typecheck` | Clean **except** known pre-existing `content-collections` codegen errors in `app/changelog/*` (4 errors, not on this branch's code). |
| `biome check` (touched file) | `project-bible.test.ts` — clean, no fixes. |
| `detect_changes` unstaged (my change) | 0 symbols, **low** risk — test-only, inert to production flows. |
| `detect_changes` compare vs `main` | 38 changed symbols / 23 processes / **critical** — the *expected* whole-branch blast radius (see below). |

**On the "critical" compare read:** every changed symbol maps to a documented integration seam —
`editor-provider.loadProject` (hydration), `project-manager.createNewProject`/`notify` (Flow E
seed + Bible reactivity), `storage/service.loadProject`/`serialize` (Bible persistence),
`director-api.createDirectorApi` (new verbs), `use-director`/`use-embedding-indexer`
(Understanding wiring), settings/voiceover/right-panel (Bible panel + consent UI). The affected
processes are overwhelmingly `→ Notify` fan-out (Bible write-through reactivity) and
`loadProject → *` (the load path). **No surprise symbols.** "Critical" = structural centrality of
promoting session state into the shared load path, the same reason the Task-1 flag fired;
behaviour is verified fail-safe.

---

## Dormant switches & seams inventory

| Switch / seam | State | What flips it on / what it needs |
|---|---|---|
| Flow A / Understanding Pass autorun | OFF | `NEXT_PUBLIC_UNDERSTANDING_AUTORUN=1` (`asset-understanding-service.ts:57`). Billing guard — VLM cost per asset. Until on, the Manifest degrades to media-type counts and role-tagged citations are empty. |
| Face identity fidelity | descriptor-tier | `AssetFace.descriptor` is a VLM-reported physical descriptor, not an embedding. A durable embedding/LoRA tier (PhotoMaker-class) is the documented next step for cross-shot face fidelity. |
| `verifySpeakerSimilarity` | stub | Returns without a real pairwise score (`voice-consent.ts:243`). Consent today = Whisper phrase-verification only. Needs a real speaker-embedding backend to become a true fingerprint gate. |
| Role-mutator cache refresh | latent | `confirmRole`/`clearRoleConfirmation`/`reinforceRole` must call `cacheUnderstanding` once they get live callers/UI (else stale manifest role until remount). No live caller today. |
| `reinforceRole` emitter | unwired | The rule is tested; the *caller* (Director/timeline promoting an asset → `hero` signal) is a documented one-line follow-up. |
| Final-cut gate | soft | Manual UI Export = approval; `approveFinalCut` records rationale but does not block export. As specified. |
| Voice-clone GRANT | UI-only | The Director can read/revoke consent but cannot grant it — human records the consent phrase in the Voiceover panel. Enforced in `addVoiceover`. |

---

## Ranked "before this ships to users" list

1. **(Product decision) Turn on Flow A autorun behind the credit meter.** The whole
   Understanding-Pass → Manifest → propose-first value chain is dark until
   `NEXT_PUBLIC_UNDERSTANDING_AUTORUN=1`. Gate it on the existing `CREDITS_ENFORCED` metering so
   the on-device pass is priced, then enable. Without this, Flow B cites an empty manifest.
2. **(Low, when wired) Refresh the sync cache from role-mutators.** Add `cacheUnderstanding` to
   `confirmRole`/`clearRoleConfirmation`/`reinforceRole` at the moment they get UI/emitters, or the
   manifest serves a stale role until remount. Harmless today (no callers).
3. **(UX) Disambiguate the two `styleBible` fields.** The durable-brief one-line string and the
   structured `ProjectBible.styleBible` share a name; the panel edits the former. Rename one (e.g.
   brief `styleLine`) to prevent "I edited the look but shots didn't change" confusion.
4. **(UX) Note that reverting the Bible does not remove placed clips.** `revertBibleCheckpoint`
   rolls back creative memory, not timeline edits (by design). Surface this in the History panel
   copy so a revert isn't mistaken for a timeline undo.
5. **(Roadmap) Real speaker-similarity backend.** Consent is phrase-only until
   `verifySpeakerSimilarity` is backed by an embedding model — the descript-doc liability is
   *reduced* (phrase gate enforced) but not fully closed to a fingerprint standard.
6. **(Roadmap) Durable face-fidelity tier.** Descriptor-based identity is the current bar; a
   trained/embedding tier is the documented path to Higgsfield-class still fidelity.

None of 1–6 block the merge; 1 is the switch that makes the feature *visible* to users.

---

*Fixes applied by this review: added the corrupt-bible fail-safe test
(`project-bible.test.ts`). No production code changed — all findings were either clean, dormant,
or product-shaped (reported, not fixed).*
