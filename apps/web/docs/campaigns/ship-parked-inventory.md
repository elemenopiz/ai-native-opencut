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

(filled as work completes)
