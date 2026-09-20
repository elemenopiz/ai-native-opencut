# Higgsfield REST catalog — mapped by validation-oracle probing

**Date:** 2026-09-19
**Method:** every probe below sends a POST with at least one deliberately-invalid
field (wrong type, bogus enum value, or a required field omitted entirely), so
the server rejects with `404` (path doesn't exist) or `422`/`400` (path exists,
validation ran) *before* any job is created. See
`apps/web/scripts/higgsfield-rest-probe.sh` for the re-runnable version of this
technique. **No probe in this document created a job or spent a confirmed
credit** — see "Two requests that turned out to be fully valid" below for the
two cases where that safety margin was thinner than intended, both caught and
both landing on `403 not_enough_credits` (no `request_id`, so no job existed to
charge).

Base URL: `https://api.higgsfield.ai`. Auth: `Authorization: Key
KEY_ID:KEY_SECRET`, read from `HIGGSFIELD_CREDENTIALS` in `.env.local`.

---

## 0. Two requests that turned out to be fully valid — read this first

The spend rule requires flagging this immediately and prominently, so it's
first, not buried.

1. `POST higgsfield-ai/soul/v2/standard` with body `{"prompt": ""}`.
   Assumption going in: Soul would reject an empty prompt the same way the
   video endpoint enforces `minLen 1`. It does not — Soul has **no minimum
   length on `prompt`**. The empty string passed validation cleanly and the
   response was `403 {"detail":"not_enough_credits"}` — i.e. the request
   reached the credits check and was only stopped by the account having no
   funds, not by validation. No `request_id` was returned, so no job was
   created and nothing was charged. Had the account been funded, this specific
   call would have created a real (if useless) generation job.
2. `POST bytedance/seedance-2.5/reference-to-video` with body
   `{"audio_urls": ["not-a-real-url"]}`. Assumption going in: a plausible-but-
   fake URL string would fail some format/reachability check. It didn't — this
   endpoint's validator (a plain JSON-Schema validator, not FastAPI/Pydantic)
   checks `type` but not URL format or reachability, and `audio_urls` turned
   out to be the *only* required field on this endpoint (see §3). Same result:
   `403 not_enough_credits`, no `request_id`, nothing created or charged.

Both are logged as a caution, not a data point to lean on: the account
happening to be unfunded is what kept these free, not anything in the request
itself. After #2, every subsequent probe against loosely-typed (JSON-Schema)
endpoints in this session switched to type-mismatched dummy values (numbers/
objects in place of strings/arrays) instead of plausible-looking strings,
specifically because this class of validator does not verify string *content*,
only type — a plausible string will sail through where a bogus enum value or
wrong type will not.

**Funding status:** both `403` responses are consistent with the account
having **zero or insufficient credits**. This was not established via a
dedicated balance endpoint — no such endpoint was found (see §5) — it's an
incidental read from two requests that otherwise passed validation. Treat it
as a reasonable inference, not a confirmed balance.

---

## 1. Soul image schema — `higgsfield-ai/soul/{mode}` and `.../v2/{mode}`

### 1.1 The path has a THIRD dimension nobody had mapped yet: `mode`

The tier segment after `soul` is not just `standard` — it's a path parameter
with its own enum, discovered because an invalid value (`cast`) echoed the
accepted set back:

- **`higgsfield-ai/soul/{mode}`** (no version prefix) — `mode` ∈
  `reference`, `character`, `standard`. All three resolve (422 on empty body,
  not 404).
- **`higgsfield-ai/soul/v2/{mode}`** — `mode` ∈ `standard` only. `character`
  and `reference` are NOT valid for `v2` (confirmed via the same literal-enum
  echo: `"Input should be 'standard'"`).

The request **body schema is identical across all three `v1` modes** —
`character` and `reference` accept exactly the same fields as `standard` (same
big-batch probe against all three produced byte-identical error sets). The
mode is a pure behavior switch server-side, not a body-shape change. This
means Soul's character/style consistency is driven by the `style_id` /
`custom_reference_id` UUID fields (§1.2) in combination with `mode`, not by an
inline image upload in the generation call — those UUIDs almost certainly come
from a separate "create a reference/style asset" endpoint that was out of
scope to hunt for here (not found; see §5 unknowns).

**`higgsfield-ai/soul/standard` and `higgsfield-ai/soul/v2/standard` take the
same body** (directly confirmed — same batch probe against both produced the
same 8-field error set). The only difference found between the tiers is the
`mode` enum itself (`v2` drops `character`/`reference`).

### 1.2 Full mapped body (applies to `soul/standard`, `soul/character`,
`soul/reference`, and `soul/v2/standard` — all identical)

| field | type | required | constraint | notes |
|---|---|---|---|---|
| `prompt` | string | **yes** | — | No minimum length enforced (see §0 finding #1). Confirmed via `string_type` error when sent as `12345`. |
| `aspect_ratio` | string enum | no | `9:16`, `16:9`, `4:3`, `3:4`, `1:1`, `2:3`, `3:2` | Different set from the video endpoint's enum. |
| `resolution` | string enum | no | `720p`, `1080p` | **No `480p`** — inverse of the video endpoint, which has no `1080p`. |
| `style_id` | UUID | no | must parse as UUID | Almost certainly a style-preset id from an asset/preset-listing endpoint not found in this session. |
| `custom_reference_id` | UUID | no | must parse as UUID | **This is very likely the "Soul ID" / character-persona reference** the `higgsfield-soul.ts` adapter's header says it can't send (`src/lib/studio/backends/image/higgsfield-soul.ts:19-27`, `:97-104`) — the field exists and is UUID-typed, confirmed live. It is NOT an inline image URL; it's a reference to something created elsewhere (a trained persona/asset id), consistent with the CLI's `--custom-reference-id` flag semantics. |
| `seed` | integer | no | `1 ≤ seed ≤ 1000000` (both bounds confirmed via `ge`/`le` errors) | |
| `batch_size` | integer literal | no | `1` or `4` only | Not a general integer — a strict two-value literal. |
| `enhance_prompt` | boolean | no | — | |

### 1.3 Confirmed NOT to exist in this schema (probed, no error, no effect)

Despite being highly plausible names (and in some cases literally the field
names the current `higgsfield-soul.ts` adapter guesses from the CLI flag
table), none of these produced any validation error when sent with a wrong
type/shape, meaning they are either silently ignored or simply absent from the
schema: `negative_prompt`, `quality`, `style`, `style_preset`, `num_images`,
`count`, `num_variations`, `variations`, `batch_size`'s sibling
guesses (`width`, `height`), `image_reference`, `image_references`,
`reference_image`, `reference_images`, `image_url`, `image_urls`, `image`,
`images`, `character_reference`, `character_id`, `persona_id`, `reference_id`,
`soul_ids`, `soul_id`, `soul-id` (dash key), `input_image`, `strength`,
`lora_id`, `preset_id`, `guidance_scale`, `steps`, `model`, `camera`,
`lighting`, `medium`, `webhook_url`, `callback_url`, `metadata`,
`nsfw_filter`, `safety_tolerance`, `moderation`.

**This directly contradicts the `higgsfield-soul.ts` adapter's current
`buildSubmitBody`**, which sends `quality` and `image_references` — neither
exists on this endpoint. See §6 recommendations.

### 1.5 Independent re-confirmation (Agent 1C, same day)

Before editing `higgsfield-soul.ts` off this document's findings, the fields
above were re-verified with a fresh probe in this session rather than taken
on faith: `POST higgsfield-ai/soul/v2/standard` with
`{"prompt":123,"aspect_ratio":"bogus_ratio","resolution":"999p","quality":"legacy_guess","image_references":123,"custom_reference_id":"not-a-uuid","style_id":"not-a-uuid","seed":99999999,"batch_size":7,"enhance_prompt":"not-a-bool","__nonexistent__":true}`
(guaranteed-invalid via `prompt: 123`, a wrong type) returned `422` with:

```json
[{"type":"string_type","loc":["body","prompt"],"msg":"Input should be a valid string","input":123},
 {"type":"literal_error","loc":["body","aspect_ratio"],"msg":"Input should be '9:16', '16:9', '4:3', '3:4', '1:1', '2:3' or '3:2'","input":"bogus_ratio"},
 {"type":"literal_error","loc":["body","resolution"],"msg":"Input should be '720p' or '1080p'","input":"999p"},
 {"type":"bool_parsing","loc":["body","enhance_prompt"],"msg":"Input should be a valid boolean, unable to interpret input","input":"not-a-bool"},
 {"type":"uuid_parsing","loc":["body","custom_reference_id"],"msg":"Input should be a valid UUID, invalid character…","input":"not-a-uuid"},
 {"type":"uuid_parsing","loc":["body","style_id"],"msg":"Input should be a valid UUID, invalid character…","input":"not-a-uuid"},
 {"type":"less_than_equal","loc":["body","seed"],"msg":"Input should be less than or equal to 1000000","input":99999999},
 {"type":"literal_error","loc":["body","batch_size"],"msg":"Input should be 1 or 4","input":7}]
```

This matches §1.2 exactly, and reconfirms `quality`, `image_references`, and
`__nonexistent__` produce **no error each**, despite 8 other fields in the
same request all correctly erroring — i.e. they're silently dropped, not
validated. `higgsfield-soul.ts` has been corrected accordingly: it now sends
`prompt` / `aspect_ratio` / `resolution` / `seed` only, `supportsReferenceEdits`
is `false` (an image reference has zero effect through this endpoint today),
and `supportsSeedLock` stays `false` (the shared seed-lock clamp's ceiling is
2^31-1, well above Soul's real 1,000,000 max — wiring that safely needs a
per-backend seed range, out of scope here). See the adapter's header for the
full explanation and `image/__tests__/higgsfield-image.test.ts`'s
`"higgsfield-soul — submit body"` block for the tests.

### 1.4 Unknown-field handling — the question that determines adapter safety

**Unknown fields are silently ignored, not rejected.** `__nonexistent__` (an
obviously-fake key) was included in every large batch probe against Soul and
never once appeared in an error, including in batches where 5+ *other* bogus
fields DID produce errors in the same response (proving the validator is
actively checking the fields it recognizes, not just failing open on
everything). This means:

- A client CANNOT rely on a `422` to catch a typo'd or renamed field name —
  the server will accept the request and silently drop what it doesn't
  recognize.
- Any adapter sending guessed field names (like `quality` /
  `image_references` above) is not just wrong, it is **silently** wrong: the
  request goes through, money may be spent, and the guessed parameter has zero
  effect on the actual generation.

---

## 2. Video family — `bytedance/seedance-{2.0,2.5}/{task}`

Different vendor, different validator: this one is a plain JSON-Schema
validator (error shape `"field: value is not of type 'X'"` or `": 'field' is a
required property"`), and it reports **only one error per response** — it does
not collect all violations like Soul's Pydantic/FastAPI validator does. That
changes the safe-probing technique: you cannot batch many bogus fields in one
call and read all the answers at once; you fix one field at a time and
re-probe to find the next one. It also does not validate string *content*
(URL format, etc.) — only `type` — which is exactly what produced spend-risk
event #2 in §0.

### 2.1 Confirmed-existing tasks (probed with `{}`, existence only)

| path | first missing-field error on `{}` |
|---|---|
| `bytedance/seedance-2.5/text-to-video` | `prompt` (baseline; fully mapped, not re-probed) |
| `bytedance/seedance-2.5/image-to-video` | `image_url` |
| `bytedance/seedance-2.5/video-edit` (hyphen, NOT `video_edit`) | `prompt` |
| `bytedance/seedance-2.5/reference-to-video` | `audio_urls` |
| `bytedance/seedance-2.0/text-to-video` | `prompt` |
| `bytedance/seedance-2.0/image-to-video` | `image_url` |
| `bytedance/seedance-2.0/reference-to-video` | `video_urls` (order differs from 2.5's; not meaningful — see below) |

`bytedance/seedance-1.5*` (any spelling tried) is **404** — the CLI's
`seedance1_5` model has no REST surface. So the REST catalog for this vendor
is `{2.0, 2.5} × {text-to-video, image-to-video, video-edit*, reference-to-video}`,
where `video-edit` was only confirmed on 2.5 (404 on 2.0).

### 2.2 `bytedance/seedance-2.5/video-edit` — partially mapped

| field | type | required |
|---|---|---|
| `prompt` | string | **yes** (confirmed via isolated omission — `{}` and `{video_url omitted}` both flag it independently) |
| `video_url` | string | **yes** (confirmed via isolated omission — flagged when `prompt` was valid and only `video_url` was missing) |
| `video_urls` | array | no (confirmed optional — omitting it while `prompt`/`video_url` were otherwise invalid never produced a "required" error for it) |

Not explored further (aspect_ratio/resolution/duration on this endpoint —
out of scope; flagging as unknown in §5).

### 2.3 `bytedance/seedance-2.5/reference-to-video` — partially mapped, and a
correction to make explicitly

**Only `audio_urls` (array) is confirmed required.** This was directly proven,
not inferred: `{"audio_urls": ["not-a-real-url"]}` — with `prompt`,
`image_urls`, and `video_urls` all fully **omitted** — passed validation
completely (§0, event #2). That is the cleanest possible evidence that those
three are optional: if any were required, that exact request would have
400'd. (An earlier line of probing in this session type-checked `prompt`,
`image_urls`, and `video_urls` while they were *present* with wrong types,
which confirms they're real, typed fields, but does NOT by itself prove
required-ness — worth stating explicitly since it would be easy to
misread those type-check probes as required-ness checks.)

| field | type | required |
|---|---|---|
| `audio_urls` | array | **yes** |
| `prompt` | string | no |
| `image_urls` | array | no |
| `video_urls` | array | no |
| `resolution` | string enum | no — `480p`, `720p` (same as `text-to-video`'s enum per baseline) |
| `duration` | integer | no |
| `generate_audio` | boolean | no |
| `aspect_ratio`, `output_format` | — | **not recognized** — bogus values for these never produced an error at any point, including in a response where 4 other fields' bogus values all correctly errored in sequence |

This endpoint — taking `audio_urls` + optional `image_urls` + optional
`video_urls` + optional `prompt` together — is the closest thing found in this
session to a multi-modal reference/blend endpoint for video, but it is **not**
called `omni_reference` and its primary/required axis is audio, not a
character image. See §4 for the `omni_reference` search itself.

---

## 3. Reachable-model table (the full probe log)

Legend: **EXISTS** = 422/400 (path resolves, validation ran); **404** = path
does not exist (`model_not_found`).

| path | status | meaning |
|---|---|---|
| `bytedance/seedance-2.5/text-to-video` | 400 | EXISTS (baseline, fully mapped) |
| `bytedance/seedance-2.5/image-to-video` | 400 | EXISTS — requires `image_url` |
| `bytedance/seedance-2.5/omni_reference` | 404 | absent |
| `bytedance/seedance-2.5/omni-reference` | 404 | absent |
| `bytedance/seedance-2.5/video_edit` (underscore) | 404 | absent — hyphen form exists instead |
| `bytedance/seedance-2.5/video-edit` | 400 | EXISTS — see §2.2 |
| `bytedance/seedance-2.5/video_extension` (underscore) | 404 | absent |
| `bytedance/seedance-2.5/video-extension` | 404 | absent |
| `bytedance/seedance-2.5/video-extension/standard` | 404 | absent |
| `bytedance/seedance-2.5/extend-video` | 404 | absent |
| `bytedance/seedance-2.5/reference-to-video` | 400 | EXISTS — see §2.3 |
| `bytedance/seedance-2.5/standard` (tier-only form) | 404 | absent — video family is task-suffixed, not tier-only |
| `bytedance/seedance-2.5/omni-reference/standard` | 404 | absent |
| `bytedance/seedance-2.0/text-to-video` | 400 | EXISTS |
| `bytedance/seedance-2.0/image-to-video` | 400 | EXISTS |
| `bytedance/seedance-2.0/reference-to-video` | 400 | EXISTS |
| `bytedance/seedance-2.0/omni_reference` | 404 | absent |
| `bytedance/seedance-2.0/video-edit` | 404 | absent (2.5-only) |
| `bytedance/seedance-2.0/video-extension` | 404 | absent |
| `bytedance/seedance-1.5/text-to-video` | 404 | absent |
| `bytedance/seedance-1.5-pro/text-to-video` | 404 | absent |
| `bytedance/omni-reference/standard` | 404 | absent |
| `bytedance/seedream-4.5/standard` | 404 | absent |
| `bytedance/seedream-v4.5/standard` | 404 | absent |
| `bytedance/seedream/standard` | 404 | absent |
| `bytedance/z-image/standard` | 404 | absent |
| `bytedance/seed-audio/standard` | 404 | absent |
| `bytedance/seed-audio-1.0/standard` | 404 | absent |
| `bytedance/seed-audio/{text-to-audio,text-to-speech}` | 404 | absent (baseline) |
| `kling-video/v2.5-turbo/pro/image-to-video` | 400 | EXISTS (baseline example, confirmed) |
| `kling-video/v2.5-turbo/pro/text-to-video` | 400 | EXISTS |
| `kling-video/v2.5-turbo/standard/image-to-video` | 400 | EXISTS |
| `kling-video/v2.5-turbo/pro/text-to-image` | 404 | absent |
| `kling-video/v2.6/pro/image-to-video` | 400 | EXISTS |
| `kling-video/v2.6/pro/text-to-video` | 400 | EXISTS |
| `kling-video/v2.6/standard/image-to-video` | 404 | absent — v2.6 seems `pro`-tier only |
| `kling-video/v3/pro/image-to-video` | 404 | absent |
| `kling-video/v3/standard/image-to-video` | 404 | absent |
| `kling-video/v3-turbo/pro/image-to-video` | 404 | absent |
| `minimax/hailuo-2.3/standard/text-to-video` | 400 | EXISTS (baseline example, confirmed) |
| `minimax/hailuo-2.3/pro/text-to-video` | 400 | EXISTS |
| `minimax/hailuo-2.3/standard/image-to-video` | 400 | EXISTS |
| `minimax/hailuo-2.3/fast/text-to-video` | 404 | absent |
| `minimax/hailuo-2/standard/text-to-video` | 404 | absent |
| `google/veo-3/standard` (+7 more veo path guesses, see below) | 404 (all) | absent — see §4 |
| `higgsfield-ai/soul/standard` | 422 | EXISTS (baseline, fully mapped §1) |
| `higgsfield-ai/soul/v2/standard` | 422 | EXISTS (baseline, fully mapped §1) |
| `higgsfield-ai/soul/character` | 422 | **EXISTS — new, same body as `standard`** (§1.1) |
| `higgsfield-ai/soul/reference` | 422 | **EXISTS — new, same body as `standard`** (§1.1) |
| `higgsfield-ai/soul/v2/character` | 422 (mode literal error) | absent for v2 — only `standard` valid |
| `higgsfield-ai/soul/v2/reference` | 422 (mode literal error) | absent for v2 — only `standard` valid |
| `higgsfield-ai/soul-cast/standard` | 404 | absent — not a real vendor/model split |
| `higgsfield-ai/soul-location/standard` | 404 | absent |
| `higgsfield-ai/omni-reference/standard` | 404 | absent |
| `higgsfield-ai/omni_reference/standard` | 404 | absent |
| `higgsfield-ai/text-to-speech/standard` | 404 | absent |
| `higgsfield-ai/text2speech/v2/standard` | 404 | absent |
| `higgsfield-ai/image-background-remover/standard` | 404 | absent |
| `higgsfield-ai/video-background-remover/standard` | 404 | absent |
| `higgsfield-ai/outpaint/standard` | 404 | absent |
| `openai/gpt-image-2.5/{standard,text-to-image,edit,create}` | 404 (all) | absent (2 baseline + 2 new) |
| `openai/gpt-image-2/standard` | 404 | absent (baseline) |
| `openai/tts/standard` | 404 | absent |
| `google/nano-banana-2/standard` | 404 | absent (baseline) |
| `google/nano-banana/standard` | 404 | absent (baseline) |
| `google/nano-banana-2-lite/standard` | 404 | absent |
| `google/nano-banana-flash/standard` | 404 | absent |
| `google/nano-banana-pro/standard` | 404 | absent |
| `google/nano-banana-2/standard/edit` | 404 | absent |
| `google/gemini-3-pro-image/standard` | 404 | absent (baseline) |
| `google/gemini-omni/standard` | 404 | absent |
| `black-forest-labs/flux-2/standard` | 404 | absent |
| `black-forest-labs/flux-kontext/standard` | 404 | absent |
| `recraft/v4.1/standard`, `recraft-ai/recraft-v4.1/standard` | 404 | absent |
| `xai/grok-image/standard`, `xai/grok-image/text-to-image` | 404 | absent |
| `higgsfield/soul-cinematic/text-to-image` | 404 | absent (baseline) |
| `inworld/text-to-speech/standard`, `inworld-ai/text-to-speech/standard` | 404 | absent |
| `elevenlabs/text-to-speech/standard` | 404 | absent |
| `mirelo/text-to-audio/standard` | 404 | absent |
| `sonilo/music/standard` | 404 | absent |
| `GET account`, `GET balance`, `GET credits`, `GET me`, `GET user` (+3 more) | 405 | route exists at depth-1 but POST-only pattern, NOT a real account/balance endpoint — see §5 |
| `GET requests/<fake-id>/status` | 404 `{"detail":"Not Found"}` | confirms status-endpoint's own 404 shape differs from `model_not_found` |

~90 distinct paths probed in total across this session; every non-existent one
returned `404 {"detail":"model_not_found"}` (the video-family 404s) or the
same shape (image-family), consistent with the baseline's documented
`model_not_found` behavior throughout.

---

## 4. `omni_reference` — searched for, not found

Tried under every vendor/spelling combination that seemed plausible:
`bytedance/seedance-{2.0,2.5}/omni_reference` and `omni-reference` (both
spellings, both versions), `bytedance/omni-reference/standard`,
`higgsfield-ai/omni-reference/standard`, `higgsfield-ai/omni_reference/standard`,
`bytedance/seedance-2.5/omni-reference/standard`. All 404. The CLI's
`MODELS.md` (fetched from `github.com/higgsfield-ai/cli`, `main` branch) also
has **no model whose id or description contains "omni_reference"** — the only
"omni" hits in the whole 1012-line file are `kling_omni_image` (Kling O1
Image) and `gemini_omni` (Gemini Omni Flash), neither of which is a reference-
blending endpoint by name.

**Best candidates actually found for the role the task describes** (a
character-reference-carrying endpoint, distinct from plain t2v):

- **Video:** `bytedance/seedance-2.5/reference-to-video` (§2.3) — takes
  `audio_urls`/`image_urls`/`video_urls` together. This is the closest thing
  to a multi-reference blend endpoint on the video side, but its one
  confirmed-required field is audio, not image, so it reads more like a
  music/voice-driven generator than a character-consistency tool. Not
  confirmed to be what CLI calls `omni_reference` internally — no such CLI id
  exists to cross-reference against.
- **Image:** `higgsfield-ai/soul/character` (§1.1) — same body as `standard`,
  behavior switched via the `mode` path segment plus `custom_reference_id`.
  This is a stronger match for "character reference" in spirit, but it
  carries the reference via a **UUID id**, not an inline image URL/upload in
  the generation call — so whatever endpoint mints that UUID from an image
  was not found in this session (see §5).

**Conclusion: no REST endpoint literally named or shaped like `omni_reference`
was found.** The baseline's framing that this distinction is "expressed as
separate endpoints" is directionally right (t2v/image-to-video/video-edit/
reference-to-video ARE separate endpoints), but no endpoint in this catalog
carries that specific name or matches "character reference image" as its
primary, required input.

---

## 4A. `brain_activity` (Virality Predictor) — searched for, NOT found

**Verdict: no open REST endpoint for `brain_activity` was found. This is a
negative result, not an inconclusive one** — every plausible vendor/model
spelling 404'd with the same `model_not_found` shape every other confirmed-
absent path in this catalog produces, and a control probe ruled out the one
alternative explanation (a GET-only or differently-routed endpoint).

The CLI's own `MODELS.md` (github.com/higgsfield-ai/cli, fetched fresh this
session) documents the model plainly:

> **Model ID:** `brain_activity` — "Virality Predictor". "Analyzes a video and
> predicts audience engagement." Flags: `--video` (required, UUID or path,
> single) and `--folder_id` (optional, string). No prompt, no vendor/tier
> hint of any kind — the CLI id is flat, same as every other model in that
> doc, and (as established in §1.1/§3) the CLI id does **not** predict the
> REST path shape.

19 paths were probed (all `POST … {}`, the same existence-only technique as
§3 — guaranteed-invalid since `{}` fails validation before any job exists on
every endpoint in this catalog):

| path | status | body |
|---|---|---|
| `higgsfield-ai/brain-activity/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/brain_activity/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/brain-activity` (no tier) | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/virality-predictor/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/virality/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/virality-score/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/engagement/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/engagement-predictor/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/hook-predictor/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/video-analysis/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/analyze-video/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/predict-engagement/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield/brain-activity/standard` (vendor w/o `-ai`) | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/brain-activity/analyze` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/brain-activity/v1` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/brain-activity/v2` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/analytics/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/video-score/standard` | 404 | `{"detail":"model_not_found"}` |
| `higgsfield-ai/attention-score/standard` | 404 | `{"detail":"model_not_found"}` |

**Control probe — ruling out "maybe it's GET, not POST":** analysis-style
endpoints (video in, report out, no media rendered) could plausibly be routed
differently from every generation endpoint in this catalog, all of which are
POST. `GET brain-activity`, `GET brain_activity`, and
`GET higgsfield-ai/brain-activity/standard` all returned `405 Method Not
Allowed` — the exact same generic "this API is POST-oriented, any depth-1 or
deeper path answers 405 to GET" behavior already established in §5's balance-
endpoint control probe (`GET totally-bogus-single-segment` also 405s). That
rules out a GET route hiding behind these same path guesses; it is not
evidence of existence.

**What this means for the sprint:** the Virality Predictor cannot be reached
by REST today under any spelling tried. Wave 2 should treat `brain_activity`
as CLI/console-only, same status as `gpt_image_2_5` / `nano_banana_2` /
`seed_audio` (§5) — a real Higgsfield capability, but not one this codebase
can call without either (a) Higgsfield adding a REST route in the future, or
(b) driving the CLI itself (a different integration shape — subprocess +
`higgsfield auth login`, not an HTTP adapter — and outside this task's scope
to design). No `lib/studio/backends/analysis/` module was added, because
there is nothing live to point it at; inventing a path here would be exactly
the fabrication this task was warned against.

---

## 5. Explicitly still unknown

- **No image-generation endpoint beyond the Soul family was found reachable
  over REST.** Every other CLI image model (`cinematic_studio_2_5`,
  `flux_2`, `flux_kontext`, `gpt_image_2`, `gpt_image_2_5`, `grok_image`,
  `nano_banana*`, `recraft_v4_1`, `seedream_*`, `z_image`, etc.) 404'd under
  every vendor/tier spelling tried. This is consistent with, not just assumed
  from, the existing adapter comments (`higgsfield-nano-banana.ts`,
  `higgsfield-gpt-image.ts`) that call these CLI/console-only. Not
  exhaustively proven — only the spellings in §3 were tried.
- **No audio or text-to-speech endpoint was found reachable over REST** —
  8 vendor/naming guesses for `seed_audio`, `inworld_text_to_speech`,
  `mirelo_text_to_audio`, `sonilo_music`, `text2speech_v2` all 404'd. Same
  caveat: not exhaustive.
- **`brain_activity` (Virality Predictor) has no open REST endpoint** — see
  §4A for the full 19-path probe log and the GET-method control check.
- **No dedicated balance/credits/account endpoint was found.** `GET` on
  `account`, `account/balance`, `balance`, `credits`, `me`, `user`,
  `account/credits`, `v1/account` all returned `405 Method Not Allowed` —
  and a control probe (`GET totally-bogus-single-segment`) returned the
  *same* 405, proving this is generic routing behavior for any depth-1 path
  under a POST-oriented router, not evidence any of those specific names is a
  real endpoint. Funding status is inferred only from the two incidental 403s
  in §0.
- **Where Soul's `style_id` / `custom_reference_id` UUIDs come from** — i.e.
  the endpoint that uploads/registers a reference image and returns one of
  these ids — was not found or searched for beyond the generation paths
  themselves. This is the actual gap standing between the current
  `higgsfield-soul.ts` adapter and a real Soul ID / seed-lock-equivalent
  integration.
- **`kling-video` and `minimax/hailuo` request bodies** were confirmed to
  exist (§3) but their bodies were not mapped — out of this task's scope
  (only Soul + `omni_reference` needed full mapping).
- **Whether `bytedance/seedance-2.5/image-to-video`'s `prompt` is required**
  in addition to `image_url` was not independently tested (only `image_url`'s
  required-ness was confirmed via the `{}` probe). Given the `reference-to-
  video` surprise in §2.3, do not assume it is required without checking.
- **Array-length / cross-field constraints** on `reference-to-video` (e.g.
  whether `audio_urls`/`image_urls`/`video_urls` have max-item limits, the
  way `seedance-2.0`'s CLI flags document "at most 3 audio references") were
  not probed.

---

## 6. Recommendations

1. ~~`src/lib/studio/backends/image/higgsfield-soul.ts`'s `buildSubmitBody`
   currently sends `quality` and `image_references` — neither field exists~~
   **DONE (Agent 1C, this session).** `buildSubmitBody` now sends `prompt` /
   `aspect_ratio` / `resolution` / `seed` only; `quality` and
   `image_references` are gone. `supportsReferenceEdits` flipped to `false`
   (a reference image had zero effect through this endpoint) and
   `supportsSeedLock` stays `false` pending a per-backend seed-range fix in
   `seed-lock.ts` (Soul's real ceiling is 1,000,000; the shared clamp's is
   2^31-1). `custom_reference_id` (§1.2) is real and UUID-typed and remains
   the exact Soul ID mechanism the adapter still can't send — closing that
   gap still needs (a) plumbing a persona-id field through `BackendRequest`,
   and (b) finding the endpoint that mints a `custom_reference_id` from an
   uploaded image (§5, not found in this session either — out of scope to
   hunt for without a steer on where to look).
2. ~~`resolution` on Soul should map to `720p`/`1080p` only~~ **DONE** — see
   `resolutionTier()` in the adapter; it was already using a private
   `qualityTier()`/`resolution`-shaped helper scoped to this file, not a
   shared cross-vendor one, so there was no other call site to check.
3. Given unknown fields are silently ignored (§1.4) server-side, any future
   adapter work against this API should treat a `200`/`202` as **weak**
   evidence the body was interpreted as intended — a typo'd field name will
   never surface as an error. Snapshot-testing the exact outgoing body against
   this document's field tables is cheaper than trusting the API to catch
   adapter bugs.
4. **`brain_activity` (§4A) has no REST route to point an adapter at.** If a
   future session drives it via the CLI instead of REST, that is a materially
   different integration (subprocess + `higgsfield auth login`, not
   `fetch()`) and deserves its own design pass rather than being bolted onto
   `higgsfield-client.ts`'s HTTP-only plumbing.
