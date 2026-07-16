import { describe, expect, test } from "bun:test";
import { authErrorToastContent } from "@/components/auth/auth-form-errors";

// BUG3: sign-in previously showed the same generic "Failed to sign in" toast
// for a rate-limited attempt (HTTP 429, from better-auth's server-side
// rateLimit config) as for a bad password. This pins the honest,
// distinct copy branch for 429 vs. everything else.

describe("authErrorToastContent", () => {
	test("429 status returns rate-limit copy regardless of mode", () => {
		expect(authErrorToastContent("signin", { status: 429 })).toEqual({
			title: "Too many attempts",
			description:
				"You've tried too many times. Wait a moment, then try again.",
		});
		expect(authErrorToastContent("signup", { status: 429 })).toEqual({
			title: "Too many attempts",
			description:
				"You've tried too many times. Wait a moment, then try again.",
		});
	});

	test("non-429 with a message uses the generic copy with that message", () => {
		expect(
			authErrorToastContent("signin", {
				status: 401,
				message: "Invalid email or password",
			}),
		).toEqual({
			title: "Failed to sign in",
			description: "Invalid email or password",
		});
	});

	test("non-429 without a message falls back to the generic description", () => {
		expect(authErrorToastContent("signin", { status: 500 })).toEqual({
			title: "Failed to sign in",
			description: "Please check your details and try again",
		});
		expect(
			authErrorToastContent("signin", { status: 500, message: null }),
		).toEqual({
			title: "Failed to sign in",
			description: "Please check your details and try again",
		});
	});

	test("no status at all (e.g. network error) uses generic copy, not rate-limit copy", () => {
		expect(
			authErrorToastContent("signin", { message: "Network error" }),
		).toEqual({
			title: "Failed to sign in",
			description: "Network error",
		});
	});

	test("signup vs signin titles differ for the generic branch", () => {
		expect(authErrorToastContent("signup", { status: 400 }).title).toBe(
			"Failed to create account",
		);
		expect(authErrorToastContent("signin", { status: 400 }).title).toBe(
			"Failed to sign in",
		);
	});
});
