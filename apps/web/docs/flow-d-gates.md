# Flow D — The Three Human Approval Gates + two deferred follow-ups

**Status:** shipped on `feat/director-context`. Implements Flow D from
`docs/reimagined-director-workflows.md` §3 ("Taste in the loop, labor out of it")
and §6 item 5, plus the consent-gate called out in
`docs/poach/descript-underlord-poaches.md` §4 #4.

> Flow D collapses the human's job to **EXPRESS / REACT / APPROVE**. Everything
> ambient (understanding, retrieval, continuity, self-review, recovery) is already
> automatic. This package makes the three **APPROVE** gates real — the moments that
> need judgment or carry liability — and **each approval writes its rationale into
> the Project Bible so decisions compound**.

The gates write through the EXISTING durable Bible/brief paths
(`director-brief.ts`, `project-bible.ts`) — no parallel decision store. All new
verbs are registered in `tool-catalog.ts` (agent + MCP surface); the read-only one
is whitelisted in `agent.ts` like `getProjectBible`.

---

## Gate 1 — Voice-clone consent (the liability fix)

**The gap.** Before this, the clone path (`aiClient.cloneVoice` →
`/api/tts/clone-voice`, driven from the Voiceover panel) "just uploads a reference
WAV and saves it — no consent, no fingerprint, no gating. This is a liability gap,
not just a feature gap" (descript poach §4 #4). A cloned voice was immediately
usable.

**The gate.** A cloned voice is now tracked from creation and is **UNUSABLE until
consented**. Nothing in TTS/voice-lock will speak it until the speaker records a
consent statement containing a required phrase, verified by the app's existing
Whisper transcription.

### The consent state machine (`lib/director/voice-consent.ts`, pure)

```
pending ──grantConsent(verified)──▶ consented ──revokeConsent──▶ revoked
   ▲                                                                 │
   └──────────────────── grantConsent (re-consent) ─────────────────┘
```

- **`pending`** — created at clone time (`createPendingProfile`). `isProfileUsable`
  is `false`. This is the birth state; nothing can speak it.
- **`consented`** — reached only after the phrase verifies. `isProfileUsable` is
  `true`. Records `{ phrase, grantedAt, grantedBy, method, transcript?, similarityScore? }`.
- **`revoked`** — terminal-until-re-granted; `isProfileUsable` is `false` and the
  prior grant is DROPPED (revoke = delete the grant, leaving a tombstone). Revoking
  **immediately** disables the clone everywhere.

`ClonedVoiceProfile.referencePath` is the backend speaker-WAV path — the exact
thing gated. The profile id is derived from it (`profileIdForReference`) so
re-clones dedupe.

### Verification — what is REAL vs STUBBED

- **Phrase verification is REAL.** The consent recording is transcribed via
  `aiClient.transcribe` (the app's Whisper path) and matched against the required
  phrase by `verifyConsentPhrase` — token-recall of the expected words with a 0.8
  default threshold (robust to minor ASR error and extra words). Wired end-to-end
  in `lib/director/voice-consent-service.ts` (`captureConsent`).
- **Speaker-similarity / voice-fingerprint is a documented STUB.**
  `verifySpeakerSimilarity` returns `undefined` ("no comparison available"), so
  consent falls back to **phrase-verification-only**. This is deliberate: the only
  speaker capability the repo exposes is `aiClient.analyzeSpeakers` — pyannote
  **diarization**, which labels speakers *within one file*. It returns neither a
  cross-file speaker embedding nor a pairwise similarity, so a faithful fingerprint
  match cannot be computed client-side today. **We do not fake a check that doesn't
  exist.** The seam is explicit: pass a real `SpeakerSimilarityFn` to
  `captureConsent` when a backend speaker-embedding endpoint lands (it is already
  honored — a score below `similarityThreshold`, default 0.7, blocks consent), and
  replace the `verifySpeakerSimilarity` default.

### Enforcement (server-side-equivalent, not just UI)

Client-side UI gating alone is not a gate. Enforcement lives at the chokepoints
every TTS consumer funnels through, keyed on the reference path:

- **`assertReferenceUsable(referencePath)`** (`stores/voice-consent-store.ts`) —
  throws for a registered-but-unconsented (pending/revoked) clone. Called in
  `generateVoiceoverTakeMedia` (`lib/studio/generate-voiceover-take.ts`), which is
  the path both the Voiceover panel's per-segment Take flow and the Director's
  `addVoiceover` render through, so an unconsented clone never reaches the backend
  (it surfaces as a failed take).
- **`addVoiceover`** (`director-api.ts`) additionally refuses up-front with a clear
  message when `voiceRef` names an unconsented clone — the Director-path analog of
  a server route refusing to activate an unconsented profile.
- **Policy for unknown refs:** a reference the registry never minted (e.g. a
  built-in speaker id, or an undefined ref) is **allowed** — the gate governs only
  the clones it created. In this app the only way to obtain a clone reference is the
  Voiceover panel's upload, which now always registers a `pending` profile first, so
  every clone is gated.

### Note on the clone endpoint

`/api/tts/clone-voice` is an **external backend service** (Python FastAPI), not a
Next.js route in this repo, so it cannot be gated from here. The gate is therefore
enforced at the single app-side chokepoint all clone usage funnels through
(above). If/when the clone endpoint is brought in-repo, it should also refuse to
mint a usable clone without an on-record consent — the registry is the contract.

### Data handling

Consent data is sensitive and stored **minimally** (phrase + who/when + a short
transcript for audit — never the raw audio) and **locally** (`byorn-voice-consent`
in localStorage, like the other client stores). It is **deletable**: `removeProfile`
hard-deletes, and `revokeProfileConsent` tombstones + immediately disables. Revoke =
delete the grant.

### Director verbs (consent grant is UI-only)

- `getVoiceProfiles` (read-only, whitelisted in `agent.ts`) — the agent can SEE
  each clone's consent status to tell the user what's blocking a clone.
- `revokeVoiceConsent({ profileId })` — the agent can revoke on request; immediate
  disable.
- **There is NO grant verb.** Consent is a deliberate human act (record your own
  voice reading the phrase), captured in the Voiceover panel — the agent must never
  fabricate it.

### UI

The Voiceover panel (`components/editor/panels/assets/views/voiceover.tsx`): an
uploaded clone enters a **"Consent required"** state showing the exact phrase to
read; the speaker uploads a consent recording; on verification the clone flips to
**"Cloned (consented)"** and becomes usable. Remove/Cancel revokes it.

---

## Gate 2 — Hero-shot approval (`approveHeroShot`)

The human approves a specific shot's take as THE hero.

- **Effect:** selects that take active (the approval choice, mirroring
  `chooseTake`); folds the rationale into the durable brief (prompt-facing memory);
  and checkpoints a `hero-shot` entry into the Bible's **approvals ledger**
  referencing `{ slotId, takeId, mediaId }`, so the manifest/proposals/consistency
  can treat it as the approved hero.
- **Args:** `slotId`, optional `takeId`/`index` (else the active/most-recent-ready
  take), optional `rationale`.
- **Rejection records nothing permanent** — it is simply NOT calling the verb.

## Gate 3 — Final-cut approval (`approveFinalCut`)

The human's sign-off before export/render finalization.

- **Effect:** records a `final-cut` approval + a summary of what shipped (shot
  count + duration, or a caller summary) into the Bible (approvals ledger + brief
  note).
- **Soft gate — never a hard block.** The Director's `export` verb notes in its
  result when no final-cut approval is on record (nudging `approveFinalCut` next
  time) but still exports. **A human triggering Export manually through the UI IS
  the approval** — that path is never nagged or blocked.

### Where approvals live in the Bible

Both gates write to `ProjectBible.approvals` — a bounded (`MAX_BIBLE_APPROVALS =
30`), append-only, newest-last ledger (`BibleApproval` in `types/project.ts`). Like
`decisions`, it **rides through checkpoints and reverts** rather than being part of
the revertable creative state: an approval is a recorded fact, not a look to roll
back. `recordBibleApproval` (`project-bible.ts`) appends the entry and checkpoints
the current creative state with a decision note in one write-through, so an
approval is both a durable fact and a revertable point in history. The rationale
also lands as a durable **brief note**, so future shots inherit the preference
through the same prompt-block path `chooseTake` uses.

---

## Follow-up A — refresh the live understanding cache after `saveUnderstanding`

`understanding-lookup.ts` keeps a synchronous in-memory cache the Asset Manifest /
proposals read each turn (primed on editor mount). Previously a freshly-persisted
understanding only showed up after a full re-prime. Now `understandAsset`
(`services/search/asset-understanding-service.ts`) calls `cacheUnderstanding(record)`
right after every `saveUnderstanding` (both the reuse re-key path and the fresh
path), so a newly-understood asset is visible to the manifest/proposals without a
reload.

## Follow-up B — route the Understanding style probe into the Bible's `styleBible`

- `styleProbeToStyleBible(probe)` (`project-bible.ts`, pure) maps a `StyleProbe`
  (palette / lens-mood / setting) onto a `StyleBible`.
- `seedStyleBibleFromProbe(editor, probe, { force? })` applies it — **additive and
  checkpointed, and NEVER silently clobbering a human-set look**. If the Bible has
  no `styleBible` (or `force`), the probe is applied and checkpointed. If a
  `styleBible` already exists, the human look is **preserved** and the read is
  recorded as a decision note instead.
- `understanding-lookup.ts` keeps a parallel sync `styleProbeLookup` cache (primed
  / updated / cleared in lockstep with the manifest cache, so Follow-up A refreshes
  it too).
- Director verb `seedStyleFromUnderstanding({ mediaId, force? })` ("the Director
  asks") routes an asset's style read into the Bible via the injected `styleProbe`
  seam (default `styleProbeLookup`, wired in `use-director.ts`). An automatic
  seed at ingest is deferred: the ingest/service layer has no editor handle, matching
  the repo's existing gated-off Understanding-Pass autorun.

---

## Tests

- `lib/director/voice-consent.test.ts` — consent state machine
  (pending→consented→revoked, unusable until consented, re-consent), phrase
  verification, the similarity stub, the store + `assertReferenceUsable`
  enforcement, `captureConsent` (phrase pass/fail, similarity-below-threshold
  block, revoke disables, delete).
- `lib/director/flow-d-gates.test.ts` — `approveHeroShot` / `approveFinalCut` Bible
  write-through (approvals ledger + brief note + take selection), `addVoiceover`
  refusing an unconsented clone (server-route-equivalent) and allowing a consented
  one, `getVoiceProfiles`/`revokeVoiceConsent`, the styleProbe seam incl. the
  no-clobber rule and `force`, the approvals ledger surviving a later checkpoint,
  and catalog registration.
- `lib/director/understanding-lookup.test.ts` — `cacheUnderstanding` (the seam
  Follow-up A calls) refreshing the manifest + style-probe caches in lockstep.

Run from `apps/web`: `bun test && bun run typecheck`.
