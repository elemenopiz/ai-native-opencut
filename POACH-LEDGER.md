# Poach Ledger

One row per shipped poach: what we took, from where, under what license, and
where it landed in Byorn. Licensing details live in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); scouting/decision docs live
in `apps/web/docs/poach/`. Poaches shipped before this ledger existed
(2026-07-13) are recorded in THIRD_PARTY_NOTICES.md only.

| Date | Source | License | What | Kind | Landed in |
|---|---|---|---|---|---|
| 2026-07-13 | [WyattBlue/auto-editor](https://github.com/WyattBlue/auto-editor) | Unlicense | Silence/dead-air removal: max-abs loudness curve → threshold → asymmetric margin (`mutMargin`) → min-run smoothing → multi-label cut/keep/speed chunkify | Algorithm reimplementation (upstream is Nim) | `apps/web/src/lib/auto-cut/` (engine + apply), "Remove silence" clip menu, `removeSilence` Director verb |
