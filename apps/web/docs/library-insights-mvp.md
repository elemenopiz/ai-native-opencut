# Library Insights — MVP brief

> **This is a problem brief, not a design.** It defines *what the feature must do*
> and *what data it has to work with*. It deliberately does **not** prescribe
> layout, components, colors, or interaction patterns — the implementing model
> should design its own UI. Everything under "Data contract" and "Constraints"
> is binding; everything about *how it looks* is open.

## The problem

Byorn runs an **Understanding Pass** over a user's imported media: a paid,
demand-driven vision pass (fires when the Director mounts) that turns each clip
or image into a structured record of *what it is* — a caption, a role belief +
confidence, open-vocabulary tags, faces reconciled against the persona roster,
and a "look" probe (palette / lens-mood / setting). This record grounds every
reel the Director proposes.

**The user never sees any of it.** The only surfacing anywhere in the product is
a single number in Settings → cross-project memory: *"Understood library media:
N clips."* Everything the pass derives — captions, roles, tags, faces, look —
flows silently into the Director's context and is otherwise invisible. Three
concrete consequences:

1. **No trust / no payoff.** A paid step spends credits and reshapes every
   generation, but the user gets a disappearing toast and nothing to look at.
   They can't tell what the AI thinks their footage *is*.
2. **A correction loop exists but is unreachable.** The store already ships
   `confirmRole` / `clearRoleConfirmation` (a human override that permanently
   wins over the inferred role belief) — fully implemented and tested, with
   **no UI to trigger it**. If the pass mislabels a hero shot as b-roll, the
   user currently has no way to fix it.
3. **Actionable signals are lost.** The pass flags recurring **new faces** with
   no persona match — precisely the "want to lock this person for consistency?"
   moment Byorn's seed-lock feature is built for — and nothing acts on it.

## Goal

Give the user a way to **see what the AI understood about their library**, and
to **correct it** where it's wrong. Turn an invisible paid step into visible,
trustworthy value.

This is a **pure UI feature.** All the data already exists and is queryable.
There are **no new model calls, no new endpoints, no credit cost** — it reads
records that were already written and (for corrections) calls store functions
that already exist.

## Functional requirements

**Core (MVP):**

- The user can view, per understood asset, what the pass derived: at minimum the
  caption, the effective role + confidence, the tags, any faces, and the look
  probe. Tie each record to its source media (name/thumbnail) so it's clear
  which clip it describes.
- The user can see an at-a-glance **summary of the whole library** — e.g. how
  many assets are understood vs. total, the distribution of roles, how many
  faces were found and how many mapped to personas, the dominant look. (These
  are examples of useful aggregates; the exact set is the designer's call.)
- The user can **correct an asset's role** — pick the right role from the fixed
  vocabulary and have it stick. This wires the existing `confirmRole` /
  `clearRoleConfirmation` write path. A corrected role must visibly win over the
  inferred one.

**Stretch (strongly desirable, not required for MVP):**

- When the pass found a **new, unlocked face**, let the user lock it as a persona
  in one step (seeds Byorn's persona/seed-lock system). The face record carries
  a reusable `descriptor` and an `anchorFrame` for exactly this.
- Surface **low-confidence** records so the user knows which guesses to check.
- Flag a **stylistic outlier** — an asset whose look diverges from the library's
  dominant look (real data has surfaced e.g. an "anime style" frame among
  otherwise photographic footage).

## Where it lives

The natural home is a new view in the editor's **assets panel**, alongside the
existing sibling views (`captions`, `speakers`, `director`, `settings`) under
`apps/web/src/components/editor/panels/assets/views/`. Whether it's a dedicated
tab, an overlay on the existing media grid, or something else is open — but it
should sit inside that panel system, not a separate page.

## Data contract (binding)

Everything is client-side and local-only. Nothing here touches the network.

**The record** — `AssetUnderstanding`, defined in
`apps/web/src/lib/search/asset-understanding.ts`:

| Field | Meaning |
|---|---|
| `mediaId` | FK to the media asset (join key for name/thumbnail) |
| `caption` | one-line description of what the asset shows |
| `role` | inferred role *belief* — one of `hero`, `product`, `logo`, `face-anchor`, `b-roll`, `screen-rec` (`ASSET_ROLES`) |
| `roleConfidence` | 0–1; `0` means no real belief |
| `roleConfirmed?` | human override; when present it WINS over `role` |
| `tags[]` | open-vocab tags observed across frames |
| `faces[]` | `{ personaMatch?, score, isNew, descriptor?, anchorFrame? }` — `isNew` ⇒ recurring face with no roster match |
| `styleProbe?` | `{ palette?, lensMood?, setting? }` |
| `modelName`, `createdAt` | provenance |

- **Always read the effective role through `effectiveRole(record)`** (returns
  `roleConfirmed ?? role`) — never read `record.role` directly, or a
  confirmation won't be honored.
- A degraded/failed record is `role: "b-roll"` at `roleConfidence: 0` with empty
  tags/faces — the UI must treat confidence `0` as "no real belief," not "0%
  sure it's b-roll."

**Reads** — `apps/web/src/services/search/asset-understanding-store.ts`:

- `getAllUnderstandings(): Promise<AssetUnderstanding[]>`
- `getUnderstanding(mediaId): Promise<AssetUnderstanding | undefined>`
- `listUnderstoodMediaIds(): Promise<string[]>`

There's also a synchronous in-memory cache the Director primes
(`manifestUnderstandingLookup`, `primeUnderstandingCache`,
`getUnderstandingCaptions`) in `apps/web/src/lib/director/understanding-lookup.ts`
— relevant if live updates matter, but `getAllUnderstandings()` is the simple
source of truth for a read view.

**Writes (for corrections)** — same store:

- `confirmRole(mediaId, role): Promise<AssetUnderstanding | undefined>` — set the
  human override.
- `clearRoleConfirmation(mediaId): Promise<AssetUnderstanding | undefined>` —
  hand the effective role back to the inferred belief.
- `reinforceRole(...)` exists but is a usage-signal path — **not** for this UI.

**Persona locking (stretch)** — the persona roster lives in `usePersonaStore`
(`apps/web/src/stores/...`); a locked face reuses the face's `descriptor` as the
persona descriptor and `anchorFrame` as the anchor image.

**Storage detail:** records are in IndexedDB, DB `byorn-asset-understanding`,
object store `understanding`, keyPath `mediaId`. Local to the browser; cleared
via Settings → cross-project memory.

## Constraints

- **No new model calls, no new API routes, no credit cost.** Read existing data;
  for writes, call the existing store functions. If a task seems to need a
  network call, it's out of scope.
- **Handle every state:** loading, empty (nothing understood yet — remember the
  pass is demand-driven and only runs when the Director is opened with credits,
  so a fresh project legitimately has zero records), and degraded records
  (confidence 0, no tags/faces).
- **Roles are a fixed vocabulary** (`ASSET_ROLES`) — the correction control must
  offer exactly those six, no free text.
- **Confidence and raw tags are model guesses.** Prefer presenting confidence in
  plain language over exposing raw percentages to end users; the goal is "this
  is helpful" not "the AI is second-guessing itself."
- **Light and dark mode both** — this is inside the editor, which supports both.
- **Reuse the existing panel/view conventions** in the assets panel rather than
  introducing a parallel system.

## Non-goals

- Re-running or configuring the Understanding Pass (this view only *reflects* it).
- Editing captions, tags, faces, or the look probe (role correction is the only
  write in the MVP).
- Any server-side or cross-device sync — the data is local by design.

## Reference dataset (real, for designing/mocking against)

An actual 8-asset library after the pass (a pastry brand). Useful as a fixture —
note the realistic skew (7 `product`, 1 `hero`), the single unlocked new face,
healthy confidence, and one stylistic outlier ("anime style"):

```json
[
  { "role": "product", "confidence": 0.85, "caption": "A person in a white shirt holds a small fluted pastry on a pink plate over a dark table.", "tags": ["pastry","dessert","hands","plate","food","baking","close-up"], "faces": [], "look": "soft neutral with pink accent · shallow DoF, clean product-style framing · indoor, even lighting" },
  { "role": "product", "confidence": 0.85, "caption": "A hand holds a green fluted pastry on a pink plate against a dark surface.", "tags": ["pastry","hand","plate","green food","dessert","overhead shot"], "faces": [], "look": "muted with green and pink contrast · casual overhead smartphone · tabletop, indoor" },
  { "role": "product", "confidence": 0.85, "caption": "A hand places a decorative flower-shaped pastry onto a pink plate on a dark countertop.", "tags": ["pastry","flower-shaped","plate","hand","food styling","overhead shot"], "faces": [], "look": "soft pastels against dark gray · clean overhead food photography · kitchen counter" },
  { "role": "product", "confidence": 0.85, "caption": "A hand places a flower-shaped pastry onto a pink ceramic plate on a dark countertop.", "tags": ["pastry","dessert","hand","ceramic","food styling","overhead shot"], "faces": [], "look": "muted pastels with dark contrast · clean overhead food photography · soft diffused lighting" },
  { "role": "product", "confidence": 0.92, "caption": "Close-up and overhead shots of flower-shaped baked cookies arranged on a white tray, camera pulling back then pushing in.", "tags": ["cookies","baked goods","tray","overhead shot","close-up","golden brown"], "faces": [], "look": "warm golden browns on cream white · bright natural light, crisp detail · daylight, hard shadows" },
  { "role": "hero", "confidence": 0.85, "caption": "A woman in a white t-shirt eats a chocolate-filled pastry from a pink plate at an outdoor café table.", "tags": ["woman","pastry","chocolate filling","outdoor café","eating","reaction","daytime"], "faces": [{ "isNew": true, "score": 0.9, "descriptor": "young woman, white t-shirt", "anchorFrame": 0 }], "look": "bright natural daylight, warm tones · casual handheld, shallow DoF · outdoor urban café, sunny" },
  { "role": "product", "confidence": 0.85, "caption": "Hands break open a sugar-dusted pastry to reveal a dark filling over a pink plate.", "tags": ["pastry","hands","sugar dusting","filling","close-up","breaking"], "faces": [], "look": "muted with pink accent · shallow depth of field, intimate food detail · indoor tabletop" },
  { "role": "product", "confidence": 0.90, "caption": "A freshly baked flower-shaped bun rests on a ceramic plate beside a steaming cup of tea on a rustic wooden table.", "tags": ["pastry","bread roll","teacup","steam","wooden table","cozy","anime style"], "faces": [], "look": "warm golden tones, soft pastels · shallow DoF, soft bokeh · morning light, sunlit dining area" }
]
```
