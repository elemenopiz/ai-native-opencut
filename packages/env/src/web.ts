import { z } from "zod";

const webEnvSchema = z.object({
	// Node
	NODE_ENV: z.enum(["development", "production", "test"]),
	ANALYZE: z.string().optional(),
	NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),
	// Overrides the server logger's minimum emitted level (debug|info|warn|error).
	// Unrecognized/empty values fall back to the built-in default (info in
	// production, debug in dev) — see lib/observability/logger.ts `minLevel`.
	LOG_LEVEL: z.string().default(""),

	// Public
	NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
	NEXT_PUBLIC_MARBLE_API_URL: z.url().default("https://api.marblecms.com"),
	NEXT_PUBLIC_AI_BACKEND_URL: z.url().default("http://localhost:8420"),

	// Asset-understanding pass model override (see
	// lib/search/asset-understanding.ts `configuredUnderstandingModel`). Empty =
	// no `model` sent, the Director relay picks its default. A `gemini-*` value
	// (e.g. `gemini-3.5-flash`) runs the pass natively via the Gemini relay.
	NEXT_PUBLIC_UNDERSTANDING_MODEL: z.string().default(""),

	// Feature flag: shared-projects / collaboration UI (invite-by-email,
	// "Shared with me", share dialog, shared-project onboarding). Default OFF
	// for the private beta per ADR-003 — the collab API routes stay live and
	// auth-gated; this flag only hides discoverability, not the security
	// boundary. Read directly in client components (process.env.…) since it is
	// inlined at build; unset reads as OFF. Flip to "true" to expose the UI.
	NEXT_PUBLIC_FEATURE_COLLAB: z.enum(["true", "false"]).default("false"),

	// Server — required for the app to function
	DATABASE_URL: z
		.string()
		.startsWith("postgres://")
		.or(z.string().startsWith("postgresql://")),

	BETTER_AUTH_SECRET: z.string(),
	UPSTASH_REDIS_REST_URL: z.url().default("http://localhost:8079"),
	UPSTASH_REDIS_REST_TOKEN: z.string().default("example_token"),

	// Comma-separated allowlist of admin emails. During soft launch (no role
	// system yet) these accounts may grant credits via POST /api/admin/credits/grant.
	ADMIN_EMAILS: z.string().default(""),

	// Metering kill-switch. Default ON (paid AI actions debit credits). Set to
	// "false" to disable credit enforcement entirely — every paid generation runs
	// free (no hold, no charge, no 402). Use for a phased rollout or a promo.
	CREDITS_ENFORCED: z
		.string()
		.default("true")
		.transform((v) => v.toLowerCase() !== "false"),

	// Transactional email (password reset + email verification). Optional —
	// without RESEND_API_KEY the app logs the action link to the server console
	// instead of sending (dev-friendly, never throws). EMAIL_FROM must be a
	// verified sender on your Resend account in production.
	RESEND_API_KEY: z.string().default(""),
	EMAIL_FROM: z.string().default("Byorn <noreply@byorn.app>"),

	// Analytics (optional)
	NEXT_PUBLIC_GA_MEASUREMENT_ID: z.string().default(""),

	// Optional — features degrade gracefully without these
	MARBLE_WORKSPACE_KEY: z.string().default(""),
	FREESOUND_CLIENT_ID: z.string().default(""),
	FREESOUND_API_KEY: z.string().default(""),
	CLOUDFLARE_ACCOUNT_ID: z.string().default(""),
	R2_ACCESS_KEY_ID: z.string().default(""),
	R2_SECRET_ACCESS_KEY: z.string().default(""),
	R2_BUCKET_NAME: z.string().default("byorn-media"),
	// Public read base for R2 objects (custom domain or r2.dev), e.g.
	// https://media.yourapp.com — used to serve rehosted Studio media with
	// permanent URLs. Leave blank to fall back to time-limited presigned URLs.
	R2_PUBLIC_BASE_URL: z.string().default(""),
	// Soft storage cap (bytes) to stay under R2's 10 GB free tier. New uploads
	// are refused once the bucket reaches this size. 0 disables the guard.
	R2_MAX_STORAGE_BYTES: z.coerce.number().default(9_500_000_000),
	MODAL_TRANSCRIPTION_URL: z.url().optional(),

	// ── Studio: direct-to-source video generation ─────────────────────────
	// BytePlus ModelArk — direct Seedance 2.0, no reseller markup. Only backend.
	BYTEPLUS_API_KEY: z.string().default(""),
	// API base URL. Defaults to the BytePlus (international) endpoint; set to
	// https://ark.cn-beijing.volces.com/api/v3 for Volcengine China accounts.
	BYTEPLUS_BASE_URL: z.string().default(""),
	// Endpoint IDs are user-specific in ModelArk; leave blank to use the
	// default Seedance 2.0 model (dreamina-seedance-2-0-260128 on BytePlus).
	BYTEPLUS_SEEDANCE_ENDPOINT_ID: z.string().default(""),

	// OpenAI — for GPT Image reference frame generation
	OPENAI_API_KEY: z.string().default(""),
	// Model name — defaults to gpt-image-2 (current GPT Image model id)
	OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2"),

	// ── Director brain: Anthropic / Kimi (server-side relay) ──────────────
	// Optional — with NEITHER key set, /api/llm/agent returns a machine-readable
	// 503 ("anthropic_not_configured") and the client agent falls back to the
	// local Ollama brain (privacy mode). MOONSHOT_API_KEY, when set, wins over
	// ANTHROPIC_API_KEY (Kimi via Moonshot's Anthropic-compatible endpoint).
	ANTHROPIC_API_KEY: z.string().default(""),
	MOONSHOT_API_KEY: z.string().default(""),
	// Model override for whichever Director brain is active. Empty = the
	// route's built-in default (claude-opus-4-8 / kimi-k2.6).
	DIRECTOR_MODEL: z.string().default(""),

	// Pexels stock-photo search (/api/images/search). Optional — callers may
	// also supply a personal key per request (X-Pexels-Api-Key header from
	// Settings); with neither, image search returns a 401 with setup help.
	PEXELS_API_KEY: z.string().default(""),

	// How many trusted reverse proxies sit between the client and the app —
	// used to pick the real client IP from x-forwarded-for for rate limiting.
	// Default 1 (a single edge proxy, e.g. Vercel). Invalid values fall back
	// to 1 rather than failing the boot.
	TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).default(1).catch(1),

	// ── Routed partner backends (all optional) ────────────────────────────
	// Each adapter under src/lib/studio/backends/ stays INERT until its key is
	// set (isAvailable() gates routing), so a blank key simply disables that
	// provider. Base-URL/model overrides are optional; empty string = the
	// adapter's built-in default.
	//
	// Kling (Kuaishou) — JWT-signed from an access/secret key pair.
	KLING_ACCESS_KEY: z.string().default(""),
	KLING_SECRET_KEY: z.string().default(""),
	KLING_BASE_URL: z.string().default(""),
	KLING_MODEL: z.string().default(""),
	// Google Gemini — ONE key shared by Imagen (image) and Gemini Flash Image /
	// "Nano Banana" (image).
	GEMINI_API_KEY: z.string().default(""),
	GEMINI_BASE_URL: z.string().default(""),
	GEMINI_IMAGEN_MODEL: z.string().default(""),
	GEMINI_NANO_BANANA_MODEL: z.string().default(""),
	// Runway (Gen-4 / Aleph).
	RUNWAY_API_KEY: z.string().default(""),
	RUNWAY_BASE_URL: z.string().default(""),
	RUNWAY_API_VERSION: z.string().default(""),
	RUNWAY_MODEL: z.string().default(""),
	// Luma (Ray-2 / Dream Machine).
	LUMA_API_KEY: z.string().default(""),
	LUMA_BASE_URL: z.string().default(""),
	LUMA_MODEL: z.string().default(""),
	// fal.ai — aggregator used for Pika 2.2.
	FAL_KEY: z.string().default(""),
	FAL_BASE_URL: z.string().default(""),
	// Black Forest Labs FLUX (image).
	BFL_API_KEY: z.string().default(""),
	// Ideogram 3.0 (image).
	IDEOGRAM_API_KEY: z.string().default(""),

	// ── Deploy metadata (host-injected, optional) ─────────────────────────
	// Surfaced by GET /api/health as `sha`. Vercel injects the first one
	// automatically; set GIT_SHA yourself in Docker/other hosts if you want it.
	VERCEL_GIT_COMMIT_SHA: z.string().optional(),
	GIT_SHA: z.string().optional(),

	// ── Payments: Polar (merchant-of-record) ──────────────────────────────
	// Phase 2 of the credit system. Polar handles global tax/VAT as MoR. The
	// whole payments surface stays INERT until POLAR_ACCESS_TOKEN and
	// POLAR_WEBHOOK_SECRET are set (see `isPaymentsConfigured()`), mirroring the
	// Studio provider adapters' inert-until-configured pattern.
	//
	// NOTE: kept as a self-contained block so a parallel change adding a
	// CREDITS_ENFORCED flag elsewhere in this schema merges cleanly.
	//
	// Server-side API token (Organization Access Token from the Polar dashboard).
	POLAR_ACCESS_TOKEN: z.string().default(""),
	// Webhook signing secret (Polar → Organization Settings → Webhooks). Used to
	// verify inbound webhook signatures; a request that fails verification is 401.
	POLAR_WEBHOOK_SECRET: z.string().default(""),
	// Organization id — optional for the SDK calls used here (the access token is
	// already org-scoped), kept for completeness / future org-scoped listings.
	POLAR_ORGANIZATION_ID: z.string().default(""),
	// Which Polar environment to talk to. Defaults to the sandbox so a
	// misconfiguration can never hit real money.
	POLAR_SERVER: z.enum(["sandbox", "production"]).default("sandbox"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export const webEnv = webEnvSchema.parse(process.env);
