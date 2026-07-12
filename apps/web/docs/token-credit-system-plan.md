# Token / Credit System — Design & Plan

Net-new workstream. Byorn pays the AI provider bills (env-only keys); end users consume paid AI
through **credits**. This doc is the plan of record.

## Decisions (2026-07-10, user)
1. **Metered per-action cost** — each paid action debits credits proportional to its real API cost
   (a Seedance video ≫ a GPT-Image still ≫ a text call). Protects margin.
2. **Ledger first, payments later** — build the credit engine (ledger + metering + gating) now; grant
   credits via an admin path for a soft launch; wire real payment provider afterward.
3. **No free tier** — any paid (cloud) AI action requires credits from day one. Local features
   (transcription, editing, transitions, chroma key, etc.) remain free and are NEVER metered.
4. **Subscription + top-ups** — monthly plans grant a recurring credit allotment; one-time top-up
   packs cover overflow. (Payments deferred to Phase 2.)

## Core principles
- **Server-authoritative.** Cost is computed server-side from a fixed table; the client never supplies
  a price. Metering lives at the API chokepoints, not in the browser.
- **Append-only ledger.** Every balance change is an immutable row (debit/credit) with a reason and a
  reference. Balance = derived (running column) for O(1) reads, reconcilable from the ledger.
- **Only cloud/provider-cost actions are metered.** If an action doesn't spend our provider keys, it's
  free (matches the "local-first" product line and the existing `isAvailable()` gating).
- **Never charge for failure.** Reserve on start → settle on success → release on failure/timeout.
- **Idempotent.** Every debit carries an idempotency key (job id / request id) so retries don't
  double-charge.

## Data model (Postgres, drizzle — auth `users` already exists)

```
credit_ledger                      -- append-only source of truth
  id            text pk
  user_id       text  -> users(id) on delete cascade
  delta         integer            -- +credit / -debit (whole credits)
  balance_after integer            -- running balance snapshot (fast reads + audit)
  reason        text               -- 'generation' | 'topup' | 'subscription' | 'admin_grant' | 'refund'
  ref_type      text               -- 'studio_job' | 'stripe_invoice' | 'polar_order' | 'admin' | ...
  ref_id        text               -- job id / invoice id / etc.
  idempotency_key text unique       -- guards double-apply
  metadata      jsonb              -- {backendId, action, unitCost, quantity, ...}
  created_at    timestamp

credit_accounts                    -- one row per user; hot path
  user_id       text pk -> users(id)
  balance       integer  not null default 0
  reserved      integer  not null default 0   -- held for in-flight jobs
  updated_at    timestamp
  -- (balance - reserved) = spendable
```

Reservation lives in `credit_accounts.reserved` (a hold), not a separate table, to keep the hot path
one row. A `credit_reservations` table can be added later if we need per-job hold visibility.

## Cost model

**Anchor: 1 credit = US$0.01 of real provider cost, rounded UP** (never round down — protects margin).
Margin is NOT baked into the cost table; it lives in the **credit sale price** (Phase 2, e.g. sell at
$0.015–$0.02/credit = 50–100% margin). This keeps the cost table an honest mirror of our provider bill,
independently adjustable from pricing.

### Researched provider costs → credit rates (2026-07, sourced below)

**Video — priced per second** (`credits/s = ceil(usdPerSec × 100)`; a 5s clip = rate × 5):

| Backend | Real cost | credits/s | 5s clip |
|---|---|---|---|
| BytePlus Seedance | ~$0.10/s (~$0.50/clip entry) | **10** | 50 |
| Kling | ~$0.07–0.10/s | **10** | 50 |
| Luma Ray-2 | ~$0.08/s ($0.95 / 5s 1080p) | **10** | 50 |
| Google Veo | ~$0.15–0.40/s | **20** | 100 |
| Runway Gen-4 | ~$0.35/s | **35** | 175 |
| Pika (via fal) | $0.05/s | **5** | 25 |

**Image — flat per still (1024²):**

| Backend | Real cost | credits |
|---|---|---|
| OpenAI GPT-Image (medium) | ~$0.04 | **4** |
| BFL FLUX 1.1 pro / Kontext | ~$0.04 | **4** |
| Google Imagen 4 (standard) | ~$0.04 | **4** |
| Google Nano-Banana (2.5 Flash Image) | ~$0.039 | **4** |
| Ideogram 3.0 (standard) | ~$0.03 | **3** |

**Text/local — free (cost 0):** `enhance-prompt` (tiny LLM), `infographic` (Pillow-only, no provider cost).

> Numbers are point-in-time (2026-07) and conservative (rounded up, mid-to-high tier) to protect margin.
> Re-confirm against your live console quotes; higher-res/quality tiers (Ideogram Quality $0.09,
> Imagen Ultra $0.06, GPT-Image High $0.167, Veo up to $0.40/s) cost more — encode tier multipliers.

```ts
// lib/credits/cost-table.ts  (server-only, single source of truth)
const VIDEO_CREDITS_PER_SEC: Record<string, number> = {
  "byteplus-seedance": 10, "kling": 10, "luma": 10, "google-veo": 20, "runway": 35, "pika": 5,
};
const IMAGE_CREDITS: Record<string, number> = {
  "openai-gpt-image": 4, "bfl-flux": 4, "google-imagen": 4, "google-nano-banana": 4, "ideogram": 3,
};
const FREE = new Set(["enhance-prompt", "infographic"]);
// costFor(backendId, action, {seconds=5, count=1, tier}) → whole credits (ceil), min 1 for paid actions
export function costFor(backendId: string, action: GenAction, opts?: {seconds?: number; count?: number; tier?: string}): number
```

Surface a per-action estimate in the UI *before* the user commits ("~50 credits").

### Sources
- Seedance: [BytePlus ModelArk pricing](https://docs.byteplus.com/en/docs/ModelArk/1544106)
- GPT-Image: [OpenAI GPT Image pricing calc](https://costgoat.com/pricing/openai-images), [pricepertoken](https://pricepertoken.com/gpt-image-pricing)
- Video per-second (Kling/Runway/Veo/Pika): [FluxNote 2026 guide](https://fluxnote.io/blog/ai-video-generation-pricing-guide-2026), [buildmvpfast](https://www.buildmvpfast.com/api-costs/ai-video), [fal pricing](https://fal.ai/pricing)
- FLUX / Ideogram / Imagen: [BFL pricing](https://bfl.ai/pricing), [buildmvpfast image](https://www.buildmvpfast.com/api-costs/ai-image)
- Nano-Banana: [Google Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) ($30/1M tok ≈ $0.039/image)
- Luma Ray-2 / Pika: [eesel Luma pricing](https://www.eesel.ai/blog/luma-ai-pricing), [Pika API $0.05/s](https://crazyrouter.com/en/blog/ai-video-generation-api-pricing-comparison-2026)

## Metering — where it hooks

Chokepoints (all already login-gated per the studio auth passes):
- `POST /api/studio/generate` (+ `generate/[jobId]`) — the main video/image generator ← **primary**
- `POST /api/studio/image` — direct image gen
- `POST /api/studio/personas/[id]/still` — persona still
- `POST /api/studio/takes/[takeId]/promote` — if it triggers a paid gen
- (`/api/llm/agent` — Director brain: meter only if we decide agent calls cost credits; TBD)

### Flow (reserve → settle)
```
1. Resolve backendId + action + size → cost = costFor(...)
2. In one DB txn (row lock on credit_accounts):
     if (balance - reserved) < cost  → 402 { error: 'insufficient_credits', needed, balance }
     reserved += cost                → write a 'reserve' ledger row (delta 0, holds cost)
3. Dispatch the provider job (sync or async).
4a. success → settle: balance -= cost; reserved -= cost; ledger 'generation' debit (idempotency_key = jobId)
4b. failure/timeout → release: reserved -= cost; no debit (never charge for failure)
```
For **async video jobs**, the settle/release happens in the job-completion callback keyed by `jobId`
(idempotency_key), so a retried webhook can't double-charge.

## Gating & UX
- **402 `insufficient_credits`** from the metered routes → frontend intercepts → "Out of credits" modal
  with the top-up CTA (Phase 2 wires the buy button; Phase 1 shows "contact/soft-launch" or admin grant).
- **Balance indicator** in the editor header next to `AccountMenu` (built in Category A) — a small pill
  showing spendable credits; turns amber when low.
- **Pre-action estimate** — paid actions (Generate, Reroll, etc.) show "~N credits" and disable when
  `spendable < cost`, with a tooltip. Reuse the existing generation-form + director surfaces.
- **Account page** (already exists from Category A) gains a "Credits" section: balance, ledger history,
  and (Phase 2) manage-subscription / buy-credits.

## Admin path (soft launch, no role system yet)
- Minimal admin gate: `ADMIN_EMAILS` env allowlist (add to `@byorn/env` server schema) checked against
  the session email. (A real `users.role` column can supersede later.)
- `POST /api/admin/credits/grant` `{ userId, amount, note }` → ledger `admin_grant`. Also a CLI script
  `bun run credits:grant` for ops.
- Lets you comp credits, refund, and run the soft launch before payments exist.

## Phasing

### Phase 1 — Credit engine (build now, no payments)
- Migration: `credit_ledger` + `credit_accounts` (+ drizzle schema `schema-credits.ts`).
- `lib/credits/`: `ledger.ts` (getSpendable, reserve, settle, release, grant — all txn-safe),
  `cost-table.ts`, `errors.ts` (InsufficientCredits).
- Wire metering into the 4 paid routes (reserve→settle/release), with idempotency on job id.
- `402 insufficient_credits` contract + frontend interceptor + "Out of credits" modal.
- Header **balance pill** + **pre-action estimates** + Account page **Credits** section.
- Admin grant route + CLI + `ADMIN_EMAILS`.
- Tests: ledger concurrency (no oversell), refund-on-failure, idempotent settle, gate returns 402.

### Phase 2 — Payments (later)
- Provider (recommend **Polar** = merchant-of-record, handles global tax/VAT for a solo operator;
  Stripe if you want max control and will handle tax).
- Products: subscription plans (monthly credit grant on renewal) + top-up packs (one-time grant).
- Webhooks → ledger credits (`subscription` / `topup`), idempotent on invoice/order id.
- Billing UI: plans, buy-credits, manage subscription, invoices. Wire the top-up CTA in the
  out-of-credits modal.

### Phase 3 — Polish
- Low-balance email/toast, optional auto-refill, usage analytics, monthly rollover rules, receipts.

## Risks / decisions to nail during build
- **Concurrency / oversell** — must reserve under a row lock (or `SELECT ... FOR UPDATE`) so two
  simultaneous generations can't both pass the balance check.
- **Async settle correctness** — the video job callback is the single settle point; ensure failure and
  timeout both release the hold (add a sweep for stale reservations).
- **Cost-table accuracy** — fill `CREDIT_COSTS` from real provider prices + your margin; wrong numbers
  bleed margin or overcharge. Keep it in one server-only file, versioned.
- **Idempotency everywhere** — generation settle, webhook credit, admin grant all need a unique key.
- **Infographic/enhance-prompt** — Pillow-only / cheap; likely **free** (cost 0) to avoid nickel-and-diming.
- **Agent (`/api/llm/agent`)** — decide whether Director agent turns cost credits (they cost us
  Anthropic/Kimi tokens). Recommend a small per-run cost or a daily free allowance.

## Relationship to other work
- Sits on the **auth** built in Category A (balance is per authenticated user; Account page + header
  menu already exist to host the credit UI).
- The **provider-key status** decision (env-only, hidden from users) is consistent: users see credits,
  never keys or provider config.
- BYO-key-as-premium-tier (parked) could later be a subscription perk that bypasses metering.
