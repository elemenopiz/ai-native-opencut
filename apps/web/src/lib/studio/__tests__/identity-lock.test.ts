import { describe, expect, it } from "bun:test";
import { IDENTITY_LOCK_INSTRUCTION, withIdentityLock } from "../identity-lock";

describe("withIdentityLock", () => {
	it("returns the prompt unchanged when locked is false", () => {
		expect(withIdentityLock("a woman walking on the beach", false)).toBe(
			"a woman walking on the beach",
		);
	});

	it("preserves the prompt verbatim at the start and appends the instruction block when locked", () => {
		const prompt = "a woman walking on the beach";
		const out = withIdentityLock(prompt, true);
		expect(out.startsWith(prompt)).toBe(true);
		expect(out).toBe(`${prompt}\n\n${IDENTITY_LOCK_INSTRUCTION}`);
	});

	it("leaves an empty prompt unchanged even when locked is true", () => {
		expect(withIdentityLock("", true)).toBe("");
	});

	it("leaves a whitespace-only prompt unchanged even when locked is true", () => {
		expect(withIdentityLock("   ", true)).toBe("   ");
	});
});
