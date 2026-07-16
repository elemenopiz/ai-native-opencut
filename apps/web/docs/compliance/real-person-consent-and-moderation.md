# Real-Person Likeness: Consent & Moderation Architecture

**Status:** Working draft · 2026-07-15
**Owner:** Byorn founder
**Purpose:** (1) the safety/consent infrastructure Byorn needs to responsibly support
real people in generated video, and (2) the compliance deliverable required to pitch
BytePlus (and any other AI-video provider) for authorized real-human generation access.

> This doc is **provider-agnostic**. It is worth building regardless of which backend
> ends up powering real-face VFX (BytePlus Seedance verified route, Runway, Kling, or a
> future self-hosted model). It is also the single most important artifact for an
> enterprise-access pitch: it demonstrates you are a good actor who has already designed
> the consent + abuse-prevention loop, rather than someone asking to have a safety filter
> switched off.

---

## 0. Context you must not skip

ByteDance **suspended** Seedance 2.0's open real-person reference feature on
**2026-02-10** after it was shown cloning a voice from a single photo, and re-gated it
behind live verification. As of this writing the provider is in an actively-restricting
posture on exactly this capability. **Before investing in a BytePlus-specific pitch,
confirm via BytePlus enterprise sales what real-human access is currently offered on the
*international* ModelArk surface (not just China's Jimeng/Doubao apps).** Design the
system below to be portable so a "no / not yet" from BytePlus doesn't strand the product.

---

## 1. Principle: consent is a credential, not a checkbox

The whole reason the filter exists is that **consent cannot be verified at the pixel
level** — you cannot look at a JPEG and know the subject agreed. So Byorn must treat an
authorized likeness as a *credential attached to a verified identity*, mirroring the
provider model (verified subject → `asset_id` → only that id may appear in output).

Two tiers, gated by strength of proof:

| Tier | Proof | What it unlocks |
|------|-------|-----------------|
| **T0 — Synthetic / no real person** | none | AI-generated characters, b-roll without identifiable people. Always allowed. |
| **T1 — Verified real person** | live verification of the subject + logged consent | that specific person's likeness in generation, referenced by a Byorn-issued `personaId` mapped to the provider's verified `asset_id`. |

There is deliberately **no "upload a raw face JPEG and generate" path.** That path is the
liability the provider is offloading; Byorn must not re-open it, and must not circumvent
any provider face filter (an explicit AUP violation that risks all API access).

---

## 2. Consent & verification flow (T1)

Maps directly onto Byorn's existing persona system (`persona-manager`,
`intakeReferences`, seed-lock) — the persona *becomes* the consent record.

1. **Initiate.** User creates a persona and marks it "real person (me / authorized actor)."
2. **Verify the subject.** Byorn requests a provider verification session (e.g. BytePlus
   ModelArk authorization QR / liveness). The **actual subject** scans it and completes
   live capture on their own device. If no provider verification is available for the
   chosen backend, Byorn requires, at minimum: (a) a live selfie-video capture by the
   subject, and (b) an explicit consent attestation naming the persona and permitted
   use. This is weaker than provider liveness and must be labeled as such internally.
3. **Consent record.** Persist, immutably and timestamped: subject verification token,
   attestation text + version, purpose scope, permitted output types, expiration, and a
   **revocation path**. (Per the consent-workflow guidance: record subject, purpose,
   allowed outputs, expiry, revocation.)
4. **Handoff.** Store the provider-issued `asset_id` / `groupId` against the `personaId`.
   Never store or transmit the raw face reference to the generation endpoint once a
   verified asset id exists.
5. **Generate.** Requests that include a real person pass `asset://<asset_id>` (provider
   verified route) — not an image URL. Byorn's `provider-adapter` content[] builder gets
   a branch: real-person persona → asset reference; synthetic → image URL as today.
6. **Revoke.** A subject can revoke; revocation disables future generation with that
   persona and is logged. (Retention/deletion of prior outputs per ToS.)

---

## 3. Moderation layers

Defense in depth. Each layer is independently valuable and independently demoable to a
compliance reviewer.

### 3a. Input screening (before any generation)
- **Public-figure / celebrity detection** on any real-person reference — block generation
  of a recognizable public figure even if a "consent" box was checked. (Face-embedding
  match against a public-figure set; conservative threshold; human-review queue on hits.)
- **NSFW / minor detection** on reference images and video frames — hard block.
- Reject real-person references that lack a T1 verification record.

### 3b. Prompt screening (text → intent)
- Toxicity / harassment classifier on the prompt.
- Blocklist for non-consensual, sexual-deepfake, violence-against-identifiable-person,
  and impersonation intents (e.g. "make <persona> say/do <harmful>").
- Named-person extraction: a prompt naming a real public individual + a real-person
  reference is a high-risk combination → block or human review.

### 3c. Output screening (after generation, before delivery/export)
- NSFW / harmful-content classifier on output frames.
- Optional: re-run public-figure detection on output (providers do this and can flag
  retroactively — mirror it so you're not surprised).
- **Provenance:** attach C2PA / visible "AI-generated" labeling to real-person output
  (aligns with the AI-transparency regulations driving these provider restrictions).

### 3d. Audit & retention
- Immutable audit log per generation: `personaId`, verification token ref, prompt,
  backend, moderation verdicts, output hash, timestamp, requesting user.
- Retention + deletion policy for face data and outputs; honor revocation and deletion
  requests.

---

## 4. Terms of Service hooks (draft language to formalize with counsel)
- User warrants they are the subject or hold documented rights/consent for any real
  person; Byorn may require verification.
- Prohibited: public figures without authorization, non-consensual/sexual/defamatory
  content, impersonation, and any attempt to bypass moderation or provider filters.
- Byorn may suspend accounts and delete content on violation; subjects may revoke consent.
- Clear AI-generated-content disclosure obligations for published output.

> **Not legal advice** — this section is a scoping draft for a lawyer to turn into
> enforceable ToS + a Personal Information Processing / consent notice.

---

## 5. BytePlus enterprise pitch checklist

Only after §§1–4 exist as a *working prototype* (synthetic faces are fine for the demo —
do **not** demo a filter bypass):

- [ ] **Legal entity** formed (LLC/C-Corp) with business registration docs.
- [ ] **Working prototype** proving UX + generation pipeline (Runway/Kling or synthetic
      faces on Seedance) with a polished recorded demo.
- [ ] **This moderation doc** as the compliance narrative.
- [ ] **Narrow, low-risk B2B use case** framed for a compliance team, e.g. *"VFX tooling
      for indie filmmakers to transform footage of their own consenting actors"* — not
      *"anyone uploads any face."*
- [ ] **Discovery first:** contact ModelArk enterprise sales, state you're a registered
      business building a B2B video app, and ask specifically what **real-human / verified
      asset** access is currently available on the international surface and what the
      verification + volume + region requirements are. **Confirm availability before
      building the full deck.**

---

## 6. Immediate vs. endgame

- **Endgame (weeks–quarter):** verified real-human route on Seedance via BytePlus
  enterprise access — pending confirmation it's currently offered internationally.
- **Immediate (days):** real-footage VFX on **Runway Aleph / Kling** under their
  rights-based policies (no liveness gate). Runway is already wired in
  `apps/web/src/lib/studio/backends/video/runway.ts` (needs `RUNWAY_API_KEY` + routing).
  This unblocks the product now and produces the very prototype the enterprise pitch
  requires.

**The moderation layer (§§1–4) is the durable moat and applies to every one of these
backends. Build it first; it is never wasted work.**
