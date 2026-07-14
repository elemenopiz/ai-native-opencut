# Omniclip (omni-media/omniclip) — competitor doc (OSS WebCodecs browser NLE)

> Source-grounded pass, **2026-07-13**. Every claim below is verified against the live
> repo — `gh repo view omni-media/omniclip`, a full recursive tree dump
> (`git/trees/main?recursive=true`, 559 paths, not truncated), and direct reads of
> `README.md`, `package.json`, `LICENSE`, and ~9 core source files (compositor
> controller, video-export controller + encoder/decoder, collaboration controller,
> transition-manager, animation component, filter-manager, types.ts, state.ts) — plus
> a GitHub code-search for AI-provider strings and a scan of all 20 open non-PR issues.
> Not vendor marketing — this is the only doc in this directory written entirely from
> the competitor's own source code rather than its website. Cross-reference
> [oss-video-editors-poaches.md](oss-video-editors-poaches.md) (same-day sweep that
> flagged omniclip as one of three "direct competitors, track don't poach" — this doc
> is the promised follow-up) and [vyra-mcp-editor-poaches.md](vyra-mcp-editor-poaches.md)
> (structure template; also the closest analog for the "AI drives the timeline" thesis
> omniclip's sibling project gestures at but has not built).

---

## 1. Header

- **Competitor:** Omniclip (`omni-media/omniclip`). Live app: **omniclip.app** — appears
  to be the OSS build itself deployed to Netlify (`npm run build-netlify` in
  `package.json`), not a distinct paid product; the site is a client SPA with no
  marketing/pricing copy found, consistent with the README's "no accounts, everything
  stored on your device."
- **Who built it:** Solo/small-indie, **not VC-backed**. GitHub org "Omni Studio"
  (`omni-media`) has **one public member** — `zenkyuv` / Przemysław Gałęzki (LICENSE
  copyright holder) — no company, blog, or org email on record, 19 org followers, 4
  public repos. The README's own funding ask is personal: *"discord: zenkyu, gmail:
  przemekgg2002@gmail.com."* This reads as a genuine solo-founder OSS project with a
  Discord community, not a funded startup — the "omni-media" org name is not a
  commercial-backing signal, it's just the project's umbrella.
- **When created / activity:** Repo created **2023-11-05**; last push **2026-07-13**
  (same day as this doc — actively maintained, not dormant). **1,436 stars**, 113
  forks, 25 open issues, TypeScript, **license MIT** (verified from the actual
  `LICENSE` file text — note `package.json`'s `"license": "ISC"` field is stale/wrong
  and contradicted by the repo's real license and GitHub's own MIT badge).
- **Architecture at a glance:** Lit web components (`@benev/slate` / `@benev/construct`
  / `@benev/turtle` — the author's own small state/build toolkit) + **PixiJS 7**
  (WebGL2 canvas compositor) + native **WebCodecs** encode/decode in Web Workers +
  **ffmpeg.wasm** for final audio/video muxing + **gl-transitions** for shader
  transitions + **GSAP** for animation timing + **sparrow-rtc** (author's own WebRTC
  lib) + OPFS for serverless peer-to-peer live collaboration.
- **Pricing / monetization:** **Fully free**, no accounts, no cloud processing, no paid
  tier found anywhere (site, repo, issues). Funded by community sponsorship
  (Discord ask), not a business.
- **Last verified:** 2026-07-13, via `gh repo view`, `gh api repos/omni-media/omniclip`,
  recursive tree dump, and direct file reads (paths cited throughout).

## 2. Threat read

**Correction to the earlier same-day survey:** [oss-video-editors-poaches.md](oss-video-editors-poaches.md)
grouped omniclip as a "WebGPU+WebCodecs" browser NLE. The source code says otherwise —
`s/context/controllers/compositor/controller.ts:37` constructs
`new PIXI.Application({width: 1920, height: 1080, backgroundColor: "black", preference: "webgl"})`.
It is a **WebGL2** (via PixiJS 7) compositor with WebCodecs used only for
decode/encode, not WebGPU. Worth fixing in the survey doc.

**The headline finding: omniclip has zero AI or generative features, anywhere.**
GitHub code search over the repo for `openai`, `gpt`, `anthropic`, and `whisper` each
returned **0 results**. The file tree (559 paths, not truncated) has no `ai/`, `llm/`,
`caption/`, `transcri*`, or `generat*` directory. The README's own "To be added" list
is: *Audio Editing (volume), Speech to text, Keyframes* — i.e. even **basic per-clip
volume control and keyframe animation don't exist yet**, let alone anything generative.
Open issue #7 ("[idea] Use speech-to-text for sound timeline") and #24 ("[idea] Text
Based Editing") are unclaimed community suggestions, not roadmap commitments. This is a
pure, well-crafted **manual** NLE — trim, split, transitions, filters, text overlays,
multi-track, export. Nothing about generation, personas, seed-lock, or agent-driven
editing exists in the codebase today.

That said, three things temper "zero threat":

- **It's a genuinely solid manual-editing product**, actively maintained (pushed the
  same day as this research), with real engineering under the hood: worker-based
  per-effect demux/decode with transition-padding lookahead, a clean unidirectional
  state architecture, and a working WebCodecs export pipeline that produces real MP4s.
  As the "craft layer" underneath any AI layer, this is the bar for polish — trim
  precision, snapping, transition smoothness, filter responsiveness.
- **It has one feature we don't obviously have: serverless peer-to-peer live
  collaboration.** `s/context/controllers/collaboration/controller.ts` implements
  real-time multi-editor sessions over WebRTC (`sparrow-rtc`) with no account, no
  server-side project DB, and no signup — host creates a room, shares an invite ID,
  video files are compressed and transferred peer-to-peer with OPFS-backed local
  caching. Our own collaboration ([shared_projects_collaboration] memory) is
  account/DB-backed via a "vc sync layer" — a different, heavier model. Omniclip's
  zero-friction "share a link, no signup" collab mode is worth studying even though our
  architecture is fundamentally different.
- **Watch the sibling project, not the current repo.** The omniclip README teases:
  *"Soon, Omniclip will be powered by **Omni Tools** — a programmatic engine for
  creating timelines from code, automating rendering, and integrating with **AI or
  scripting workflows**."* `omni-media/omnitool` (40 stars, separate repo, explicitly
  "🚧 Work In Progress") is a declarative JS/TS timeline-authoring DSL
  (`o.video(...)`, `o.sequence(...)`, `o.transition.fade(...)`) — a headless engine an
  external process (script, or eventually an LLM agent) could drive. This is
  conceptually adjacent to our own Sprint-2 MCP/agent-drives-the-timeline thesis and to
  Vyra (see [vyra-mcp-editor-poaches.md](vyra-mcp-editor-poaches.md)) — but it is
  **pre-alpha, un-integrated with the main editor, and has no AI wired to it today.**
  If it ships and gets an actual model behind it, the calculus changes; right now it's
  a README aspiration on a WIP repo, nothing more.

**Net:** Omniclip is not a threat on the axis that defines Byorn (generative Takes,
persona/seed-lock, multi-backend AI routing) — it has literally none of it, confirmed
by direct code search, not inference. It *is* a credible reference for manual-editing
polish and for one genuinely novel feature (serverless P2P collab) worth evaluating.
The one thing to keep an eye on is `omnitool` maturing into an AI-drivable layer.

## 3. Priority table

| # | Poach | code\|idea | Relevance | Effort | Tier/Prio |
|---|-------|-----------|-----------|--------|-----------|
| 0 | **Zero generative AI, anywhere — verified by code search, not assumption.** Not a build item; a positioning fact. Every AI-adjacent claim we could make (generation, personas, seed-lock, multi-backend routing, agent-driven edits) is uncontested by this competitor. | — | Highest | S (messaging) | **T1** |
| 1 | **Serverless P2P live collaboration** (`collaboration/controller.ts` + `sparrow-rtc` + OPFS + pre-send video compression) — zero-account, zero-server-DB "share a link" co-editing, architecturally distinct from our account/DB-backed model | code (reference) | Med–High | L | **T2** |
| 2 | **Canvas alignment/snap guidelines** (`compositor/lib/aligning_guidelines.ts`, MIT-licensed sub-module) — drag-to-snap guides against canvas edges and other elements | code | Med | M | **T2** |
| 3 | **Per-effect demux/decode-worker export pipeline** with transition-padding lookahead + nearest-timestamp frame buffering (`video-export/parts/decoder.ts`, `decode_worker.ts`) — reference architecture for hardening our own export path | code (reference only, not verbatim-portable) | Med | M | T3 |
| 4 | **Named in/out animation presets** (GSAP-driven fade/slide/etc library with a duration slider, distinct from true keyframing — `compositor/parts/animation-manager.ts`) — cheap motion polish if we lack it | code/idea | Med (**verify we don't already have this**) | S | T2 |
| 5 | **gl-transitions + GSAP-timeline transition-progress pattern** — **we already ship this** per [opencut-ecosystem-poaches.md] ("transitions surface FIXED in-house @edf1bdf4"). Confirm parity, don't rebuild. | idea (parity check) | — | S | **T1** |
| 6 | **Export preset matrix** — clean small `AspectRatio × Standard` cross (`16/9 · 1/1 · 4/3 · 9/16 · 3/2 · 21/9` × `4k/2k/1080p/720p/480p`) in `context/types.ts` — worth mirroring if our export UI is thinner | idea | Low–Med | S | T3 |
| 7 | **`omnitool` declarative timeline DSL** — watch item, not a build. Pre-alpha sibling repo positioned as future "AI or scripting workflows" substrate; re-check in a few months for whether an actual model gets wired in | idea (watch) | Med (horizon risk) | — | **T2 (watch)** |
| 8 | **ffmpeg.wasm final-mux helper** (`video-export/helpers/FFmpegHelper/helper.ts` — merges raw H.264 elementary stream + separately-extracted audio into MP4) — reference only; our own export was already machine-verified frame-exact ([verify_lane_export_sanity] memory), so low urgency | code (reference) | Low | S | T3 |

`S`=hours · `M`=1–3 days · `L`=1–2 weeks. `T1`=close/can't-cede (mostly messaging here)
· `T2`=credibility/feature gap worth closing · `T3`=nice-to-have reference material.

## 4. How "zero AI" was verified (methodology, not vendor claim)

Unlike Vyra (closed SaaS, verified from marketing copy), omniclip is MIT and fully
public, so this claim is checked directly rather than inferred:

1. **Full tree scan.** `gh api repos/omni-media/omniclip/git/trees/main?recursive=true`
   returned 559 paths, `"truncated": false`. Grepping the full path list for
   `ai|gpt|openai|anthropic|generat|whisper|caption|subtitle|transcri` produced zero
   real hits (the only substring matches were `main.ts` and `utils/wait.ts`).
2. **Code search.** `gh api "search/code?q=repo:omni-media/omniclip+<term>"` for
   `openai`, `gpt`, `anthropic`, `whisper` each returned `"total_count": 0`.
3. **README's own admission.** The "To be added" section lists *Audio Editing, Speech
   to text, Keyframes* — the maintainer's own roadmap confirms these aren't built,
   speech-to-text included.
4. **Open issues.** Of 20 open non-PR issues, exactly two gesture at
   AI/NLP-adjacent ideas (#7 speech-to-text for the sound timeline, #24 text-based
   editing) — both are unclaimed community suggestions, not in-progress work, and
   neither is about generation (they're about *transcribing existing footage*, not
   creating new content).
5. **`types.ts` confirms no generative data model.** `AnyEffect` is a closed union of
   `VideoEffect | AudioEffect | TextEffect | ImageEffect`, each pointing at a
   `file_hash` into locally-imported media. There is no effect kind, state field, or
   controller for an AI-generated/derived clip, no versioning/takes concept, and no
   provider/backend field anywhere in `State`.

This is about as close to a definitive negative as open-source verification gets.

## 5. Per-poach detail

### 5.0 Zero generative AI — the fact to lead with (idea, T1)

Nothing to build. The action is rhetorical: when comparing Byorn to "other browser
NLEs," omniclip is the clean baseline for "well-built manual editor, zero AI" — useful
as a contrast point precisely because it's good at what it does and still has nothing
on our axis. Don't strawman it; it's a legitimate, actively-maintained free tool. The
honest framing is "omniclip proves you can be free/private/high-quality *and* have no
generative layer — Byorn is the same free/private/high-quality manual-editing core
*plus* the generative layer they don't have."

### 5.1 Serverless P2P live collaboration (code, T2)

**What it does.** `Collaboration.createRoom()` (`collaboration/controller.ts:42`) spins
up a WebRTC host via `sparrow-rtc` (the author's own signaling/data-channel library),
sends the full app state to each joining peer over a reliable data channel, and
broadcasts subsequent actions (`broadcastAction`) the same way. Large media files are
compressed (`Compressor`) before P2P transfer and cached locally via
`OPFSManager`/`opfs-tools`. No account, no server-side project storage — the host's
browser tab *is* the server for the session's lifetime; `toggleLock()` lets the host
close the room to new joiners, `kick()` disconnects a peer.

**Why it's worth studying, not copying wholesale.** Our own collaboration model is
account/DB-backed (invite-by-email, roles, clone/branch — see
[shared_projects_collaboration] memory) — a heavier, more persistent, multi-session
model that P2P WebRTC can't replicate (no durability once all peers leave, no
async/offline collaborators). But the "zero-friction, share-a-link, no-signup"
lightweight session mode is a genuinely different product surface — e.g. a "quick
co-watch/quick-edit" mode alongside the durable project-based one. Effort is large (a
whole new transport + conflict-resolution path, likely last-write-wins broadcast rather
than real CRDT merge based on the code shown), so this is a considered feature bet, not
a quick win.

### 5.2 Canvas alignment/snap guidelines (code, T2)

`compositor/lib/aligning_guidelines.ts` (with its own bundled `license.md`, i.e. it's
itself a vendored MIT library) drives snap-to-edge / snap-to-object guides during
canvas drag operations (`init_guidelines()`, `on_object_move_or_scale` in
`compositor/controller.ts:308-323`). This is Pixi-coupled, so a literal port needs a
WebGL2-native rewrite rather than a drop-in copy, but the interaction model (guideline
rect sized to canvas, `ignoreObjTypes`/`pickObjTypes` filtering, live guideline redraw
on drag) is a clean, small reference for a polish feature if our own canvas editor
lacks precise snapping.

### 5.3 Per-effect worker demux/decode pipeline (code reference, T3)

`video-export/parts/decoder.ts` spins up one dedicated `decode_worker.js` per video
effect, demuxes only the needed byte range (via `web-demuxer`/`mp4box`) with an
explicit lookahead/lookbehind pad equal to the effect's transition duration
(`effect.start - incoming` to `effect.end + outgoing`), and buffers decoded
`VideoFrame`s in a `Map` keyed by generated id, resolved by nearest-timestamp lookup
during composition. It's a clean answer to "how do you keep transitions frame-accurate
without decoding the whole file" — worth a read if our own export pipeline ever needs
transition-boundary hardening, but it's architecture to learn from, not code to lift
(tightly coupled to their Compositor/Media/Actions classes).

### 5.4 Named in/out animation presets (code/idea, T2 — verify first)

`compositor/parts/animation-manager.ts` + the `omni-anim` component implement a small
library of named entrance/exit presets (`animationIn`, `animationOut` arrays, e.g.
`fade-in`, driven by GSAP) applied per video/image effect with a duration slider
(520ms–clip length, `omni-anim/component.ts:134-157`). This is explicitly **not**
general keyframing — it's canned presets, and the README lists real "Keyframes" as
still unbuilt on their side too. Cheap to add (S effort) if Byorn doesn't already have
an equivalent quick-motion feature; check before building since it may already exist.

### 5.5 Transitions via gl-transitions + GSAP — parity check, not a build (idea, T1)

`compositor/parts/transition-manager.ts` imports `gl-transitions/gl-transitions.js` and
drives transition progress with a GSAP timeline
(`gsap.timeline({duration: 10, paused: true})`, `transition-manager.ts:30`), applying
shader transitions between adjacent clips with automatic effect-boundary
adjustment (`selectTransition` shrinks the outgoing/incoming clip by half the
transition duration on each side). Per our own [opencut-ecosystem-poaches.md] notes,
we already shipped a gl-transitions-based transitions surface in-house
(@edf1bdf4) after finding mainline OpenCut has none post-rewrite. Action here is
confirming feature parity (badge/remove UI, adjacency handling, blank-frame clamping —
see that doc's fix list) rather than re-building from omniclip's version.

### 5.6 `omnitool` — watch, don't build (idea, T2)

Separate repo, 40 stars, explicitly "🚧 Work In Progress." A declarative timeline DSL
(`Driver.setup()`, `omni.timeline(o => ...)`, `o.video/text/transition.fade/filter.blur`)
for building and rendering timelines from code, currently JS/TS-only. The omniclip
README's own words position it as *"integrating with AI or scripting workflows"* —
that phrase is the only AI-adjacent language found anywhere across all four
`omni-media` repos, and it describes an *intention*, not a shipped capability; `omnitool`
today has no model, no agent, no AI SDK dependency of any kind. If this matures and
gets a real LLM wired to script timelines through it, it becomes conceptually
Vyra-adjacent (agent authors an EDL programmatically) — re-check in a few months.
Nothing to act on now beyond noting it as a horizon risk.

## 6. Bottom line

Omniclip is a well-engineered, actively-maintained, genuinely free (no accounts, no
uploads, MIT) browser NLE built by a solo indie maintainer with a Discord community —
not a funded competitor, not an AI competitor. Direct code search (not inference)
confirms **zero generative AI features anywhere in the codebase**: no captions, no
speech-to-text, no LLM integration, no generated clips, no personas — even basic
per-clip volume and true keyframing are still on their "to be added" list. It sets a
real bar for manual-editing craft (worker-based transition-accurate decode, snap
guidelines, GSAP-driven presets) and has one feature outside our current model worth a
look — serverless P2P live collaboration via WebRTC + OPFS, architecturally distinct
from our account/DB-backed collab. The one thing worth monitoring, not acting on today,
is the sibling `omnitool` project's stated ambition to become a scriptable/"AI or
scripting workflows" substrate — currently pre-alpha and AI-free, but the closest thing
to a Vyra-style thesis anywhere in this competitor's ecosystem. Recommended posture:
use omniclip as the "quality bar" reference for manual-editing polish, evaluate
serverless P2P collab as a possible lightweight companion to our durable collab model,
and re-check `omnitool` in a few months rather than treating it as a current threat.

## 7. Open items to verify

- Whether Byorn already has per-effect volume control and/or true keyframe animation
  (omniclip lacks both — if we already have them, that's a concrete stated advantage
  worth putting in outward-facing comparisons; this doc didn't check our own state).
- Real-world robustness of omniclip's WebRTC P2P collaboration at scale/on flaky
  networks — open issue #8 ("[idea] Live collaboration") reads oddly given the feature
  is already coded, which may mean the shipped version has known rough edges worth
  hands-on testing before treating the pattern as reference-quality.
- Whether "Omniclip 2.0" (teased at the top of the README, discussed on their Discord)
  changes any of the above — that discussion is not visible via the public API/repo,
  only the Discord invite link.
- Whether `omnitool` ever actually gets an AI/LLM dependency wired in — re-run the same
  code-search methodology (§4) against `omni-media/omnitool` periodically.
- Exact codec/container robustness (HEVC/AV1 decode reliability, browser codec-support
  gating) — only inferable from dependency list (`mp4box`, `web-demuxer`,
  `mediainfo.js`, `ffprobe-wasm`), not confirmed by hands-on testing in this pass.
