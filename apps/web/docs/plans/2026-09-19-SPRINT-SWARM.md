# Sprint Handoff + Agent Swarm Plan

**Written:** 2026-09-19 · **Branch:** `claude/nifty-bohr-l4brpu` · **Tip:** `fd440bf`
**Supersedes** `2026-09-18-SESSION-HANDOFF.md`, which has two factual errors (corrected in §2).

---

## 1. What we are building toward

**An AI-native video editor whose Director takes "edit this vlog" and returns a finished,
professional cut with near-zero intervention** — asking 2–3 questions once, then working.

Three properties define "done", and they are the lens for every task below:

1. **It sees its own work.** The Director watches the composited cut back, reads the mix,
   and reacts. An agent with unlimited actions and no feedback produces confident garbage
   faster. *(`watchBack` shipped — §2.)*
2. **It composes rather than invokes.** Fifteen primitives plus the project's derived data
   (beats, word timings, scenes, loudness), not forty frozen macro verbs. `cutOnBeat` is one
   possible program, not a ceiling.
3. **It weaves real and generated footage.** Deciding unprompted that a sagging moment needs
   B-roll that doesn't exist, generating it, and cutting it in. Nothing in the Higgsfield
   ecosystem does this — their own pipeline ends at *"assemble in your video editor of
   choice."* It requires an NLE that understands both. That's the whole position.

Higgsfield is the generation substrate: cheapest per generation, Seedance 2.5 with face
inputs, and — critically — it dissolved the BytePlus real-person gate that blocked using
your own face.

**Background reading, in priority order:**
`2026-09-18-director-autonomy-architecture.md` (the why) →
`2026-09-18-commercial-prompt-patterns.md` (first-party prompt craft) →
`2026-09-18-challenge-execution-timeline.md` → `2026-09-18-generation-workflow-research.md`

## 2. Verified state — measured today, not remembered

```
typecheck   1 error   program/limits.ts(63,6) TS2352 — a bad type assertion
director    859 pass / 2 fail   both in mix-read.test.ts (computeSpeechMusicOverlaps)
tree        clean, 0 unpushed
```

**Two corrections to yesterday's handoff:**
- It named `evals.test.ts(203,34)` as the blocker. That is **fixed**; the only error is now
  `program/limits.ts`.
- It said `watchBack` was inert because `agent.ts` hardcoded `action === "reviewTake"`.
  **The fix landed** — `agent.ts:683` covers both actions, and `:1575` adds a system-prompt
  instruction telling the model to watch its own cut. `watchBack` works.

| Area | State |
|---|---|
| Higgsfield **video** adapter | Shipped, registered, cost-tabled. **Never called live.** |
| Higgsfield **image / audio** | Do not exist |
| `DEFAULT_BACKEND_ID.video` | Still `byteplus-seedance` — flips only after a live success |
| `watchBack` | Shipped, wired, production phase only |
| `mix-read.ts` | Written (520 lines), **unregistered**, 2 failing tests |
| `edit-critic.ts` | Mix read + external-score seam wired |
| `program/` | `ast.ts`, `errors.ts`, `limits.ts`, `values.ts`. **No executor, no primitives, no tests** |
| Evals | 7 scenarios (1 original + 6 new) |

## 3. The binding constraint: **no money on the key**

Everything must be provable **without spending**. This shapes every task:

- Adapters are verified by **unit tests with mocked `fetch`**, never live calls.
- `isAvailable()` must be false without keys, and an unconfigured adapter must stay fully
  inert — that is the house pattern (`backends/types.ts`: *"real, complete code that stays
  inert until its provider is configured"*).
- "Operational" here means **the wiring is provably correct**, not that a video came back.
- **Exactly one live call** is reserved for the user once the key is funded:
  `cd apps/web && bun run scripts/higgsfield-example/index.ts`.
- `api.higgsfield.ai` is blocked by this environment's egress policy anyway (403 at CONNECT),
  so no agent can accidentally spend. Treat that as a safety rail, not an obstacle.

> **Trap:** the SDK maps *every* HTTP 403 to `NotEnoughCreditsError`, and a proxy denying
> CONNECT also answers 403. "Not enough credits" may mean the request never left the machine.
> Check `curl -sS "$HTTPS_PROXY/__agentproxy/status"` → `recentRelayFailures`.

---

# THE SWARM

Four waves. **Within a wave, agents run in parallel and MUST NOT share files.**
**Between waves, strictly sequential** — a wave starts only when the previous one is
committed and green.

File ownership is the coordination mechanism. It is the only thing preventing two agents
writing the same file, which has already cost this project a torn-state repair commit.

---

## WAVE 0 — Green the tree · 1 agent · BLOCKING

Nothing else starts until this is committed. Every later wave measures itself against a
green baseline; without one, no agent can tell its own breakage from inherited breakage.

### Agent 0 — "green"
**Owns:** `lib/director/program/limits.ts`, `lib/director/mix-read.ts`, `lib/director/mix-read.test.ts`

1. Fix `program/limits.ts(63,6)` TS2352. Read the type; do **not** paper over it with
   `as unknown as` unless you explain in a comment why the conversion is genuinely safe.
2. Fix the 2 failures in `mix-read.test.ts` → `computeSpeechMusicOverlaps` ("merges two
   speech intervals close enough to produce one overlap window per music element"). Decide
   whether the **test** or the **implementation** is wrong and say which in your report —
   do not just make the assertion match current behaviour.

**Done when:** `npx tsc --noEmit -p tsconfig.json` exits 0 AND `bun test src/lib/director/`
is 100% green.

---

## WAVE 1 — Three agents in parallel · disjoint file sets

### Agent 1A — "higgsfield breadth"
**Goal:** Higgsfield behind every modality, all inert-but-correct.
**Owns:** `lib/studio/backends/image/**`, `lib/studio/backends/audio/**`,
`lib/credits/cost-table.ts`, `packages/env/src/web.ts`
**Must not touch:** anything under `lib/director/`, `backends/video/`, `backends/registry.ts`

Model the new adapters on `backends/video/higgsfield.ts` — same auth
(`Authorization: Key ${id}:${secret}` from `HIGGSFIELD_CREDENTIALS`), same submit/poll split,
same raw `fetchWithTimeout` (the SDK's `subscribe()` blocks and cannot satisfy our contract).

From Higgsfield's own model catalog (`/home/user/higgsfield-ai/skills` if still cloned,
else `docs/plans/2026-09-18-*`):
- **Image:** `gpt_image_2_5` (general/text), `nano_banana_2` (character), `soul_cinema`
  (cinematic stills). Endpoint pattern is `<vendor>/<model>/<task>`, e.g.
  `bytedance/seedance-2.5/text-to-video`.
- **Audio:** `seed_audio` (text-to-audio, SFX, ambience).

Mark every unverified field `UNVERIFIED` in comments, exactly as the video adapter does.
Tests mock `fetch` — **no live calls, the host is blocked**.

### Agent 1B — "register the orphans"
**Goal:** everything built but unreachable becomes reachable.
**Owns:** `lib/director/tool-catalog.ts`, `lib/director/phase-scope.ts`,
`lib/director/director-api.ts`, `lib/director/types.ts`
**Must not touch:** `program/**`, `mix-read.ts`, `agent.ts`, `backends/**`

1. **Register `mix-read` as a verb** (`readMix` or similar). It exists and nothing can call
   it. Assign a phase; justify it.
2. **`watchBack` into the polish phase.** It is production-only. Polish is where
   trim/split/addText/applyTransition live — exactly the watch-it-back moment. Polish sits
   on `phase-scope.test.ts`'s enforced ceiling of **32**. **You are authorised to raise that
   bound to 33 for this specific verb** — a decision deferred twice now. Update the test's
   comment explaining why.
3. **`readPlaybook` enum gap** — the JSON-schema enum still lists only the two old playbook
   ids and omits `shot-craft`. Advisory-only (the handler resolves it), but fix it.

### Agent 1C — "program executor"
**Goal:** finish the sandbox. This is the single highest-leverage item in the codebase.
**Owns:** `lib/director/program/**` — entirely, and nothing else.
**Must not register anything** — Wave 2 does that.

`ast.ts`, `errors.ts`, `limits.ts`, `values.ts` exist from a dead agent; they were **never
run**. Read them, then either build on them or restart — your call, state which.

Build: the **primitive surface** (wrap `director-api.ts`'s genuinely primitive ops — trim,
move, split, reorder, remove, addClip, addText, applyTransition, applyEffect, animateItem —
do not modify that file), **derived-data accessors** (beats, word timings, scenes, loudness
— reuse `lib/audio/`, `lib/auto-cut/`, `mix-read.ts`; do not reimplement), and the
**executor**.

**Security is the deliverable, not a footnote.** Programs are model-authored, therefore
untrusted. **No `eval`, no `new Function`.** Whitelisted-AST interpretation is the expected
answer. Write the threat model in the module header. Bounded op-count, wall-clock and loop
iterations, each failing cleanly with a typed error naming the cap. **Dry-run mode**
returning the operation list without applying — that is the entire safety story. Whole run
collapses to **one undo entry** (reuse the batching from `e8bd66f`).

**The test that justifies the design:** reimplement `cutOnBeat` as a program over your
primitives and assert it matches `craft/cut-on-beat.ts` on the same fixture. **If that fails,
the direction is wrong — say so plainly rather than bending the test.**

---

## WAVE 2 — Two agents in parallel · after Wave 1 is committed and green

### Agent 2A — "applyEdit"
**Owns:** `tool-catalog.ts`, `phase-scope.ts`, `director-api.ts` (freed by 1B)
Register the program executor as one `applyEdit(program)` verb. Expose dry-run to the model
so it can inspect before applying. Add an eval scenario driving a real program end to end.
**Do not delete the macro verbs yet** — parity first, deletion later, and only once the
evals covering them still pass.

### Agent 2B — "reference-first defaults"
**Owns:** `lib/studio/provider-adapter.ts`, `lib/studio/backends/types.ts`,
`lib/studio/personas.ts`, `lib/studio/identity-lock.ts`
Implement the two mechanisms from `2026-09-18-commercial-prompt-patterns.md` §3–4:
1. **Semantic reference handles** — `@Orlando`, not positional `@Image1`, persisting across
   a project. Identity gets *referenced*, never re-described; prompts carry only the delta.
2. **Per-reference role labels** — `referenceImages[]` becomes `{url, role}` where role is
   appearance / environment / grade / style, and the prompt builder writes the explicit
   contract sentence ("use image 1 only for the character's appearance…").

---

## WAVE 3 — One agent · final · after Wave 2

### Agent 3 — "operational proof, zero spend"
**Owns:** `scripts/**`, `docs/plans/**`, and any test file
Produce a single command proving the whole Higgsfield surface is correctly wired **without
spending a cent**: every adapter's `isAvailable()` inert-when-unkeyed, auth header shape,
request-body shape against mocked `fetch`, cost estimates finite and non-zero for each
modality, router intent selection. Then write `docs/plans/HIGGSFIELD-OPERATIONAL.md`
recording exactly what is proven, what still needs one funded live call, and the exact
command to run it.

---

## 4. Rules for every agent

- **Never** commit, stage, or push. Leave work in the tree; the orchestrator reviews and
  commits. (Learned the hard way — see `9b17e6b`.)
- **Never** touch a file outside your stated scope. If you need one, report it; don't take it.
- Run `npx tsc --noEmit -p tsconfig.json` and the relevant `bun test` before reporting, and
  paste output **verbatim**. A claim without output is not a result.
- **No live Higgsfield calls.** The host is blocked and the key is unfunded.
- Match the repo's idiom and comment density — it writes substantial explanatory docblocks.
- Report honestly: what you did **not** finish, what you could not verify, and anything that
  turned out riskier than the brief said. A flagged gap is worth more than a confident claim.

## 5. Open decisions — for the user, not for agents

- **Personas.** The tab is gone; the system (`persona-manager.tsx`, `/api/studio/personas`,
  the table, `persona-still.ts`, seed-lock, the Director verb) is untouched. "Remove
  personas entirely" was never disambiguated. Note Wave 2B *builds on* seed-lock, so
  deleting it later means rework.
- **`mode` on Seedance 2.5.** Two first-party sources disagree (`std|fast` speed tier vs
  `t2v|omni_reference|…` generation kind). The adapter omits the field. Settle with
  `higgsfield model get seedance_2_5 --json` locally — the CLI authenticates interactively,
  so it works even though the console is blocked here.
- **Rotate the API key.** It was pasted in chat.

## 6. Gotchas that have already cost time

- **`TAB_KEYS`, not `tabs`, drives the left rail order.** Reordering `tabs` alone looks
  right in a diff and changes nothing on screen.
- **Never `getRenderTree()` for compositing** — `buildScene()` on demand.
  `RenderTreeController` isn't mounted under the worker compositor, so the stored tree can
  be stale or null. `watchBack` and freeze-frame both do this correctly; copy them.
- **A fresh container fails ~59 tests environmentally** (needs Postgres / browser APIs).
  Create `apps/web/.env.local` first or ~69 fail on `Cannot access 'webEnv' before
  initialization`.
- **`npx gitnexus analyze .` rewrites the managed block** in `CLAUDE.md`/`AGENTS.md` and
  reshuffles `.claude/skills/` — unexplained diff noise, harmless.
