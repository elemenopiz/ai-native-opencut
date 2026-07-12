# Production-Readiness Map — Byorn

> Living state file of the Fable orchestrator. Updated every loop iteration.
> Autonomy level: **aggressive** (auto-integrate low/medium-risk green work to `main`;
> hard gates: migrations, auth, secrets, payments/credits, deletion, push/deploy).
> Started 2026-07-11.

## Rubric scoreboard

| Dimension | Status | One-line reason |
|---|---|---|
| Build & CI | 🟡 | typecheck/build/build:e2e/test:e2e PASS; tooling repaired @6485aeb (biome installed, root `bun run test` 671/671); remaining: 454 biome check errors to triage (#5c) |
| Auth & accounts | 🟢? | login/signup/account/reset/verify all present on main (verified importers); confirm not regressed via recon + e2e |
| Security & tenancy | 🟡 | Downgraded 2026-07-12 (advisor): shared-projects collab @7e1b5b56 added a NEW multi-tenant surface (members/invitations, migration 0008) with no dedicated post-merge security pass — UI hidden for beta per ADR-003, routes stay (session+role gated). Prior state: board/takes `ownerId` tenancy MERGED + PUSHED @48fe173; #6 CLOSED (llm/agent gated since @a2937da); arrangements rate limiting @9217a269. NOT-NULL flip after prod backfill verification |
| Billing/credits | 🟢 | All HIGH+MED audit findings FIXED — MERGED + PUSHED @48fe173 (user-approved, 747/747). LOW findings #6-#9 + #10 on backlog |
| Feature completeness | 🟢 | Unbuilt-UI inventory resolved: all Cat-B panels wired (verified importers 2026-07-11); only E1/E2 dead code remains |
| Error handling & UX | 🟢 | Invalid-key UX fixed (sounds 401 w/ actionable message; songs warning banner); ccMixter fixed end-to-end (allowlisted proxy for hotlink-403/no-CORS + X-JSON header-overflow fix). Follow-up: eyeball the two new UI states in browser |
| Data & migrations | 🟡 | 0007 applied to LOCAL dev DB 2026-07-11; journal drift FIXED @5a8b35c1 (scratch-DB proof: all migrations apply). NEW 2026-07-12: migration **0008** (collab members/invitations + previously-unjournaled vc_* tables) landed @7e1b5b56 — ships with first deploy. Prod has applied NOTHING yet (deploy = 0001–0008 fresh) |
| Reliability & perf | 🟡 | STALE-ROW FIX 2026-07-12 (cofounder-architect): perf-fix waves A+B MERGED 2026-07-11 (timeouts/maxDuration/caps/rate-limits/N+1), plus playback/compositor perf wave on main @75e7d287 (resolution scaling, decode tiers, prefetch ring, canvas pooling; measured 28.4fps@30). Remaining: async-persona-still (money-gated #14, deferred past beta per ADR-005 — draft branch in flight, see cofounder-architect section), providerJobId index (migration packet) |
| Observability | 🟡 | MERGED @f743382 (2026-07-11, advisor session): structured JSON logging, onRequestError server capture, error boundaries, rate-limited client-error intake w/ secret redaction; verified tsc 0 + 702/702 + prod build. Also fixed: removeConsole was stripping ALL prod console output. Remaining: vendor alerting deferred by ADR-002 (one-file adapter when user picks provider) |
| Config & deploy | 🟢 | MERGED @e20a0c3 (2026-07-11, advisor session): env schema reconciled (27 vars added, .env.example complete w/ what-breaks notes), DEPLOY.md runbook (Vercel+Neon+Upstash+R2 primary, Docker alt), DB-checked /api/health (live-smoked 200 {ok,db:true}), drizzle prod-env-ordering fix (migrations would have hit dev DB). Verified tsc 0 + 702/702 + prod build w/ placeholder env. Remaining: the actual first deploy (human gate) |
| Tests | 🟢 | Auth-path coverage LANDED @ebb168e3 (2026-07-12, cofounder-architect, =B4): 401 sweep w/ new-route classification guard (61 method cases), better-auth flow integration vs real Postgres (13), auth-lifecycle e2e (4) + fixed pre-existing e2e RED on main (onboarding key v2→v3 broke happy-path). Post-merge: 1121/1121 unit. Money-path tests exist on gated `fix/credit-audit-money-gated` branch |

## ⭐ BETA COMMIT + pre-beta register (2026-07-12, advisor — supersedes backlog ordering below)

**Committed 2026-07-12 with user:** beta in **~1 week (~2026-07-19), <20 trusted users**.
Scope = **core edit loop + export** and **Director/AI generation**. Collab and local-AI
are OUT (ADR-003, ADR-004). Risk posture: ship-fast, floors hard. Sequencing is
ADR-005; the short version, in order:

| # | Item | Class | Effort | Floor | Owner |
|---|---|---|---|---|---|
| B1 | Reach pushable tree: local-AI session stops at clean point (ADR-004), collab UI flag-off (ADR-003: `NEXT_PUBLIC_FEATURE_COLLAB` default-off in `packages/env/src/web.ts`, gate `shared-projects-section` / `version-control-drawer` share dialog / `shared-project-onboarding`), battery, push (origin is 19+ commits behind). **Collab flag-off LANDED on main @f13917bf (feat d8569985): env flag + `lib/feature-flags.ts` (+test) + gates on all 4 collab entry points incl. per-project Share dialog; API routes untouched/live; battery green — typecheck, 1246 unit pass/0 fail, build.** ✅ **B1 COMPLETE 2026-07-12: user-approved push, origin/main f02dfc4f → 73706b6f (35 commits: local-AI freeze, health preflight, frame extraction, flag-off, migration 0009).** | BLOCKER | S | data | ✅ DONE |
| B2 | **First prod deploy by 2026-07-14** per DEPLOY.md (Neon fresh **0001–0009** — 0009 delete-floor packet MERGED @73706b6f, user-approved after opus review, scratch-DB-proven; R2, Upstash, Polar webhook @ real URL, RESEND_API_KEY, provider keys + spend caps) ✅ **B2 COMPLETE 2026-07-12 (advisor session, user-directed): LIVE at `https://byorn-liart.vercel.app`** — Vercel project `byorn` (root `apps/web`, git-linked, NO vercel.json — the 8 Python services deliberately not deployed per ADR-004), Neon migrated 0000–0009 + verified (applied=10, credits_ok, tenancy_ok), 18 prod env vars (fresh BETTER_AUTH_SECRET; NEXT_PUBLIC_* provider keys deliberately NOT promoted — browser-exposed). **Deployment smoke ALL GREEN on @e4576eb9**: `/api/health` `{ok,db:true,redis:true}`; signup→session→delete-account round-trip on prod Neon; 401s (gemini/credits unauth) + **402 `insufficient_credits` on zero-credit generate (money floor proven)**; live Gemini + Kimi relay responses (both keys valid); enhance-prompt full rewrite; sitemap on real host, 0 localhost; browser pass homepage→projects→editor shell, **zero console errors**. ⚠️ Residual: **Vercel Authentication still ON** (`all_except_custom_domains`, no custom domain owned) — user must toggle off in dashboard before invites; smoke used a protection-bypass secret. EMAIL_FROM default `noreply@byorn.app` unverifiable on Resend (user owns no byorn domain) — reset emails won't deliver until a sender domain is verified. Polar inert (sandbox), FREESOUND key promoted (Songs stays). | BLOCKER | M | data/money | ✅ DONE |
| B3 | Hands-on core-loop verify ON the deployment: real media → edit (mask/transition/speed-ramp) → **real export → play the file**; one real paid Director generation with reserve→settle observed. (e2e export asserts a STUB; real encode machine-verified LOCALLY ✅ 2026-07-12 @80118e7f — remaining risk is production-only: CSP/COOP-COEP/HTTPS gating) | BLOCKER-class verify | S | core-loop | user + Orchestrator |
| B4 | Auth insurance: discard dead `worktree-agent-abc79021bb8a6f12c`, re-run auth-tests brief (401 sweep, signup/login/logout e2e, delete-account, reset-leak). Test-only | degrades | S | auth | Orchestrator |
| B5 | Remaining days: fix only what B2/B3 surface; nothing new lands | — | — | — | all |

**Deliberately deferred past beta (ADR-005):** #14 async persona-still + credit LOWs
#6–#10 (residual failures under-charge US, never users), #13 NOT-NULL flip, #5c biome.
Songs tab = deploy-day call (fresh FREESOUND key or hide).

**Beta onboarding packet (user-directed, 2026-07-13, branch `beta-gate-credits`, final
shape after two product pivots):** `src/proxy.ts` is a DOUBLE DOOR — (1) whole site behind
shared 4-digit code **6715** (`BETA_ACCESS_CODE`, /beta-gate page, server-checked POST
/api/beta-gate, per-IP rate-limited `beta:gate` 5/min·60/day, httpOnly year cookie), then
(2) forced signup: no session ⇒ /signup?redirect= (auth+legal pages exempt; E2E builds
exempt — runner can't mint sessions). **650-credit signup grant** (user.create.after hook,
idempotent `grant:signup:${userId}`; ≈$5 Seedance = 10×5s clips + ≈$1.50 Nano Banana Pro
≈10 images; balance fungible, split enforced by pricing); **owner unlimited**:
zsrumishaikh@gmail.com gets 1,000,000 cr at signup (signupGrantFor). Image model =
**Nano Banana Pro (gemini-3-pro-image)**, bills 14 cr/image, panel speaks 1K/2K+aspect
ratios, GPT Image de-branded everywhere; /api/studio/image routes through the registry,
n clamped 1–4, default quality 1K. **Gemini surface trim**: ONLY Director chat, image gen,
enhance-prompt may call Gemini — Understanding Pass + Insights tab + Podcast AI gated off
(FEATURE_UNDERSTANDING_PASS / FEATURE_PODCAST_AI, default off, env-re-enablable).
⚠️ Post-deploy: (a) set nothing new — code default is 6715; override via BETA_ACCESS_CODE
if rotating; (b) accounts created BEFORE this ships got no grant — top up via
POST /api/admin/credits/grant; (c) watch the BytePlus balance — grants are first-come
against the $25 pool.

## 🧊 Architect session (2026-07-12, late) — push #3, FEATURE FREEZE, B2 prep

**Push record (user-approved):** origin/main `73706b6f → 80118e7f`. Carried the 17 commits
that landed after the B1 push: native Gemini 3.5 Flash Director brain + `/api/llm/gemini`
relay (@d92c2e76), understanding-model seam (@419c6200), Ollama-fallback retirement
(@af7ae65b), phase-scoped Gemini tools (@3229d1ff), Director speech grounding (@38aadbf9),
dark-only theme (@e21d4d36), Understanding-Pass delete fix (@42a93175), podcast-on-Gemini
(@7a4c7647), single "Direct" surface (@80118e7f). Battery on the pushed tip: tsc 0,
1348/0 unit, prod build clean. ⚠️ Coordination incident (minor): the director-single-surface
merge landed on main BETWEEN battery and push, so the push carried 2 commits beyond the
user-approved set; re-verified green post-hoc and reported to user. Lesson: re-check `git
log -1` immediately before `git push` in this shared tree.

**🧊 FEATURE FREEZE IN EFFECT (user-ratified with this push): nothing new lands on main
until B3 is green.** This applies to ALL sessions — in-flight worktrees (`fix/scope-playback-perf`,
`fix/db-journal-0006-0007`, etc.) hold at their branches; fix-only merges for what B2/B3 surface.

**B2 live status (user-confirmed 2026-07-12): NOTHING provisioned yet** — no Vercel/Neon/
Upstash/R2. Deadline 2026-07-14. In flight to compress the human gate:
| Agent | Task | Status |
|---|---|---|
| export-sanity (opus) | Runbook §C local REAL-export machine-verify: non-E2E prod build, headless Chromium, ffmpeg fixture w/ audio, Playwright download + ffprobe asserts | ✅ **PASS — first machine-verified real export EVER.** h264+aac, 1280×720@30 == live canvas, 8.000s, A/V drift 0.08s, 2.88MB, full decode clean, 242 gradual progress samples (stub-leak clear). Crown risk retired LOCALLY; remaining export risk is production-only (CSP/COOP-COEP/HTTPS gating) = the human B3 pass. Gotchas folded into runbook @64d2bb01 (anon flow OK, port≠3000 CORS, Upstash placeholder-not-empty zod trap, tour modal blocks Export, canvas adapts to first media). Artifacts in session scratchpad `export-sanity/` |
| b2-packet (sonnet, worktree) | env-var audit + DEPLOY.md Gemini promotion + operator checklist | ✅ **MERGED @53b4c3c6** (tsc 0, 1348/0): schema += `NEXT_PUBLIC_UNDERSTANDING_MODEL`, `LOG_LEVEL`; DEPLOY.md GEMINI_API_KEY → strongly-recommended + stale Ollama-fallback claim fixed; NEW `docs/DEPLOY-B2-CHECKLIST.md` (30-min operator packet). Flagged, human call: `NEXT_PUBLIC_UNDERSTANDING_AUTORUN` read but undocumented (client-only-toggle convention may be intentional) |

**Net position after this session: everything dispatchable before B2 is DONE.** The ladder is
blocked on the human gate: **B2 provision + first deploy (due 2026-07-14) via
`docs/DEPLOY-B2-CHECKLIST.md`**, then B3 on the deployment per the runbook. Local main is 3
ahead of origin (b2-packet merge + 2 docs commits) — batch into the next push.

## Cofounder-architect session (2026-07-12) — push, browser sweep, 2 agents

**Push (B1 half-done, with a caveat):** user-approved push 2026-07-12 — origin/main
fast-forwarded `a65b8015 → d3236b03` (18 commits: homepage final, playback-perf wave,
shared-projects collab, transitions fix, local-AI design docs). ⚠️ This pushed BEFORE the
B1 collab flag-off — irrelevant for exposure (origin is a private repo, no deploy), but
the `NEXT_PUBLIC_FEATURE_COLLAB` flag-off must still land before B2 deploy.

**Browser-verification sweep (the "merged-but-never-eyeballed" backlog)** — driven live
in the Browser pane on a seeded 2-clip project (E2E fixture WebM, port 3105):
- ✅ VERIFIED RENDERING: gl-transitions (badge UI + real mid-transition cross-warp frame,
  no blank frames at the cut), heart/analytic masks (feathered SDF), pen-tool custom mask
  (raster→GLSL feather), text-reveal mask, keyframed scale animation, bezier easing
  (stored + applied), curve-aware keyframe copy/paste (easing survives paste), group
  move + group resize with atomic undo, LUT (`lut-3d` builtin-mono renders grayscale,
  effect badge on clip), subtitle-import panel affordance (+ 27/27 parser tests),
  onboarding v3 + "Direct your first reel" guide, Whisper transcript panel.
- ℹ️ Main-track group-move "no-op" when ALL main clips selected = intended pin-to-0
  clamp (`clampAnchorStartTime`), not a bug.
- ❌ NOT verifiable synthetically (needs owner's B3 hands-on with real media): detach
  audio + beat grid (fixture has no audio stream), on-canvas mask handle drags, the
  bezier value-graph editor UI polish (engine verified).

**Findings (new):**
1. **DURABILITY (S-fix, pre-beta candidate):** an element missing `transform` bricks a
   project PERMANENTLY — `resolveTransformAtTime` crashes in `TransformHandles` AND in
   `VideoNode.renderVisual` via `ProjectManager.loadProject`'s thumbnail render, so the
   project can never load again (raw crash, error boundary doesn't recover it).
   Reached via public `EditorCore.timeline.insertElement` (buildElement spreads+casts,
   no validation). Real-flow risk: any future writer bug/migration miss = user project
   gone. Fix = defensive default in `resolveTransformAtTime` + validate visual elements
   in `InsertElementCommand`. Zombie repro project in local dev storage:
   id `8c48f97e-118c-4191-8273-68c90e1c74ce` (safe to delete).
2. **Onboarding copy:** tour eyebrow reads "BYORN · CAPCUT × HIGGSFIELD" — competitor
   name-drop in user-facing copy, off the serious-editor brand. 1-line fix, batch with
   the papercut pass.
3. Minor: mask not applied during transition-overlap frames (plausibly intended paint
   order); `lut-3d` intensity param default 100 vs API-set 1 scale ambiguity — check
   slider range when consolidating the two LUT systems.

**Agents (this session):**
| Agent | Task | Owned files | Status |
|---|---|---|---|
| auth-tests (=B4) | 401 sweep (61 cases + classification guard for NEW routes), better-auth flows vs real DB, auth-lifecycle e2e; salvaged the dead worktree's untracked files | test files only | ✅ **MERGED to main @ebb168e3**, post-merge 1121/1121 unit; tsc noise = stale `.next/types` referencing deleted roadmap/contributors pages (env artifact, regenerates on build). Also FIXED pre-existing e2e red on main (onboarding key v2→v3). B4 = DONE |
| money-packet | DRAFT-ONLY gated branch: credit LOWs #6–#9 + #14 async-persona-still + money tests | promote/generate/poll routes, ledger, sweep script, credit tests | ✅ DRAFT READY — `fix/credit-audit-money-gated` @822ea00c (6 commits, tsc 0, 1075/1075, build 0). POST-BETA per ADR-005; review flag: promote now priced 3× (1080p multiplier — intended, judgment call) |
| transform-brick fix | 3-layer durability fix: defensive resolveTransformAtTime/opacity defaults + insertElement normalization + deserializeProject load-heal (+11 tests; new dep-light `element-normalize.ts` to avoid a storage-service import cycle) | lib/animation/resolve.ts, insert-element command, storage service | ✅ **MERGED to main @f02dfc4f**, post-merge 1132/1132 unit + **LIVE-VERIFIED: the bricked repro project (8c48f97e) now loads in the browser** with healed elements. Finding #1 above = CLOSED |
| deploy-preflight (opus) | `/api/health` gains Upstash reachability check (`{ok,db,redis}`, 503 when configured Redis is down — auth is fail-closed on Redis in prod) + DEPLOY.md hard pre-smoke step + 6 tests | `app/api/health/**`, `docs/DEPLOY.md`, new test file | ✅ **MERGED @d6ce60c0**; post-merge 1215/1215 unit ON THE COMBINED TREE (includes the local-AI freeze landing @aeb55126 that another session put on local main); live-verified: dev → `{ok,db:true,redis:"not-configured"}` 200, dead-Redis under next start → 503 (agent). B2 smoke now starts at one URL |
| migration-packet (opus, GATED) | DRAFT 0009 `0009_delete_floor_and_takes_job_index.sql`: idempotent `ON DELETE SET NULL` flips on the 5 actor FKs (fixes delete-account 500 for users w/ vc commits; all 5 columns already nullable, readers audited null-safe) + #15 `takes_provider_job_id_idx` | `migrations/0009*`, `_journal.json`, db schema TS, auth-flows test | ✅ **DRAFT READY, AWAITING USER REVIEW** — branch `worktree-agent-aca06305aa9df74bb` @2e317cd0. Scratch-DB proof: fresh 0000→0009 chain clean, idempotent re-run, 23503 bug REPRODUCED at 0008 and delete SUCCEEDS post-0009 w/ denormalized author_name preserved. Tests 14/14 on migrated scratch, loud-skip on 0008 dev DB, full suite 1122/1122 + tsc 0 + build 0. NOT applied to shared dev DB. **Recommend: review + merge BEFORE the first deploy so fresh Neon applies 0001–0009** (delete-account works from day one, no post-deploy migration event) |

**Push record:** 2026-07-12 (second push, user-approved) — origin/main `d3236b03 → f02dfc4f` (6 commits: auth-tests B4 + transform-brick durability fix). ⚠️ SINCE THEN local main advanced to 24 ahead: the local-AI session's ADR-004 freeze landing (@aeb55126 batch incl. cloud TTS + retire-gates) + my health merge @d6ce60c0. Combined tree verified 1215/1215 unit. **Push of this batch = user gate (B1)** — includes the local-AI landing, outside my standing approval.

**⚠️ AUTH DEFECTS found by the 401/flow sweep (product code — NOT fixed, test-only mandate):**
1. **Delete-account 500s for any user who ever made a vc commit** — `vc_commits.author_id` (+ `vc_tags.created_by`, `vc_media_objects.uploaded_by`, `project_members.invited_by`, `project_invitations.invited_by`) have no `onDelete`; FK 23503 aborts the user-row delete, user left intact. Fix = `set null` + **migration** (gated). Beta call: trusted <20 users → acceptable to defer, but it's a deletion-floor item; decide before public.
2. **B2 DEPLOY WARNING — auth is fail-closed on Redis outage in prod mode:** under `next start`, better-auth rate limiting uses Upstash `customStorage`; unreachable `UPSTASH_REDIS_REST_URL` ⇒ EVERY `/api/auth/*` POST 500s. Deploy-day checklist MUST verify Upstash reachability before smoke. Also: CI e2e job has placeholder Upstash env + no Postgres/Redis services (auth e2e self-skips there); local `.env.local` points at dead `localhost:8079`.
3. Papercut: sign-in rate limit (3/10s/IP) surfaces as the same generic toast as a bad password.

## Backlog (ranked)

| # | Item | Rubric | Effort | Risk | Notes |
|---|---|---|---|---|---|
| 1-5b | Recon; sounds/songs UX+CORS; credit audit+fixes; dead code; tenancy; tooling | — | — | — | ✅ ALL DONE + pushed @48fe173 (see done log) |
| 5c | Triage/fix 454 biome check errors (repo-wide) | Build & CI | M | Low | NEXT — tree must be quiet; cofounder deps-wave still owns package.json/bun.lock, and poach-wave merge pending → coordinate before dispatch |
| 11 | Credit LOW findings #6-#9 (+#10 units divergence) | Billing | S-M | Low-Med | money-gated; batch as one draft |
| 12 | Drizzle meta/journal drift cleanup (journal ends 0005; 0006/0007 unjournaled) | Data | S | Med | schema-adjacent → gated; blocks db:generate |
| 13 | ownerId NOT-NULL flip + drop parent-set fallback | Security | S | Med | after prod backfill verified (post-deploy) |
| 14 | Move persona-still + sync image gen behind async job pattern (perf #1 full fix) | Reliability | M | Med | MONEY-GATED (rearranges reserve/settle timing) — bundle with #11 |
| 15 | `takes_provider_job_id_idx` (perf #5) | Reliability | S | Low | migration → fold into #12 journal-cleanup packet |
| 6 | llm/agent route auth gating | Security | S | Med | ✅ ALREADY DONE @a2937da (pre-existing; verified by advisor 2026-07-11 — session check → 401). Replaced by: arrangements anonymous-POST rate limiting, IN FLIGHT (advisor session) |
| 7 | Env schema completeness + deploy runbook | Config | M | Low | ✅ DONE — advisor session, MERGED @e20a0c3, verified green |
| 8 | Observability (error reporting + structured logs) | Observability | M | Low | ✅ DONE — advisor session, MERGED @f743382, verified green; vendor adapter deferred (ADR-002) |
| 9 | Credit-path + auth-path test coverage | Tests | M | Low | after #3 audit report |
| 10 | Push main → origin | Deploy | — | — | ✅ user-approved pushes 2026-07-11; latest @56ef15d1 (advisor batch: journal/onboarding/enhance/guide) — origin in sync |

## In-flight wave (iteration 1)

| Agent | Task | Owned files | Status |
|---|---|---|---|
| recon | build/test baseline (6 commands) | none (read-only) | ✅ DONE — see Build & CI row |
| credit-audit | holds/sweeps/402/admin-grant correctness | none (read-only) | ✅ DONE — see Credit audit findings section |
| tooling-fix | biome install + root test cwd | package.json, bun.lock | ✅ MERGED @6485aeb, verified green |
| dead-code | remove dangling open-copilot action (E1/E2 files were already gone @5014bba) | `lib/actions/definitions.ts` | ✅ MERGED, verified green |
| tenancy-draft | board/takes ownerId schema+migration+scoped queries | branch `sec/studio-board-tenancy` @ab48da1 | ✅ DRAFT READY — user decided (2026-07-11): HOLD merge until credit-fix lands; review both together |
| credit-fix | draft fixes for audit #1/#1b/#2/#3/#4/#5 + tests (MONEY-GATED, user approved drafting 2026-07-11) | promote/generate/poll routes (metering lines), `lib/credits/ledger.ts`, sweep script, credit tests | running |
| sounds-ux | invalid-key UX (sounds+songs) + ccMixter proxy + X-JSON overflow fix | 6 files under sounds scope | ✅ MERGED + pushed @54c0c6f, verified green (687/687, full build battery) |
| deploy-ready (advisor session) | env schema reconcile (50 raw process.env reads vs @byorn/env), health route + DB check, DEPLOY.md, prod build | `packages/env/**`, `.env.example`, `app/api/health/**`, `docs/DEPLOY.md`, scattered env-read callsites (EXCLUDES sounds/songs/studio routes) | ✅ MERGED @e20a0c3 via `advisor-integrate` worktree, verified green (tsc 0, 702/702, prod build, live /api/health 200). Bonus fixes: drizzle prod-env ordering (dev-DB migration trap), metering-test mock.module leak. Handoff note: dead client-side reads of server vars in settings.tsx/template-panel.tsx = separate UI-bug pass. NOT pushed |
| observability (advisor session) | logger + reportError seam, instrumentation onRequestError, global-error/error boundaries, `api/telemetry/error` intake | `lib/observability/**`, `instrumentation.ts`, `app/global-error.tsx`, editor `error.tsx`, `app/api/telemetry/**`, root layout (1-line client hook) | ✅ MERGED @f743382 via `advisor-integrate` worktree (main checkout was busy on integrate/credits-tenancy), verified green (tsc 0, 702/702, prod build). Pushed @48fe173 |
| perf-audit (orchestrator wave 3) | reliability/perf first assessment | none (read-only) | ✅ DONE — see Perf audit findings section |
| auth-tests (orchestrator wave 3) | auth-path coverage: 401 sweep, signup/login/logout e2e, delete-account, reset-leak check | test files only (`__tests__`, `e2e/auth.e2e.ts`); STOPS if product code needs changing | running |
| perf-fix-A (orchestrator wave 4) | shared fetchWithTimeout across ALL studio adapters (#2), fetchBytes 120s+200MB cap (#6), maxDuration on 9 heavy routes (#1-partial), voiceover objectURL leak (#10) | 29 files in lib/studio + routes | ✅ MERGED (post-advisor cbcb9be5), verified 770/770 + tsc 0; push pending final battery |
| perf-fix-B (orchestrator wave 4) | upload size caps + vc rate limits (#3), board N+1 join (#4), fork transaction (#7), commit-push caps (#9), images/search rate limit + Pexels protection (#8) | `api/version-control/**` handlers, `api/studio/upload`, `api/studio/board`, `api/images/search`, RATE_LIMITS table | running |
| journal-fix (advisor session, USER-APPROVED 2026-07-11) | re-journal 0006/0007 + scratch-DB proof + dev-DB bookkeeping reconcile + DEPLOY.md truth pass | `migrations/meta/_journal.json`, `drizzle.config.ts` (comment), `docs/DEPLOY.md` | ✅ MERGED @5a8b35c1, verified in combined battery 814/814 + tsc 0 + build. Scratch fresh-DB proof: all 8 applied, credits+owner_id present. BONUS: dev DB was missing bookkeeping for 0005 too — reconciled, migrate now clean no-op. Backlog #12 journal-half DONE (snapshots for db:generate = separate; snapshots 0001+ never existed) |
| onboarding (advisor session, USER-REQUESTED) | Byorn-specific first-run tour (6 steps, Bible/Director/takes, credits + Local-AI honesty) | `components/editor/onboarding.tsx` (in-place), key bumped v2→v3 | ✅ MERGED @35dec707, verified 808/808 + browser-eyeballed: renders, steps navigate, "Open the Director" CTA confirmed switches panel to Director tab. Note: arrow-key nav didn't respond in browser test (buttons/dots work) — cosmetic, unverified cause |
| prompt-enhance (advisor session, USER-REQUESTED 2026-07-11) | sparkle Enhance button on studio image/video + Director chat; /api/llm/enhance-prompt (auth+rate-limited, Kimi-preferred, un-metered for beta), StyleBible/brief/understanding context, replace-in-field w/ Undo, never auto-submits | `api/llm/enhance-prompt/**`, `enhance-prompt-button.tsx`, 3 surface wirings, RATE_LIMITS `llm:enhance` | ✅ MERGED @07c6e0e5, verified 814/814 + tsc + build; live provider smoke via dev Kimi key: short prompt → rich cinematic prompt confirmed. PAPERCUT: logged-out click fails silently (should toast sign-in) — batch with dead-button audit |
| guide-rebrand (advisor session) | kill old "edit by editing text" pitch: Get-started panel → "Direct your first reel" 4-step (Bible/Director/takes/export), + YouTube template tips | `empty-editor-guide.tsx`, `constants/project-constants.ts` | ✅ MERGED @56ef15d1, verified 814/814 + tsc (copy-only; build verified on branch), browser-eyeballed on-brand. Left format-appropriate transcript tips + feature marketing pages alone (correct call) |

## Perf audit findings (2026-07-11; #1/#2/#3 = launch blockers)

- **#1 HIGH** — no `maxDuration` on any route + sync provider work in request path (persona still 20-60s inside generate; image gen inline) → serverless kill mid-flight, held credits stranded till sweep. Route maxDuration = wave 4; moving still/image behind the async job pattern = MONEY-GATED refactor (backlog #14)
- **#2 HIGH** — zero timeouts/AbortSignal in all studio adapters (provider hang = route hang); no retries anywhere in lib/studio (availability-only). Wave 4
- **#3 HIGH** — VC media upload: uncapped arrayBuffer + no rate limit (multi-GB → OOM + R2 spend); studio/upload uncapped too. Wave 4
- **#4 MED** — board GET N+1 (200+ queries @100 pins). Wave 4 · **#5 MED** — `takes.providerJobId` unindexed on hottest poll query → migration-gated (fold into backlog #12 packet) · **#6 MED** — poll-route rehost buffers whole videos, no timeout/cap. Wave 4 · **#7 MED** — fork: unbounded read + per-row inserts, no txn → partial forks. Wave 4 · **#8 MED** — anonymous /api/images/search burns server Pexels quota (200/hr); no limits on any VC route. Wave 4 · **#9 MED** — commit push unbounded batch/payload. Wave 4 · **#10 LOW** — voiceover objectURL leak. Wave 4
- Verified sound: telemetry intake, sounds proxy (the pattern to copy), studio proxy+ssrf-guard (30s socket timeout), ai-client timeouts, Polar webhook, credit metering ordering, rate-limit lib design, DB indexes (except #5)

## Credit audit findings (2026-07-11, read-only audit; fixes money-gated)

Ledger core verified SOUND: row-locked transactions (no oversell, concurrency-tested), unique idempotency keys, reserve→settle/release lifecycle correct in the 3 metered routes, consistent 402 shape + client gate, server-authoritative pricing, signature-verified Polar webhook.

Open findings (severity — one-liner — anchor):
- **#1 HIGH** — promote-to-1080p route entirely unmetered (paid video gen, user-reachable) — `api/studio/takes/[takeId]/promote/route.ts`
- **#1b HIGH** — promote shares the draft's hold key (setId): a failed promote can release the draft's hold → draft never charged — poll route keys holds by setId not per-job chargeId
- **#2 HIGH** — persona "high" fallback renders a paid still inside the video route before/outside the reserve (free image gen for direct API/MCP callers) — `api/studio/generate/route.ts:150`
- **#3 MED** — sweep release doesn't recheck under lock; settle-then-sweep interleave can double-decrement reserved → inflated spendable — `scripts/sweep-stale-holds.ts:56`
- **#4 MED** — poll-route settle/release errors swallowed (`.catch(console.error)`); job reports completed, hold leaks, sweep later refunds a successful job — `api/studio/generate/[jobId]/route.ts:65`
- **#5 MED** — settlement only happens on client poll; closed tab ⇒ completed video eventually refunded by sweep (sweep can only release, never settle)
- **#6 LOW/MED** — client-supplied `duration` unvalidated; no resolution multiplier in cost table
- **#7 LOW** — still route reserves "worst case" by coincidence; settle > hold silently clamps
- **#8 LOW** — one paid fetch missing gateOn402 (`generation-form.tsx:423`)
- **#9 LOW** — grant paths OK; CLI idempotency-key footgun on identical repeat grants
- **#10 INFO** — director budget (modeled USD) vs ledger (credits) will visibly diverge; consider single source
- **Tests** — no coverage: route-level release-on-failure, poll settlement, sweep (incl. #3 race), settle>hold, promote billing

## Done log

- 2026-07-11: Stale-doc reconciliation — auth UI (Cat-A) SHIPPED on main; bughunt branch fully merged (all 6 BLOCKED items fixed on main); all Cat-B quick-wires landed. `unbuilt-ui-inventory.md` and memory were stale.
- 2026-07-11: Removed 3 merged leftover worktrees + branches (director Understanding-Pass/Bible/Manifest agents).
- 2026-07-11: MERGED @6485aeb — biome 2.1.2 installed (lint runnable for the first time), root `bun run test` fixed (cd apps/web). Verified: lint executes, typecheck 0, 671/671 tests.
- 2026-07-11: MERGED — dangling `open-copilot` ACTIONS entry removed (dead command-palette item; E1/E2 files themselves were already deleted @5014bba). Verified: typecheck 0, 671/671.
- 2026-07-11: Credit-accounting audit delivered (see findings section). User approved drafting HIGH+MED fixes on a gated branch.
- 2026-07-11: MERGED sounds/songs robustness (invalid-key UX + allowlisted ccMixter audio proxy + header-overflow fix; live curl-verified). Combined battery green: typecheck/build/build:e2e 0, e2e 1/1, 687/687 unit.
- 2026-07-11: PUSHED main → origin (38 commits, @54c0c6f) per user's standing "push after green" approval. Note: biome lint executes but carries the 454 pre-existing style errors (#5c backlog) — typecheck/build/tests were the green gate.
- 2026-07-11: User approved (a) local 0007 apply, (b) merge+push of credits+tenancy packet. 0007 applied to local Postgres (columns/indexes/FKs verified; backfill 0 rows).
- 2026-07-11: `integrate/credits-tenancy` built — credit branch + tenancy branch reconciled (2 conflicts: take inserts keep per-job charge id + gain ownerId), then synced with main @f743382 and @e20a0c3. FULL BATTERY GREEN ×3 runs; final: 747/747, typecheck/build/build:e2e 0, e2e 1/1. Landing blocked only on main checkout (advisor worktree) — monitor armed.
- 2026-07-11: DISCLOSURE — orchestrator's second push (54c0c6f→f743382) raced the advisor's local merge and published its observability commits; re-verified green in the combined battery afterward.
- 2026-07-11: LANDED + PUSHED @48fe173 — main fast-forwarded to the verified integration (credit fixes + tenancy + advisor deploy wave). origin/main in sync. All orchestrator worktrees/branches cleaned up.

## Notes for other sessions

- Local `.env.local` FREESOUND_API_KEY appears INVALID (upstream says "Invalid token") — the new songs warning banner will fire until refreshed.
- Uncommitted `AGENTS.md` modification exists at repo root (not orchestrator's; presumed advisor session's — left alone).
- **2026-07-12 — mainline-poach swarm LANDED (ff) on local `main` @`32e1f814`, NOT pushed.** 5 features merged via `--no-ff` (each browser-eyeball PENDING): bezier value-graph easing editor, split/heart/diamond masks + on-canvas handles, preview grid/rule-of-thirds guides (also fixed dead layout-guide-overlay + no-op "Show grid" menu), multi-select group move & resize, detach/extract audio to own track + shortcut-hint tooltips. Source = `OpenCut-app/OpenCut` @ tag `pre-rewrite` (238750c0), MIT (ledger rows 8–13 + NOTICES updated). Gate met: tsc 0 new, 794 unit pass / 11 env-baseline, prod build 0. `lib/media/audio.ts` export-audio gate changed but verified behavior-preserving for pre-existing clips. Your uncommitted WIP (13 files, incl. `AGENTS.md`, `opencut-fork-network-sweep-2026-07-12.md`) was NOT touched by the ff (zero file overlap). Wave 2 (pen-tool freeform mask + text-reveal) may follow.
- **2026-07-12 — Wave 2 LANDED (ff) on local `main` @`a65b8015`, NOT pushed.** Fable orchestrator → 2 Opus agents built custom **pen-tool freeform mask** + **text-reveal mask** (`poach/pen-mask` @`c6be49a5`, merged `--no-ff`). Their Rust/WASM JFA feather isn't portable → built an ORIGINAL WebGL raster→texture→GLSL-Gaussian-feather pipeline (new rasterized-mask branch in `services/renderer/nodes/visual-node.ts`; analytic shape-mask untouched). Ledger rows 16–17 + NOTICES. Gate (with env): tsc 0 new, **992 unit pass / 0 fail**, prod build 0. Integrated against current main after it advanced under me (your keyframe-clipboard @`7445b97c` + subtitle-import @`e5d2f7c9` merges) — zero file overlap. Browser-eyeball of the mask render still PENDING (agents have no browser). **2026-07-12: user-approved PUSH — `origin/main` fast-forwarded `56ef15d1 → a65b8015` (39 commits: my 7 poaches + the concurrent session's keyframe-clipboard/subtitle-import + ~15 older unpushed feature/branding/Whisper commits that had accumulated locally). origin now in sync.** Browser pass verified GRID GUIDE live (3×3 renders/clears) + clean boot/0 console errors; masks/bezier/group-move/detach-audio rest on 99 new unit tests (both existing dev projects lacked a video/multi-clip to drive them) — owner to do final hands-on pass.

## Tenancy draft review packet (branch `sec/studio-board-tenancy` @ab48da1)

- Real hole was narrower than documented: only `board_items` lacked ownership (sets/stills/personas already had `userId`; takes were transitively owned via parent set). Board GET/POST/DELETE were fully cross-tenant.
- Change: `ownerId` (nullable, FK→users, indexed, CASCADE) on `takes` + `boardItems`; board routes filter/stamp/404; take routes prefer denormalized ownerId with legacy parent-set fallback; +13 IDOR tests (26 pass). typecheck 0; apps/web tests 525/525 on branch.
- Migration `0007_studio_tenancy.sql` hand-written (house style — `db:generate` is broken by pre-existing meta/journal drift: journal ends at 0005, 0006 unjournaled). Nullable → lineage backfill → NOT NULL deferred to follow-up. Fail-closed: underivable (anonymous-era) rows become invisible to everyone. Down-SQL documented in-file.
- Reviewer flags: (1) drizzle meta/journal drift = separate cleanup decision; (2) NOT-NULL flip + fallback removal are follow-ups; (3) confirm fail-closed hiding of anonymous-era rows is acceptable.
- Conflict note: credit-fix branch (in flight) also edits promote/generate/poll routes; orchestrator reconciles at integration.

## Cofounder-session poach wave (2026-07-11, separate session — do not collide)

| Branch/agent | Task | Owned files | Status |
|---|---|---|---|
| `worktree-agent-aad73c45558ae564f` | LUT UI wiring (.cube upload + picker + 5 builtin LUTs) | `lib/effects/lut-*`, `definitions/lut-3d.ts`, `types/effects.ts`, `effect-param-field.tsx`, `services/storage/{service,types}.ts`, `core/index.ts` (1-line hydrate) | ✅ green; folded into `integrate/poach-wave` |
| `worktree-agent-a3c6558581819dab0` | 48 gl-transitions shaders (68 total), adapter prelude, per-author MIT attribution | `lib/transitions/**` incl. new `shaders/gl/`, `gl-definitions.ts`, `transitions.tsx` panel labels, `THIRD_PARTY_NOTICES.md` (appended) | ✅ green (WebGL harness 48/48 + build); folded into `integrate/poach-wave` |
| `worktree-agent-af3627faf3b4399b4` | 3 MIT deps (web-audio-beat-detector, smartcrop, signalsmith-stretch) + BPM-grid beat detection (legacy detector kept as fallback) + smartcrop no-face reframe fallback | `package.json`+`bun.lock`, `hooks/use-beat-detection.ts`, `hooks/use-smart-reframe.ts`, new `lib/reframe/smartcrop-fallback.ts`, `THIRD_PARTY_NOTICES.md` | ✅ green (702/702, detect_changes LOW); folded into `integrate/poach-wave` |
| ~~`integrate/poach-wave`~~ | all 3 poach branches | union of above | ✅ **MERGED to main @d5f92a89 (user sign-off 2026-07-11)**; verified ON MAIN: tsc 0, 792/792, build 0. Source worktrees/branches cleaned. Pending: browser eyeball of LUT picker + new transitions + beat grid |
| ~~`feat/pitch-preserved-speed`~~ @47d41266 | chipmunk fix — signalsmith offline pre-stretch through ONE shared seam (`lib/media/pitch-preserving-stretch.ts`) used by BOTH preview & export; also fixed pre-existing preview-speed no-op; WASM vendored to `public/vendor/` (Next bundler corrupts the lib's worklet-blob; sync-pinning unit test); null→graceful pitch-shifted fallback | `core/managers/audio-manager.ts` (private methods only; `mixAudioChannels` HIGH-risk untouched), `lib/media/audio.ts`, new stretch module + vendored .mjs | ✅ **MERGED to main @3fdab8b6 (user sign-off 2026-07-11)**; on-main verify: tsc 0, 808/808. Full battery pre-merge incl. **audible e2e (440Hz stays 440Hz at 2x/0.5x)**. All cofounder-session branches/worktrees cleaned — **wave complete**. Known limits: keyframed speed ramps stay pitch-shifted, >300s slots fall back, reversed clips unhandled (pre-existing) |

Note: two parallel LUT systems now exist (`lut` effect inline picker vs registry-based `lut-3d`) — consolidation is a product decision for the user.

## COORDINATION — resolved 2026-07-11

Advisor released the main checkout; orchestrator landed `integrate/credits-tenancy` (fast-forward) and PUSHED — origin/main @48fe173 now carries: credit fixes + tenancy + observability (f743382) + deploy readiness (e20a0c3). All verified in one combined battery (747/747, full builds, e2e). Earlier push-race disclosure retained in the done log.

⚠️ **Advisor disclosure (2026-07-11, later):** while the orchestrator was merging a perf-fix branch in the main checkout, an advisor merge script's `git merge --abort` fallback fired in the shared checkout. Reflog audit says no damage — the orchestrator's merge had already committed (@970e4c4d) and the abort resolved to a no-op reset-to-HEAD — but if a subsequent in-progress merge silently vanished from your session, this was the cause; re-run it. Advisor has dropped abort-fallbacks entirely; all its merges are now precondition-checked (`test ! -f .git/MERGE_HEAD`) and atomic. **Advisor STOPPED 2026-07-11:** final merge @4b1bf1cc (settings/template-panel dead env reads → provider-keys `serverEnv` booleans) VERIFIED on merged tip — build clean, tsc 0, **792/792**. No advisor work in flight; all advisor branches merged. Unpushed main delta awaits user's next push approval.

## Human gates pending

1. ~~Tenancy draft~~ / ~~credit fixes~~ / ~~push~~ — ALL RESOLVED 2026-07-11.
2. **Push main → origin** (B1) — origin 19+ commits behind as of 2026-07-12; push after collab flag-off + local-AI stop + green battery.
3. **First production deploy** (B2) — target **2026-07-14** per ADR-005; runbook DEPLOY.md.
4. ~~Poach-wave merge sign-off~~ — RESOLVED (merged @d5f92a89 with user sign-off 2026-07-11).
5. ~~llm/agent route auth gating (#6)~~ — RESOLVED (gated since @a2937da).

## Caveats / known follow-ups

- `unbuilt-ui-inventory.md` is now historical; this file supersedes its open-items list.
- ~~Resend email transport deferred~~ STALE (corrected 2026-07-12): `lib/auth/email.ts` exists — Resend when `RESEND_API_KEY` set, console-log fallback otherwise. Auth verify/reset AND collab invites route through it; the key must be set at deploy (B2).
- D1 (studio provider keys env-only) — decide document-vs-build before public launch.
- Import cycles in `core/index.ts` (graph report) — not launch-blocking; refactor later.
- **Test-infra hazard (systemic):** bun `mock.module` is process-global and keyed by resolved path — `credit-metering.test.ts` and `llm-agent route.test.ts` no-op `@/lib/rate-limit` for the whole suite. Any future test needing the REAL rate limiter must re-pin it (see the query-import + `mock.module` pass-through pattern in `arrangements/__tests__/route.test.ts` @cbcb9be5). Bit us once (suite-red 2026-07-11, resolved same hour).
- Dead client-side reads of server env vars in `settings.tsx` / `template-panel.tsx` (always undefined in browser bundle) — UI bug, separate small pass (deploy-ready agent handoff).

## Orchestrator session wind-down (2026-07-11, final)

User called the stop; state at handoff — **origin/main @4b1bf1cc, fully in sync, battery green** (typecheck/build/build:e2e 0, e2e 1/1, unit 792/792).

Landed by this orchestrator today (all verified + pushed): tooling repair (biome install, root test), sounds/songs UX + ccMixter proxy, credit-accounting fixes (all HIGH+MED), board/takes tenancy (+0007 applied to local DB), dead-code cleanup, perf wave (provider fetch timeouts everywhere, rehost cap, maxDuration on heavy routes, upload size caps + VC rate limits/transactions, board N+1 join, Pexels protection, objectURL leak).

**Parked / next session:**
- `worktree-agent-abc79021bb8a6f12c` — auth-tests agent died mid-flight on a session limit; PARTIAL work in that worktree (branch of same name); resume or discard, then re-run the auth-coverage brief (401 sweep, signup/login/logout e2e, delete-account, reset-leak check).
- Gated packet for user review: #11 credit LOW findings, #12 drizzle journal cleanup + #15 providerJobId index (one migration packet), #14 async-persona-still refactor (money), #13 NOT-NULL flip (post-deploy).
- #5c lint triage (454 errors) — still needs a quiet tree (cofounder deps-wave owns package.json).
- Human gates: first prod deploy (DEPLOY.md), poach-wave sign-off (cofounder session).
- Ops note: earlier transient test-suite red (262s run, exit 1) was cross-session contention on the shared local Postgres — rerun was 792/792 in <1s; don't chase it.
