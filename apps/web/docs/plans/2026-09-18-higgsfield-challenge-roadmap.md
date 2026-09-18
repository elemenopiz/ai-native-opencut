# Higgsfield $50k Challenge — 5-Day Roadmap

**Written:** 2026-09-18. **Deadline:** ~2026-09-23 (tweet posted Sep 16, "7 days").
**Goal:** a 60–90s demo video, posted as a QT, that nobody else in that thread can make.

---

## 0. The two contests — do not confuse them

| | **$50k bounty** (the tweet) | **$100k app contest** (`skills/higgsfield-websites/references/contest.md`) |
|---|---|---|
| Judge | Alisher S, personally, by QT | Admin-curated jury, recurring |
| Criterion | "something people actually fcking use" | Usage 40%, creativity 30%, social 15%, gallery 15% |
| Platform requirement | None stated | App must be published **on Higgsfield** via the fnf SDK |
| Third-party generation | Not stated | **DISQUALIFIED** |

We are entering the **$50k bounty**. But the $100k rules tell us what they value, and
one line is decisive even for the bounty:

> *"An app that routes generation through a third-party API instead of Higgsfield is DISQUALIFIED."*

**Therefore: for this build, Higgsfield is the default video backend, not a peer.**
BytePlus stays registered and working as a fallback, but `DEFAULT_BACKEND_ID.video`
flips to `higgsfield`. A demo where generation visibly runs on their API is the
entry; one where it runs on BytePlus is not.

Also note the bounty is judged **by a QT**, which means the artifact that wins is a
*video*, not a repo. Budget effort accordingly — roughly 60% build, 40% demo.

---

## 1. The demo concept

Everyone else in that thread will ship a prompt box with a grid of outputs
(see [Higgsfield-Open](https://github.com/princejain756/Higgsfield-Open) — 38 models,
already built, before the tweet even landed). Model catalogs are the commodity play.

**We have the only real timeline and the only real agent.** The demo is the loop
that requires both:

```
brief → Director storyboards → generates shots on Higgsfield (face-locked)
      → assembles a real multi-track cut → scores its own hook via Virality Predictor
      → recuts the weak opening → exports a real mp4
```

All in one tab. The middle two steps are impossible without an NLE. The scoring step
is the thing nobody else will think of.

### Why Virality Predictor is the wow

`brain_activity` takes a finished clip and returns attention / hook / retention
scores. In a generator app that's a novelty button. In an **editor** it closes a
feedback loop: cut → grade → recut → grade again. "The editor that grades its own
work and fixes it" is a sentence that survives a QT.

It also reuses machinery we already have: `edit-critic.ts` and `reviewTake` already
exist as the Director's self-review seam. This is a new signal into an existing loop,
not a new subsystem.

---

## 2. Day plan

### Day 0 — today — unfreeze (half day)

The tree is cold: no `node_modules`, no `apps/web/.env.local`, last real commit
`3375cf5` (Jul 23, ~8 weeks stale). Nothing below matters until this is green.

- [ ] `bun install`; restore `apps/web/.env.local`
- [ ] `bun run test`, typecheck, boot `dev:web`, load a project, scrub, export once
- [ ] Confirm the Vercel deploy still serves (`/api/health` → `{ok,db:true,redis:true}`)
- [ ] **Get a Higgsfield API key** at `console.higgsfield.ai`
- [ ] **Confirm the v2 endpoint path for `seedance_2_5`.** The SDK shows paths like
      `/v1/image2video/dop` and `/v1/text2image/soul`; the CLI uses model ids
      (`seedance_2_5`). These are two different naming schemes and the mapping is not
      in the open-source repos — read it off the console. **This is the one hard
      blocker on the adapter.**
- [ ] Verify live per-generation pricing before it goes in the cost table

### Day 1 — the adapter

Everything here rides the existing `GenerationBackend` seam — one file, one
`registerBackend()` call, no other edits.

- [ ] `apps/web/src/lib/studio/backends/video/higgsfield.ts`
  - Auth: `Authorization: Key ${KEY_ID}:${KEY_SECRET}`, base `https://api.higgsfield.ai`
  - `submit()` → request id; `poll()` → `/requests/{id}/status` → `jobs[0].results.raw.url`
  - Maps 1:1 onto our async submit/poll contract. Server module only — the SDK
    blocks browser use, which matches our adapter rule exactly.
  - Capabilities: `supportsSeedLock`, `supportsOmniReference: true`,
    `supportsLastFrame: true` (`start_image` + `end_image`),
    `durationRangeSec: {min: 4, max: 30}`, resolutions 480p/720p/1080p
- [ ] `packages/env/src/web.ts` — `HIGGSFIELD_KEY_ID`, `HIGGSFIELD_KEY_SECRET`, `HIGGSFIELD_BASE_URL`
- [ ] `lib/credits/cost-table.ts` — real published rates (they publish exact
      per-generation pricing; this is the first backend where our "honest cost before
      you press the button" claim is fully true)
- [ ] **Wire the dead `realFaceReference` seam.** `backends/router.ts:160` routes
      real-human-face video to Runway as an "interim" and the header says wave 2 never
      landed. Higgsfield *is* wave 2 — repoint it and set `REAL_FACE_VIDEO_BACKEND`.
- [ ] Flip `DEFAULT_BACKEND_ID.video` → `"higgsfield"` (§0)
- [ ] Adapter unit tests alongside the existing ones in `backends/video/__tests__/`

**Face-lock caveat:** Soul ID training requires a **paid plan (Basic+)** and runs
through `higgsfield auth login` (interactive session), *not* an API key. Do **not**
put Soul ID on the demo path. Use Seedance 2.5 `--mode omni_reference` with
`image_references` / `start_image` — that is API-key-reachable and gives the
face-continuity beat we need.

### Day 2 — the differentiator

- [ ] `brain_activity` adapter — video in, text report out. It doesn't fit
      `GenerationBackend` (returns a score, not media), so give it its own small
      module rather than bending the interface.
- [ ] New Director verb `scoreCut` → renders the current cut, submits it, returns
      hook/retention. Register in `phase-scope.ts` under **polish** (that's where
      review verbs live, and production is at its enforced tool ceiling).
- [ ] Feed the score into `edit-critic.ts` so the Director can *act* on it —
      "hook scores low, tighten the first 1.5s" → `tightenToLength` / `cutOnBeat`,
      which already exist as craft macros.
- [ ] Show the score in the UI. A number on screen that moves after a recut is the
      single most demoable thing in this build.

### Day 3 — brain + rehearsal

- [ ] **Upgrade the Director brain.** It currently runs Gemini 3.5 Flash. For a demo
      where the agent's taste *is* the product, that's the weakest link and the
      cheapest fix — it's a model-id change, not a refactor.
- [ ] **Write evals for the demo path.** `lib/director/evals/` has exactly one
      scenario (`draft-cut-scenario.ts`). Add 3–5 covering the exact demo flow. This
      is not ceremony: it's how you stop the demo breaking on take 11.
- [ ] Run the full demo end-to-end, repeatedly. Fix what breaks. Nothing new lands.

### Day 4 — record

- [ ] Deploy. Real key, real spend cap, watch the balance.
- [ ] Record 60–90s. Structure: brief typed → shots generating → **timeline visible**
      (this is the shot that differentiates us — hold on it) → score appears →
      Director recuts → score improves → export → play the actual file.
- [ ] Repo presentable: README is done, this doc is the plan of record.

### Day 5 — post + buffer

- [ ] QT with the video. Lead with the loop, not the feature list.
- [ ] Buffer for whatever Day 4 broke.

---

## 3. Cut list, if behind

Drop in this order. Do not drop upward.

1. **Never cut:** brief → generate on Higgsfield → timeline → export. Without this
   there is no entry.
2. **Cut last:** the brain upgrade (it's a config change, keep it).
3. **Cut first if Day 2 slips:** the Director's *automatic* reaction to the score.
   Fall back to a manual "Score this cut" button — still demoable, far less risk.
4. **Cut if Day 1 slips:** `end_image` / last-frame support, multi-reference.
   Single `start_image` + prompt is enough for the demo.

**Not in these 5 days:** MCP server (real Tier-1 gap, wrong week), PhotoMaker /
per-persona LoRA (obsoleted — see §4), worker compositor, model breadth in the UI.

---

## 4. What Higgsfield replaces vs augments

**Replaces (delete from the roadmap):**
- The entire durable-persona tier from `docs/poach/higgsfield-soul-id-poaches.md`
  §4.1–4.3 — PhotoMaker v1 self-host, per-persona LoRA infra, multi-photo anchor
  intake as its prerequisite. Rated L / M–L / M there, i.e. 2–4 weeks. Seedance 2.5
  with face inputs makes it an API call. **Do not build it.**
- The Runway interim in the `realFaceReference` seam.

**Augments:**
- Video generation — adds 4–30s single-shot (up from our current short clips), plus
  `video_edit` and `video_extension` modes we have no equivalent for.
- Adds a capability class we have *nothing* for: video analysis (`brain_activity`).

**Changes nothing:**
- The timeline, the Director, export, local Whisper captions, local CLIP search.
  That's the whole wedge and none of it is affected.

**Contradicts (and should be updated):** `AGENTS.md` says *"don't re-add model
breadth"* and names the 30-model buffet as the anti-pattern. Half-reverse it: breadth
behind the **router** is now free and correct; breadth in the **UI** is still wrong.
One front door, many backends.

---

## 5. Materials worth poaching (MIT — ledger-eligible)

[`higgsfield-ai/skills`](https://github.com/higgsfield-ai/skills) is MIT, 99 markdown
files, and is their actual production prompt craft:

| File | Use |
|---|---|
| `higgsfield-generate/references/prompt-engineering.md` | Drops straight into `lib/studio/playbooks/` — we already have a `readPlaybook` Director verb with nowhere good to read from. Covers i2v prompting ("describe motion, don't redescribe the frame"), positive-phrasing for models with no negative prompt, the ~200-token ceiling. |
| `higgsfield-generate/references/model-catalog.md` | Exact model ids, modes, media roles, duration/resolution sets. This is the adapter spec. |
| `higgsfield-generate/references/media-inputs.md` | Per-model accepted roles — what `start_image` vs `image_references` means where. |
| `higgsfield-soul-id/references/photo-guide.md` | Anchor-photo quality rules, if we ever revive multi-photo intake. |
| `higgsfield-websites/references/design-taste-frontend.md` | 12.8k words of frontend taste guidance. Unrelated to video, genuinely good. |

Log anything that lands in `POACH-LEDGER.md` per the existing process.

---

## 6. Honest risks

- **The endpoint mapping is unverified.** CLI model ids ≠ v2 REST paths, and the
  console is the only source. If it turns out the API surfaces fewer models than the
  CLI, the adapter shrinks. Check this Day 0, before committing to Day 1.
- **Pricing is launch pricing** from a company seeding an ecosystem. Fine for a
  5-day demo; don't build a business model on it.
- **We'd be routing our differentiated path through a direct competitor.** Mitigated
  by the registry: BytePlus stays registered and one constant flips it back.
- **The bounty is one person's informal judgment**, with no published rules, judged
  on a QT. Treat the demo video as the deliverable and the repo as supporting
  evidence — not the other way round.
