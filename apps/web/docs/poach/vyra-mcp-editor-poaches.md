# Vyra (usevyra.com) — competitor doc (MCP-driven "agent-first" editor)

> Web-research pass, **2026-07-10**. Sources: usevyra.com (home, pricing, vs-Descript,
> vs-VEED, vs-Descript blog), MCP registry entry `io.github.kale-eb/vyra`
> (crossaitools.com), OpenCut-rewrite coverage (explainx.ai). Marketing-sourced —
> claims are the vendor's own unless noted; treat perf/pricing numbers as unverified.
> This is the **closest competitor to our own architecture** yet catalogued — it is
> effectively our `feat/mcp-sprint2` thesis (agent drives the timeline over MCP)
> shipped as a paid product. Read alongside [opencut-ecosystem-poaches.md](opencut-ecosystem-poaches.md)
> and [palmier-mcp-schema-spec.md](palmier-mcp-schema-spec.md).

---

## 1. Header

- **Competitor:** Vyra (usevyra.com). Author/handle **`kale-eb`** (GitHub); MCP registry id `io.github.kale-eb/vyra`. Appears to be a solo/small indie build, not VC-backed as far as public record shows. No open-source repo surfaced — the editor itself is closed SaaS; only the MCP connector is publicly registered.
- **One-line:** An **"agent-first" video editor** you drive entirely through MCP — Claude, ChatGPT, or any MCP client connects and edits your **real footage** on a real timeline (not a template generator). Positioning: *"visual-first"* — it indexes footage with embeddings so the agent edits by *what's shown*, not just the transcript.
- **License / stack / platform:** Closed SaaS, account required. MCP over **HTTP (streamable)** at `api.usevyra.com/mcp`. Client-agnostic: works from desktop app, terminal, web browser, or any chat host. Rendering engine / browser-vs-cloud split not disclosed; credit-based cloud processing implies server-side render. Registry last updated **2026-05-22**.
- **Pricing:** MCP Starter **$24/mo** (6,000 credits, 100 GB, 1440p export, 1,000 exports/mo, 100 projects) · MCP Pro **$65/mo** (20,000 credits, 500 GB, 4K export, 1,000 exports/mo, 1,000 projects). Both: motion-graphic export + MCP access, 3-day trial. **Discrepancy to verify:** the vs-VEED blog cites *"starts at $9.99/month"* — implies a hidden entry tier below Starter, or stale copy.
- **Last verified:** 2026-07-10.

## 2. Threat read

Restated bet: *our Sprint-2 wedge is "external agents drive our timeline over MCP" (shared `toolCatalog()`, ~21 verbs, relay-bridge to in-browser EditorCore, per-project token auth). Vyra ships exactly that as a product.* So the MCP-editor lane is **contested, not owned.**

Confirmed and sharpened:

- **Same core thesis, already shipped.** Vyra's whole pitch — *"every tool in the editor is available through natural language… the AI generates [graphics] as code components rendered in real-time on your timeline"* — is our Sprint-2 design as a launched product with billing. The "agent gets **actual editing tools + timeline control**, not a passthrough that just sends prompts to an internal AI" framing (their explicit jab at Descript and VEED) is *our* exact differentiator too. We are no longer first-mover on the concept.
- **Upstream is also moving.** OpenCut's own May-2026 ground-up rewrite adds a plugin system, headless render, scripting tab, **MCP server, and public Editor API**. Our fork's upstream is racing the same direction — the MCP surface is becoming table stakes across the OpenCut ecosystem, not a moat.
- **Their real differentiator is retrieval, not MCP.** The defensible piece is **visual indexing + embeddings** — searchable scene descriptions / object+person tags ("speech transcribed, 18 tags generated" per clip) so the agent selects clips by visual content. That's the capability we should treat as the bar, more than the MCP plumbing.
- **Where they're thin (our openings):** self-admitted **no screen recording**; weak for **dialogue-heavy/podcast** content (transcript editors win there); **no AI avatars** (VEED has them); and — critically — **nothing on character consistency, seed-lock, or persona**. Our locked build #1 (identity engine + seed-lock, see [higgsfield-soul-id-poaches.md](higgsfield-soul-id-poaches.md)) is entirely absent from their story.

Net: Vyra proves the MCP-editor market is real and monetizable, and removes "nobody's done this" as our pitch. The moat has to be **persona/seed-lock depth + a richer generative-clip timeline**, not MCP access itself. Their visual-retrieval layer is the one capability worth chasing directly.

## 3. Priority table

| # | Poach | code\|idea | Relevance | Effort | Tier/Prio |
|---|-------|-----------|-----------|--------|-----------|
| 0 | **Visual indexing + semantic search — WE ALREADY SHIP THIS** (`services/search/`, agent verb `searchMedia`, on-device). Not a build; a *marketing* gap — Vyra headlines it, we bury it in a panel. **Surface it.** | — | Highest | S (copy/positioning) | **T1** |
| 1 | **Richer per-clip tagging** — the only real capability gap: open-vocab object + **person/face** tags, computed per-scene not just first frame. Person-tagging feeds persona/seed-lock (Vyra can't). Extends existing `ZERO_SHOT_LABELS` path. | code | High | M | **T1** |
| 2 | **"Agent gets real tools, not a prompt passthrough"** positioning — sharpen our MCP messaging to claim this lane explicitly before it's generic | idea | High (positioning) | S | **T1** |
| 3 | **Motion graphics as generated code components** rendered live on the timeline (animated titles, lower-thirds, data-viz) | idea | High | M–L | **T2** |
| 4 | **Beat-synced auto-cut** — detect beats + energy in an audio track, cut/transition footage to match (**note:** Palmier already shipped this too — see landscape doc; audio compute is half-orphaned on our side) | idea | High | M | **T2** |
| 5 | **Reference-video style matching** — analyze a reference's pacing/color/transitions, apply to user footage | idea | Med | M–L | **T2** |
| 6 | **Client-agnostic MCP framing** — "works wherever your AI assistant lives" (desktop/terminal/web/chat) as an explicit selling point of our HTTP/SSE server | idea | Med | S | **T2** |
| 7 | **Credit-metered processing model** ($/credit, storage tiers, export caps) as a pricing reference point for our own monetization | idea | Med | S | T3 |
| 8 | **Bilingual captions** as a default agent verb | idea | Low–Med | S | T3 |

`S`=hours · `M`=1–3 days · `L`=1–2 weeks. `T1`=close/can't-cede · `T2`=credibility gap · `T3`=nice-to-have.

## 4. Vyra's MCP surface — schema is auth-gated (could not retrieve)

**Attempted 2026-07-10, failed.** `https://api.usevyra.com/mcp` is fully behind OAuth Bearer
auth — a `tools/list` handshake (unauth GET, JSON-RPC `initialize`, JSON-RPC `tools/list`) all
return `401 {"error":"Missing or invalid Authorization header"}`. Response headers reveal the
stack, not the verbs:

```
www-authenticate: Bearer resource_metadata="https://api.usevyra.com/.well-known/oauth-protected-resource"
server: railway-hikari · x-powered-by: Express · x-railway-edge: hnd1
```

So: **Express on Railway, OAuth-protected MCP resource.** The real verb list requires a paid
Vyra account token — not obtainable without signing up. The list below is **inferred from
marketing copy**, not the schema; treat as directional only:

- **Search footage** — semantic clip search over the visual index ("search through video clips").
- **Cut / trim** · **Apply effects / transitions** · **Generate captions** (bilingual).
- **Generate motion graphics** — titles/lower-thirds/data-viz as code components on the timeline.
- **Beat-sync** — detect beats/energy, auto-cut+transition to audio.
- **Style-match from reference** — copy pacing/color/transitions from a reference video.
- **Timeline manipulation** (general) · **Export** to 1440p/4K.

**Key correction vs the first draft of this doc — we already ship their "moat."** A codebase
audit (2026-07-10) found we already have the full visual-index stack, and unlike Vyra it is
**on-device (privacy-first, $0 marginal cost) AND already wired to the agent**:

| Vyra claim | Our equivalent | Status |
|---|---|---|
| Visual indexing + embeddings | `services/search/embedding-service.ts` — CLIP ViT-B-32, per-frame L2-normalized vectors in IndexedDB; `use-embedding-indexer.ts` auto-indexes every new asset in the background | **Shipped** |
| Semantic clip search ("edit by what's shown") | `use-visual-search.ts` — text→CLIP query embedding, cosine ranking over frames, `findSimilar`, debounced UI in `panels/assets/views/visual-search.tsx` | **Shipped** |
| Agent can search footage by content | `lib/director/tool-catalog.ts` → **`searchMedia`** verb ("semantic search over indexed footage (CLIP embeddings)") + **`addClip`** to drop a hit onto the timeline. In the shared `toolCatalog()` that feeds the Sprint-2 MCP surface. | **Shipped & agent-wired** |
| Per-clip auto-tags ("18 tags/clip") | Zero-shot tagging via `ZERO_SHOT_LABELS` (20 scene labels: indoor/outdoor/face/screen-recording/b-roll/…) | **Partial** — see gaps |
| Near-duplicate detection | `findDuplicates()` (cosine over mean vectors) | **Shipped (we exceed)** |

**Where we're genuinely behind Vyra's tagging (the only real gap, and it's small):**
1. Our zero-shot tags are a **fixed 20-label closed vocabulary**; Vyra advertises ~18 *open*
   tags/clip incl. **object + person** detection.
2. We compute tags from **only the first sampled frame** (`embedding-service.ts` ~L231) — one
   tag set per asset, not per-scene. Vyra tags across the clip.
3. **No person/face tagging** → this is the one worth building, because it feeds persona/
   seed-lock (find every shot of persona X), which Vyra cannot do at all.

Gaps on *their* side vs us (from public info): **persona/identity, seed-lock, generative-clip
takes/versioning, on-device/private, $0 marginal cost.**

## 5. Per-poach detail

### 5.0 Visual indexing + semantic search — already shipped, under-marketed (T1)

**What Vyra does.** Runs each clip through analysis — scene detection, transcription, object/
person tagging ("18 tags/clip") — and stores embeddings so the agent retrieves clips by visual
description ("find the shots of the red car at dusk"). Their explicit wedge vs Descript ("treats
video as visual media… understands every scene") and VEED ("VEED cannot").

**What we already have (audited 2026-07-10).** The same thing, on-device and agent-wired — see
the table in §4. CLIP ViT-B-32 per-frame embeddings, background auto-indexer, text→embedding
cosine search, `findSimilar`, duplicate detection, a UI panel, and the agent verbs `searchMedia`
+ `addClip`. It's in the shared `toolCatalog()` feeding Sprint-2 MCP. **This is not a build item
— it's parity we already hold, and in two ways we're ahead: on-device/private and $0 marginal
cost (Vyra meters it as processing credits).**

**Action = positioning, not code.** Vyra headlines "your AI understands your footage"; we hide
the capability in an assets panel. Surface it: name it, demo the agent doing `searchMedia →
addClip`, and put "local, private, unmetered visual search" in the pitch as a direct counter.

### 5.1 Richer per-clip tagging — the one real capability gap (code, T1)

**The gap.** Our tagging is thinner than Vyra's on three axes (§4): (1) fixed 20-label closed
vocabulary vs their open ~18 tags; (2) tags from only the **first** sampled frame, not per-scene;
(3) **no person/face tagging.** Everything else is parity or better.

**Why it's worth doing (and why it's ours to win).** Person/face tagging is the piece that
compounds with our moat: a face-aware clip index lets the agent "find every shot of persona X,"
which plugs straight into persona/seed-lock — a capability Vyra structurally lacks. Reuse the
existing zero-shot path (`embedding-service.ts` tag step) — widen the label set / swap in an
open-vocab detector, tag across sampled frames not just frame 0, and add a face-embedding pass
that reconciles against active personas. Medium effort; highest strategic payoff of the list.

### 5.2 "Real tools, not a passthrough" positioning (idea, T1)

**What it is.** Vyra hammers a specific message: rival MCPs (Descript, VEED) only let the agent *send a prompt to the vendor's own AI* or *generate synthetic clips* — Vyra hands the agent the *actual editing toolset* with visual feedback and timeline control. That is precisely what our relay-bridge-to-EditorCore architecture does.

**How it lands.** Zero code — this is our messaging to claim now, while it's still differentiating. Frame our MCP server as "your agent operates the real editor, on your real footage, with full undo/timeline state," and contrast against prompt-passthrough MCPs. Fold into the Sprint-2 launch narrative. (Risk: this window is closing as OpenCut upstream ships its own MCP server — move on positioning before it's generic.)

### 5.3 Motion graphics as generated code components (idea, T2)

**What it is.** Agent generates original animated titles / lower-thirds / data-viz *from a description or reference*, emitted as code components rendered live on the timeline — not template selection. Their differentiator vs VEED's "basic text animations."

**How it lands.** Fits our generative-clip timeline model well: a motion-graphic *is* a generative clip whose source is code (Remotion-style / canvas components) rather than a diffusion model. Reuse the takes-as-versions pattern from our locked direction. Medium-large; slot after core persona work.

### 5.4 Beat-synced auto-cut (idea, T2) & 5.5 reference style-match (idea, T2)

Both are self-contained agent verbs with clear off-the-shelf paths: beat/onset detection (librosa-class) → snap cut points to beats; and reference-analysis (shot-length histogram, color stats, transition detection) → apply as edit-decision parameters. Neither is a moat but both are credibility features an "agent-first editor" is expected to have. Note the audio pipeline overlap with our orphaned TTS/audio work ([poach_session_findings] memory).

## 6. Bottom line

Vyra is validation and warning in one: the "AI drives a real timeline over MCP" market is real, paid, and now occupied — by an indie, with OpenCut's own rewrite close behind. Our Sprint-2 work is no longer novel *as a concept*; its value now depends on (a) the depth under it — **persona/seed-lock/character consistency**, which Vyra entirely lacks — and (b) matching their one genuine edge, **visual retrieval**. Recommended posture: ship Sprint-2 MCP with the "real tools, not passthrough" framing now, prioritize a clip-understanding/visual-index service next (it double-serves persona), and keep identity as the moat Vyra can't quickly copy.

## 7. Open items to verify

- Real MCP schema at `api.usevyra.com/mcp` (exact verb names/args) — current §4 is inferred.
- The **$9.99/mo** entry tier (vs-VEED blog) vs $24 Starter (pricing page) — is there a cheaper tier?
- Whether Vyra is itself an OpenCut/Remotion fork (unconfirmed; concept-adjacent but no code link found).
- Any avatar/lip-sync/persona roadmap (currently absent — our moat depends on it staying absent).
