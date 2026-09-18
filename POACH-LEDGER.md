# Poach Ledger

One row per shipped poach: what we took, from where, under what license, and
where it landed in Byorn. Licensing details live in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); scouting/decision docs live
in `apps/web/docs/poach/`. Poaches shipped before this ledger existed
(2026-07-13) are recorded in THIRD_PARTY_NOTICES.md only.

| Date | Source | License | What | Kind | Landed in |
|---|---|---|---|---|---|
| 2026-07-13 | [WyattBlue/auto-editor](https://github.com/WyattBlue/auto-editor) | Unlicense | Silence/dead-air removal: max-abs loudness curve → threshold → asymmetric margin (`mutMargin`) → min-run smoothing → multi-label cut/keep/speed chunkify | Algorithm reimplementation (upstream is Nim) | `apps/web/src/lib/auto-cut/` (engine + apply), "Remove silence" clip menu, `removeSilence` Director verb |
| 2026-09-18 | [higgsfield-ai/skills](https://github.com/higgsfield-ai/skills) | MIT | Prompt-engineering guidance (camera/lens/lighting language, motion verbs, don't-redescribe-the-anchor-frame rule for image-to-video/image-to-image, positive-phrasing rewrites for no-negative-prompt models, density-over-length token ceiling) from `higgsfield-generate/references/prompt-engineering.md`, plus the structured multi-shot template (verbatim STYLE descriptor reused per shot, SCENE/MOTION/AUDIO/NEGATIVE shot block) from `higgsfield-video-explainer/references/prompts.md` | Prose adapted (rewritten in Byorn's voice, CLI mechanics dropped, cross-referenced to Byorn's `ConsistencyContext`/`StyleBible` and camera-preset vocabulary) — no code | New `apps/web/src/lib/studio/playbooks/shot-craft.md` playbook + `PROMPT_CRAFT_QUICKREF` in `playbooks/index.ts`; both consumed by the Director's `readPlaybook` verb and by `apps/web/src/app/api/llm/enhance-prompt/route.ts`'s system prompt |
