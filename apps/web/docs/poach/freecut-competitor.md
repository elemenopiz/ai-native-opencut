# FreeCut (walterlow/freecut) — competitor doc (WebGPU browser NLE, no generative layer)

> Source-code research pass, **2026-07-13**. Unlike the Vyra doc (closed SaaS,
> marketing-sourced), FreeCut is MIT and fully public — every claim below is
> read directly from the repo: `gh repo view walterlow/freecut`, the full file
> tree via `gh api .../git/trees/main?recursive=true`, and ~15 source files
> fetched via `gh api .../contents/<path>`. Surfaced by the same-day sweep in
> [oss-video-editors-poaches.md](oss-video-editors-poaches.md) as one of three
> "direct competitor, track don't poach" WebGPU/WebCodecs browser NLEs
> (alongside `omniclip-competitor.md`, `openreel-video-competitor.md`).

---

## 1. Header

- **Competitor:** FreeCut (`walterlow/freecut`, [freecut.net](http://freecut.net)). Effectively a **solo project**: `walterlow` has 2,188 of 2,221 commits (98.5%); next contributor (`hermeswalter`) has 26. No company on the owner's GitHub profile, no org account, `.github/FUNDING.yml` points to personal GitHub Sponsors only. No public funding/VC signal.
- **One-line:** A browser-native, WebGPU-first **professional NLE** aimed at editors coming from Premiere Pro / DaVinci Resolve — deep manual-editing feature set (multi-track, keyframes, GPU effects/transitions/scopes, ProRes) plus **on-device-only** AI (transcription, captioning, scene detection, TTS voiceover, music generation, and a small local-LLM chat copilot that drives editing tools). **No cloud AI, no generative visual content creation, no personas.**
- **License / stack / pricing:** MIT (verified: `LICENSE` file, standard text, copyright FreeCut 2025). Open source but explicitly **not open-contribution** — README: *"Pull requests are not accepted at this time."* No pricing, billing, or paywall code anywhere in the repo — fully free, no monetization mechanism found. Stack (from `package.json`): React 19 + TypeScript, Vite+ (`vite-plus`), Zustand + Zundo (undo/redo), TanStack Router, Tailwind 4 + Radix, **WebGPU** for effects/compositing/transitions/scopes, **WebCodecs** for preview/export, **File System Access API + OPFS** for storage, **Mediabunny** (demux/mux/encode, own npm package by a third party — same one flagged as a Tier-1 poach in `oss-video-editors-poaches.md`), **Transformers.js + onnxruntime-web** for local ML, **Kokoro.js** for local TTS.
- **Scale (live, `gh repo view` + `gh api`, 2026-07-13):** 1,531 stars, 221 forks, 13 open issues, 0 GitHub releases (rolling web deploy, no versioned distribution). Created **2025-11-16** (~8 months old). Last push **2026-07-13T00:12:42Z** — same-day activity.
- **Last verified:** 2026-07-13.

## 2. Threat read

FreeCut is the deepest **manual-editing** NLE found in the whole OSS sweep, and simultaneously the clearest proof that this category and Director's generative-AI category are different games.

- **Feature depth exceeds ours on pure manual editing.** From the README (cross-checked against the actual `src/features/` and `src/infrastructure/gpu-*` trees, not just marketing copy): 25 GPU blend modes (verified byte-for-byte in `gpu-shared/blend-modes.ts`), a full bezier-graph/dopesheet keyframe editor with procedural motion modifiers (drift/sway/breath/spin/shake) that bake to keyframes, chroma keying, `.cube` LUT support, GPU color scopes (waveform/vectorscope/histogram), Apple ProRes decode, multiple timelines-as-Sequences with compound-clip nesting, and the full ripple/rolling/slip/slide toolkit. This is Premiere/Resolve-workflow-deep — well past where a "spine + generative Takes" editor like Byorn needs to go on manual tools, but a real gap if we ever compete head-on for the "serious editor" audience on craft alone.
- **Zero generative AI, confirmed by source, not inference.** Grepped the entire 2,260-file tree for every major AI-vendor name (OpenAI, Anthropic, Replicate, RunwayML, Stability, Gemini, Claude, ElevenLabs, DALL-E) — **zero hits** outside unrelated dev-tooling config. All AI in FreeCut is on-device: Parakeet/Whisper transcription, an LFM vision-language model for captioning/tagging, histogram + optical-flow scene detection, Kokoro TTS, MusicGen music generation, and CLIP-class embeddings for semantic scene search — all **analysis or utility generation**, never generation of new visual footage. The AI-output storage schema itself (`workspace-fs/ai-outputs/types.ts`) only has three kinds: `transcript | captions | scenes`. There is no fourth kind for generated video/image assets.
- **There IS a local-LLM editing copilot — but it's tool-calling over manual ops, not content generation.** `src/features/editor/agent/` runs a small on-device model (code comments say "a 4B local model") through a single-shot structured-output loop with a validation-feedback retry, driving a **13-verb tool catalog**: `find_clips, search_transcript, select_clips, seek_to, add_title, split, delete_clips, set_speed, set_volume, trim_clip, add_transition, remove_silence, remove_fillers`. That's the entire surface — no clip generation, no persona, no seed-lock, no reroll/remix, no multi-backend routing, no credit system (moot — everything is local and free).
- **Their own code says the MCP surface isn't shipped yet.** `agent/tools/mcp.ts` wraps the tool registry in MCP `tools/list`/`tools/call` shape and is explicitly commented: *"This is the future-facing seam... everything an MCP server would delegate to... standing one up later is just choosing a transport... without yet shipping a server."* So FreeCut has architected cleanly for external-agent-drives-timeline (our Sprint-2 thesis, and Vyra's shipped product) but has not exposed it. This is a codebase to watch, not a shipped competitor on that axis yet.
- **Brand and product docs actively reject the direction Director is betting on.** `PRODUCT.md`: target user is "experienced video editors... from Premiere Pro and DaVinci Resolve," brand personality is "precise, confident, calm," and the anti-references list explicitly rejects "consumer-cute editors (CapCut, iMovie)" and "flashy SaaS dashboards." Nothing in the product vision, roadmap language, or code gestures toward generative content creation as a future direction — this reads as a durable, not incidental, positioning choice.

**Net:** FreeCut is validation that a serious, 100%-local, WebGPU-first browser NLE can reach real scale (1.5k★, 8 months, one person, zero funding) purely on manual-editing craft and privacy/local-first architecture — with no generative AI at all. It is not a threat to Director's core thesis; it is a threat to any claim that Byorn's *manual*-editing surface (blend modes, keyframe depth, color tools, scopes) is competitive with the best of the open-source field. Track their editing-feature depth and their storage architecture; do not worry about them entering the generative lane — their entire brand identity runs the other direction.

## 3. Priority table

| # | Poach | code\|idea | Relevance | Effort | Tier |
|---|-------|-----------|-----------|--------|------|
| 1 | **Dual-tier storage: FSA workspace-as-truth + OPFS-as-mirrored-speed-cache** — idempotent mirror-writes, workspace-fallback reads, optional OPFS backfill (`infrastructure/storage/workspace-fs/cache-mirror.ts`) | code | High | M | **T1** |
| 2 | **Atomic JSON writes** (tmp-file + `FileSystemFileHandle.move()`, with per-root memoized fallback to copy+delete when `move()` rejects — e.g. cloud-synced folders) + per-path in-memory write lock (`workspace-fs/fs-primitives.ts`, `with-key-lock.ts`) | code | Med–High | S | **T1** |
| 3 | **25-blend-mode WGSL compositor math** — clean, dependency-free, Photoshop-equivalent blend functions incl. stochastic dissolve-alpha dithering (`infrastructure/gpu-shared/blend-modes.ts`) | code | Med | S | T2 |
| 4 | **Headless Playwright CLI** — drives real headless Chrome to run the actual export/edit engine from the command line, range-streams media (no full download), reuses production Zustand stores (`headless/*.mjs`, `src/headless/`) | idea (read code as reference) | Med | M–L | T2 |
| 5 | **Small-model tool-calling reliability pattern**: single-shot structured JSON plan + one validation-feedback retry + a bounded one-hop "resolve read-only tools, then re-plan" loop, tuned for a 4B on-device model (`agent/agent-service.ts`, `agent/prompt.ts`) | idea | Med | S | T2 |
| 6 | **Zod-validated tool registry, MCP-shaped from day one** — every tool carries a hand-authored JSON Schema alongside its Zod runtime schema, plus `readOnly`/`destructive`/`handoff` flags, so the same registry serves the local-LLM prompt catalog *and* an MCP `tools/list`/`tools/call` adapter without duplication (`agent/tools/definitions.ts`, `agent/tools/mcp.ts`) | idea | Med | S | T2 |
| 7 | **Procedural motion modifiers** (drift/sway/breath/spin/shake) evaluated at render time with one-click "bake to keyframes" | idea | Low–Med | M | T3 |
| 8 | **GPU color scopes** (waveform/vectorscope/histogram) as a "serious editor" credibility feature | idea | Low–Med | M | T3 |
| 9 | **"Quiet instrument, not a toy" brand positioning** — counter-reference for our own anti-consumer-cute stance (`DESIGN.md`, `PRODUCT.md` anti-references section) | idea | Low | S | T3 |

`S`=hours · `M`=1–3 days · `L`=1–2 weeks. `T1`=close/can't-cede · `T2`=credibility gap · `T3`=nice-to-have.

## 4. Per-poach detail

### 4.1 Dual-tier storage architecture (code, T1)

**What it is.** FreeCut's storage is **not** "OPFS-first" as a casual read of the README might suggest — it's more precise than that. The **File System Access API workspace folder the user picks on disk is the single source of truth**: `workspace-fs/root.ts` holds one `FileSystemDirectoryHandle` behind `requireWorkspaceRoot()`, and every project/media/thumbnail/waveform/transcript/caption file is a plain file under it, written via `fs-primitives.ts`. **OPFS is a secondary, origin-local speed cache** for expensive derived data (proxies, filmstrips, preview-audio conforms) — `cache-mirror.ts` writes to OPFS for speed on the fast path, then *also* idempotently mirrors the same bytes into the workspace folder so a different origin (or a fresh browser profile) can read the derived data without re-transcoding. Reads fall back to the workspace copy when OPFS is empty, with an option to backfill OPFS from that read.

**Why it's worth porting.** This is the correct shape for "local-first with a disk-backed source of truth, but instant re-opens": OPFS gives you sub-millisecond origin-local reads, while the workspace mirror makes the cache portable and durable to browser-storage eviction. If Byorn ever moves derived caches (thumbnails, waveforms, proxies) toward user-visible disk persistence — relevant to the "local-first storage architecture" gap noted in `local_ai_browser_first` and `opencut_fork_sweep` memory — this file is the reference implementation to read before designing our own.

### 4.2 Atomic JSON writes + write-lock (code, T1)

**What it is.** `writeJsonAtomic()` writes to `{file}.tmp`, then commits via `FileSystemFileHandle.move()` when available (true atomic rename), falling back to copy-then-delete when `move()` rejects. The rejection isn't treated as "unsupported browser" — the code's own comment explains Chromium has shipped `move()` since M111, and the *spec* still permits per-file rejection when the file "does not correspond to a file on the underlying filesystem" (i.e., cloud-synced folders like OneDrive/Dropbox, or Brave with the FSA flag off). So they **probe once per workspace root** (`WeakSet<FileSystemDirectoryHandle>`, not a session-global flag — because the user can swap roots mid-session) and remember the answer, rather than eating a doomed `move()` call on every single write. A companion `with-key-lock.ts` serializes writes to the same path in-memory to prevent two concurrent writers from deadlocking each other's `.move()` call.

**Why it's worth porting.** This is a small, self-contained, well-reasoned piece of defensive engineering around a genuinely gnarly FSA edge case (cloud-synced folders silently degrading atomicity). If Byorn writes any project state directly to a user-chosen folder (or ever will), this is the exact bug class to pre-empt. Low effort, direct file-path port candidate.

### 4.3 25-blend-mode WGSL math (code, T2)

**What it is.** `infrastructure/gpu-shared/blend-modes.ts` is a single, dependency-free WGSL source string implementing all 25 standard Photoshop-style blend modes (multiply, screen, overlay, soft/hard/vivid/linear/pin light, hard mix, difference, exclusion, subtract, divide, hue/saturation/color/luminosity via HSL round-trip, plus a stochastic-dither "dissolve" mode using a hash-based per-pixel coverage function) as `vec3f`-in/`vec3f`-out functions dispatched by a `switch` on a `u32` mode index, composited with correct premultiplied-alpha source-over math in `compositeBlendSourceOver()`.

**Why it's worth porting.** It's pure math with zero external dependencies — a near-mechanical WGSL→GLSL translation (WGSL `select()` → GLSL `mix()`/conditional) would drop straight into Byorn's WebGL2 renderer if our blend-mode coverage is thinner than 25. Confirmed count matches the README's claim exactly (25), so this is a verified, not inferred, number.

### 4.4 Headless Playwright render/edit CLI (idea, T2)

**What it is.** `headless/render.mjs` and `headless/edit.mjs` launch real headless Chrome (channel `chrome`, via Playwright) against a UI-less harness page (`window.freecut`) that reuses the exact production export pipeline and Zustand timeline stores — not a reimplementation. Media is HTTP range-streamed rather than downloaded (a 5-second slice of a 3GB file renders without loading the whole file), and `edit.mjs` drives the real timeline action modules so transition repair, split-id rebinding, and linked-clip cascades behave identically to the in-app editor. This exists because WebCodecs/WebGPU/OffscreenCanvas/OfflineAudioContext make a Node-native port infeasible — headless Chrome is the only way to get engine-identical fidelity outside a browser tab.

**Why it's worth reading before building.** Byorn's own `e2e_harness` memory shows we already use a Chromium-minted-fixture + Playwright pattern for smoke tests; this is the same idea taken further into a general-purpose batch-render/automation CLI. Worth a design read if we ever want scriptable/CI-driven export or bulk regeneration outside the interactive editor — not an urgent gap, but a clean reference architecture.

### 4.5 Small-model tool-calling pattern (idea, T2)

**What it is.** `agent/agent-service.ts` and `agent/prompt.ts` implement a single-shot structured-output loop tuned specifically for a small (4B-class) local model: one JSON object (`{reply, steps[]}`) per turn, a Zod-validated tool registry that drops invalid calls, a **corrective retry** that feeds the exact validation failure back to the model once, and a **bounded one-hop resolve loop** — if the model asks for a read-only tool (e.g. `search_transcript`), the service runs it, feeds results back, and forces a final grounded plan in one more turn, explicitly rejecting further read-only calls to avoid an open-ended ReAct loop. The code comment is explicit about why: "far more reliable on a 4B local model than multi-turn ReAct tool use."

**Why it's relevant.** Not a code-port candidate (Director already runs larger cloud models with more headroom for multi-turn tool use), but a useful reference if Byorn ever routes a request to a small/local/cheap backend and needs a reliability pattern that doesn't assume frontier-model tool-calling quality.

## 5. Bottom line

FreeCut is real evidence that a solo developer can build and ship a genuinely deep, WebGPU-first, fully local browser NLE to 1,500+ stars in eight months with zero funding and zero generative AI — it is the strongest "manual editing craft" bar in the whole OSS sweep (25 blend modes, full keyframe/motion-graph editor, GPU scopes, ProRes decode, multi-sequence compound clips). But its product identity, its AI-output schema, and its dependency tree all confirm the same conclusion from three independent angles: **there is no generative content layer, no persona/character system, and no roadmap signal toward one.** Its on-device LLM copilot is a manual-editing dispatcher (13 verbs: cut, trim, title, transition, silence-removal), not a Take-generating agent. Recommended posture: mine it for manual-editing feature parity and local-storage architecture patterns (§3, items 1–3 are genuine, low-risk code poaches), and do not treat it as competitive pressure on Director, seed-lock, or the generative-clip timeline — those remain uncontested by this project specifically.

## 6. Open items to verify

- Real playback/export performance numbers (fps ceiling, encode throughput) — this doc is architecture-read only, no benchmarks run.
- Whether the on-device Gemma-class copilot ships enabled by default or behind an opt-in model-download gate (bundle-size/first-run UX tradeoff not inspected).
- Actual user base / retention signals beyond star count — Discord community size not checked.
- Whether `.github/workflows` runs the headless CLI in their own CI (plausible given the tooling exists, not confirmed — would strengthen the case for §4.4 if true).
- Re-check `pushedAt` before acting on anything here — this repo pushes same-day; specific line numbers/file contents may drift.
