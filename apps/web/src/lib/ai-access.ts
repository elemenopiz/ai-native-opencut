/**
 * AI-access gate: restricts every provider-billed AI feature (Gemini/Kimi
 * Director brain, BytePlus/Seedance video, image generation, TTS, audio
 * generation, prompt-enhance, persona stills, …) to "existing users" — every
 * other feature (the editor itself, uploads, exports, board, version control,
 * …) stays open to anonymous visitors and brand-new accounts unchanged.
 *
 * An "existing user" is any signed-in account for which ONE of the following
 * holds:
 *   - it's an owner account (`OWNER_EMAILS` in `lib/credits/signup-grant.ts`);
 *   - its email is on the runtime allowlist (`AI_ACCESS_ALLOWLIST`); or
 *   - it was created before the cutoff instant (`AI_ACCESS_CUTOFF`).
 *
 * Runtime levers (both readable straight from `process.env`, no redeploy
 * needed to move them):
 *   - `AI_ACCESS_CUTOFF` — an ISO-8601 timestamp. Accounts created strictly
 *     BEFORE this instant are grandfathered into AI access; accounts created
 *     at or after it are not, unless owner/allowlisted. Unset OR unparsable
 *     (`Invalid Date`) falls back to `2026-07-23T00:00:00.000Z` — the day
 *     this gate shipped — so every account that already existed keeps AI
 *     access and every account created from that day on needs the allowlist.
 *   - `AI_ACCESS_ALLOWLIST` — comma-separated emails (case-insensitive,
 *     whitespace-trimmed) granted AI access regardless of signup date, e.g.
 *     for manually inviting specific new users ahead of a wider rollout.
 *
 * Fails CLOSED: a null/undefined user, a missing email, or a `createdAt` that
 * is absent or doesn't parse to a valid `Date` all resolve to false rather
 * than throwing or defaulting to access.
 */
import { isOwnerEmail } from "@/lib/credits/signup-grant";
import { NextResponse } from "next/server";

/** Machine-readable code the client maps to the early-access upsell copy. */
export const AI_ACCESS_DENIED_CODE = "ai_access_restricted";

/** The day this gate shipped — see the module doc comment for the semantics. */
const DEFAULT_AI_ACCESS_CUTOFF = new Date("2026-07-23T00:00:00.000Z");

/**
 * The AI-access cutoff instant. Reads `AI_ACCESS_CUTOFF` (an ISO date
 * string) and falls back to {@link DEFAULT_AI_ACCESS_CUTOFF} whenever the env
 * var is unset OR fails to parse into a valid `Date` — a typo'd env var must
 * never silently turn into an `Invalid Date` that (via `NaN` comparisons)
 * would deny AI access to every existing account.
 */
export function aiAccessCutoff(): Date {
	const raw = process.env.AI_ACCESS_CUTOFF;
	if (!raw) return DEFAULT_AI_ACCESS_CUTOFF;
	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? DEFAULT_AI_ACCESS_CUTOFF : parsed;
}

/**
 * `AI_ACCESS_ALLOWLIST` (comma-separated emails) normalized into trimmed,
 * lowercased, non-empty entries. Unset/empty → `[]`.
 */
function aiAllowlist(): string[] {
	const raw = process.env.AI_ACCESS_ALLOWLIST;
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

/**
 * Whether `user` has AI access — true iff the account is an owner, is on the
 * allowlist, or was created before the cutoff. See the module doc comment for
 * the full model. Null/undefined user, a missing/blank email for the
 * owner/allowlist checks, or a missing/invalid `createdAt` all fall through
 * to false.
 */
export function hasAiAccess(
	user:
		| { email?: string | null; createdAt?: Date | string | null }
		| null
		| undefined,
): boolean {
	if (!user) return false;

	if (isOwnerEmail(user.email)) return true;

	const normalizedEmail = user.email?.trim().toLowerCase();
	if (normalizedEmail && aiAllowlist().includes(normalizedEmail)) return true;

	if (user.createdAt != null) {
		const createdAt = new Date(user.createdAt);
		if (!Number.isNaN(createdAt.getTime())) {
			return createdAt.getTime() < aiAccessCutoff().getTime();
		}
	}

	return false;
}

/**
 * 403 response for a request that failed {@link hasAiAccess}. `code` lets the
 * client distinguish this from a generic error and show the early-access
 * upsell copy instead of a failure toast.
 */
export function aiAccessDeniedResponse(): NextResponse {
	return NextResponse.json(
		{
			error: "AI features are available to early-access members.",
			code: AI_ACCESS_DENIED_CODE,
		},
		{ status: 403 },
	);
}
