# Campaign C8 — director-intel (2026-07-17)

Branch: `campaign/director-intel` off main @259683ee.
Territory (exclusive): `apps/web/src/lib/director/**` internals — prompts, context
manifest (asset-manifest/understanding-lookup/agent digest), critic (vision-critic,
take-critic-adapter, cross-project-memory), verb-adapter internals — plus their tests.
OFF-LIMITS: `tool-catalog.ts` + `director-api.ts` SURFACE (C3 landed there today; behavior
extends via internals only — a genuinely-required catalog change STOPS that item),
`lib/studio`, `app/api/**`, `stores/*` (read-only imports OK), money/credits, migrations,
`package.json`.

## Objective (ladder card C8, priority order)

1. **Audit tail** — re-derive Tier 2/4 open items of the 2026-07-13 context-gap audit
   against CURRENT code (3 Tier-1 bundles landed @9a1fcd76/@baf15b0b/@6ec49c2a; heavy
   director-adjacent churn landed today). Deliverable: precise finding doc.
2. **Beat-grid/LUFS audio grounding** — surface existing beat-grid (`stores/beat-grid-store.ts`,
   on-demand, single-grid) + loudness data into the Director's ambient context for audio
   assets. Surface-when-present ONLY — no new ingestion/analysis triggered, zero bytes when
   absent (ORIENTATION-MISMATCH facet precedent in `asset-manifest.ts`).
3. **Critic sharpening** — Tier-4 open finding: `CriticVerdict` is transient/inline;
   reject/reroll history never persisted to inform later generations. Extend verdict
   quality + memory via critic internals/adapter.
4. **Verb-adapter defaults regression tests** — sweep for the undefined-clobbers-defaults
   bug class (auto-cut incident); pin correct default-merge behavior with tests.

## Status table (records ONLY what has happened — L0 verifies every sha)

| Part | Worker | Branch @ tip | Status |
|---|---|---|---|
| 1 · tail finding doc | W1 (sonnet) | task/c8-tail-doc @79d64c22 | merged @6a7bfa0d |
| 2 · audio grounding + Tier-2 digest timing | W2 (sonnet) | task/c8-audio-grounding @bd4aa52f | merged @c2e72c22; wiring applied @a8192df8 |
| 3 · critic sharpening | W3 (sonnet) | task/c8-critic @00ebc816 | merged @ce3782bf; wiring applied @a8192df8 |
| 4 · defaults regression sweep | W4 (sonnet) | task/c8-adapter-defaults @951dd9bc | merged @dac5f8a9 |

Campaign tip: **a8192df8** (off main @259683ee). Battery on tip (deps installed +
env.local copied in — both gitignored, uncommitted): typecheck 0 · lint 344e/225w
(≤ ~347 baseline) · build 0 · `bun test src/lib/director/` 470 pass / 1 skip / 0 fail
(skip = W4's documented buildSpec out-of-territory finding) · auto-review canary 11/0.

## Item verdicts (tier: merged; context-plumbing verified via unit tests, not pixels)

1. **Audit tail (W1)** — `apps/web/docs/director-context-tail-2026-07-17.md`, 14-item
   Tier 2/3/4 verdict table vs post-churn tree. Nothing silently fixed by today's churn.
   Recommended in-territory next slice: T2.1 (done here), T4.6 segmentShots capture,
   T4.1-3 VLM prompt/schema self-report (all (c), prep-only). Surface-gated rows
   (T2.3-6, T4.5/7/8) queued below — need director-api/tool-catalog, frozen this campaign.
2. **Beat-grid/LUFS grounding (W2 + wiring)** — `reelSummary()` now emits per-slot
   `@Ns+Ns` timing (T2.1 closed); `buildLibraryManifest` gains optional `AssetBeatGridLookup`
   → `♫ ...bpm/beats/energy` digest facet; `director-api.buildManifest` reads
   `useBeatGridStore.getState().grid`. Zero bytes when no grid (pinned by regression test).
   Never triggers analysis. **LUFS: NOT surfaced** — `useLoudnessNormalization` is
   component-local `useState` (no store/persistence, whole-mix not per-asset) → filed as
   queue row F3-LUFS.
3. **Critic sharpening (W3 + wiring)** — bounded in-memory per-session verdict ledger
   (`recordVerdict`/`recentVerdictsFor`, capped 5/key × 200 keys); additive `FailureAxis`
   enum + `classifyFailureAxes`; feed-forward folded into `buildCriticUserBlocks` and
   `pickBest`. `agent.autoReviewSlot` now records every verdict. Zero new model calls.
   Persist-to-Take (T4.5) is surface-gated → queued.
4. **Defaults sweep (W4)** — `adapter-defaults.test.ts` (578 lines): all in-territory
   verb adapters SAFE (auto-cut `resolveOptions` fix pinned; reviseProposalShot/
   applyBriefPatch/split/setStartTime proven). One out-of-territory VULN: `buildSpec`
   (director-api.ts) uses a raw `{...DEFAULTS, ...overrides}` spread — explicit-undefined
   `mode`/`resolution`/`orientation` clobbers the literal default. NOT prod-reachable today
   (sole caller `tool-catalog.asSpecOverride` uses a key-omission guard) → skipped test +
   queue row.

## File-cluster partition (no two workers share a file)

- W1: `apps/web/docs/director-context-tail-2026-07-17.md` (new doc) only.
- W2: `asset-manifest.ts`, `understanding-lookup.ts`, `agent.ts` + `asset-manifest.test.ts`,
  `understanding-lookup.test.ts`, `director-manifest.test.ts`, `agent*.test.ts`.
- W3: `vision-critic.ts`, `take-critic-adapter.ts`, `cross-project-memory.ts` + their tests
  (`vision-critic.test.ts`, `director-critic-adapter.test.ts`, `cross-project-memory.test.ts`).
- W4: NEW `apps/web/src/lib/director/adapter-defaults.test.ts` only.

## Verify plan

Per-worker: typecheck 0 + targeted `bun test` green. Campaign tip after serial merges:
full battery from `apps/web` (typecheck / lint-no-worse / build / bun test vs known
pre-existing fail set — see queue C8 chore row: 44 pre-existing fails on main).
Item 2/3 are context-plumbing (agent-prompt-visible, not pixel-visible) — verification =
unit tests asserting manifest/digest/prompt content, not browser screenshots.

## Queue rows to file (surface-gated / out-of-territory follow-ups)

- **BUG24** — `buildSpec` (director-api.ts:577-590) undefined-clobbers-defaults: raw
  `{ mode:"text-to-video", resolution:"480p", orientation:"portrait", ...overrides }`
  spread; an explicit-undefined key in `overrides` clobbers the literal. Not prod-reachable
  (only caller `tool-catalog.asSpecOverride` key-omission-guards) but `reserveSlot`/
  `storyboard` both funnel through it. Fix = per-key `??` in buildSpec (surface = C3/director-api
  territory). Skipped regression test ready at `adapter-defaults.test.ts:528` to unskip on fix.
- **F3-LUFS** — loudness grounding needs a persistence layer first: `useLoudnessNormalization`
  is component-local `useState`, whole-timeline mix, not per-asset. Surfacing per-asset LUFS
  to the Director requires a store/persisted measurement (stores/* + a lib/audio seam) — larger
  than a manifest read. Owner: whoever holds stores/* + audio.
- **F3-tail surface rows** (from W1 doc §surface-gated, all need director-api/tool-catalog):
  T2.3 transition type/duration into SlotSnapshot (S), T2.4 voiceover/music-bed readability in
  getReel (M), T2.5 slotId-aware getTranscript timeline offsets (M), T2.6 richer Freesound
  fields through defaultResolveMusic (S), T4.5 persist CriticVerdict onto Take (M), T4.7
  searchMedia top-K per asset (M), T4.8 listAssets paging verb (M). Phase-1 prep (T4.6
  segmentShots capture, T4.1-3 VLM self-report) is (c)-class, in-territory for a future C8 wave.

## Ops note for L0

- **W4 built in a STRAY worktree** at `../ai-native-opencut-c8-adapter-defaults` (outside
  `.claude/worktrees/`). Branch `task/c8-adapter-defaults` @951dd9bc is clean and merged;
  the stray worktree needs `git worktree remove` cleanup.
- Battery required `bun install --frozen-lockfile` (worktree had no node_modules) + copying
  the checkout's gitignored `apps/web/.env.local` in for the build's env-validation (ZodError
  on `/_not-found` otherwise). Both artifacts are gitignored/uncommitted.

## Log

- 2026-07-17: campaign branch cut @259683ee; log committed; W1–W4 dispatched.
- 2026-07-17: monitor died mid-run; resumed by L0. All 4 workers had committed. Verified
  lineage (W2/W3/W4 merge-base 259683ee, W1 doc-only @99ab432c ancestor — no stray lineage).
  Reviewed each diff; merged all 4 into campaign branch conflict-free; applied W2 + W3 wiring
  diffs @a8192df8; battery green on tip a8192df8.
