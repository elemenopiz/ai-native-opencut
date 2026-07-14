import { describe, expect, it } from "bun:test";
import {
	OWNER_GRANT_CREDITS,
	SIGNUP_GRANT_CREDITS,
	isOwnerEmail,
	signupGrantFor,
} from "@/lib/credits/signup-grant";

describe("signupGrantFor — owner accounts get the unlimited balance", () => {
	it("grants the standard welcome balance to regular emails", () => {
		expect(signupGrantFor("tester@example.com")).toBe(SIGNUP_GRANT_CREDITS);
	});

	it("grants the owner balance to the owner email, case- and whitespace-insensitively", () => {
		expect(signupGrantFor("zsrumishaikh@gmail.com")).toBe(OWNER_GRANT_CREDITS);
		expect(signupGrantFor("  ZSRumiShaikh@Gmail.com ")).toBe(
			OWNER_GRANT_CREDITS,
		);
	});

	it("falls back to the standard grant when the email is missing", () => {
		expect(signupGrantFor(null)).toBe(SIGNUP_GRANT_CREDITS);
		expect(signupGrantFor(undefined)).toBe(SIGNUP_GRANT_CREDITS);
	});
});

describe("isOwnerEmail — runtime owner check used by beta-only gates (e.g. Director's free-turn cap)", () => {
	it("is true for the owner email, case- and whitespace-insensitively", () => {
		expect(isOwnerEmail("zsrumishaikh@gmail.com")).toBe(true);
		expect(isOwnerEmail("  ZSRumiShaikh@Gmail.com ")).toBe(true);
	});

	it("is false for a regular email", () => {
		expect(isOwnerEmail("tester@example.com")).toBe(false);
	});

	it("is false when the email is missing", () => {
		expect(isOwnerEmail(null)).toBe(false);
		expect(isOwnerEmail(undefined)).toBe(false);
		expect(isOwnerEmail("")).toBe(false);
	});
});
