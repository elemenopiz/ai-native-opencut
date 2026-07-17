# Campaign: hardening-w2 — security fix-forward (BUG24 + BUG26)

Branch: `campaign/hardening-w2` off main @2a1307a0. L1 orchestrator log — crash-survival
state. Status tables record only what HAS happened.

## Scope

| Item | File | Fix |
|---|---|---|
| BUG24 (tenancy floor, MED) | `apps/web/src/app/api/version-control/media/[hash]/route.ts` | GET is session-gated but selects mediaObjects by hash globally → 302 to R2. Add repo-access check mirroring sibling `repos/[repoId]/media/route.ts`. |
| BUG26 (LOW) | `apps/web/src/app/api/beta-gate/route.ts:21` | Non-constant-time `!==` code compare → `crypto.timingSafeEqual` with length guard. |

## BUG24 authorization semantics (decided up front)

- Resolve hash → `mediaObjects` row (404 if none, unchanged).
- Allow (302 to R2) iff EITHER:
  1. caller is the uploader (`mediaObjects.uploadedBy === session.user.id`) — covers the
     upload→register-refs window where an object has no commit refs yet; OR
  2. caller has read access (`checkRepoAccess`, which subsumes owner/member/branch-perm
     AND public-read) to **at least one** repo referencing the hash, resolved via
     `commitMediaRefs (mediaHash) → commits (repoId)` distinct repoIds.
- Otherwise **403** (per queue row; hash is already a bearer-capability, existence leak
  via 403-vs-404 is accepted and documented in the route comment).
- `checkRepoAccess` (not `getRepoRole`) is the seam: `getRepoRole` returns null for
  public-repo non-members, which would break shared-project clone media downloads —
  the sibling manifest GET grants public read, so the blob route must match.
- Content-addressed dedup ⇒ one hash may be referenced by many repos: access to ANY ONE
  referencing repo suffices (the caller could fetch the same bytes via that repo anyway).

## Worker roster / file partition

| Worker | Branch | Owned files | Status |
|---|---|---|---|
| W1 BUG24 (sonnet) | `task/hardening-w2-bug24` | `api/version-control/media/[hash]/route.ts` + new `__tests__/route.test.ts` beside it | dispatched |
| W2 BUG26 (sonnet) | `task/hardening-w2-bug26` | `api/beta-gate/route.ts` + new `api/beta-gate/__tests__/route.test.ts` | dispatched |

No shared files. `version-control-utils.ts` is READ-only for W1 (import, don't edit).

## Verify plan

- Per-worker: typecheck, targeted `bun test` on the new test file + the
  `route-protection.test.ts` sweep (must stay 59/59; media/[hash] stays classified as
  session-swept — the `auth.api.getSession` pattern must remain in source).
- L1 battery (serial, on merged campaign tip): `bun run typecheck` · `bun run lint`
  (no-worse vs main) · `bun run build` · root `bun test`.
- No browser verify needed: both are API-only behavior changes fully covered by
  executed-handler unit tests (rerun a red suite once — known false-red classes).

## Gates

None expected. If a fix turns out to need a migration/auth-config/new dep → stop, report
packet to L0. L0 reads the BUG24 diff before any merge to main.

## Log

- 2026-07-17: campaign branch cut @2a1307a0; log committed; W1+W2 dispatched.
