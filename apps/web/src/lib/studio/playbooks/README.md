# Generation prompt playbooks

Prompt-engineering playbooks for the AI generation pipeline. These are the
canonical, human-readable source; [`index.ts`](./index.ts) exposes a verbatim
mirror as importable string constants so generation code can inject them into a
system prompt.

## Provenance & license

The two UGC playbooks are reproduced **verbatim** from
[palmier-io/palmier-skills](https://github.com/palmier-io/palmier-skills):

| File | Upstream path |
|---|---|
| [`ugc-photo-prompts.md`](./ugc-photo-prompts.md) | `skills/ugc-photo-prompts/SKILL.md` |
| [`ugc-video-prompts.md`](./ugc-video-prompts.md) | `skills/ugc-video-prompts/SKILL.md` |

Licensed under **Apache-2.0**, Copyright (c) 2025 Palmier. The full license text
is in [`LICENSE`](./LICENSE); the project-wide attribution is in
`THIRD_PARTY_NOTICES.md` at the repository root.

**Changes from upstream:** none to the prose — the `.md` bodies are unmodified.
The only additions are this README, `index.ts` (a generated mirror), and the
`LICENSE` copy. The upstream "Running inside Palmier Pro" sections reference that
app's MCP tools (`get_timeline`, `generate_image`, …); we reuse the prompt-craft,
not the tool calls.

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
