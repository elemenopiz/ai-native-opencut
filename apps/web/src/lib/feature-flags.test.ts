import { describe, expect, it } from "bun:test";
import { collabEnabled } from "./feature-flags";

describe("collabEnabled (ADR-003 collab flag)", () => {
	it("is OFF when the value is undefined (unset — beta default)", () => {
		expect(collabEnabled(undefined)).toBe(false);
	});

	it('is OFF for the literal string "false"', () => {
		expect(collabEnabled("false")).toBe(false);
	});

	it('is OFF for any non-"true" value (e.g. "1", "TRUE")', () => {
		expect(collabEnabled("1")).toBe(false);
		expect(collabEnabled("TRUE")).toBe(false);
	});

	it('is ON only for the exact string "true"', () => {
		expect(collabEnabled("true")).toBe(true);
	});
});
