# MCP verb classification + project-binding refusal contract

Companion to the competitive-hardening item tracked in
`docs/poach/palmier-delta-refresh-2026-07-14.md` §4.1 ("MCP session→project
binding + read/write split", T1). That doc is IDEA-ONLY input (GPL-3.0
source, never read or copied — see the attestation at the bottom of this
file); everything below is our own design, our own wording.

## 1. Why this exists

Byorn's MCP server (`/api/mcp`) pins a session to `{userId, projectId}` from
the bearer token at `initialize` (`mcp-session-store.ts`, enforced per-request
in `app/api/mcp/route.ts`). Every `tools/call` then relays through
`getEditorBridge().relayToolCall({projectId: pin.projectId, ...})` —
**never** "whichever project the browser tab happens to have open." That part
was already correct before this pass (audited below, §3).

The gap this pass closes: when the bound project has **no live editor tab**
(the user switched the editor to a different project, or closed it), the
bridge rejected with a generic `BridgeError("no-tab", …)` and every verb —
mutating or not — got the same bare `{ok:false, message, bridge:"no-tab"}`
shape. A mutating verb refusing here is correct behavior (it must never
silently act on the wrong/no project) but the shape didn't say so
structurally, and a read verb hitting the identical gap was indistinguishable
from a "you're on the wrong project" warning, even though a read has nothing
to corrupt.

## 2. The refusal contract

`editor-bridge.ts`'s `relayToolCall` now attaches `BridgeErrorDetails` to a
`"no-tab"` `BridgeError`:

```ts
interface BridgeErrorDetails {
  boundProjectId: string;
  activeProjectId?: string; // only when knowable — see below
}
```

`build-mcp-server.ts`'s `bridgeRefusalFor(mutating, details, fallbackMessage)`
turns that into the structured payload every `tools/call` error response uses
for this gap:

```ts
interface McpBridgeRefusal {
  ok: false;
  refusal: "project-mismatch" | "bridge-unavailable";
  boundProjectId: string;
  activeProjectId?: string;
  message: string;
}
```

- **`refusal: "project-mismatch"`** — a **mutating** verb was blocked. This
  verb requires the bound project's own live editor, full stop; there is no
  world where it's safe to guess. Message example (both projects known):

  > Refused: this MCP session is bound to project "proj_X", but the
  > connected editor is currently on project "proj_Y". Open project "proj_X"
  > in the editor to continue.

- **`refusal: "bridge-unavailable"`** — a **read** verb hit the identical
  bridge gap. A read has no mutation risk, so it is deliberately **not**
  framed as a binding violation — it's an availability problem, nothing more:

  > This read needs a live editor connection for project "proj_X"; the
  > connected editor is currently on project "proj_Y" instead. Open project
  > "proj_X" in the editor, or retry once it reconnects.

- **`activeProjectId`** is populated only when the bridge can see **another
  live tab for the SAME user** connected to a different project
  (`EditorBridge.findActiveProjectForUser`, mirrors the permissiveness
  `relayToolCall` already applies when answering calls). It is **never**
  another user's state — a stranger's live tab is invisible to this
  mechanism by construction (userId must match, or both sides must be the
  dev wildcard). Covered by the "no cross-user leak" test in
  `mcp-project-binding.test.ts`.

- When no tab for the user is live anywhere, `activeProjectId` is omitted and
  the message says so plainly ("no editor tab is currently connected" /
  "none is currently connected").

Other `BridgeErrorCode`s (`user-mismatch`, `timeout`, `tab-disconnected`) are
different failure classes — a foreign tab, a slow tab, a tab that dropped
mid-call — and keep their existing generic `{ok:false, message, bridge:code}`
shape. Only the binding gap (`"no-tab"`) got the new structured contract;
scope-forbidden calls and rate-limit refusals were already structured before
this pass and are untouched.

## 3. What was audited and confirmed already correct

- **Session pin is token-derived, never browser-derived.** `app/api/mcp/route.ts`
  resolves `session.userId`/`session.projectId` from the session store (set
  at `initialize` from the verified token grant) and 403s any request whose
  *current* token doesn't match — so even mid-session token swaps can't
  retarget a session to a different project.
- **The relay always asks for the bound project's tab.**
  `build-mcp-server.ts` calls `getEditorBridge().relayToolCall({projectId:
  pin.projectId, ...})` — `pin` is the `{userId, projectId}` passed into
  `createByornMcpServer` at session-creation time from the token grant, not a
  parameter threaded from the request. There is no code path in the relay
  that reads "the active project" from anywhere browser-side.
  `EditorBridge.tabs` is keyed by `projectId`, and a tab only ever registers
  itself under the project it's currently mounted for (`use-mcp-bridge.ts`'s
  effect re-registers under a NEW projectId and tears down the OLD one on
  every project switch) — so a stale tab can silently answer for the wrong
  project only if two tabs were simultaneously registered for the SAME
  project id and the older one's in-flight call raced the replacement; that
  case is already handled (`registerTab` fails in-flight calls to the
  replaced tab before swapping it in).
- **The "generic timeout" premise in the delta doc didn't hold as literally
  described.** `relayToolCall` already rejects **synchronously** (no
  `setTimeout`) when `this.tabs.get(projectId)` is empty — it was never
  actually a slow timeout for the "no tab for this project" case, just an
  unstructured fast rejection. The real gap was the missing structured shape
  and the missing "which project is active" hint, not latency.

## 4. Verb read/write classification

53 verbs in `lib/director/tool-catalog.ts` (source of truth: each
descriptor's `mutating` flag, which also drives `scopeForTool` → MCP scope
enforcement and the `readOnlyHint` annotation). **16 read / 37 mutate.**

| # | Verb | `mutating` | MCP scope | Notes |
|---|------|:---:|---|---|
| 1 | `getReel` | read | `reel:read` | |
| 2 | `getSlot` | read | `reel:read` | |
| 3 | `searchMedia` | read | `reel:read` | |
| 4 | `findDuplicateAssets` | read | `reel:read` | |
| 5 | `getProjectInfo` | read | `reel:read` | |
| 6 | `getLibraryManifest` | read | `reel:read` | |
| 7 | `getTranscript` | read | `reel:read` | |
| 8 | `getBackends` | read | `reel:read` | |
| 9 | `storyboard` | mutate | `reel:write` | |
| 10 | `proposeReel` | mutate | `reel:write` | mutates pending-draft state, not the reel proper |
| 11 | `reviseProposal` | mutate | `reel:write` | mutates pending-draft state |
| 12 | `acceptProposal` | mutate | `reel:write` | |
| 13 | `getProposal` | read | `reel:read` | reads the pending draft |
| 14 | `intakeReferences` | mutate | `reel:write` | can create/activate a persona |
| 15 | `reserveSlot` | mutate | `reel:write` | |
| 16 | `setPrompt` | mutate | `reel:write` | |
| 17 | `generate` | mutate | `reel:write` | provider spend |
| 18 | `reroll` | mutate | `reel:write` | provider spend |
| 19 | `compareTake` | mutate | `reel:write` | provider spend (2x) |
| 20 | `remix` | mutate | `reel:write` | provider spend |
| 21 | `extractFrame` | mutate | `reel:write` | adds a library asset |
| 22 | `chainFrom` | mutate | `reel:write` | stamps a slot's spec |
| 23 | `chooseTake` | mutate | `reel:write` | |
| 24 | `getBudgetStatus` | read | `reel:read` | |
| 25 | `setBudget` | mutate | `reel:write` | |
| 26 | `getBrief` | read | `reel:read` | |
| 27 | `updateBrief` | mutate | `reel:write` | |
| 28 | `reviewTake` | **read** | `reel:read` | ⚑ see §5 — paid vision critique, no reel mutation |
| 29 | `addVoiceover` | mutate | `reel:write` | |
| 30 | `addMusicBed` | mutate | `reel:write` | |
| 31 | `getConsistencyContext` | read | `reel:read` | |
| 32 | `setConsistencyContext` | mutate | `reel:write` | |
| 33 | `getProjectBible` | read | `reel:read` | |
| 34 | `revertBibleCheckpoint` | mutate | `reel:write` | |
| 35 | `approveHeroShot` | mutate | `reel:write` | |
| 36 | `approveFinalCut` | mutate | `reel:write` | |
| 37 | `getVoiceProfiles` | read | `reel:read` | |
| 38 | `revokeVoiceConsent` | mutate | `reel:write` | |
| 39 | `seedStyleFromUnderstanding` | mutate | `reel:write` | |
| 40 | `trim` | mutate | `reel:write` | |
| 41 | `move` | mutate | `reel:write` | |
| 42 | `split` | mutate | `reel:write` | |
| 43 | `reorder` | mutate | `reel:write` | |
| 44 | `remove` | mutate | `reel:write` | |
| 45 | `removeSilence` | mutate | `reel:write` | |
| 46 | `addText` | mutate | `reel:write` | |
| 47 | `updateText` | mutate | `reel:write` | |
| 48 | `applyTransition` | mutate | `reel:write` | |
| 49 | `applyEffect` | mutate | `reel:write` | |
| 50 | `addClip` | mutate | `reel:write` | |
| 51 | `undo` | mutate | `reel:write` | |
| 52 | `redo` | mutate | `reel:write` | |
| 53 | `export` | **read** | `reel:read` | ⚑ see §5 — real render + browser download side effect, no reel mutation |

## 5. Misclassification review

The `mutating` flag is defined (per `tool-catalog.ts`'s own header comment)
as "does this verb return a `delta`" — i.e. does it change the reel/timeline
data structure. Checked every verb's `director-api.ts` implementation against
that definition; **no verb mutates the reel while flagged `mutating: false`,
and no verb leaves the reel untouched while flagged `mutating: true`.** The
flag is internally consistent with its own definition.

That said, two verbs are classified `read` by the strict "does it return a
delta" test but do not behave like the other 14 free, side-effect-free reads,
and are worth flagging for anyone building policy on top of the `mutating`
flag (rate limits, retry-safety, "safe to relay against a stale/wrong-context
bridge") rather than the read/write scope it was designed for:

- **`export`** — triggers a real render (`editor.project.export`) and a
  browser file download. It is correctly read-classified for *scope*
  purposes (it never touches `editor.timeline`/slots — no `withDelta`) but it
  is **not idempotent and not free**: calling it twice does two renders and
  two downloads. It is also not in `build-mcp-server.ts`'s
  `LONG_RUNNING_TOOLS` set (`generate`/`reroll`/`remix` only), so it runs
  under the same `DEFAULT_TIMEOUT_MS` (30s) as `getReel` — a render that
  takes longer than 30s will time out even though the underlying export may
  still complete tab-side. **Recommendation (not made in this pass — out of
  the stated file boundary and out of scope for a binding-refusal hardening
  pass):** consider adding `export` to `LONG_RUNNING_TOOLS`, and treat it as
  cost-bearing for any future per-verb telemetry/quota work (the delta doc's
  §4.6 "per-verb telemetry" poach is the natural home for this).
- **`reviewTake`** — a "paid vision critique" (per its own catalog
  description) that decodes frames and sends them through a model. Correctly
  read-classified (no `withDelta`, nothing on the reel changes), but it costs
  real money per call, same caveat as `export`.

Neither is a bug in the existing classification — both are correctly
"read" for the reel-mutation definition the flag exists to serve — but
`reel:read` scope + the generous `mcp:read` rate-limit bucket (120/min) were
sized for genuinely free reads like `getReel`/`searchMedia`. Flagging here
rather than fixing: `tool-catalog.ts` is out of this pass's file boundary
(owned by a parallel agent).

## 6. Read/write and the project-binding refusal — why reads don't get a
   "mismatch" refusal

All 53 verbs — read and mutate alike — execute through the SAME browser
bridge (`use-mcp-bridge.ts`'s `descriptor.handler(director, args)` against
the live `DirectorApi`). There is no server-side execution path for reads;
`getReel` cannot be answered "from the database" the way a typical REST read
could, because the source of truth is the in-memory `EditorCore` in the
user's browser tab. That's a real architectural constraint (documented in
`editor-bridge.ts`'s header), not a design choice this pass could route
around — so a read WITH no live bridge for its bound project genuinely cannot
be served, same failure mode as a mutating verb.

The distinction this pass draws is about **framing, not availability**: a
mutating verb refusing is a **binding violation avoided** (the alternative
would be silently acting on the wrong project, or on nothing) — that's worth
a scary, specific "Refused:" message. A read verb failing under the same
conditions has caused **no harm** — nothing was at risk of being mutated
wrong — so it gets a plain availability message. A client/agent that branches
on `refusal` gets the right signal either way: `"project-mismatch"` means
"you tried to write and were correctly blocked, go open the right project";
`"bridge-unavailable"` means "this read just isn't servable right now, open
any editor tab and retry" (reads are cross-session-safe in principle — they
carry no risk of touching the wrong project's data, so once the SAME bound
project's bridge reconnects, or even in theory a future server-side read
path existed, there is no reason a read would need the human's out-of-band
judgment the way a refused mutation does).

**Design decision, since the delta doc left this ambiguous:** the doc's
prose ("read-only tools stay allowed via an allowlist") describes a system
where the tool surface is DIFFERENT depending on which project is active vs.
bound. That doesn't map onto Byorn's architecture 1:1, because our reads
have no separate serving path — they aren't "allowed to run against the
wrong project's data," they simply can't run at all without SOME live
bridge. We resolved this ambiguity in our own idiom: instead of an
allowlist that changes which tools are callable, every verb stays callable
(scope-gated as before), and the **failure mode** for the identical bridge
gap is what differs — a mutation-safety refusal vs. a bare availability
gap. This preserves the spirit (reads are not blocked by project-binding
logic the way mutations are) without inventing a serving path the
architecture doesn't have.

## 7. Tests

`src/lib/mcp/__tests__/mcp-project-binding.test.ts` (bun test, same
in-process Streamable-HTTP harness as `mcp-e2e-smoke.test.ts` /
`mcp-rate-limit.test.ts` — real SDK `Client` → real `/api/mcp` route → real
`EditorBridge` singleton, only `@/lib/mcp/auth`'s DB-backed token lookup is
mocked):

1. Mutating verb (`undo`) + no live bridge anywhere for the user →
   `refusal: "project-mismatch"`, `boundProjectId` correct,
   `activeProjectId` absent, message names the bound project and says no tab
   is connected.
2. Mutating verb + the SAME user's bridge live on a DIFFERENT project →
   refusal names BOTH projects correctly (`boundProjectId` and
   `activeProjectId`).
3. Read verb (`getReel`) + no live bridge anywhere → `refusal:
   "bridge-unavailable"`, NOT `"project-mismatch"`; message does not use the
   `"Refused:"` mutation framing.
4. Read verb + the SAME user's bridge live on a DIFFERENT project →
   `"bridge-unavailable"`, still names the active project.
5. A DIFFERENT user's live tab is never surfaced as `activeProjectId` (no
   cross-user leak) — caught a real test-isolation bug while writing this
   (see the doc comment on `registerFakeTab` in the test file: the existing
   test files' `unregisterTab(projectId, "")` cleanup pattern is a silent
   no-op because it doesn't pass the real generated `tabId`, so tabs leak
   across tests in the same `bun test` process; this new suite tracks and
   tears down real tab ids per test via `afterEach`).
6. A matching bridge for the bound project → the call proceeds normally,
   `refusal` is absent, the tab's real result comes back.

All 6 pass; full existing MCP suite (`mcp-e2e-smoke`, `mcp-rate-limit`,
`installers`, `telemetry`, `token-cache`) still passes unchanged; full repo
`bun test` (1514 pass / 5 pre-existing skip / 0 fail) unaffected.

---

**Clean-room attestation:** no palmier-pro source consulted. This document
and the accompanying code were derived entirely from the prose in
`docs/poach/palmier-delta-refresh-2026-07-14.md` §4.1 (itself GPL
clean-room, idea-only) plus first-party reading of Byorn's own
`lib/mcp/*`/`app/api/mcp/*`/`lib/director/tool-catalog.ts` source. Every
error code, field name, and message string above is original.
