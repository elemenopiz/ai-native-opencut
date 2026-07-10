import { z } from "zod";

const webEnvSchema = z.object({
	// Node
	NODE_ENV: z.enum(["development", "production", "test"]),
	ANALYZE: z.string().optional(),
	NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),

	// Public
	NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
	NEXT_PUBLIC_MARBLE_API_URL: z.url().default("https://api.marblecms.com"),
	NEXT_PUBLIC_AI_BACKEND_URL: z.url().default("http://localhost:8420"),

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
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export const webEnv = webEnvSchema.parse(process.env);
