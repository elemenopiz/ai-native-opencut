# Director Revamp — Design

> Mission: `.claude/fable-director-revamp.md` (deep mission, design-first).
> Status: ☑ DESIGN drafted 2026-07-19 · ☑ gates signed (A: remove-UI-keep-product · B: both local+server) · ☐ built · ☐ verified.
> Lane: Fable designs + integrates; Sonnet fleet builds; user signs the two one-way doors (§7-8, §9).

## TL;DR

Director's chat has quietly regrown into a kitchen-sink tab, its world-model only sees
*generative slots* (not the actual timeline), and its conversation state is a single
throwaway in-memory buffer. This pass: (a) give Director eyes on the real timeline,
(b) strip the chat UX back to one clean conversational surface and relocate the 10 bolted-on
tool panels, (c) hide raw chain-of-thought, (d) make the draft + completion UI behave, and
(e) — gated — decide the fate of persona/Style-Bible and stand up real conversation
persistence. Items **1–6** are the un-gated floor; **7–8** and **9** are decisions for the
user because they touch **moat #1 (persona/seed-lock)** and a **new persisted data shape**.

---

## GROUND — evidence per item

| # | Claim | Verdict from code | Evidence |
|---|-------|-------------------|----------|
| 1 | Timeline blindness | **Design gap, not a regression** | `getReel().slots = locateSlots()` keeps only `isSlotElement` = image/video *with a `.generation` recipe* (`director-api.ts:618,691`). Manual clips (no `.generation`), text (`type:"text"`), and audio are timeline elements but **never** slots. `getProjectInfo()` returns canvas/fps/personas/**media-library** manifest — not timeline elements (`director-api.ts:1035`). The system prompt's "REEL listing" enumerates slots only (`agent.ts:1449,1478`). So a hand-built timeline reports an **empty reel** even though `getReel().totalDuration` (the real timeline length, `director-api.ts:933`) is nonzero. Director is *correct about slots* and *blind to the actual timeline*. |
| 2 | Wordy/technical chat | **Confirmed, prompt-driven** | System prompt tells the model to "Ask ONE short round of 1–2 sharp questions" but examples model a support-ticket register (`agent.ts:1454`). Assistant bubbles render full markdown incl. `h1/h2/ol` (`director.tsx:1046-1108`) → invites long structured answers. |
| 3 | Raw CoT leaking as a card | **Confirmed** | `thinking_delta` events create real assistant messages `> 💭 …` (`director.tsx:494-504`); every assistant bubble — including these — gets a **"Save idea"** footer (`director.tsx:1110-1131`). Reasoning renders as, and is savable as, an assistant message. |
| 4 | Direct tab is a kitchen sink | **Confirmed** | `director.tsx` (1551 lines) has a 16-value `StudioMode` switch (`director.tsx:112-128`) hosting BRoll, YouTubeReels, Dubbing, Chapters, Reframe, Tracking, ABTesting, ScriptToVideo, Shorts, SceneDetection, ThumbnailGen + Templates/Ideas/Workflows as sibling panels (`director.tsx:44-54, 770-931, 1234-1535`). Contradicts the "Director = ONE conversational tab" decision. |
| 5 | Draft lost on tab switch | **Confirmed** | `const [inputValue, setInputValue] = useState("")` (`director.tsx:353`) — bare local state, unmounts with the tab, no persistence. |
| 6 | Persistent "tasks completed" checklist | **Confirmed (with a scope note)** | `completedSteps: Set<string>` + the progress bar / strikethrough render around `activeWorkflow.steps` (`director.tsx:357,1444-1508`) never auto-clears. **Scope note:** that block is the *manual* Workflows checklist. The artifact the user likely saw after an agentic run is the accumulation of `✅ \`action\`` tool chips in chat (`director.tsx:538-548`). Design covers both; build agent confirms against the transcript. |
| 7 | Style Bible "should be gone" | **Still user-facing** | `StyleBibleChip` renders live in the Generate flow (`generation-form.tsx:94,1034`); `styleBible` also feeds Director's enhance-prompt context (`director.tsx:374-386`). Marketing pages reference it (`landing/*`). "Removed" never happened — or referred to a different surface. **Entangled with the consistency context (moat).** |
| 8 | Remove persona picker | **It's the front door to moat #1** | `PersonaManager` is a "Personas" tab **inside the Generate panel** (`generate.tsx:55-59,173-174`), wired to `usePersonaStore` + `seed`/`anchorImageUrl`/`refImageUrls`/`descriptor` (`persona-manager.tsx`). Core doctrine names **persona/seed-lock character consistency as moat #1**. Removing the picker removes the only UI entry to the top competitive feature. |
| 9 | Conversations must persist | **No persistence at all today** | `useAIStore = create<AIState>()(...)` has **no `persist` middleware**; `studioMessages` is one global in-memory array (`ai-store.ts:49,61,141-153`), not scoped per-project, not per-conversation, gone on reload. `agent.ts` header confirms "browser-held `messages` history … pure stateless relay" (`agent.ts:1482`). Item 9 = a genuine new storage layer. |

Coordination: no in-flight branch touches `director.tsx` (checked all local branches); local `main == origin/main`; companion `fable-feature-ideas-round2.md` not present locally. This mission is the one-executor for `director.tsx`.

---

## DESIGN decisions

### Item 1 — Timeline visibility (the headline fix)

**Root cause:** Director models *generative slots + media library*, never the composed timeline.

**Fix:** add a first-class **timeline snapshot** to Director's world-model, alongside the reel.

- New read verb **`getTimeline`** (non-mutating) returning a compact per-track digest:
  tracks (id, kind: video/audio/text), and per element a `{ kind, startSec, durationSec,
  label }` where `label` = asset name / text content (truncated) / "generative slot" — with
  slots cross-referenced to their reel short-id so the model doesn't double-count them.
- Fold a **one-line TIMELINE digest** into the system prompt context block
  (`buildContextBlock`, `agent.ts:369`) next to the existing PROJECT/PERSONAS/LIBRARY lines:
  e.g. `TIMELINE: 3 tracks · 5 clips (4 uploaded, 1 generative), 2 text, 1 audio · 0:42`.
  Full detail stays behind the on-demand `getTimeline` verb (token economy — same
  digest-in-prompt / detail-on-verb pattern as the library manifest).
- Update the system-prompt framing so "a reel is an ordered list of slots" becomes "a reel is
  the generative layer *on* a timeline that may also hold uploaded clips, text, and audio" —
  so the model stops treating empty-slots as empty-project.

**Budget impact:** +~1 line (~25 tokens) per turn in the prompt; the verb is opt-in. Negligible.
**Also check for a state-sync component:** verify the reported symptom isn't *also* a stale
snapshot (build agent reproduces the two-turn transcript). The design gap is sufficient to
explain it, but confirm the digest reflects live state each turn.

### Item 2 — Chat UX target

Shift from "clarify with a numbered list / support-ticket paragraphs" to **"one warm line +
do the thing + show the result."** Concretely:

- Rewrite the CLARIFY and register guidance in `buildFrontierSystemPrompt` (`agent.ts:1454`):
  at most one short, friendly clarifying question **only when truly thin**, phrased for a lazy
  user, with a one-word-acceptable default; otherwise act and narrate briefly. Prefer plain
  sentences over headed sections for chat replies.
- Tighten the markdown renderer for chat: keep bold/lists, down-rank `h1/h2` to inline
  emphasis so the model can't produce a wall of headed sections (`director.tsx:1046`).
- **Before/after** (from this session's transcripts) lives in Appendix A; build agent asserts
  the "just build something" prompt yields a short reply + action, not a numbered interrogation.

### Item 3 — Thought-bubble handling

**Decision: replace raw CoT with a single short status line, and never render it as a savable
message.** `thinking_delta` no longer creates an assistant message; instead it drives a
transient "thinking" status row (reuse the existing `isThinking` dashed-spinner region,
`director.tsx:1138-1149`) showing a short human status ("Checking your library…", "Planning
the shots…") — either derived from the current tool or a de-jargoned summary, not the raw
token stream. The "Save idea" footer renders **only on final answer bubbles**, never on
status/tool rows.

### Item 4 — Tab declutter destination (IA decision)

Director's tab returns to **one conversational surface (chat only)**. The bolted-on panels get
a real home, not the void:

- **New sibling tab in the right panel: "Tools"** (a.k.a. "More") — a compact launcher/grid
  hosting the utility panels: BRoll, Reframe, Tracking, A/B Test, Shorts, Scenes, Thumbnail,
  Chapters, Dubbing (feature-gated), YouTube Reels (feature-gated), Script→Video (gated),
  Templates. These are *operations on existing media*, not conversation.
- **Ideas** → stays reachable but as a lightweight affordance from chat (the "Save idea" flow
  already writes to the Ideas store); its list view moves under Tools or a small popover, not
  a top-level Director mode.
- **Workflows** → moves under Tools as a guided-checklist launcher (see item 6).
- **Script (transcript editor)** → stays adjacent to Director chat (it's conversational text
  editing) OR moves to Tools; build resolves by which reads cleaner — default: keep next to
  chat since it shares the input surface.
- Mechanics: extract the mode-switcher + panel hosting out of `director.tsx` into a new
  `assets/views/tools.tsx` (or a right-panel tab), leaving `director.tsx` as chat-only. This
  is the file-split that lets items 2/3/5/6 (chat surface) and item 4 (relocation) touch
  disjoint files.

### Item 5 — Prompt draft persistence

**Mechanism: lift the draft into a store keyed by project, smallest possible.** Add
`directorDraftByProject: Record<projectId, string>` to `ai-store` (or a tiny dedicated slice)
with a `setDirectorDraft(projectId, text)` action; `DirectorView` reads/writes it instead of
local `useState`. Survives unmount/remount and tab switches; scoped per project so switching
projects doesn't bleed drafts. No new persistence layer (in-memory store is enough for
"survives a tab switch"; if we want it to survive reload, it rides item 9's persistence, not
its own). Chosen over sessionStorage to avoid a second serialization path.

### Item 6 — Completion behaviour

- **Agent-run tool chips:** a few seconds after a run finishes, collapse the per-step
  `✅ \`action\`` chips into a single summary line ("Done — 3 steps") and fire a transient
  `sonner` toast for the outcome; the detail is available on hover/expand but doesn't camp on
  screen. (`director.tsx:538-548` render path.)
- **Workflows manual checklist:** once `completedSteps.size === steps.length`, auto-dismiss
  the progress display after ~4s (fade the bar/checklist to a compact "Completed ✓" summary),
  rather than holding the full strikethrough list indefinitely (`director.tsx:1444-1508`).
- Toast copy stays in the craft register (no "viral"/"tasks completed!" exclamation spam).

### Item 7 — Style Bible  ·  GATE (see below)
### Item 8 — Persona picker  ·  GATE (see below)

### Item 9 — Conversation persistence  ·  GATE (see below)

---

## GATES — decisions for the user (touch moat / one-way doors)

### GATE A — Persona picker + Style Bible (items 7–8)

The user asked to **remove the persona/"keep a character" picker** and believed **Style Bible
was already gone**. But both are the *visible surface of moat #1 (persona/seed-lock character
consistency)* — the single feature the doctrine ranks first and that Higgsfield's "Soul ID"
competes on. Silent deletion would remove our top competitive wedge's only UI entry. Options:

- **A1 (recommended): Don't delete — relocate + de-jargon.** Keep the machinery; move the
  Persona picker out of the *Generate* panel into a quieter "Cast"/"Characters" affordance so
  it stops feeling like clutter on the main generate flow, and rename "Style Bible" to plain
  language ("Look" / "Style") so the user stops seeing an unfamiliar internal term. Preserves
  the moat; addresses the *actual* irritation (jargon + placement), not the capability.
- **A2: Hide behind a flag for beta** (like collab) — machinery intact, surface off, revisit
  post-beta. Reversible.
- **A3: Remove the UI as asked** — accept losing the persona/seed-lock entry point; only if
  the user confirms they want character-consistency out of the beta product entirely.

I recommend **A1**. This needs the user's call because A3 contradicts a named moat.

**DECISION (user, 2026-07-19): "Remove the UI but keep the product — don't like it for now,
will revisit."** → Remove the *visible surfaces* only, keep the machinery 100% intact:
- Unmount the **Persona picker** from the Generate panel (drop the "Personas" tab trigger +
  `<PersonaManager />` mount in `generate.tsx:55-59,173-174`) and remove the **`StyleBibleChip`**
  render (`generation-form.tsx:94,1034`) and any "Style Bible" *label* the user sees.
- **KEEP untouched:** `usePersonaStore`, `persona-manager.tsx` (file stays, just unmounted),
  seed-lock, `consistency-prompt.ts`, `reference-intake.ts`, `project-bible.ts`, and Director's
  *invisible* consistency seeding (`director.tsx:374-386` enhance-prompt context keeps reading
  `getReel().consistency` — that's backend grounding, not a picker).
- Revisit path = re-add the mount; make the removal a clean, self-contained diff so flipping it
  back on is trivial. Do NOT delete store/machinery/backend plumbing.

### GATE B — Conversation persistence storage (item 9)

New persisted data shape = one-way door (migration + replay-into-context budget). Options:

- **B1 (recommended): Project-scoped IndexedDB (browser-local), list + reopen in Director.**
  Conversations persist on-device per project; no server schema, no migration, no tenancy/PII
  surface, ships inside the autonomy envelope. Matches the "browser-held history" reality and
  the local-first posture. Limit: not cross-device. Replay policy: reopening replays the last
  N turns verbatim + a short summary of older turns (bounded context budget).
- **B2: Server-side (new Postgres table, per-user/project).** Cross-device, durable, but =
  **migration + auth/tenancy review = hard gate**, bigger lift, PII (chat content) at rest.
- **B3: Fold into the existing project document.** Simplest storage, but bloats the project
  doc and its autosave/quota path (recently hardened — C28); risky for large histories.

I recommend **B1** for this pass (reversible, no gated infra), with B2 logged as a follow-up
if cross-device history is wanted later. If the user prefers B2, this becomes a
migration-bearing mission that builds to the gate and stops. **Candidate for an Advisor
red-team pass before building either.**

**DECISION (user, 2026-07-19): "Both local and server side."** → Two-layer design:
- **F-local (ships in the autonomy envelope):** project-scoped IndexedDB is the source of
  truth the UI reads/writes — instant, offline, cross-tab. List + reopen conversations in the
  chat surface. Replay policy: last N turns verbatim + a short summary of older turns (bounded
  context budget). This lands first and delivers item 9's UX on its own.
- **F-server (HARD GATE — build to the gate, then STOP):** a new Postgres table
  (`director_conversation` / `_message`, per-user + per-project, tenancy-isolated) with a sync
  layer that mirrors the local store up and hydrates it on a fresh device. Migration authored +
  proven on a scratch DB on the branch; **do NOT apply the migration or merge the schema —
  stop for user review** (migration + auth/tenancy = core hard gate). Sync is idempotent
  (client-generated ids, last-write-wins per message) so local works with or without the server.
- **Advisor red-team** requested on the combined persistence design (new persisted PII shape +
  sync semantics) before F-server is built on top of F-local.

---

## Context / intelligence upgrade — the 2–3 highest-leverage (defer the rest)

1. **Timeline awareness (item 1)** — the single biggest "more context" win; already in scope.
2. **Conversation memory across turns/reopens (item 9)** — the model reasoning over prior
   turns in the same project instead of a cold buffer; the persistence work unlocks it.
3. **Tighter Understanding-Pass use in the digest** — the manifest already carries role/caption
   facts (`asset-manifest.ts`); surface a one-line "what's in the library that's relevant to
   this ask" hint. Cheap, rides the existing manifest.

**Explicitly deferred** (log as queue rows, don't build here): richer cross-project memory
weighting, beat-grid/LUFS audio grounding (existing F3 backlog), speculative tool-catalog
rework. Non-goal per mission.

---

## PARTITION (agent × file cluster — build once gates are signed)

| Part | Owns | Depends on |
|------|------|-----------|
| **A — Timeline context** | `tool-catalog.ts` (new `getTimeline`), `director-api.ts` (`getTimeline` impl), `agent.ts` (`buildContextBlock` digest + prompt framing), `types.ts` | none — disjoint; can start immediately |
| **B — File split** | extract mode-switcher/panels → new `tools.tsx`; `director.tsx` becomes chat-only | must land FIRST of the director.tsx parts |
| **C — Chat surface** | `director.tsx` (items 2,3,5,6 chat rendering + draft store + completion), `ai-store.ts` (draft slice) | after B (disjoint file post-split) |
| **D — Tools relocation** | `tools.tsx` + right-panel tab wiring (item 4) | after B |
| **E — Persona/StyleBible UI removal** | `generate.tsx` (unmount picker + tab), `generation-form.tsx` (drop StyleBibleChip/label). KEEP all machinery. | independent — disjoint; runs in Wave 1 |
| **F-local — IndexedDB persistence** | storage module + `ai-store` history slice + reopen UI in chat-only `director.tsx` | after B+C settle director.tsx |
| **F-server — Postgres sync (HARD GATE)** | new migration + `director_conversation`/`_message` tables + sync layer; **build to gate, STOP** | after F-local; Advisor red-team first |

**Wave plan:** Wave 1 = A + B + E (disjoint file sets, parallel). Wave 2 (after B merges) =
C + D. Wave 3 = F-local, then F-server to the gate.

**Build-orchestrator revision (2026-07-19 Step 0):** Part B stalled (0 commits) → re-dispatched
as **B+D combined** against current `main` (same file cluster; splitting it across two
sequential agents violates file-cluster partitioning). Part E's branch lacks the e2e
reconcile — `e2e/persona-consistency.e2e.ts` still asserts the removed testids — so E
integrates via a fresh agent that cherry-picks the two UI commits and rewrites the spec to
pin the *absence* of the picker/chip (re-adding stays an intentional act).

`director.tsx` is the hot shared surface → B is the sequencing pivot; C/D/F queue behind it.
A and E are disjoint and can run alongside. Fan-out cap = the non-overlapping file sets.

## Verification plan

Battery (typecheck/lint-no-worse/build/e2e + `bun test`), then **browser-verify locally** by
re-running this session's "just build something" transcript: (1) Director correctly reports
timeline state on a hand-built timeline; (2) the Direct tab shows only chat; (3) a typed draft
survives a tab switch; (4) a finished run's checklist/chips auto-clear; (5) no raw 💭 card and
no "Save idea" on reasoning; (6) [gated] a past conversation reopens and continues; (7) [gated]
persona/Style-Bible resolution is as-decided. Tier target: **verified locally**; no push (local
`main` merge only).

## Non-goals / follow-ups

Generation backends, pricing/credits, auth — untouched. No silent panel deletions. No
speculative agent-loop rewrite. Follow-ups → queue rows: B2 cross-device history (if B1
chosen), deferred context items above, transcript-editor final placement.

## Appendix A — chat before/after (fill from session transcripts during build)
```
BEFORE (observed): numbered clarifying questions, dense paragraphs, 💭 card as its own bubble.
AFTER (target):    one warm line + action + result; reasoning as a quiet status; no CoT card.
```
