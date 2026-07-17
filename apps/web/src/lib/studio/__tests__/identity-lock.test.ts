import { describe, expect, it } from "bun:test";
import { IDENTITY_LOCK_INSTRUCTION, withIdentityLock } from "../identity-lock";

describe("withIdentityLock", () => {
	it("returns the prompt unchanged when locked is false", () => {
		expect(withIdentityLock("a woman walking on the beach", false)).toBe(
			"a woman walking on the beach",
		);
	});

	it("leads with the instruction block and carries the prompt verbatim as directions when locked", () => {
		const prompt = "a woman walking on the beach";
		const out = withIdentityLock(prompt, true);
		// Instruction-first is load-bearing: a trailing lock loses to prompts
		// that describe a person (see the module header).
		expect(out.startsWith(IDENTITY_LOCK_INSTRUCTION)).toBe(true);
		expect(out).toBe(`${IDENTITY_LOCK_INSTRUCTION}\n\nDirections: ${prompt}`);
	});

	it("declares prompt-described people to be the reference person", () => {
		expect(IDENTITY_LOCK_INSTRUCTION).toContain(
			"that is THIS person playing that role",
		);
	});

	it("leaves an empty prompt unchanged even when locked is true", () => {
		expect(withIdentityLock("", true)).toBe("");
	});

	it("leaves a whitespace-only prompt unchanged even when locked is true", () => {
		expect(withIdentityLock("   ", true)).toBe("   ");
	});
});
