import { webEnv } from "@byorn/env/web";

/**
 * Soft-launch admin gate (no role system yet). An account is an admin iff its
 * email is in the comma-separated ADMIN_EMAILS server env var. Case-insensitive,
 * whitespace-trimmed. Empty ADMIN_EMAILS ⇒ nobody is an admin.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
	if (!email) return false;
	const allow = webEnv.ADMIN_EMAILS.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	return allow.includes(email.trim().toLowerCase());
}
