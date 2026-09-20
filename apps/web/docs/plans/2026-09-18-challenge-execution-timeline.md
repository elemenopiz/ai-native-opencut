# Byorn × Higgsfield — 5-Day Execution Timeline

**Written:** 2026-09-18 · **Ship by:** 2026-09-22 EOD (deadline 09-23, one buffer day)
**Split:** 3 days building · 2 days demo + promotion
**Strategy context:** `2026-09-18-higgsfield-challenge-roadmap.md`. This doc is the
execution plan and supersedes that doc's day-plan section.

**The demo, locked:**
> brief → Director storyboards → generates face-locked shots on Higgsfield →
> assembles a real multi-track cut → scores its own hook with Virality Predictor →
> recuts the weak opening → score improves → exports a real mp4.

**Soul ID is out of scope.** It needs a paid plan and interactive `higgsfield auth
login`, not an API key. Face continuity comes from Seedance 2.5 `omni_reference` with
`image_references` / `start_image`.

---

## 1. Where Byorn actually is (verified 2026-09-18, this checkout)

Every line below was checked today, not recalled from a doc.

### Green

| | Evidence |
|---|---|
| Install | `bun install` — 1291 packages, 11.9s, clean |
| Typecheck | `tsc --noEmit` — exit 0, zero errors |
| Dev server | `✓ Ready in 2.2s`, homepage HTTP 200 |
| Unit tests | 2695 pass / 5 skip / 59 fail — **all 59 environmental** (see below) |
| Surface | 21 page routes, 56 API routes |

**The 8-week gap since `3375cf5` (Jul 23) rotted nothing.** This was the biggest
unknown going in, and it's clear.

The 59 failures are two buckets, neither a code regression:
- **Need Postgres** — ledger reserve/settle/release/grant, metering, 402 gate, Polar
  webhook, conversation store, route-protection. Test names literally say "real
  ledger". No Postgres in this container.
- **Need browser APIs** — `generateProxyOffThread` (Worker + WebCodecs), video-cache,
  use-transcription, media decode reprobe.

Before the env file existed it was 69 fail / 23 errors, dominated by
`Cannot access 'webEnv' before initialization` — a missing `.env.local`, not a bug.

### Built, and better than our own docs claim

- **Generation backends — 15 adapters already written** behind one registry:
  video (`byteplus-seedance`, `google-veo`, `google-veo-fast`, `kling`, `luma`,
  `pika`, `runway`), image (`google-nano-banana`, `openai-gpt-image`, `bfl-flux`,
  `google-imagen`, `ideogram`), audio (`elevenlabs-music`, `fal-mmaudio`).
  Most are inert for want of a key. **Adding Higgsfield is one file.**
- **Director — 75 tool-catalog descriptors**, phase-scoped across
  briefing/production/polish with 7 always-on core verbs and enforced per-phase
  ceilings. Budget, project bible, board/takes, craft macros, story engine,
  edit-critic, preference learning.
- **MCP — fully shipped.** `/api/mcp` Streamable HTTP, bearer project tokens,
  per-tool scopes, session store with idle eviction, `editor-bridge` relay into the
  live tab, telemetry. It serves **the same tool catalog as the Director**.
  *(`docs/poach/competitive-landscape-2026.md` lists MCP as our #1 Tier-1 gap. That
  doc is from Jul 9 and is wrong now — MCP shipped since. Don't plan off it.)*
- **Director brain is already frontier Claude.** `/api/llm/agent` defaults to
  `claude-opus-4-8`, with Kimi as the zero-setup fallback and `DIRECTOR_MODEL` as an
  override. `director.tsx:570` says so in as many words. The Gemini relay
  (`gemini-3.5-flash`) is a *separate* path for asset understanding, podcast and
  enhance-prompt — **it is not the Director brain.**
- **Generation path is production-shaped:** auth → rate-limit → `routeSlot` →
  `meteredReserve` → submit → `meteredSettle`, with a 402 on insufficient credits.
- **Export:** `scene-exporter.ts` + decodability checks, CapCut draft export, GIF
  encoder, caption burn-in. Real h264+aac encode was machine-verified in July.

### Gaps that matter this week

| Gap | Cost |
|---|---|
| No Higgsfield adapter | ~4h (the seam is clean) |
| No API key, endpoint mapping unknown | ~30min of yours, **blocks everything** |
| `brain_activity` / `scoreCut` doesn't exist | ~6h |
| `realFaceReference` seam is dead code (`router.ts:160`) | ~1h |
| 1 eval scenario total (`draft-cut-scenario.ts`) | ~3h |
| No local Postgres | ~20min (docker) or use deployed Neon |

---

## 2. How Higgsfield handles faces — the roadblock is gone

**The BytePlus problem (ours, since February):** ByteDance suspended Seedance 2.0's
open real-person reference on 2026-02-10 after a single-photo voice-clone
demonstration, and re-gated it behind live verification. Our
`docs/compliance/real-person-consent-and-moderation.md` responded correctly — a T0/T1
consent architecture where a real likeness is a *credential* (verified subject →
provider `asset_id`), with **deliberately no "upload a face JPEG and generate" path**.
That's why you couldn't put your own face in a video.

**What Higgsfield does instead.** Across their entire MIT skills repo there is **no
liveness gate, no verified-asset id, no consent attestation flow.** The only content
controls documented are two terminal job statuses:

- `nsfw` — content policy
- `ip_detected` — public figures, trademarks, branded characters

Both are *prompt/content* filters returning "rephrase," not identity gates. Their own
README says:

> `Image with my own face` → `higgsfield-soul-id` then `higgsfield-generate`
> `Train a custom face identity` → **5–20 photos**, returns `reference_id`

Five to twenty photos. No liveness. And for our path, Seedance 2.5 accepts
`start_image`, `end_image`, `image_references`, `video_references` directly — which is
precisely the tweet's claim: *"Seedance 2.5 in the US, with face inputs. No other
provider offers that."*

**Read:** Higgsfield has absorbed the compliance burden as the licensed intermediary.
We pass a face reference; their relationship with ByteDance covers the verified route.
From our side it is one more `image_references` array. **No "approved media" section,
no verification UI, no enterprise pitch.** The whole §5 BytePlus-pitch checklist in
the compliance doc is deferred, not deleted — it stays the right architecture for
*other people's* faces at scale.

**Unverified, and you should test it first (Day 1, 15 min):** the skills repo documents
the **CLI**, which authenticates via `higgsfield auth login` (a user session). We will
use an **API key**. Whether the key route enforces the same face policy is not stated
anywhere in the open-source material. **Test with one photo of yourself before building
anything on top of it.** If the API key route is stricter, the demo pivots to a
synthetic persona — the loop still works, we just lose "that's literally me."

---

## 3. Build Day 1 — Wednesday 09-19 — the adapter

**Goal: a real clip, generated on Higgsfield, landing on the Byorn timeline.**

### 1a · Unblock (first 30 min — do before anything else)
- [ ] Get an API key at `console.higgsfield.ai`
- [ ] **Read off the v2 endpoint path for `seedance_2_5`.** The CLI uses model ids
      (`seedance_2_5`); the SDK uses REST paths (`/v1/image2video/dop`,
      `/v1/text2image/soul`). The mapping is in neither open-source repo.
      *(Partly resolved 09-18: the endpoint for text-to-video is
      `bytedance/seedance-2.5/text-to-video`, i.e. `<vendor>/<model>/<task>`. The
      `brain_activity` equivalent is still unknown.)*
- [ ] **Run the CLI locally to dump the live schema — this resolves several unknowns
      at once.** `MODELS.md` is generated from these, and the CLI authenticates with
      `higgsfield auth login` rather than an API key, so it works from your machine:
      ```bash
      higgsfield model list --json
      higgsfield model get seedance_2_5 --json
      higgsfield model get brain_activity --json
      ```
      This settles the `mode` conflict (§3 note), confirms Seedance 2.5's real
      parameter set, and gives `brain_activity`'s schema. Paste the output back.
- [ ] Note live per-generation pricing
- [ ] **Face test:** one photo of yourself → Seedance 2.5 `omni_reference`. Pass or fail,
      this decides the demo's persona (§2)
- [ ] Local Postgres (`docker compose up db`) or point `DATABASE_URL` at Neon

### 1b · The adapter (~4h)
- [ ] `apps/web/src/lib/studio/backends/video/higgsfield.ts`
  - Auth `Authorization: Key ${KEY_ID}:${KEY_SECRET}`, base `https://api.higgsfield.ai`
  - `submit()` → request id; `poll()` → `/requests/{id}/status` → `jobs[0].results.raw.url`
  - Capabilities: `supportsSeedLock`, `supportsOmniReference: true`,
    `supportsLastFrame: true`, `durationRangeSec: {min: 4, max: 30}`,
    resolutions 480p/720p/1080p, intents `["character-video", "broll-video"]`
  - Server module only — their SDK blocks browser use, matching our adapter rule
- [ ] Register in `backends/video/index.ts`
- [ ] `packages/env/src/web.ts` — `HIGGSFIELD_KEY_ID`, `HIGGSFIELD_KEY_SECRET`, `HIGGSFIELD_BASE_URL`
- [ ] `lib/credits/cost-table.ts` — real rates from 1a
- [ ] Unit tests mirroring `backends/video/__tests__/kling.test.ts`

**Input fields — `mode` is a known conflict, so we omit it.** `prompt`, `duration`,
`resolution` and `aspect_ratio` are confirmed against Higgsfield's own CLI `MODELS.md`
for `seedance_2_0` (2.5 postdates that file) and assumed stable. But `mode` has two
incompatible documented meanings: MODELS.md says Seedance 2.0's `mode` is a *speed
tier* (`std` | `fast`), while the skills repo says Seedance 2.5's modes are
`t2v` | `omni_reference` | `video_edit` | `video_extension`. Sending the wrong one
risks a 422 or a silently wrong render, so the adapter omits `mode` and lets the
server default stand until `higgsfield model get seedance_2_5 --json` settles it.

### 1c · Routing (~1h)
- [ ] Wire the dead `realFaceReference` seam — `router.ts:160` routes real faces to
      Runway as an "interim"; Higgsfield is the wave 2 that never landed
- [ ] Flip `DEFAULT_BACKEND_ID.video` → `"higgsfield"` (their contest rules disqualify
      third-party generation; a demo on BytePlus is not an entry)

**Done when:** you type a prompt in the studio panel, a clip generates on Higgsfield,
and it lands on the timeline. Nothing else counts.

---

## 4. Build Day 2 — Thursday 09-20 — the differentiator

**Goal: the editor grades its own cut and fixes it.** This is the beat nobody else in
that QT thread can demo, because it needs a timeline.

> **Discovery 09-18 — most of this UI already exists, orphaned.** Byorn shipped an
> engagement/virality scorer on 2026-07-17 and then lost the entry point:
>
> | File | State |
> |---|---|
> | `components/editor/youtube/engagement-panel.tsx` | **Orphaned** — nothing imports it. Its docblock: *"check your video's engagement score at any time during editing or before export. Works with any video on the timeline."* |
> | `components/editor/youtube/score-breakdown.tsx` | Live (used by `clip-grid`) |
> | `components/editor/youtube/engagement-diagnostics.tsx` | Live |
> | `lib/engagement-diagnostics.ts` (418 lines) | Live — derives HOOK / HOLD RATE / ATTENTION heatmap from 7 raw signals |
> | `stores/engagement-store.ts` | Live |
> | `services/ai-backend/.../engagement/scorer.py` | Live, but the Python backend is **not deployed** (ADR-004) |
>
> So Day 2 is **not** "build a scoring feature." It is: un-orphan the panel, and swap
> its data source from the undeployed local transcript heuristic to Higgsfield's
> model-based `brain_activity`, which scores an actual video. The signal shapes line
> up — `brain_activity` returns hook / attention / retention, which is exactly what
> `score-breakdown.tsx` already renders.
>
> Correction to the record: `docs/unbuilt-ui-inventory.md` line 87 claims
> "Virality Score + Engagement Diagnostics (`virality-score-modal.tsx` from header)"
> is **verified wired**. That file has never existed in git history and nothing was
> wired from the header. Don't trust that line.

- [ ] `lib/studio/backends/analysis/higgsfield-virality.ts` — `brain_activity` takes a
      video, returns a score report. It does **not** fit `GenerationBackend` (no media
      out) — give it its own small module rather than bending the interface.

      **Verified contract** (Higgsfield CLI `MODELS.md`, cloned at
      `/home/user/higgsfield-ai/cli`):
      > `brain_activity` — Virality Predictor
      > `--video` (single) · **required** · UUID or path
      > `--folder_id` · optional · string
      > *"Analyzes a video and predicts audience engagement."*

      No prompt. One video in, a score report out. The v2 REST endpoint path is still
      unknown (the model id is the CLI's handle, not the REST path).
- [ ] Director verb `scoreCut` — render current cut → submit → return hook/retention.
      Register in `phase-scope.ts` under **polish** (review verbs live there;
      production is at its enforced tool ceiling).
- [ ] Add the descriptor to `lib/director/tool-catalog.ts` — it feeds both the Director
      *and* MCP, so the verb is externally drivable for free.
- [ ] Feed the score into `edit-critic.ts` so the Director can act: low hook →
      `tightenToLength` / `cutOnBeat`, both already shipped as craft macros.
- [ ] **Surface the score in the UI.** A number that visibly moves after a recut is the
      single most demoable thing in this build. Do not skip the visual.

**Done when:** you can run score → recut → score and watch the number go up.

---

## 5. Build Day 3 — Friday 09-21 — harden and rehearse

**Goal: the demo runs ten times without breaking. No new features.**

- [ ] Write 3–5 eval scenarios in `lib/director/evals/` covering the exact demo path.
      There is currently **one** scenario total. This is not ceremony — it's how you
      stop the demo breaking on take 11.
- [ ] Run the full loop end to end, repeatedly. Fix only what breaks.
- [ ] Failure modes to handle explicitly, because they *will* fire on camera:
      `nsfw` / `ip_detected` rejection, HTTP 429, the CloudFlare/DataDome captcha their
      own troubleshooting doc warns about, and a job timing out past 10 min.
- [ ] Deploy to Vercel with the real key. Set a hard spend cap.
- [ ] Prepare demo assets: the brief text, your face photo, any b-roll.
- [ ] **Feature freeze at EOD.** Whatever works at this moment is what gets filmed.

---

## 6. Demo Day 1 — Saturday 09-22 — record and cut

- [ ] Screen-record the full loop. Multiple takes. Expect 6–10.
- [ ] Cut to 60–90s. Shot order that earns the differentiation:
      1. Brief typed (5s)
      2. Shots generating on Higgsfield (10s)
      3. **Hold on the timeline.** Multi-track, real clips. This is the shot no
         competitor can produce — give it real screen time (15s)
      4. Score appears (10s)
      5. Director recuts, score improves (20s)
      6. Export, then **play the actual mp4** (15s)
- [ ] Cut it in Byorn. "This demo was edited in the thing you're watching" is a free
      credibility beat.
- [ ] Write the QT copy. Lead with the loop, not a feature list. One sentence on what
      they can't do without a timeline.

---

## 7. Demo Day 2 — Sunday 09-23 — post

- [ ] Post the QT. Tag appropriately.
- [ ] Repo presentable — README is done, these two plan docs are the record.
- [ ] Be responsive in replies for the first few hours. Judged on attention.
- [ ] Buffer for anything Day 1 broke.

---

## 8. Cut list, if behind

Drop in this order. Never drop upward.

1. **Never cut:** brief → generate on Higgsfield → timeline → export. Without this
   there is no entry.
2. **Cut first:** the Director's *automatic* reaction to the score. Fall back to a
   manual "Score this cut" button — still demoable, far less risk.
3. **Then:** `end_image` / multi-reference. One `start_image` + prompt is enough.
4. **Then:** the eval scenarios — replace with a written manual checklist you run
   before each take.

**Explicitly not this week:** MCP work (already shipped), Director brain work (already
frontier Claude), PhotoMaker / per-persona LoRA (obsoleted by face inputs), worker
compositor, model breadth in the UI, the BytePlus enterprise pitch.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| **Endpoint mapping unknown** — blocks the adapter entirely | First 30 min of Day 1. If the API surfaces fewer models than the CLI, the adapter shrinks but the demo holds. |
| **API-key face policy may differ from CLI** (§2) | 15-min test on Day 1. Fallback: synthetic persona; the loop is unchanged. |
| **Rate limits / captcha on camera** | Pre-generate a fallback take. Never demo live against a cold API. |
| **Launch pricing** is customer-acquisition pricing | Fine for 5 days. Don't build a business model on it. |
| **Routing our differentiated path through a competitor** | The registry mitigates it — BytePlus stays registered, one constant flips back. |
| **The bounty is one person's informal judgment**, on a QT | Treat the *video* as the deliverable and the repo as supporting evidence. Budget 40% of total effort on the demo — that's why 2 of 5 days are demo days. |
