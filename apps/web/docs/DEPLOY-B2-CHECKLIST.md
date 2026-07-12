# B2 First-Production-Deploy Checklist

> ✅ **DONE 2026-07-13.** Live at `https://byorn-liart.vercel.app` (public, Vercel Authentication
> disabled). Kept below as the reference runbook for future deploys/re-provisioning — see
> `PROD-READINESS.md`'s B2 row for the full completion record.

Human-operator checklist for the first-ever prod deploy: Vercel + fresh Neon Postgres (migrations 0001–0009) + Upstash + R2 + Polar + Resend. Target ~30 minutes. Full rationale for every step lives in [`DEPLOY.md`](./DEPLOY.md) — this is the click-by-click distillation.

## 1. Provision

- [ ] **Neon** — new project `byorn`, region near your Vercel region. Connection Details → **Pooled connection** → copy as `DATABASE_URL`.
- [ ] **Upstash** — Create Database (Regional, same region). REST API tab → copy `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
- [ ] **Cloudflare R2** — create bucket (→ `R2_BUCKET_NAME`) → Manage R2 API Tokens → Object Read & Write, scoped to that bucket → `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`; account id from dashboard sidebar → `CLOUDFLARE_ACCOUNT_ID`. Enable public access (custom domain or `r2.dev`) → `R2_PUBLIC_BASE_URL`. Set CORS `AllowedOrigins` to your real domain.
- [ ] **Resend** — create API key → `RESEND_API_KEY`; verify a sender domain, set `EMAIL_FROM` to a verified address on it. Without this, password reset/verify emails only log to the server console.
- [ ] **Polar** (wire if selling credits at launch) — create products, then Webhook endpoint → `https://<your-real-domain>/api/webhooks/polar` (the real deployed domain, not localhost/preview) → signing secret into `POLAR_WEBHOOK_SECRET`; org access token → `POLAR_ACCESS_TOKEN`.
- [ ] **Vercel project** — Add New → Project → import GitHub repo `elemenopiz/ai-native-opencut`. Root Directory = `apps/web`, keep "Include source files outside Root Directory" **enabled** (needs `packages/env`, `packages/ui`). Framework: Next.js (bun auto-detected).
- [ ] `BETTER_AUTH_SECRET` — generate fresh, never reuse dev value: `openssl rand -base64 32`.
- [ ] `NEXT_PUBLIC_SITE_URL` — exact deployed URL (scheme, no trailing slash).

## 2. Env vars — paste into Vercel (Project → Settings → Environment Variables, Production)

`NEXT_PUBLIC_*` vars are baked in at **build** time — set before deploying.

**REQUIRED** (boot fails without these): `DATABASE_URL`, `BETTER_AUTH_SECRET`, `NEXT_PUBLIC_SITE_URL`. (`NODE_ENV` — do not set, Vercel sets it.)

**STRONGLY RECOMMENDED** (beta degrades hard or breaks without these):
- [ ] `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — else in-memory rate limiting per serverless instance (weak on Vercel).
- [ ] `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL` — else uploads/rehosting fail.
- [ ] `RESEND_API_KEY`, `EMAIL_FROM` — else no self-serve password reset.
- [ ] `GEMINI_API_KEY` — Director's auto brain-chain is frontier → Gemini → **loud config error** (no local-Ollama fallback anymore); the native-Gemini asset-understanding path and podcast find-best-clips/keywords are Gemini-homed. Missing this degrades or errors all three.
- [ ] `ANTHROPIC_API_KEY` — Director's frontier brain; without it the chain still works via Gemini alone, but you lose the primary brain.
- [ ] `BYTEPLUS_API_KEY` — default Studio video backend (Seedance); inert without it.
- [ ] `OPENAI_API_KEY` — default Studio image backend (GPT Image); inert without it.
- [ ] At least one of the two provider keys above is needed for generation to be usable at all.

**OPTIONAL** (inert/graceful default — add only if enabling the feature):
- [ ] `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_ORGANIZATION_ID`, `POLAR_SERVER` (default `sandbox`)
- [ ] `MOONSHOT_API_KEY`, `DIRECTOR_MODEL`, `PEXELS_API_KEY`, `FREESOUND_CLIENT_ID`/`FREESOUND_API_KEY`, `MARBLE_WORKSPACE_KEY`, `NEXT_PUBLIC_GA_MEASUREMENT_ID`, `MODAL_TRANSCRIPTION_URL`
- [ ] `ADMIN_EMAILS`, `CREDITS_ENFORCED` (default `true`), `TRUSTED_PROXY_HOPS` (default 1 — correct for Vercel), `R2_MAX_STORAGE_BYTES`
- [ ] Partner backends: `KLING_ACCESS_KEY`+`KLING_SECRET_KEY`, `RUNWAY_API_KEY`, `LUMA_API_KEY`, `FAL_KEY`, `BFL_API_KEY`, `IDEOGRAM_API_KEY` (+ their `*_BASE_URL`/`*_MODEL` overrides, `GEMINI_BASE_URL`/`GEMINI_VEO_MODEL`/`GEMINI_IMAGEN_MODEL`/`GEMINI_NANO_BANANA_MODEL`)
- [ ] `NEXT_PUBLIC_UNDERSTANDING_MODEL` (understanding-pass model override), `LOG_LEVEL` (server log verbosity), `GIT_SHA` (Vercel auto-injects `VERCEL_GIT_COMMIT_SHA`; only needed on non-Vercel hosts)

Full descriptions/consequences for every var: `DEPLOY.md` § Environment variable matrix.

## 3. Provider keys — spend caps

Set a spend/usage cap in each console before flipping the switch, so a runaway loop or abuse can't produce a surprise bill:
- [ ] **BytePlus** ModelArk console → usage/billing limits
- [ ] **Anthropic** console.anthropic.com → Settings → Limits
- [ ] **OpenAI** platform.openai.com → Settings → Limits (usage cap)
- [ ] **Gemini** (Google AI Studio / Cloud) → set a budget alert or quota

## 4. Deploy + migrate

- [ ] Click **Deploy** in Vercel. A missing required var fails the build with a named zod error — that's expected validation, not a bug.
- [ ] Apply migrations 0001–0009 to the fresh Neon DB **from your machine** (no auto-migrate on boot):
  ```sh
  cd apps/web
  DATABASE_URL="<the Neon pooled URL>" bunx drizzle-kit migrate
  ```
- [ ] Verify the chain actually landed (a skipped/unjournaled migration exits cleanly and lies to you):
  ```sh
  psql "$DATABASE_URL" -c "
    SELECT (SELECT count(*) FROM drizzle.drizzle_migrations) AS applied,
           (SELECT to_regclass('public.credit_ledger') IS NOT NULL) AS credits_ok,
           (SELECT count(*) = 2 FROM information_schema.columns
             WHERE table_schema='public' AND column_name='owner_id'
               AND table_name IN ('takes','board_items')) AS tenancy_ok;"
  ```
  `applied` must equal the journal's entry count; both booleans `t`.

## 5. Post-deploy smoke gate — health MUST be green before any clicking

`/api/auth/*` is **fail-closed** on Redis in production: if `UPSTASH_REDIS_REST_URL`/`TOKEN` are set but Upstash is unreachable, every auth POST throws `ECONNREFUSED` and returns 500 — a mystery outage, not an obvious error. Check this first, every time.

- [ ] `curl https://<your-domain>/api/health` → expect **HTTP 200** with `{"ok":true,"db":true,"redis":true,...}`.
  - `db:false` → can't reach Postgres; recheck `DATABASE_URL` / Neon IP allowlist.
  - `redis:false` + HTTP 503 → Upstash configured but unreachable. **Stop — do not smoke auth yet.** Recheck `UPSTASH_REDIS_REST_URL`/`TOKEN`.
  - `redis:"not-configured"` → fine for a first smoke (in-memory fallback), but wire real Upstash before real traffic.
- [ ] Only once `redis` is `true` or `"not-configured"`: sign up a test account, confirm login works on the real domain.

## Next: B3

Once this checklist is green, hand off to [`beta-b3-verification-runbook.md`](./beta-b3-verification-runbook.md) for the full B3 verification pass.
