import { describe, expect, test } from "bun:test";
import { DEFAULT_PALETTE } from "./palette";

const HEX = /^#[0-9A-Fa-f]{6}$/;

describe("DEFAULT_PALETTE", () => {
	test("core colors are valid hex", () => {
		expect(DEFAULT_PALETTE.foreground).toMatch(HEX);
		expect(DEFAULT_PALETTE.background).toMatch(HEX);
		expect(DEFAULT_PALETTE.accent).toMatch(HEX);
	});

	test("foreground and background are not the same color (contrast baseline)", () => {
		expect(DEFAULT_PALETTE.foreground).not.toBe(DEFAULT_PALETTE.background);
	});

	test("scrims carry a valid hex color and an opacity in (0, 1]", () => {
		for (const scrim of [
			DEFAULT_PALETTE.scrimDark,
			DEFAULT_PALETTE.scrimLight,
		]) {
			expect(scrim.color).toMatch(HEX);
			expect(scrim.opacity).toBeGreaterThan(0);
			expect(scrim.opacity).toBeLessThanOrEqual(1);
		}
	});
});
