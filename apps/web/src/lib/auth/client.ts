import { createAuthClient } from "better-auth/react";

// This is a CLIENT module (better-auth/react). Do NOT import `@byorn/env/web`
// here — that schema `.parse(process.env)`s server-only vars (DATABASE_URL,
// BETTER_AUTH_SECRET) that are `undefined` in the browser, which throws a
// ZodError at load. Read the inlined public var directly; better-auth falls
// back to the current origin when it's undefined.
export const {
	signIn,
	signUp,
	signOut,
	useSession,
	getSession,
	deleteUser,
	// Password reset: `requestPasswordReset` sends the reset email; `resetPassword`
	// consumes the `?token=` from the emailed link to set the new password.
	requestPasswordReset,
	resetPassword,
	// Email verification: resend the verification email / verify a token.
	sendVerificationEmail,
	verifyEmail,
} = createAuthClient({
	baseURL: process.env.NEXT_PUBLIC_SITE_URL,
});

// better-auth renamed `forgetPassword` → `requestPasswordReset` (v1.5+). Export
// a `forgetPassword` alias so existing/expected call sites keep working.
export const forgetPassword = requestPasswordReset;
