import { describe, expect, it } from "bun:test";
import {
	OWNER_GRANT_CREDITS,
	SIGNUP_GRANT_CREDITS,
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
