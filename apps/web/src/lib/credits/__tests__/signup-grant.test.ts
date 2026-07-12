import { describe, expect, it } from "bun:test";
import {
	MODALITY_SPLIT,
	OWNER_GRANT_CREDITS,
	SIGNUP_GRANT_CREDITS,
	modalityBudgetFor,
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

describe("modalityBudgetFor — the 500/150 earmark", () => {
	it("splits the welcome grant exactly: $5 of video, $1.50 of images", () => {
		expect(modalityBudgetFor(SIGNUP_GRANT_CREDITS, "video")).toBe(
			MODALITY_SPLIT.video,
		);
		expect(modalityBudgetFor(SIGNUP_GRANT_CREDITS, "image")).toBe(
			MODALITY_SPLIT.image,
		);
	});

	it("always sums to the total — no credit is unspendable", () => {
		for (const total of [0, 1, 13, 650, 651, 1_000_000]) {
			expect(
				modalityBudgetFor(total, "video") + modalityBudgetFor(total, "image"),
			).toBe(total);
		}
	});

	it("scales proportionally for the owner grant and top-ups", () => {
		expect(modalityBudgetFor(1_300, "video")).toBe(1_000);
		expect(modalityBudgetFor(1_300, "image")).toBe(300);
		expect(modalityBudgetFor(1_000_000, "video")).toBe(
			Math.floor((1_000_000 * 500) / 650),
		);
	});
});
