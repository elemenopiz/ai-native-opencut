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

| Part | Worker | Branch | Status |
|---|---|---|---|
| 1 · tail finding doc | W1 (sonnet) | task/c8-tail-doc | dispatched |
| 2 · audio grounding + Tier-2 digest timing | W2 (sonnet) | task/c8-audio-grounding | dispatched |
| 3 · critic sharpening | W3 (sonnet) | task/c8-critic | dispatched |
| 4 · defaults regression sweep | W4 (sonnet) | task/c8-adapter-defaults | dispatched |

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

## Log

- 2026-07-17: campaign branch cut @259683ee; log committed; W1–W4 dispatch next.
