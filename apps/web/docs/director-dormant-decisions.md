# Director Dormant Items — Decisions (2026-07-11)

**Scope:** the dormant switches, stubs, and clean-ups inventoried in
`director-workflows-review.md` ("Dormant switches & seams inventory" + ranked list +
recommendations). This doc records the decision on each so nobody re-litigates or
re-discovers them. One line each, then the reasoning.

| # | Item | Decision |
|---|---|---|
| 1 | Understanding Pass activation | Demand-driven on Director mount (credit-gated); env autorun demoted to opt-in prefetch |
| 2 | `verifySpeakerSimilarity` stub | Keep the honest stub; consent stays phrase-verification-only |
| 3 | Face identity (`AssetFace`) | VLM descriptors interim; upgrade = on-device face **recognition** embeddings, NOT identity-conditioned generation |
| 4 | Role-mutator cache gap | Fix when the role-confirmation UI is built; spec recorded here |
| 5 | Timeline-vs-Bible revert | Behavior stays; copy fix specified, not yet implemented |
| 6 | `styleBible` name collision | FIXED — brief string renamed `styleNote` (legacy-key migration on read) |

---

## 1. Understanding Pass activation

**Supersedes** the review's ranked item 1 ("flip `NEXT_PUBLIC_UNDERSTANDING_AUTORUN=1`
behind the credit meter").

**Decision:** import-time autorun is NOT the primary trigger. The value moment is
Director engagement — a blanket autorun on import bills for assets that may never be
used. New design (implemented on branch `feat/understanding-demand-gate`):

- **Demand-driven batch understanding when the Director mounts.** Un-understood project
  assets are run through `understandAsset` behind the credit gate (`gateOn402` → the
  out-of-credits dialog), with small concurrency and a progress toast. The sync cache is
  refreshed as results land so the Asset Manifest updates in-session.
- **`NEXT_PUBLIC_UNDERSTANDING_AUTORUN=1` is retained as an opt-in import-time
  PREFETCH**, also credit-gated, with a per-tick batch cap (default 20). Assets past the
  cap are picked up by the demand-driven path above.

Net: the flag stops being the product switch; Director engagement is.

## 2. `verifySpeakerSimilarity` stub

**Decision: keep as-is.** The stub honestly returns `undefined`; consent remains
phrase-verification-only (Whisper transcript match). We do not fake a fingerprint check.

UI audit (2026-07-11) confirmed nothing user-visible claims voice-identity
verification: no component renders `similarityScore`, `ConsentMethod`, or the word
"fingerprint"; the voiceover-panel copy speaks only of the consent phrase.

Revisit only when a backend exposes cross-file speaker embeddings — the
`SpeakerSimilarityFn` seam makes that a one-line injection at that point.

**Guard for future UI work:** consent UI copy must say "phrase verified" and must never
imply speaker *identity* was confirmed.

## 3. Face identity (`AssetFace`)

**Decision:** VLM descriptors are the interim tier. The upgrade path is on-device face
**recognition** embeddings — NOT PhotoMaker or any identity-conditioned generator.

**Key insight (why not PhotoMaker-class):** `AssetFace` needs face RECOGNITION —
matching a face across assets and against the persona roster. That is a discriminative
problem. PhotoMaker / InstantID / PuLID / InfiniteYou are identity-conditioned
GENERATION models; they belong to the seed-lock / durable-tier discussion, a separate
track (see the generation-side note below).

**Recommended architecture for recognition:** on-device, in the browser — a face
detector (SCRFD-class) + an ArcFace-class 512-d embedding via `onnxruntime-web` (WASM,
WebGPU where available). Rationale:

- (a) **Zero relay cost per face** — doesn't inflate the credit-gated understanding pass.
- (b) **Compliance:** face embeddings are legally biometric data (BIPA/GDPR exposure).
  Keeping them in the user's IndexedDB and never shipping them to a server materially
  lowers the risk.
- (c) The app already runs an on-device embedding path (CLIP in the embedding indexer)
  — the infra pattern exists.
- (d) The understanding pass already samples frames to canvas — detector input is free.

**LICENSE CAVEAT (binding at build time):** the architecture recommendation is
detector + ArcFace-class embedding; the SPECIFIC weights need a license-clean pick.
InsightFace's pretrained packs (buffalo / antelopev2) are licensed for
**non-commercial research use only** — this repo already rejected
InstantID / PhotoMaker-v2 / UNO once over exactly this "InsightFace-weights trap"
(see `poach/higgsfield-soul-id-poaches.md`). Do NOT read this doc as "ship
`buffalo_l`". Options at build time:

- (a) commercially-licensed weights (insightface.ai sells commercial licenses);
- (b) permissively-licensed alternatives — e.g. Apache-2.0 MediaPipe face detection +
  an MIT-licensed embedding implementation (AdaFace code is MIT, but check the
  training-set terms of any pretrained weights);
- (c) train / fine-tune our own head.

**Seam change when built:** add an optional `embedding` field to `AssetFace`
(`src/lib/search/asset-understanding.ts`); match `personaMatch` by cosine threshold
against per-persona embedding anchors. Keep the VLM descriptors as the complementary
human-readable layer — they are reused verbatim as `Persona.descriptor` in generation
prompts.

**Generation-side note (separate track, for the future durable-tier re-evaluation
only):** identity-conditioned generation is already handled today by the routed
multi-provider persona-still path (`lib/studio/backends/`) — PhotoMaker was removed
from this codebase on 2026-07-09, so nothing here deprecates a live option. For
context if a trained/durable tier is ever re-evaluated: published face-similarity
numbers rank InstantID (~0.72) > PuLID-FLUX (~0.67) > PhotoMaker-v2 (~0.59), and
newer FLUX-era work (e.g. ByteDance InfiniteYou) targets PuLID-FLUX's text-alignment
weaknesses. PhotoMaker v1/v2 is no longer the default pick; re-evaluate at build time.

## 4. Role-mutator cache gap

**Decision: fix WHEN the role-confirmation UI is built, not before.** There are zero
live callers today, so the gap cannot bite.

**Spec requirement recorded so it isn't rediscovered:** `confirmRole` /
`clearRoleConfirmation` / `reinforceRole` MUST call `cacheUnderstanding`
(`understanding-lookup.ts`) when they mutate a role, or the Asset Manifest serves a
stale role until remount. See `director-workflows-review.md` (~line 216, ranked
item 2).

## 5. Timeline-vs-Bible revert separation

**Decision: behavior stays.** `revertBibleCheckpoint` reverts creative memory —
plan / look / brief — and intentionally leaves placed clips on the timeline.

**Copy fix (specified, NOT yet implemented — tracked here):** when next touching that
dialog, the revert confirmation should read approximately:

> Reverts the project's creative direction (plan, look, brief). Clips already on the
> timeline are unchanged.

## 6. `styleBible` name collision

**FIXED on this branch** (`chore/stylebible-rename-decisions`). The durable brief's
one-line free-text string is renamed `styleNote` (with one-way legacy-key migration on
read — `migrateLegacyBrief` in `lib/director/director-brief.ts`, applied at
`ProjectManager.getDirectorBrief` and the cross-project-memory promote/seed reads; the
`updateBrief` verb still accepts `styleBible` as a legacy arg alias). The structured
`ProjectBible.styleBible` look object is unchanged. The Bible panel placeholder no
longer says "style bible" for the one-line field.
