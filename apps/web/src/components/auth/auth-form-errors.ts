// Pure toast-content selection for auth-form errors, split out so it's
// unit-testable without rendering React / mounting the form.
//
// `error.status` comes from better-auth's client, which surfaces the
// underlying @better-fetch/fetch `BetterFetchError` (see
// node_modules/.bun/@better-fetch+fetch@*/node_modules/@better-fetch/fetch/dist/index.d.ts):
// `class BetterFetchError extends Error { status: number; statusText: string; error: any }`.
// better-auth's rate-limit plugin responds with HTTP 429 when the
// server-side `rateLimit` config (apps/web/src/lib/auth/server.ts) trips.

export type AuthFormMode = "signin" | "signup";

export type AuthFormError = {
	status?: number;
	message?: string | null;
};

export type AuthErrorToastContent = {
	title: string;
	description: string;
};

const RATE_LIMIT_STATUS = 429;

export function authErrorToastContent(
	mode: AuthFormMode,
	error: AuthFormError,
): AuthErrorToastContent {
	if (error.status === RATE_LIMIT_STATUS) {
		return {
			title: "Too many attempts",
			description:
				"You've tried too many times. Wait a moment, then try again.",
		};
	}

	return {
		title: mode === "signup" ? "Failed to create account" : "Failed to sign in",
		description: error.message ?? "Please check your details and try again",
	};
}
