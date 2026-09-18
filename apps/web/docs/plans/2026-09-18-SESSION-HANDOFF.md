# Session Handoff — 2026-09-18

**Branch:** `claude/nifty-bohr-l4brpu` · **Tip:** `3a82bca` (a WIP commit — see §1)
**Read this before touching anything.**

---

## 1. FIRST: the branch tip is red. One error.

```
src/lib/director/evals/evals.test.ts(203,34):
error TS2339: Property 'data' does not exist on type 'AgentToolStep'.
```

`3a82bca` is an unreviewed WIP commit made to preserve five agents' in-flight work
before the session ended. Subagents cannot be paused across sessions and the container
is ephemeral, so the choice was commit-unreviewed or lose it.

**Either** fix that one line (read `AgentToolStep` in `agent.ts` — the assertion is
probably reaching for a field that lives elsewhere on the step) **or**
`git revert 3a82bca` if you'd rather restart that work clean. Everything below
`3a82bca` is reviewed, green, and pushed.

## 2. What is DONE and verified

| Commit | What |
|---|---|
| `adbaf6b` | Audos removal (38 files, zero coupling) + real README |
| `0ab4f54` | `@higgsfield/client` SDK + Seedance 2.5 smoke test |
| `87679ea` | **Higgsfield video adapter** — `GenerationBackend`, registered, cost table |
| `c4daeb1` | Engagement Score panel restored, scorer made pluggable |
| `ce3116a` | Director leads the rail; watermark / CapCut copy / Personas tab removed |
| `1637903` | Director chat: new-chat split from history, bigger type, "Byorn is editing" |
| `35d62c3` | Higgsfield shot-craft playbook + enhance-prompt rewrite |
| `863f363` | **`watchBack`** — renders the composited cut for the agent to see |

Docs worth reading before deciding anything:
- `2026-09-18-director-autonomy-architecture.md` — why fewer primitives beat more verbs
- `2026-09-18-challenge-execution-timeline.md` — the 5-day plan
- `2026-09-18-commercial-prompt-patterns.md` — first-party prompt patterns
- `2026-09-18-generation-workflow-research.md` — reference-first workflow

## 3. BLOCKING — these need a human, nothing proceeds without them

1. **`api.higgsfield.ai` is blocked by this environment's egress policy** (403 at CONNECT;
   `docs.` and `console.` too). The adapter has never made a live call. Run locally:
   ```bash
   cd apps/web && bun run scripts/higgsfield-example/index.ts
   ```
   `HF_CREDENTIALS` is already in `apps/web/.env.local` (gitignored). **Rotate that key** —
   it was pasted in chat.
2. **Confirm the Seedance 2.5 schema.** The CLI authenticates interactively, so it works
   from a laptop even though the console is blocked:
   ```bash
   higgsfield model get seedance_2_5 --json
   higgsfield model get brain_activity --json
   ```
   This settles the `mode` conflict (§5) and gives `brain_activity`'s schema.

## 4. NEXT ACTIONS, in order

1. **Fix or revert `3a82bca`** (§1).
2. **Make `watchBack` non-inert.** `executeTool` in `agent.ts` (~line 656) attaches image
   blocks under a conditional hardcoded to `action === "reviewTake"`. Until it also covers
   `watchBack`, the verb renders frames the model never sees. A fix was routed to the agent
   holding `agent.ts` — **check whether it landed** before redoing it.
3. **Register what's unregistered.** `mix-read.ts` exists but has no verb. `edit-critic.ts`
   + its test DID land (in `a1f0e21`, after the first WIP commit) — the agent died mid-run
   while writing test blocks, so treat that file as unfinished and re-run
   `bun test src/lib/director/edit-critic.test.ts` before trusting it.
4. **`readPlaybook` enum gap** — `tool-catalog.ts`'s enum still lists only the two old
   playbook ids, so `shot-craft` isn't offered as an explicit choice. Advisory-only; the
   handler resolves it fine.
5. **The program sandbox was barely started.** `lib/director/program/` now holds `ast.ts`,
   `limits.ts` and `values.ts` — the agent died before the executor, the primitive surface,
   the derived-data accessors or any test existed. Read those three, then decide whether to
   build on them or start clean; they were never run. This is
   the big item from the autonomy doc: ~15 primitives + derived data + one
   `applyEdit(program)` verb. Do **not** use `eval`/`new Function` on model-authored
   programs. The design's own test is reimplementing `cutOnBeat` as a program and asserting
   it matches `craft/cut-on-beat.ts` — if that fails, the direction is wrong.
6. **Then flip `DEFAULT_BACKEND_ID.video` to `"higgsfield"`** — only after one real
   generation succeeds. Their contest rules disqualify third-party generation, so the demo
   must visibly run on their API. Not before.

## 5. OPEN DECISIONS — for the user, not to be guessed

- **Personas scope.** The *tab* is removed. The *system* (`persona-manager.tsx`,
  `/api/studio/personas`, the personas table, `persona-still.ts`, seed-lock, the Director
  verb) is untouched. "Remove personas entirely" was never disambiguated.
- **Polish-phase ceiling.** `watchBack` is production-only. It belongs in polish too, but
  polish sits on `phase-scope.test.ts`'s enforced ceiling of 32. Adding it means bumping
  that bound to 33 — a deliberate human call.
- **`mode` on Seedance 2.5.** Two first-party sources disagree: the CLI's `MODELS.md` says
  `std|fast` (a speed tier), the skills repo says
  `t2v|omni_reference|video_edit|video_extension`. The adapter omits the field so the server
  default stands. §3.2 settles it.
- **CapCut copy.** The removed paragraph had a second sentence ("Unsupported effects are
  skipped.") that went with it rather than leaving an orphan fragment. Restore if wanted.

## 6. Gotchas that cost real time this session

- **`TAB_KEYS`, not `tabs`, drives the left rail order.** `tabs` is only an icon/label
  lookup, and the two were already out of sync. Reordering `tabs` alone looks right in a
  diff and changes nothing on screen.
- **Never `getRenderTree()` for compositing** — use `buildScene()` on demand.
  `RenderTreeController` isn't mounted under the worker compositor, so the stored tree can
  be stale or null. `watchBack` and freeze-frame both do this correctly; copy them.
- **The SDK maps every HTTP 403 to `NotEnoughCreditsError`**, and an egress proxy denying
  CONNECT also answers 403. "Not enough credits" may mean the request never left the
  machine. Check `$HTTPS_PROXY/__agentproxy/status` → `recentRelayFailures`.
- **Don't stage files a running agent may still be writing.** Doing it once produced a torn
  `CLAUDE.md`/`AGENTS.md` state needing a repair commit (`9b17e6b`).
- **`npx gitnexus analyze .` rewrites the managed block** in `CLAUDE.md`/`AGENTS.md` and
  reshuffles `.claude/skills/`. Harmless, but it shows up as unexplained diff noise.
- **Test failures in a fresh container are environmental**, not regressions: ~59 need a real
  Postgres or browser APIs. Create `apps/web/.env.local` first or ~69 fail on
  `Cannot access 'webEnv' before initialization`.

## 7. The strategic through-line, in two sentences

The Director's problem was never its verb count — it's that macro verbs freeze creative
decisions, phase gates enforce a planner shape, and the agent edits a timeline it has never
looked at. Fix the eyes first, then replace macros with composable programs; everything else
in the autonomy doc follows from those two.
