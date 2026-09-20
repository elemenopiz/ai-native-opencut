# Generation prompt playbooks

Prompt-engineering playbooks for the AI generation pipeline. These are the
canonical, human-readable source; [`index.ts`](./index.ts) exposes a verbatim
mirror as importable string constants so generation code can inject them into a
system prompt.

## Provenance & license

Two provenances, two license shapes:

| File | Upstream path | License | Reproduced |
|---|---|---|---|
| [`ugc-photo-prompts.md`](./ugc-photo-prompts.md) | [palmier-io/palmier-skills](https://github.com/palmier-io/palmier-skills) `skills/ugc-photo-prompts/SKILL.md` | Apache-2.0 | **Verbatim** |
| [`ugc-video-prompts.md`](./ugc-video-prompts.md) | [palmier-io/palmier-skills](https://github.com/palmier-io/palmier-skills) `skills/ugc-video-prompts/SKILL.md` | Apache-2.0 | **Verbatim** |
| [`shot-craft.md`](./shot-craft.md) | [higgsfield-ai/skills](https://github.com/higgsfield-ai/skills) `higgsfield-generate/references/prompt-engineering.md` + `higgsfield-video-explainer/references/prompts.md` | MIT | **Adapted** (rewritten in Byorn's own voice — prompt-engineering guidance and the structured shot-block template, not the prose) |

The full attribution for both sources is in `THIRD_PARTY_NOTICES.md` at the
repository root; the shipped poach is logged in `POACH-LEDGER.md`.

**UGC playbooks — changes from upstream:** none to the prose — the `.md` bodies
are unmodified. The only additions are this README, `index.ts` (a generated
mirror), and the `LICENSE` copy (Apache-2.0 full text, required because the
reproduction is verbatim). The upstream "Running inside Palmier Pro" sections
reference that app's MCP tools (`get_timeline`, `generate_image`, …); we reuse
the prompt-craft, not the tool calls.

**`shot-craft` — adapted, not transcribed:** Higgsfield's source is CLI-focused
(`--start-image`, `higgsfield generate create`, …) and MIT-licensed, which
doesn't require verbatim reproduction the way the Apache-2.0 UGC playbooks do.
The craft — camera/lens/lighting vocabulary, motion verbs, the
don't-redescribe-the-anchor-frame rule, the STYLE-token consistency pattern,
the structured shot-block template, and positive-phrasing rewrites — is
rewritten for Byorn's Director and multi-shot reels, with the CLI mechanics
dropped and cross-references to Byorn's real `ConsistencyContext`/`StyleBible`
mechanism and camera-preset vocabulary added. `PROMPT_CRAFT_QUICKREF` in
`index.ts` is a hand-authored condensed form of the same craft, used by
`app/api/llm/enhance-prompt/route.ts`.

## Regenerating `index.ts`

`index.ts` is a generated verbatim mirror of the `.md` bodies. If you edit a
playbook, edit the `.md` and regenerate the string constants (JSON-stringified
so escaping is exact). Do not hand-edit the `content` fields in `index.ts`.

## Why these are here

The 9-slot photo formula and the still-then-animate video pipeline map directly
onto our seed-lock / persona system: the photo playbook is how you produce a
character-consistent **anchor still**, and the video playbook is how you animate
it while holding identity and voice constant across shots. See the idea-poach
implementation doc under `apps/web/docs/poach/` for how this wires into the
Director agent's consistency context.

`shot-craft` is the general layer underneath both: camera/motion prompt craft
for any video shot, and the STYLE-token discipline that keeps the Director's
multi-shot reels — where every shot is its own independent generation call —
reading as one directed piece instead of drifting shot to shot. It's the
craft half of what `ConsistencyContext`/`StyleBible` already wires mechanically.
