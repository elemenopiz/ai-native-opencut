# Sprint Handoff #2 — after the swarm, after the live probe

**Written:** 2026-09-19 · **Branch:** `claude/nifty-bohr-l4brpu` · **Tip:** `62246100`
**Supersedes** `2026-09-19-SPRINT-SWARM.md` for state; that doc's Wave briefs are now history.

---

## 0. The headline

**The Higgsfield REST contract is no longer guessed. It is verified, and it was verified
without spending a cent** — an *unfunded* key is enough to distinguish a wrong path (404)
from a wrong auth shape (401) from a correct request that only lacks credits (403
`not_enough_credits`). That single trick resolved the sprint's biggest open unknown, and
it also proved three of our adapters are pointed at endpoints that do not exist.

Everything in §2 below is measured against the live API plus the official reference at
`https://open.higgsfield.ai/models/bytedance/seedance-2.5/text-to-video/api-reference`.

---

## 1. Tree state — measured, not remembered

```
tsc --noEmit            exit 0
bun test src/lib/director/        1011 pass / 0 fail
bun test src/lib/studio/backends/  244 pass / 0 fail
bun test src/app/api/studio/        87 pass / 0 fail
bun test src/lib/credits/           67 pass / 0 fail
working tree            clean
```

Seven commits on top of the handoff doc, none pushed:

| Commit | What |
|---|---|
| `62246100` | `applyEdit` verb, element-wide targeting, non-visual guard (Wave 2A) |
| `2546f991` | Named reference handles + per-reference role labels (Wave 2B) |
| `252bbd00` | Program engine — primitives, sandbox, `cutOnBeat` as a program (Wave 1C) |
| `fc3f493c` | `readMix` verb, `watchBack` into polish, playbook enum (Wave 1B) |
| `76a6246e` | Image callers settle async jobs instead of throwing on pending |
| `fc49ca40` | Higgsfield image + audio adapters, inert until configured (Wave 1A) |
| `a85f77ee` | Wave 0 — green the tree |

**Wave 3 (operational proof / `HIGGSFIELD-OPERATIONAL.md`) was never run** — held by the
user. Its brief is still valid but should be rewritten against §2, since most of what it
was going to *assert* is now *known*.

---

## 2. VERIFIED Higgsfield contract

### Confirmed correct (official docs + live probe agree)

- **Base URL** `https://api.higgsfield.ai`
- **Auth** `Authorization: Key KEY_ID:KEY_SECRET` — accepted; a bad path 404s *before* any
  auth complaint, so 404 vs 401 cleanly separates the two failure modes
- **Video path** `bytedance/seedance-2.5/text-to-video` — **our guess was right**
- **Status** `GET /requests/{request_id}/status`
- **Statuses** `queued | in_progress | nsfw | failed | completed | canceled`
- **Media** `MediaOutput.url`, under `video`, `images[]`, `audio`, `audios[]`
  — our adapter's `data.video?.url ?? data.images?.[0]?.url` matches, and its status
  mapping already handles `nsfw`/`canceled` correctly

### `seedance-2.5/text-to-video` request body — AUTHORITATIVE

| Field | Type | Req | Default | Values |
|---|---|---|---|---|
| `prompt` | string | **yes** | — | min length 1 |
| `duration` | integer | no | 5 | 4–30 |
| `resolution` | string | no | `720p` | **`480p`, `720p` ONLY** |
| `aspect_ratio` | string | no | `16:9` | `16:9`,`4:3`,`1:1`,`3:4`,`9:16`,`21:9` |
| `output_format` | string | no | `mp4` | `mp4`, `mov` |
| `generate_audio` | boolean | no | true | — |

### The `mode` question is CLOSED

`mode` **is not a parameter on this endpoint at all.** Sending `mode: "__bogus__"` passed
validation and reached the billing gate (403), i.e. it was ignored. The
`t2v`/`omni_reference`/`video_edit`/`video_extension` distinction from the skills repo is
expressed as **different endpoints**, not a body field. The adapter's decision to omit
`mode` was correct and should stand.

### Image / audio endpoints — three of our four adapters are pointed at nothing

Probed with an empty body; `404 model_not_found` means the path does not exist.

| Path | Result |
|---|---|
| `higgsfield-ai/soul/standard` | **422 — EXISTS** (field `prompt` required) |
| `higgsfield-ai/soul/v2/standard` | **422 — EXISTS** |
| `openai/gpt-image-2.5/{standard,text-to-image}` | 404 |
| `openai/gpt-image-2/standard` | 404 |
| `google/nano-banana-2/standard`, `google/nano-banana/standard` | 404 |
| `google/gemini-3-pro-image/standard` | 404 |
| `higgsfield/soul-cinematic/text-to-image` | 404 |
| `bytedance/seed-audio/{text-to-audio,text-to-speech}` | 404 |

**The REST API exposes a SUBSET of the CLI catalog.** `MODELS.md` documents ~40 models
for the CLI; the open REST API serves far fewer. `gpt_image_2_5`, `nano_banana_2` and
`seed_audio` are CLI/console models and appear to have **no open REST endpoint**.

The real path shape includes a **tier** segment, not a task verb:
`/{vendor}/{model}/{tier}/{task?}` — e.g. `/higgsfield-ai/soul/standard`,
`/kling-video/v2.5-turbo/pro/image-to-video`, `/minimax/hailuo-2.3/standard/text-to-video`.
That is why every `…/text-to-image` guess missed.

Note also **two different validation layers**: the video endpoint answers `400`
`{"detail":"resolution: '…' is not one of […]"}` (JSON-schema style) while
`higgsfield-ai/soul/standard` answers `422` with FastAPI's
`[{type:"missing",loc:["body","prompt"]}]`. Error handling must tolerate both.

---

## 3. Bugs this uncovered

1. **`video/higgsfield.ts:236` advertises `resolutions: ["480p","720p","1080p"]`.**
   The API accepts **only 480p/720p** — a 1080p request 400s. Both the code comment
   (line 79, extrapolated from `seedance_2_0`) and the skills repo's "supports up to
   1080p" claim are wrong for this endpoint. Fix the capability list, and check
   `cost-table.ts` for a 1080p row that can never be billed.
2. **Three image/audio adapters target non-existent endpoints** (§2). They are inert
   behind their `HIGGSFIELD_*_ENDPOINT` gate, so nothing is broken in production — the
   gate did exactly its job — but they cannot work as written.
3. **`higgsfield-seed-audio` is unreachable anyway** — `/api/studio/audio` accepts only
   `action: "score" | "music"`.

---

## 4. Open architectural question: why 69 verbs?

Raised by the user, and fair. The honest answer:

**The primitives decision was implemented, but the macros were not removed** — deliberately
("parity first, deletion later, and only once the evals covering them still pass"). So the
catalog is currently *both*, which is the worst resting state if it persists: the model
sees 69 verbs *and* a program engine.

Breakdown of the 69:

- **~10 true primitives** — `trim`, `move`, `split`, `reorder`, `remove`, `addClip`,
  `addText`, `applyTransition`, `applyEffect`, `animateItem`. These are exactly what
  `applyEdit` composes.
- **Deletable macros (the real target):** `cutOnBeat` (HIGH — already proven op-for-op
  identical as a program), `tightenToLength`, `duckMusicUnderSpeech`, probably
  `removeSilence`. Realistically **4–6 verbs**, not forty.
- **Irreducible:** reads (`getReel`, `getTimeline`, `searchMedia`, …), generation
  (`generate`, `reroll`, `remix`, `chainFrom`, …), perception (`watchBack`, `reviewTake`,
  `readMix`, `critiqueEdit`), lifecycle (`undo`, `redo`, `export`), plus proposals,
  budget, approvals, consistency/bible, board.

So the primitives thesis was always about **timeline editing**, which is precisely where
`applyEdit` now operates. It was never going to collapse generation, perception or project
state — those aren't macros over primitives, they're distinct capabilities.

Mitigation already in place: **phase scoping** means the model never sees 69 at once —
it sees briefing 28 / production 29 / polish 35. But polish at 35 is well past the 10–20
the phase-scope test's own comment cites, and that comment now says the next increment
should force a rebalance rather than another bump.

**Recommended next move:** prove parity for `tightenToLength` and `duckMusicUnderSpeech`
as programs (the way `cutOnBeat` was proven), then delete all three plus `removeSilence`.
That takes polish from 35 → 31 and makes the compose-don't-invoke story true rather than
additive.

---

## 5. Next steps, in order

### A. Free, do now — no funding needed
1. **Fix the 1080p capability lie** (§3.1) and any dead 1080p cost row.
2. **Repoint or retire the image adapters.** `higgsfield-soul` → `higgsfield-ai/soul/v2/standard`
   (real). `higgsfield-gpt-image` and `higgsfield-nano-banana` have no REST endpoint —
   either delete them or leave them gated with a comment recording that the path does not
   exist rather than that it is unverified. Same for `higgsfield-seed-audio`.
3. **Map Soul's request schema** the same way — POST with one deliberately-bogus field and
   read the enum back out of the validation error. Zero spend.
4. **Enumerate the real REST catalog.** The full list is not in `MODELS.md` (that is the
   CLI). Probe candidates from the OpenAPI sample shapes, or read the model pages under
   `https://open.higgsfield.ai/models/...`.
5. **Rewrite and run the Wave 3 brief** against verified facts — the proof harness is now
   far more valuable because it can assert *known* paths, not guesses.
6. **Delete the macro verbs** per §4, once parity is proven.
7. **Real+generated toggle** — the mechanism landed (2A's targeting widening lets one
   program address placed footage and generative slots together) but there is no control.
   Implement as a project setting that filters generation verbs out of phase scope when
   off *and* states the mode in the system prompt, so gaps get explained rather than
   silently filled. `draftCut` (ADR-007) is the precedent.
8. **Director model** — default is `claude-opus-4-8`; move to `claude-opus-5`. Note
   `MOONSHOT_API_KEY` **wins over** `ANTHROPIC_API_KEY`, so with both set you are silently
   on `kimi-k2.6`. Make that precedence visible.

### B. Needs a funded key
9. `bun run scripts/higgsfield-example/index.ts` — the one live generation.
10. Face test: one photo → Seedance `omni_reference` (decides the demo's persona).
11. Real per-generation pricing → replace the estimated cost rows.
12. Flip `DEFAULT_BACKEND_ID.video` → `higgsfield`. **Contest rules disqualify third-party
    generation, so a BytePlus demo is not an entry.**
13. Wire the dead `realFaceReference` seam (nothing sets it today).

### C. Known gaps worth a decision
- **No image-generation verb.** `slotSpecSchema` offers only `text-to-video` /
  `image-to-video`, so the Director cannot create an image slot — it cannot make a title
  card, lower third, logo treatment or background plate. Eight registered image backends
  are unreachable from the Director.
- **Animation is linear only.** `animateItem` interpolation is `linear | hold`; no easing
  curves. Every move reads mechanically.
- **No speed ramps, masks/roto, or LUT verbs.**
- `image/higgsfield-client.ts` belongs at `backends/higgsfield-client.ts`, shared with the
  video adapter (which still holds a duplicate of the same auth/status contract).
- `.env.example` has no Higgsfield entries at all.
- 2B's reference handles are built and tested but **inert** until
  `byteplus-seedance.ts` forwards `referenceImageRefs` and `GenerationSpec` carries roles.

---

## 6. Security

The API key used for the probing in §2 **was pasted into a chat transcript and must be
rotated before it is funded.** It is unfunded, so nothing was spent and nothing could be.
This is the second key to be exposed this way; treat both as burned.

The probe technique is worth keeping: **an unfunded key is a free schema oracle.** Always
include one deliberately-invalid field so validation fails before job creation — a fully
valid body reaches the billing gate, which is harmless only while the account has no
credit.

---

## 7. Method notes for whoever picks this up

- Work in the worktree at `/Users/zsha/Documents/ai-native-opencut-swarm`, not the main
  checkout (main is dirty with unrelated `.playwright-mcp` churn).
- Copy `apps/web/.env.local` from the main checkout; it is gitignored and does not travel.
- `HIGGSFIELD_CREDENTIALS` falls back to `HF_CREDENTIALS` (`packages/env/src/web.ts:138`),
  so either name works.
- A full `bun test src/lib/studio/` sweep shows 2 failures from known mediabunny
  `AudioBufferSink` pollution. Both files pass in isolation. Verify with per-file filters.
- Run **both** `tsc` and the tests. Two test files this sprint passed at runtime while
  failing typecheck.
