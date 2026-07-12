# Deploying Byorn (apps/web)

Byorn's web app is a Next.js 15 app-router application in a bun/turbo monorepo.
It needs four external services: **Postgres** (data), **Upstash Redis** (rate
limiting + auth session cache — degrades to in-memory without it), **Cloudflare
R2** (media storage), and whichever **AI provider keys** you want live. The
local FastAPI AI backend (`services/ai-backend`) is optional — without it the
app simply shows local-AI features as offline.

Environment variables are validated at boot by `packages/env/src/web.ts`
(zod). If a **required** var is missing the server refuses to start with a
clear validation error; every **optional** var has a default and a documented
degradation. The full matrix is [below](#environment-variable-matrix).

---

## Path A (recommended): Vercel + Neon + Upstash + R2

Total time ~45 minutes. You need: the GitHub repo, and free-tier accounts at
[neon.tech](https://neon.tech), [upstash.com](https://upstash.com),
[dash.cloudflare.com](https://dash.cloudflare.com), [vercel.com](https://vercel.com).

### 1. Postgres — Neon

1. Neon dashboard → **New Project** → name it `byorn`, pick the region closest
   to your Vercel region (default `iad1` = US East → AWS us-east-1).
2. On the project page, open **Connection Details**, select **Pooled
   connection**, and copy the connection string (looks like
   `postgresql://user:pass@ep-xxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`).
3. That string is your `DATABASE_URL`. Keep the tab open — you'll paste it
   into Vercel *and* use it once locally for migrations.

(Supabase works identically: Project Settings → Database → Connection string
→ URI, use the **transaction pooler** variant on port 6543.)

### 2. Redis — Upstash

1. Upstash console → **Create Database** → Regional, same region as above.
2. On the database page, under **REST API**, copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

Skipping this works (the app falls back to in-memory rate limiting) but on
Vercel every serverless instance gets its own counters — set it up for any
real beta.

### 3. Media storage — Cloudflare R2

1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket** → name it
   (e.g. `byorn-media`, must match `R2_BUCKET_NAME`).
2. R2 → **Manage R2 API Tokens** → **Create API Token** → permissions
   **Object Read & Write**, scoped to that bucket. Copy the **Access Key ID**
   (`R2_ACCESS_KEY_ID`) and **Secret Access Key** (`R2_SECRET_ACCESS_KEY`).
3. Your `CLOUDFLARE_ACCOUNT_ID` is in the dashboard right sidebar (or the URL).
4. Public reads (recommended, so generated media gets permanent URLs): bucket
   → **Settings** → **Public access** → either connect a custom domain
   (`media.yourdomain.com`) or enable the `r2.dev` subdomain. Put the
   resulting base URL in `R2_PUBLIC_BASE_URL`. Without it the app falls back
   to time-limited presigned URLs.
5. CORS (required for browser uploads): bucket → **Settings** → **CORS
   policy** → add:

   ```json
   [
     {
       "AllowedOrigins": ["https://your-domain.com"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Add `http://localhost:3000` to `AllowedOrigins` too if you want local dev
   against the same bucket.

### 4. Auth secrets

- Generate the session-signing secret once and save it:

  ```sh
  openssl rand -base64 32
  ```

  → `BETTER_AUTH_SECRET`. Never reuse the dev value; rotating it logs
  everyone out.
- `NEXT_PUBLIC_SITE_URL` must be the **exact public URL** of the deployment
  (e.g. `https://byorn.app` — scheme included, no trailing slash). better-auth
  uses it as base URL and trusted origin; if it doesn't match the domain users
  visit, logins and email links break.

### 5. Vercel project

1. Vercel → **Add New… → Project** → import the GitHub repo.
2. **Root Directory**: set to `apps/web` (Edit → pick the folder). Leave
   "Include source files outside of the Root Directory" **enabled** — the app
   imports `packages/env` and `packages/ui` from the monorepo root.
3. Framework preset: **Next.js**. Vercel detects bun from `bun.lock`; leave
   build/install commands default (`next build` / `bun install`).
4. **Environment Variables** (Project → Settings → Environment Variables,
   scope: Production): paste everything from the
   [matrix](#environment-variable-matrix) marked required, plus any optional
   features you're enabling. Two things people get wrong:
   - `NEXT_PUBLIC_*` vars are **baked in at build time**. They must be set
     *before* the build; changing one later requires a redeploy.
   - Do **not** set `NODE_ENV` — Vercel sets it.
5. Click **Deploy**. The first build doubles as validation: if a required var
   is missing, the build fails with the zod error naming it.

### 6. Database migrations (before first real use, and after every schema change)

Migrations are applied with drizzle-kit **from your machine**, pointed at the
production database (there is no auto-migrate on boot):

```sh
cd apps/web
DATABASE_URL="<the Neon pooled URL>" bunx drizzle-kit migrate
```

Notes:
- `drizzle.config.ts` also reads `.env.production` when `NODE_ENV=production`,
  or `.env.local` otherwise — an explicitly exported `DATABASE_URL` (as above)
  always wins and is the least error-prone way to target prod.
- Run this once **before** inviting beta users, and again any time a new
  migration lands in `apps/web/migrations/`.
- **Verify, don't trust "exits cleanly":** `migrate` only applies what
  `migrations/meta/_journal.json` lists, so a missing journal entry fails
  *silently* — the command succeeds having skipped the migration. After every
  run, assert the chain actually landed:

  ```sh
  jq '.entries | length' migrations/meta/_journal.json   # expected `applied` count (9 as of 2026-07-12)

  psql "$DATABASE_URL" -c "
    SELECT (SELECT count(*) FROM drizzle.drizzle_migrations)            AS applied,  -- must equal the entry count in meta/_journal.json (9 as of 2026-07-12)
           (SELECT to_regclass('public.credit_ledger') IS NOT NULL)     AS credits_ok,
           (SELECT count(*) = 2 FROM information_schema.columns
             WHERE table_schema='public' AND column_name='owner_id'
               AND table_name IN ('takes','board_items'))               AS tenancy_ok;"
  ```

  `applied` must match the journal's entry count and both booleans must be
  `t`; anything else means the journal and the SQL files have drifted — stop
  and reconcile before inviting users.
- Migration files here are **hand-written** (house style), not generated:
  `bun run db:generate` is broken by snapshot drift (only `0000_snapshot.json`
  exists — see the TODO in `drizzle.config.ts`). A new migration is not live
  until its entry is appended to `migrations/meta/_journal.json` with a
  strictly increasing `when` — the SQL file alone does nothing.
- Drift history: `0006_credits` and `0007_studio_tenancy` shipped unjournaled
  and were re-journaled on 2026-07-11; a fresh database now receives the full
  chain (verified against a scratch DB the same day).

### 7. Custom domain

Vercel → Project → Settings → Domains → add your domain, follow the DNS
instructions. Then update `NEXT_PUBLIC_SITE_URL` to the custom domain and
**redeploy** (build-time inlining, see above). Update the R2 CORS
`AllowedOrigins` to match.

---

## Path B (alternative): Docker

`apps/web/Dockerfile` builds a self-contained image (bun build → Next.js
`output: "standalone"` → `node apps/web/server.js` on port 3000). Build from
the **repo root** (the image needs `packages/`):

```sh
docker build -f apps/web/Dockerfile \
  --build-arg FREESOUND_CLIENT_ID=... \
  --build-arg FREESOUND_API_KEY=... \
  -t byorn-web .

docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://..." \
  -e BETTER_AUTH_SECRET="..." \
  -e UPSTASH_REDIS_REST_URL="..." \
  -e UPSTASH_REDIS_REST_TOKEN="..." \
  -e CLOUDFLARE_ACCOUNT_ID="..." \
  -e R2_ACCESS_KEY_ID="..." \
  -e R2_SECRET_ACCESS_KEY="..." \
  -e R2_BUCKET_NAME="byorn-media" \
  -e GIT_SHA="$(git rev-parse HEAD)" \
  byorn-web
```

Caveats:

- **`NEXT_PUBLIC_*` values are baked at image build time.** The Dockerfile
  hardcodes localhost defaults for `NEXT_PUBLIC_SITE_URL` etc. — for a real
  host, edit those `ENV` lines (or add `ARG`s) and rebuild. Runtime `-e` does
  NOT change them.
- The standalone output is **disabled when `NEXT_PUBLIC_E2E=1`**
  (see `next.config.ts` — the e2e build needs plain `next start`). Never set
  that flag for a production image; the image's `server.js` won't exist.
- Migrations are not in the image. Run them from a checkout as in Path A
  step 6.
- `docker-compose.yml` at the repo root also builds the optional local AI
  backend; for a beta you only need the web service + managed Postgres/Redis.

---

## Environment variable matrix

"Required" means the server refuses to boot (zod validation) or a core flow is
unusable. Everything else degrades gracefully as described. All vars are
declared in `packages/env/src/web.ts`; examples in `apps/web/.env.example`.

| Variable | Required? | What breaks without it | Where to get it |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | Boot fails (zod). All persistence. | Neon/Supabase dashboard (pooled URI) |
| `BETTER_AUTH_SECRET` | **Yes** | Boot fails (zod). Sessions unsignable. | `openssl rand -base64 32` |
| `NEXT_PUBLIC_SITE_URL` | **Yes (prod)** | Defaults to `http://localhost:3000` → logins/OAuth/email links broken on a real host. Build-time inlined. | Your deployed URL |
| `NODE_ENV` | Host-set | Boot fails if missing/invalid. | Vercel/`next start` set it — don't set manually |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Strongly recommended | Falls back to per-instance in-memory rate limiting + caches — ineffective on serverless/multi-instance. | Upstash console → REST API |
| `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | Strongly recommended | Uploads + rehosting of generated media fail; generations only live on expiring provider URLs. | Cloudflare dashboard → R2 |
| `R2_PUBLIC_BASE_URL` | No | Media served via time-limited presigned URLs instead of permanent ones. | R2 bucket → Public access |
| `R2_MAX_STORAGE_BYTES` | No (default ≈9.5 GB) | Uploads refused past the cap; `0` disables the guard. | — |
| `TRUSTED_PROXY_HOPS` | No (default 1) | Wrong client IP picked from `x-forwarded-for` if you have >1 proxy layer → rate limits misattributed. | Count your proxy layers (Vercel = 1) |
| `ADMIN_EMAILS` | No | Nobody can grant credits via `/api/admin/credits/grant`. | Comma-separated emails |
| `CREDITS_ENFORCED` | No (default `true`) | `false` = all paid AI actions run free (promo/rollout mode). | — |
| `RESEND_API_KEY` | No | Password-reset / verification emails only logged to server console — users can't self-serve resets. | resend.com → API Keys |
| `EMAIL_FROM` | No (default set) | Sends rejected unless it's a verified sender on your Resend account. | Resend → Domains |
| `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` | No | Payments stay inert (checkout + webhook no-op). Both needed to enable. | Polar dashboard (org token; webhook endpoint secret) |
| `POLAR_ORGANIZATION_ID` | No | Nothing today (token is org-scoped). | Polar dashboard |
| `POLAR_SERVER` | No (default `sandbox`) | Sandbox can never touch real money; set `production` to sell. | — |
| `BYTEPLUS_API_KEY` | No* | Default Studio **video** backend (Seedance) inert. *Some AI provider is needed for the product to be interesting. | console.byteplus.com (KYC required) |
| `BYTEPLUS_BASE_URL`, `BYTEPLUS_SEEDANCE_ENDPOINT_ID` | No | Defaults to the international endpoint / default model. | BytePlus ModelArk console |
| `OPENAI_API_KEY` | No* | Default Studio **image** backend (GPT Image) inert. | platform.openai.com |
| `OPENAI_IMAGE_MODEL` | No (default `gpt-image-2`) | — | — |
| `ANTHROPIC_API_KEY` | No | Director agent falls back to local Ollama brain (needs the AI backend service). | console.anthropic.com |
| `MOONSHOT_API_KEY` | No | When set, Director uses Kimi **instead of** Anthropic. | platform.moonshot.ai |
| `DIRECTOR_MODEL` | No | Uses built-in default model per brain. | — |
| `PEXELS_API_KEY` | No | Stock-photo search 401s unless users paste a personal key in Settings. | pexels.com/api (free) |
| `FREESOUND_CLIENT_ID`, `FREESOUND_API_KEY` | No | Sounds panel search/preview empty. | freesound.org/apiv2/apply |
| `MARBLE_WORKSPACE_KEY` | No | Blog renders empty. | marblecms.com workspace |
| `NEXT_PUBLIC_MARBLE_API_URL` | No (default public API) | — | — |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | No | No analytics. Build-time inlined. | Google Analytics |
| `NEXT_PUBLIC_AI_BACKEND_URL` | No (default localhost:8420) | Local-AI features (Ollama brain, local transcription/TTS) show offline. Build-time inlined. | Wherever you host `services/ai-backend` |
| `MODAL_TRANSCRIPTION_URL` | No | Cloud transcription unavailable. | Modal deployment URL |
| `KLING_ACCESS_KEY`+`KLING_SECRET_KEY`, `GEMINI_API_KEY`, `RUNWAY_API_KEY`, `LUMA_API_KEY`, `FAL_KEY`, `BFL_API_KEY`, `IDEOGRAM_API_KEY` (+ optional `*_BASE_URL`/`*_MODEL`/`RUNWAY_API_VERSION` overrides) | No | That partner backend is never routed to (adapter inert). | Each provider's console |
| `VERCEL_GIT_COMMIT_SHA` / `GIT_SHA` | No | `/api/health` omits `sha`. | Vercel injects the first; set `GIT_SHA` in Docker |

---

## First-deploy checklist

1. [ ] Neon/Supabase database created; `DATABASE_URL` (pooled) saved.
2. [ ] Migrations applied: `DATABASE_URL=... bunx drizzle-kit migrate` from
       `apps/web` — then run the verification query from
       [step 6](#6-database-migrations-before-first-real-use-and-after-every-schema-change):
       row count matches the journal, `credits_ok` and `tenancy_ok` are `t`.
       A clean exit alone is **not** proof — an unjournaled migration is
       skipped silently.
3. [ ] Upstash Redis created; REST URL + token saved.
4. [ ] R2 bucket created, API token scoped to it, CORS set to the site origin,
       public base URL configured.
5. [ ] `BETTER_AUTH_SECRET` freshly generated; `NEXT_PUBLIC_SITE_URL` matches
       the real domain exactly.
6. [ ] All required env vars entered in Vercel **before** building; at least
       one AI provider key set if you want generation live.
7. [ ] Deploy succeeds (a missing required var fails the build with a zod
       error naming it).
8. [ ] Sign up a test account, confirm login works on the deployed domain.
9. [ ] `curl https://your-domain.com/api/health` returns
       `{"ok":true,"db":true,"version":"...","sha":"..."}` with HTTP 200.
       `db:false`/503 means the app can't reach Postgres — recheck
       `DATABASE_URL` and Neon IP allowlist.

## Rollback

On Vercel, every deployment is immutable: Project → Deployments → pick the
last good one → **⋯ → Promote to Production** (or "Instant Rollback") — this
swaps the alias in seconds and needs no rebuild. Because migrations run
manually and drizzle migrations here are additive, rolling back the app does
not require rolling back the database; if a migration itself was the problem,
restore the Neon branch/point-in-time backup taken before you migrated (Neon
→ Branches → Restore) rather than hand-reversing SQL. For Docker, keep the
previously tagged image and re-run it (`docker run ... byorn-web:<old-sha>`);
confirm recovery the same way you confirmed deploy — `/api/health` returns
`ok:true` and the old `sha`.
