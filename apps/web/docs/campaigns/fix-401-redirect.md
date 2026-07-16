# Campaign: fix-401-redirect (BUG12, user-directed) — 2026-07-17

**Objective:** an anonymous editor session must never be hard-redirected to `/signup` by a
background/hydration 401. User-initiated auth-required actions keep the prompt+redirect
(that is the money-moment flow and the real-expiry surface).

**Branch:** `campaign/fix-401-redirect` off main @cf47296c.

## Root cause (verified on main)

- `GenerateView` mounts with the editor and fires `loadHistory` → `apiFetch("/api/studio/sets")`
  (`src/hooks/use-studio-generation.ts` ~L401). Anonymous → legit 401.
- `apiFetch` (`src/lib/auth/unauthorized.ts`) routes EVERY 401 from any non-`/api/auth` route
  through `handleUnauthorized` → toast + `byorn:unauthorized` event.
- `SessionExpiredListener` (`src/components/auth/session-expired-listener.tsx`) converts the
  event into `router.push("/signup?redirect=…")` unconditionally (only skips on auth pages).
- First 401 prompts immediately (debounce only collapses subsequent ones) → anon editor is
  evicted within one round trip. Also destroys signed-in editors on any stray background 401.

## Class survey (all apiFetch call sites)

| Call site | Route | Kind | Action |
|---|---|---|---|
| `use-studio-generation.ts` loadHistory | `/api/studio/sets` | background hydration (mount) | **silent 401** |
| `use-board-items.ts` refetch (GET) | `/api/studio/board` | background hydration (mount) | **silent 401** |
| `use-board-items.ts` mutations (POST/DELETE/promote) | board/takes | user-initiated | keep prompt |
| `ai-client.ts` (all) | generate/LLM | user-initiated | keep prompt |
| `audio-panel.tsx`, `image-panel.tsx` | audio/board save | user-initiated | keep prompt |
| `generation-status-store.ts` resume-poll | `/api/studio/generate/:id` | background poll | **stores/* off-limits → queue row (follow-up)** |
| `credits-store.ts` refresh | `/api/credits/balance` | background poll | already plain `fetch` (silent) — no change |
| collab services | vc/* | flag-off for beta | no change |

## Chosen fix

Direction 3 (apiFetch option) implementing direction 1's blast-radius narrowing at the
call sites: `apiFetch(input, init?, { on401: "silent" })` — silent mode skips toast/event/
debounce-stamp but still returns the untouched Response (callers already branch on `!res.ok`).
Default stays "prompt". Direction 2 (auth-gate loadHistory) rejected as sole fix: single
call site, races async session load, leaves the class open.

Real-expiry story: an expired session surfaces on the next user-initiated action (generate
click, board mutation) via the unchanged prompt path — SessionExpiredListener keeps its job.
Background polls failing silently is the desired behavior for both anon and expired.

## Worker partition (file-disjoint)

- **W1 (sonnet):** implementation + unit tests. Owns `src/lib/auth/unauthorized.ts`,
  `src/components/auth/session-expired-listener.tsx` (doc comment only if needed),
  `src/hooks/use-studio-generation.ts`, `src/hooks/use-board-items.ts`,
  new `src/lib/auth/__tests__/unauthorized.test.ts`.
- **W2 (sonnet):** new `e2e/anon-editor-stability.e2e.ts` ONLY. Anon editor open, real 401s
  flowing (no route mocks for sets/board), 20s soak, assert URL still `/editor/*` + bridge
  alive + ≥1 observed 401. Acceptance = spec red on clean main (repro), reviewed for
  correctness; goes green after W1 merges.

Coordination: campaign/test-depth owns existing specs; we add ONE new spec file, touch no
existing e2e/harness files. `happy-path.e2e.ts` must go green as a side effect, unedited.

## Verification plan (L1 runs on campaign branch after merges)

1. Battery: `bun run typecheck`, `bun run lint` (no-worse), `bun run build`, root `bun test`.
2. `bun run build:e2e` then new spec green + `happy-path.e2e.ts` ×5 green.
3. Real browser from this worktree: anon `/editor/*` open >20s, no redirect; then click a
   generate action → prompt/redirect still fires (real-expiry surface intact).

## Status log

- 2026-07-17: branch cut, recon done, log committed. Spawning W1+W2.
- 2026-07-17: COMPLETE. W2 spec merged @31bd71b3 (red on unfixed base: redirect to
  /signup reproduced inside the 20s soak). W1 fix merged @35c08ff6 (additive
  `opts?: { on401 }`, pure `shouldPromptFor401` helper, 10 unit tests; default path
  byte-for-byte for all other callers). Main @eab311a5 merged in (C12 harness).
  Evidence on campaign tip:
  - anon-editor-stability.e2e.ts GREEN (20.7s soak, ≥1 real 401 observed, no redirect)
  - happy-path.e2e.ts 5×5 green, unedited; full default e2e suite 11 pass / 0 fail /
    5 skip (real-export self-skips under stub build, auth-flow skips w/o Upstash)
  - battery: typecheck 0 · lint 347E/225W == baseline · build green · build:e2e green ·
    root bun test 1380 pass / 44 fail / 31 errors == pre-existing baseline (names
    unrelated to territory; +20 new passes)
  - browser-verified locally (worktree server, port 3211): anon editor with REAL
    `GET /api/studio/sets → 401` survived minutes, zero toast/redirect, bridge alive;
    then user-initiated Generate → `POST /api/studio/generate → 401` → redirect to
    `/signup?redirect=%2Feditor%2F<id>` (prompt path / real-expiry surface intact)
  - follow-up filed: BUG15 (generation-status-store resume-poll still prompt-mode;
    stores/* was off-limits here)
  Verification tier: **verified locally**. Awaiting L0 merge to main.
