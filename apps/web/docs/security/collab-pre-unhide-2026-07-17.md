# Collab pre-unhide security packet

**Date:** 2026-07-17 · **Scope:** shared-projects / version-control collaboration surface
(`project_members`, `project_invitations`, `vc_*` tables — migration 0008, merged @7e1b5b56)
**Status:** Audit only. **This packet un-hides nothing and changes no code or config.**
The `NEXT_PUBLIC_FEATURE_COLLAB` flag decision remains the user's call — see
[ADR-003](../decisions/ADR-003-hide-collab-for-beta.md).

## Scope + method

Read-only source review of every route under `apps/web/src/app/api/version-control/**`,
every `getRepoRole`/`checkRepoAccess`/`checkRepoWriteAccess`/`checkRepoOwner`/
`checkBranchPushPermission` call site (`apps/web/src/lib/db/version-control-utils.ts`),
the invite/member/clone/media-sync client code
(`apps/web/src/services/collaboration/*`, `apps/web/src/components/editor/dialogs/
shared-project-onboarding.tsx`, `apps/web/src/components/editor/shared-project-provider.tsx`,
`apps/web/src/components/editor/version-control-drawer.tsx`,
`apps/web/src/components/projects/shared-projects-section.tsx`), the DB schema and
migration SQL (`apps/web/src/lib/db/schema-version-control.ts`,
`apps/web/migrations/0008_project_collaboration.sql`), the R2 storage layer
(`apps/web/src/services/storage/cloud-media-storage.ts` vs. the sibling
`apps/web/src/lib/studio/media-storage.ts`), the rate-limit table
(`apps/web/src/lib/rate-limit.ts`), and the auth config
(`apps/web/src/lib/auth/server.ts`). Cross-checked against existing test coverage
(`apps/web/src/app/api/version-control/__tests__/collaboration-routes.test.ts`,
`apps/web/src/app/api/version-control/repos/[repoId]/__tests__/vc-routes.test.ts`) to
confirm what a prior pass already fixed/covers (the "H1" write-authorization-on-public-repo
regression test, IDOR tests on `sync`, batch/size caps on `commits`/`media` upload) versus
what's still open. No code was changed; no database, R2 bucket, or prod environment was
queried — findings about the R2 delivery URL are inferred from source + `docs/DEPLOY.md`,
not verified against the live bucket.

**Important scoping correction found during the audit:** `NEXT_PUBLIC_FEATURE_COLLAB` only
gates the *invite/sharing* entry points (the "Teamwork" button and
`ShareProjectDialog` in `version-control-drawer.tsx:249-267`, the shared-projects list in
`shared-projects-section.tsx`, and `SharedProjectProvider` in
`app/editor/[project_id]/page.tsx:51`). **"Cloud sync" itself — creating a repo, pushing
commits/branches/tags/media — is explicitly *not* flagged** (see the comment at
`version-control-drawer.tsx:249-251`: *"Version control itself (sync, commit, branches)
stays."*). Every beta user can already reach the full `repos/[repoId]/**` API surface today,
flag or no flag. Findings below are labeled **[live today]** vs **[collab-only]**
accordingly — the live-today ones are not something ADR-003 is protecting against and should
be fixed independent of the un-hide decision.

## Route / permission inventory

| Route | Methods | AuthZ gate | Notes |
|---|---|---|---|
| `repos/route.ts` | GET, POST | session only; GET scoped to `userId` | Repo creation always sets `userId: session.user.id` server-side — no mass-assignment |
| `repos/[repoId]/branches/route.ts` | GET, POST | `checkRepoAccess` (GET), `checkRepoWriteAccess` (POST) | 403-vs-404 pattern (doesn't leak private-repo existence) |
| `repos/[repoId]/branches/[name]/route.ts` | PUT, DELETE | `checkBranchPushPermission` | Handles protected branches + branch-level permission rows |
| `repos/[repoId]/commits/route.ts` | GET, POST | `checkRepoAccess` (GET), `checkRepoWriteAccess` (POST) | Full zod schema validation, 200-commit batch cap, 2 MB/commit + 32 MB body caps, rate-limited (`vc:commits`) |
| `repos/[repoId]/commits/[commitId]/route.ts` | GET | `checkRepoAccess` | Commit scoped by `and(repoId, commitId)` — no cross-repo leak |
| `repos/[repoId]/fork/route.ts` | POST | `checkRepoAccess` | Re-keys all commit/branch/tag ids atomically in a transaction; rate-limited (`vc:fork`, 3/min·30/day) |
| `repos/[repoId]/media/route.ts` | GET, POST | `checkRepoAccess` (GET), `checkRepoWriteAccess` (POST) | POST verifies the anchor commit belongs to *this* repo before attaching refs |
| `repos/[repoId]/members/route.ts` | GET, POST | `getRepoRole` (any role for GET, `owner` for POST) | Invite POST is rate-limited (`vc:invite`, 5/min·100/day), capped at 25 members/repo |
| `repos/[repoId]/members/[userId]/route.ts` | DELETE, PATCH | `getRepoRole` (owner, or self for DELETE) | Role PATCH schema only allows `editor`/`viewer` — cannot mint an `owner` |
| `repos/[repoId]/sync/route.ts` | POST | `checkRepoAccess` (pull), `checkRepoWriteAccess` (push, conditional on payload) | **Weaker validation than `commits/route.ts`** — see Finding 4 |
| `repos/[repoId]/tags/route.ts` | GET, POST | `checkRepoAccess` (GET), `checkRepoWriteAccess` (POST) | — |
| `repos/[repoId]/tags/[name]/route.ts` | DELETE | `checkRepoWriteAccess` | — |
| `invitations/[inviteId]/route.ts` | POST (accept/decline), DELETE (revoke) | email-match (accept/decline), `getRepoRole === "owner"` (revoke) | See Finding 3 — accept trusts `session.user.email` with no verification requirement |
| `media/route.ts` (global upload) | POST | session only, no repo scoping | By design (content-addressable, dedup before any repo reference exists); rate-limited (`vc:media`, 20/min·300/day), 200 MB cap |
| `media/[hash]/route.ts` | GET | **session only — no repo/membership check at all** | See Findings 1–2 |
| `shared/route.ts` | GET | session only, scoped to `session.user.email`/`session.user.id` | Lists the caller's own pending invites + memberships only |

## Findings

| Severity | Location | Issue | Fix needed |
|---|---|---|---|
| **HIGH** [live today] | `apps/web/src/app/api/version-control/media/[hash]/route.ts:8-36` | GET has **no repo/membership authorization** — only checks `session?.user` exists, then redirects to the stored object for *any* hash. Media is a single global content-addressable table (`vc_media_objects`) shared across every repo, public or private, collab or solo. Any signed-in Byorn account can fetch any media object if it learns the hash, with zero check that the caller has any relationship to a repo referencing it. | Scope the route to a repo (`/repos/:repoId/media/:hash`) and call `checkRepoAccess(repoId, userId)` before redirecting, or otherwise verify the caller holds a role on at least one repo whose manifest currently references the hash. |
| **HIGH** [live today] | `apps/web/src/services/storage/cloud-media-storage.ts` (`uploadMedia`/`getMediaUrl`, ~L105-163) vs. `apps/web/src/lib/studio/media-storage.ts` | `storageUrl` stored in `mediaObjects.storageUrl` (and served by Finding 1's redirect) is the **raw, unsigned R2 S3-API endpoint** (`https://{accountId}.r2.cloudflarestorage.com/{bucket}/media/{hash}`), not a presigned or `R2_PUBLIC_BASE_URL` URL. This file already implements `presignGetUrl()` (L202-207) but the VC media path never calls it — unlike the sibling `lib/studio/media-storage.ts`, which correctly branches on `R2_PUBLIC_BASE_URL`/falls back to a time-limited presigned URL (per `docs/DEPLOY.md:229`). Today this most likely **fails closed** (the raw S3-API endpoint requires SigV4 auth that the browser's redirect-follow never attaches, so collab media pulls in `pullProjectMedia` probably 403 in production) — a functional bug, not a live leak, best-effort verified from source only. But it is a landmine: whoever "fixes" the resulting broken-media-download bug by pointing this at a public bucket without also fixing Finding 1 turns it into an unauthenticated, cross-repo, cross-user leak of every VC media file ever uploaded. | Switch `uploadMedia`/`getMediaUrl` to `presignGetUrl` with a short TTL (matching the `lib/studio/media-storage.ts` pattern), **and** land Finding 1's authorization check — neither fix alone is sufficient. |
| **HIGH** [collab-only, sharpened by un-hide] | `apps/web/src/lib/auth/server.ts:74` (`requireEmailVerification: false`) × `apps/web/src/app/api/version-control/invitations/[inviteId]/route.ts:48` | Invite accept trusts `session.user.email` with no verification requirement. Since new accounts can sign up with *any* unverified email address, an attacker who signs up as `victim@example.com` before the real victim does (or in a race with them) can accept a pending invite addressed to that email and gain `editor`/`viewer` access to the shared project's full commit history + media — this is a data-access takeover, not just a credits-abuse vector. `requireEmailVerification: false` is an existing, deliberate, documented platform-wide beta posture (not introduced by collab), but collab is the first surface where an unverified email directly buys access to another user's private data rather than just app usage. | Before un-hide: either require a verified email specifically at invite-accept time (cheapest, scoped fix — check `session.user.emailVerified` in the POST accept handler), or flip `requireEmailVerification` globally once the sending domain is ready (larger, already-tracked platform change per the inline comment). |
| MEDIUM [live today] | `apps/web/src/app/api/version-control/repos/[repoId]/sync/route.ts:19-28,94-170` | `pushCommits`/`pushBranches`/`pushTags` are typed `z.array(z.unknown())` — no per-field schema validation, unlike the sibling `commits/route.ts` (`createCommitSchema`, full zod shape + 2 MB/commit cap). Fields are blind-cast (`as string`, `as boolean`, …). Still gated by `checkRepoWriteAccess` (not an authz bypass), but a malformed/oversized payload can slip through this path that the `/commits` endpoint would reject, and there's no per-item size cap (only the 32 MB whole-body cap + 200-item array cap). | Reuse `createCommitSchema`/equivalent branch/tag schemas in the sync route so both push paths enforce the same shape and per-item size bound. |
| MEDIUM [live today] | `apps/web/src/app/api/version-control/repos/[repoId]/sync/route.ts:97-127`; `apps/web/src/lib/db/schema-version-control.ts` (`vc_commits.id` is a global PK, not `(repoId, id)`) | Client supplies the pushed commit's `id` directly; `vc_commits.id` is a table-wide primary key (confirmed via the fork route's re-keying comment: "Commit ids are the table's GLOBAL primary key"). A client that supplies an `id` colliding with a commit in a *different* repo hits `onConflictDoNothing()` and silently no-ops rather than erroring — masking a legitimate push as a false "already synced." Not an authz bypass (UUID collision is impractical to engineer), but worth hardening before scaling past a small trusted cohort. | Scope the insert conflict target to `(id)` but assert `repoId` matches on conflict (e.g. `ON CONFLICT (id) DO NOTHING WHERE repo_id = excluded.repo_id`, or check-then-insert), or move to a natural composite key. |
| MEDIUM [live today] | `apps/web/src/lib/db/schema-version-control.ts` (every VC table calls `.enableRLS()`) vs. `apps/web/migrations/*.sql` | Every VC table is annotated `.enableRLS()` in the Drizzle schema, but **no migration ever runs `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` or `CREATE POLICY`** (grepped all of `apps/web/migrations/*.sql` — zero matches). RLS is not actually active at the Postgres level; all multi-tenant isolation lives exclusively in the application-layer helpers (`getRepoRole`/`checkRepoAccess`/`checkRepoWriteAccess`/`checkBranchPushPermission`). That's a single point of failure with no DB-layer backstop — exactly the kind of gap Finding 1 is an instance of. | Either land real RLS policies that mirror the app-layer role logic (defense in depth), or drop `.enableRLS()` so the schema doesn't imply a protection that isn't there. |
| MEDIUM [collab-only] | `apps/web/src/lib/rate-limit.ts:148` (`"vc:invite": { perMinute: 5, perDay: 100 }`) | 100 invite emails/account/day is generous relative to the current <20-user trusted beta — immaterial today, but sized for a much larger cohort. A compromised or malicious account becomes a modest `sendEmail` spam vector (`repos/[repoId]/members/route.ts:238-249`) once invites are user-reachable. | Tighten before a wider/public collab launch (e.g. cap by unique-repo-per-day, or lower the daily ceiling to match expected team sizes). Not blocking for a still-small, still-trusted cohort. |
| LOW | `apps/web/src/lib/db/version-control-utils.ts:216-229` (`checkRepoOwner`) | Exported helper with **zero call sites** in any route (only referenced in a test comment). Not itself a vulnerability, but it duplicates/overlaps `getRepoRole`/`checkRepoWriteAccess` and risks a future contributor assuming it's wired into an existing gate when it isn't. | Prune, or wire it in where "owner-only, never public" semantics are needed (its doc comment implies it was meant for tag/branch admin gates that currently use `checkRepoWriteAccess` instead, which *is* satisfied by public-repo write permission — worth a deliberate look, not an urgent one). |
| LOW | `apps/web/src/components/editor/dialogs/shared-project-onboarding.tsx` | Step-through dialog (Back/Next/Skip/"Create my branch") has no custom keyboard navigation beyond whatever Radix's `Dialog` provides for free (focus trap, Esc-to-close). Same class of gap as the historical BUG4. Not a security issue — noted per instructions, not fixed here. | Out of scope for this packet. |
| **Confirmed OK** | `apps/web/src/components/editor/shared-project-provider.tsx:34,38` | The client-side `sharedRole` read from local IndexedDB (`VersionStorage.getMeta("sharedRole")`) only drives UI affordances (e.g. hiding the onboarding dialog's branch-creation step for viewers). All real enforcement is server-side via the `check*` helpers — a tampered/faked local `sharedRole` cannot grant a viewer actual write access; the server still 403s via `checkRepoWriteAccess`/`checkBranchPushPermission`. | No fix needed. |
| **Confirmed OK** | `apps/web/src/app/api/version-control/repos/[repoId]/members/[userId]/route.ts:71-122`, `invitations/[inviteId]/route.ts:67-73` | No privilege-escalation path to `owner` via invite acceptance or role PATCH — both are hard-capped to `z.enum(["editor","viewer"])`. Owner is implicit (`projectRepositories.userId`) and never a `project_members` row. | No fix needed. |
| **Confirmed OK** | All `repos/[repoId]/**` routes | Consistent 403-vs-404 discipline (`visible ? "Forbidden" : "Not found"`) so private-repo existence isn't leaked to non-members via status code. Repo creation, tag `createdBy`, and commit `authorId`/`authorName`/`authorAvatar` are always server-derived from `session.user`, never client-supplied — no mass-assignment found anywhere in the surface. | No fix needed. |

## Un-hide recommendation: **GO-with-fixes**

Not a clean GO: the invite-hijack path (Finding 3) is a genuine "attacker ends up with a
real user's private project" vector, and the media authorization gap (Findings 1–2) — while
already live today independent of the flag — becomes materially more exposed the moment
invite-based sharing multiplies the number of legitimate per-repo "hash holders." Not a
NO-GO either: the core `repos/[repoId]/**` write/read surface (branches, commits, tags,
fork, sync-push) is consistently and correctly gated, has 403-vs-404 IDOR discipline, has
existing regression tests for the scenarios that matter (the "H1" public-repo
write-authorization test, sync IDOR tests, batch/size caps), and has no mass-assignment
anywhere. The three UI gate points ADR-003 specified are all still correctly wired
(`shared-projects-section.tsx`, `version-control-drawer.tsx`'s Teamwork button +
`ShareProjectDialog`, `SharedProjectProvider`/`shared-project-onboarding.tsx` via
`app/editor/[project_id]/page.tsx:51`) — confirmed by direct grep, not assumed.

**Ordered fix list before flipping `NEXT_PUBLIC_FEATURE_COLLAB`:**

1. Finding 3 — require verified email at invite-accept (scoped, cheap fix — this is the
   one that directly hands a stranger another user's private project).
2. Findings 1 + 2 together — add repo-membership authorization to the media GET route and
   switch it to presigned delivery. Fix both in the same change; either alone leaves the
   other exploitable/broken.
3. Finding 7 (recommended, not strictly blocking at <20 users) — tighten the invite rate
   limit before any cohort growth.

**Should-fix-soon, non-blocking for un-hide:** Findings 4, 5, 6 (sync-route validation
parity, global commit-id collision hardening, and either landing real RLS or dropping the
`.enableRLS()` annotation that currently overstates the DB-layer protection). These affect
the already-live cloud-sync surface regardless of the collab flag and should be tracked
independent of this decision.

**Not blocking, no action required by this packet:** Finding 8 (dead `checkRepoOwner`
helper) and the keyboard-nav note on `shared-project-onboarding.tsx`.

## Hard gate

**This packet performs no code changes, flips no flags, and un-hides nothing.** It is
audit input only. The decision to flip `NEXT_PUBLIC_FEATURE_COLLAB` — with or without the
fixes above landed first — belongs to the user.
