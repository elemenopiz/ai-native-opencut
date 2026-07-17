# Campaign log — ship-parked-inventory (C1)

Branch: `campaign/ship-parked-inventory` off main @3c7e41c8. Started 2026-07-17.
Objective: queue §1 — every parked delta branch gets a disposition:
merged-to-campaign | kill-list | gated-packet.

## Recon (done, evidence in this session)

Deltas re-derived 2026-07-17 (`git rev-list --count main..<b>`):

| Branch | Δ | Initial call |
|---|---|---|
| integrate/palmier-2026-07-14 | 15 | review per-item; Wave D excluded if product-call |
| fix/credit-audit-money-gated | 6 | GATED — packet only |
| poach/verb-telemetry | 6 | review → merge/kill |
| poach/staged-export-jobid | 5 | review → merge/kill |
| integrate/palmier-wave-a | 4 | diff vs palmier-2026-07-14 → likely kill |
| feat/upscale-backend | 2 | fal-API verify worker → gated packet (migration 0012) |
| feat/beta-gate-models-audio-templates | 2 | inspect → decide |
| poach/{scrub-audio-vu-meter,mcp-project-binding,chroma-luma-lut-check,agent-undo-origin} | 1 ea | review → merge/kill |
| wip/local-ai-session-rescue-2026-07-12 | 1 | ADR-004 frozen → likely kill |
| claude/admiring-goodall-623ae4 | 1 | SUPERSEDED: main has the finally-guard fix in preview/index.tsx; branch adds only reportFromException + unit test → kill w/ note |

Hygiene verified: `fix/project-switch-hardening` @c2a0f815 and
`fix/b1-text-background-crash` @164fd049 are **exact ancestors of main** (merged, not
held) → genuinely 0-ahead. All other claimed 0-ahead branches confirmed ahead=0
(ahead=0 ⇒ tip is ancestor of main ⇒ landed verbatim, no silent divergence possible):
perf/hevc-passthrough-hw-decode, perf/export-decode-tier, fix/scope-playback-perf,
poach/subtitle-import, poach/keyframe-clipboard, feat/director-context,
feat/director-critic-adapter, feat/audio-gen-backends, feat/openai-google-models,
axis4-export-bench, archive/virality-score, + all 17 worktree-agent-* branches.

## Plan

1. Review each delta diff myself (L1 reads every diff).
2. Workers: fal-API doc verification (upscale); merge-conflict/battery fixes if needed.
3. Merge keepers → campaign branch; battery (typecheck/lint-no-worse/build/bun test/e2e as touched).
4. Browser-verify user-visible merges from this worktree.
5. Packets: money (fix/credit-audit-money-gated), upscale (migration ⇒ gated).

## Dispositions (running)

| Branch | Disposition | Evidence |
|---|---|---|
| integrate/palmier-2026-07-14 | **merged-to-campaign** @3af26f35 | 3 conflicts resolved (union): e2e-bridge (stores+scrubPlayer), export-button (commitExport gate + HEVC toast), director-api (outcome.downloaded + degradationNote). Wave D (keyframe-verbs/ElevenLabs) was never built — not on branch, nothing to exclude. Battery: typecheck 0; lint 347e/225w == main baseline; bun test 1846 pass / 14 fail, ALL 14 shown pre-existing or order-dependent (see below). |
| poach/verb-telemetry | merged via palmier-15 | commits f1b98315+b729915c contained in merge; kill branch after campaign lands |
| poach/staged-export-jobid | merged via palmier-15 | 4224682b contained; kill after landing |
| poach/scrub-audio-vu-meter | merged via palmier-15 | 086c258d contained; kill after landing |
| poach/mcp-project-binding | merged via palmier-15 | 4b0d3973 contained; kill after landing |
| poach/chroma-luma-lut-check | merged via palmier-15 | 08bfca01 contained; kill after landing |
| poach/agent-undo-origin | merged via palmier-15 | 1215e783 contained; kill after landing |
| integrate/palmier-wave-a | **kill-list** | strict subset of palmier-15 (shared shas 1215e783/4b0d3973; merge commits patch-id-match 9b44d906) |
| feat/beta-gate-models-audio-templates | **kill-list** | net-zero: fc539d64 + its own revert 382a0e5c ⇒ `git diff main...branch` empty |
| wip/local-ai-session-rescue-2026-07-12 | **kill-list** (doc salvaged) | ADR-004 frozen; only durable artifact `opencut-fork-network-sweep-2026-07-12.md` salvaged @399aa759 |
| claude/admiring-goodall-623ae4 | **kill-list** | main's preview/index.tsx already has the finally-guard fix; branch remainder = reportFromException wiring + unit test only (optional tiny queue row) |
| fix/credit-audit-money-gated | **gated-packet** (below) | NOT merged — money floor |
| feat/upscale-backend | **gated-packet** (below) | NOT merged — migration 0012; fal APIs now verified |
| all 0-ahead branches | **kill-list** | ahead=0 ⇒ tip is ancestor of main ⇒ landed verbatim. Incl. fix/project-switch-hardening @c2a0f815 and fix/b1-text-background-crash @164fd049 (both exact ancestors of main — the "held" memories are stale, they landed). 17 worktree-agent-* branches all ahead=0. |

### Test-failure triage (bun test full run, worktree)

14 fails, none merge-caused:
- 10× generateProxyOffThread (proxy-encoder-controller.test.ts): pass in isolation
  in this worktree ⇒ order-dependent (known bun mock.module leak class).
- 2× polar/webhook signature: fail identically on main checkout ⇒ pre-existing.
- 1× recordMcpEvent: passes in isolation ⇒ order-dependent.
- 1× route-protection "every API route classified": fails identically on main —
  pre-existing defect: `studio/upload-url/route.ts` session-gated but missing from
  SWEEP table. → queue row.

## Gated packet 1 — MONEY: fix/credit-audit-money-gated (Δ6, 208 behind main)

DO NOT MERGE without user review. Per-commit:
1. `5215c767` audit #6 — server-side validation of client-supplied duration/count;
   video priced by resolution (closes client-dictates-price hole).
2. `0bb42a62` audit #7 — explicit worst-case reserve for routed stills;
   settle>hold clamps loudly instead of silently minting credit.
3. `5ce01de3` audit #8 — persona batch-still fetch gated on 402.
4. `29ecc6d1` audit #9 — grant CLI: unique per-invocation nonce key so repeat
   grants apply; `--key` opt-in idempotency; NO-OP reported loudly. Verified
   against local Postgres in-commit.
5. `69f34677` backlog #14 — persona-still render moved behind async job pattern:
   BOTH holds reserved before any provider work (402 refunds everything, burns
   nothing); 20–60s render moved post-response via new `lib/run-after.ts`;
   crash backstop via settle-aware sweep. Poll contract preserved (jobId=takeId).
6. `822ea00c` tests — sweep-level settle-vs-release interleave regression (the
   #3-MED race) + deferred-job backstop; driven against real Postgres.

Files: generate/route.ts (+453/-heavy), ledger.ts, cost-table.ts, grant-credits.ts,
poll route, personas still route, promote route, run-after.ts (new), 4 test files.
RISKS: 208 commits behind — generate/route.ts has since been heavily reworked on
main (board/takes unification, 402 sentinel, resume-poll orphan routing). Expect a
substantial conflict/rebase pass; the reserve→job→poll→settle refactor (#14) must
be re-reconciled with main's current generate flow, not just textually merged.
Recommend: user approves intent per-commit, then a dedicated gated session rebases
onto main with the money tests as the acceptance harness.

## Gated packet 2 — UPSCALE: feat/upscale-backend (Δ2, 106 behind main)

DO NOT MERGE without user gate (contains migration 0012).
- What: tiered fal.ai upscale, video (Topaz default / SeedVR2 / ByteDance) +
  image (Clarity / Real-ESRGAN); routes `takes/[takeId]/upscale` +
  `studio/upscale/[jobId]`; cost-table entries; env: FAL_KEY funds all, 5
  optional per-model slug overrides.
- Migration 0012_takes_backend_and_upscale.sql: two NULLABLE additive columns on
  `takes` (`backend_id`, `kind`), IF-NOT-EXISTS idempotent, documented manual
  rollback, no backfill/rewrite. Numbering still valid (main tops out at 0011).
- **fal API verification (2026-07-17, against live fal.ai model pages + OpenAPI
  schemas): ALL 5 endpoints exist unchanged and all 5 adapters would work
  as-coded.** Queue URL shape confirmed full-model-path (the code's own
  "UNVERIFIED" caveat is resolved — its convention is correct). Input/output
  field names, types, enums all match.
- One actionable gap: Topaz + Clarity cap `upscale_factor` at 4 server-side;
  adapters don't clamp `targetScale` (Topaz header wrongly advertises 8×). >4
  ⇒ fal 422, surfaced as failed job (caught, not a crash) — one-line clamp
  recommended pre-merge.
- Merge feasibility (merge-tree dry run vs main): ~10 conflicting files —
  migrations journal, route-protection test, cost-table(+test), rate-limit,
  backends index/register-all/types/cost, env/web.ts. Small, mechanical.
- Recommended sequence on approval: worker rebases + clamp fix → battery →
  user applies migration → FAL_KEY funded → verify one real upscale.

## Final battery + verification (2026-07-17)

Campaign branch battery (worktree, off main @3c7e41c8 + palmier merge):
- `bun run typecheck` — exit 0.
- `bun run lint` — 347 errors / 225 warnings == main baseline exactly (no worse).
- `bun run build` — exit 0, BUILD_ID minted.
- `bun test` — 1846 pass / 14 fail; all 14 triaged pre-existing or order-dependent
  (isolation + main-baseline evidence in Dispositions section). Zero merge-caused.
- e2e suite NOT run (budget; requires a second full `build:e2e`). Remainder item.

Browser verification (tier: **verified locally**, smoke depth) — worktree dev
server on :3105, real Chromium:
- Editor loads a fresh project with the merge applied; zero console errors.
- VU meter canvas mounted in the timeline toolbar (aria-label "Timeline VU
  meter — click the red strip to clear a clip indicator").
- E2E bridge exposes BOTH union-merged seams live: `scrubPlayer` (branch) and
  `projectScopedStores` (main) — the conflict resolution verified at runtime.
- Grain-scheduling on real audio + chroma visual spot-check not re-driven
  (verified 07-14 on the branch pre-merge; B3 hands-on covers chroma).
- Gotchas hit + handled: react-scan overlay intercepts clicks (disable via
  `window.reactScan({enabled:false})` + reload), MobileGate on navigate.

## Post-main-merge battery (tip after merging main @82f16d0e, 2026-07-17)

- Merge of main into campaign @3d63c737: clean, zero conflicts.
- typecheck exit 0 · lint 347e/225w == baseline · `bun run build` exit 0 ·
  `bun run build:e2e` exit 0.
- `bun test`: 1852 pass / 13 fail — same known set as before (10 proxy
  order-dependent, BUG15 route-protection, BUG16 polar ×2), zero merge-caused;
  recordMcpEvent flake green this run; main's new auth-form tests pass.
- **e2e (`test:e2e`, ×2 runs, identical results): 2 passed (incl. pitch-stretch
  real-WASM audio path), 2 failed, 3 skipped.**
  - happy-path main journey: FAILS with the editor hard-redirected to /signup at
    Stage 2 (page snapshot in test-results = signup form) — the exact BUG12
    anon-401 redirect race, documented failing on CLEAN MAIN by C12's worker
    (see queue BUG12 row); C13's fix lands on newer main (@fa603a7a), not on
    this tip. NOT merge-caused: failure precedes the generate/export stages my
    merge touched, and the export assertion never executed.
  - auth-flow (serial, 4 tests): first test stuck on /signup after submit
    (63× URL poll) = the known Upstash-unreachable signup failure in this
    sandbox; its 3 serial followers auto-skip. Pre-existing, not merge-caused.
  - Baseline basis: documentation-based (queue BUG12 row = C12 clean-main repro
    + L0's sandbox-known-reds note), not a fresh main-side e2e run.

## Remainder (explicit, for L0)

1. e2e suite run (`build:e2e` + `test:e2e`) on the campaign branch before it
   merges to main — export path touched (commitExport gate).
2. Scrub-audio real-WAV re-drive post-merge (optional; pre-merge verified).
3. Queue rows discovered: (a) route-protection test red on main —
   `studio/upload-url/route.ts` session-gated but missing from SWEEP table;
   (b) polar/webhook signature tests red on main (2 tests, pre-existing);
   (c) optional: port reportFromException + render-guard unit test from
   claude/admiring-goodall-623ae4 before killing it.
