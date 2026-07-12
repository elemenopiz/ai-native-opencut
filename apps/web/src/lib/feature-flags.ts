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
