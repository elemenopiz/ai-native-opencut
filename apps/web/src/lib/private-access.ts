/**
 * Private-testing lock — who may use the SITE at all.
 *
 * Distinct from `lib/ai-access.ts`, which governs who may spend our provider
 * keys. This one governs who may get through the front door:
 *
 *  - `PRIVATE_ACCESS_ALLOWLIST` UNSET or empty → the app is PUBLIC, exactly as
 *    it is today. That is the default, and nothing in this module changes any
 *    behaviour until someone deliberately sets the variable.
 *  - set to one or more comma-separated emails → every page requires a signed-in
 *    account whose email is on the list. Everyone else gets a plain "private
 *    testing" screen with a way to sign out; they never see the product.
 *
 * Enforced in two places on purpose:
 *  1. `proxy.ts` (edge, optimistic): no session cookie → redirect to /login.
 *     Cheap, keeps anonymous crawlers out, and cannot check an email because
 *     the edge has no session.
 *  2. The root layout (server, authoritative): resolves the real session and
 *     compares the email. A forged cookie gets past (1) and is stopped here.
 *
 * Fails CLOSED in the sense that matters: when the lock IS configured, a
 * missing user, a missing email, or an email not on the list all deny. It
 * deliberately fails OPEN when the variable is unset — that is not a gate
 * failure, it is the app's normal public mode.
 */

/**
 * `PRIVATE_ACCESS_ALLOWLIST` (comma-separated emails) normalized into trimmed,
 * lowercased, non-empty entries. Unset/empty → `[]`.
 */
export function privateAccessAllowlist(): string[] {
	const raw = process.env.PRIVATE_ACCESS_ALLOWLIST;
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

/**
 * Whether the site is currently locked to an allowlist. False → public app,
 * and every caller should behave exactly as it did before this module existed.
 */
export function isPrivateAccessEnabled(): boolean {
	return privateAccessAllowlist().length > 0;
}

/**
 * Whether `email` may use the site. Always true when the lock is off. When it
 * is on, only a non-blank email present on the list passes — a null/undefined
 * user or a missing email denies rather than throwing.
 */
export function hasPrivateAccess(email: string | null | undefined): boolean {
	const allowlist = privateAccessAllowlist();
	if (allowlist.length === 0) return true;

	const normalized = email?.trim().toLowerCase();
	if (!normalized) return false;
	return allowlist.includes(normalized);
}

/**
 * Paths that must stay reachable even when the lock is on, or a locked-out
 * visitor could never sign in as someone who IS allowed. Auth screens only —
 * everything else goes through the gate.
 */
export const PRIVATE_ACCESS_PUBLIC_PREFIXES = [
	"/login",
	"/signup",
	"/forgot-password",
	"/reset-password",
] as const;

/** Whether `pathname` is one of {@link PRIVATE_ACCESS_PUBLIC_PREFIXES}. */
export function isPrivateAccessPublicPath(pathname: string): boolean {
	return PRIVATE_ACCESS_PUBLIC_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}
