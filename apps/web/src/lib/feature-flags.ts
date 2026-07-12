/**
 * Build-time feature flags read from NEXT_PUBLIC_* env vars. Next.js inlines
 * these at build, so referencing `process.env.NEXT_PUBLIC_*` as a full static
 * member expression is required. An unset var reads as `undefined`, so every
 * flag treats "unset" as OFF. Mirrors the E2E_ENABLED seam in e2e-bridge.tsx.
 */

/**
 * Pure predicate for the collab flag — takes the raw env value so both branches
 * are unit-testable. Only the exact string "true" enables it; anything else
 * (including unset/undefined) is OFF. See ADR-003.
 */
export function collabEnabled(
	value: string | undefined = process.env.NEXT_PUBLIC_FEATURE_COLLAB,
): boolean {
	return value === "true";
}

/**
 * Shared-projects / collaboration UI gate (invite-by-email, "Shared with me",
 * share dialog, shared-project onboarding). Default OFF for the private beta
 * per ADR-003: the collab API routes stay live and auth-gated — this only hides
 * discoverability. Read as a module const so Next inlines the value at build;
 * flip by setting NEXT_PUBLIC_FEATURE_COLLAB=true.
 */
export const FEATURE_COLLAB = collabEnabled();

/**
 * Pure predicate for the media "Understanding Pass" gate — the demand-driven,
 * paid VLM pass that reads each imported clip's role/caption/faces/style (see
 * `services/search/asset-understanding-service.ts`) and surfaces in the
 * Library "Insights" tab. NOT one of the three Gemini surfaces allowed to
 * spend from the shared beta pool (Director / image gen / enhance-prompt) —
 * default OFF so it can't burn the pool; env-overridable to re-enable once the
 * beta has its own budget. Only the exact string "true" enables it.
 */
export function understandingPassEnabled(
	value: string | undefined = process.env
		.NEXT_PUBLIC_FEATURE_UNDERSTANDING_PASS,
): boolean {
	return value === "true";
}

/**
 * Gate for the demand-driven Understanding Pass trigger (Director mount /
 * media-add in `use-director.ts`, and the opt-in ingest autorun in
 * `use-embedding-indexer.ts`) and its UI surface (the Insights tab). Default
 * OFF for the closed beta — flip with NEXT_PUBLIC_FEATURE_UNDERSTANDING_PASS=true.
 */
export const FEATURE_UNDERSTANDING_PASS = understandingPassEnabled();

/**
 * Pure predicate for the Podcast AI gate — the three Gemini structured-output
 * workflows in `lib/podcast/podcast-ai.ts` (find best clips, keyword
 * highlighting, question cards). NOT one of the three Gemini surfaces allowed
 * to spend from the shared beta pool — default OFF; env-overridable to
 * re-enable post-beta. Only the exact string "true" enables it.
 */
export function podcastAiEnabled(
	value: string | undefined = process.env.NEXT_PUBLIC_FEATURE_PODCAST_AI,
): boolean {
	return value === "true";
}

/**
 * Gate for the Podcast Clips panel's Gemini-backed features (clip finder,
 * keyword highlighting, question cards) in `podcast-clips.tsx` and the
 * "Find clips" quick action. Default OFF for the closed beta — flip with
 * NEXT_PUBLIC_FEATURE_PODCAST_AI=true.
 */
export const FEATURE_PODCAST_AI = podcastAiEnabled();
