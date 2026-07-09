import { describe, expect, test } from "bun:test";
import { createShortIdMap, MIN_PREFIX } from "./short-id";

// Two ids that share their first 8 chars ("abcdef01") but diverge at index 9.
const COLLIDE_A = "abcdef01-2000-4000-8000-000000000000";
const COLLIDE_B = "abcdef01-3000-4000-8000-000000000000";
const SOLO = "12345678-9abc-4def-8000-000000000000";

describe("createShortIdMap", () => {
	test("single id shortens to MIN_PREFIX and round-trips", () => {
		const map = createShortIdMap([SOLO]);
		const short = map.shorten(SOLO);
		expect(short).toBe(SOLO.slice(0, MIN_PREFIX));
		expect(short.length).toBe(MIN_PREFIX);
		expect(map.expand(short)).toBe(SOLO);
	});

	test("colliding ids extend past MIN_PREFIX until unambiguous", () => {
		const map = createShortIdMap([COLLIDE_A, COLLIDE_B]);
		const shortA = map.shorten(COLLIDE_A);
		const shortB = map.shorten(COLLIDE_B);

		// 8-char prefix collides, so both must extend to the first differing char.
		expect(shortA.length).toBeGreaterThan(MIN_PREFIX);
		expect(shortA).toBe("abcdef01-2");
		expect(shortB).toBe("abcdef01-3");
		expect(shortA).not.toBe(shortB);

		// And they still round-trip.
		expect(map.expand(shortA)).toBe(COLLIDE_A);
		expect(map.expand(shortB)).toBe(COLLIDE_B);
	});

	test("expand throws on an ambiguous prefix", () => {
		const map = createShortIdMap([COLLIDE_A, COLLIDE_B]);
		// The shared 8-char prefix matches both ids.
		expect(() => map.expand("abcdef01")).toThrow(/[Aa]mbiguous/);
	});

	test("expand throws on an unknown prefix", () => {
		const map = createShortIdMap([SOLO]);
		expect(() => map.expand("ffffffff")).toThrow(/[Uu]nknown/);
	});

	test("expand accepts a full-length id", () => {
		const map = createShortIdMap([COLLIDE_A, COLLIDE_B, SOLO]);
		expect(map.expand(COLLIDE_A)).toBe(COLLIDE_A);
		expect(map.expand(SOLO)).toBe(SOLO);
	});

	test("duplicate ids are collapsed", () => {
		const map = createShortIdMap([SOLO, SOLO, SOLO]);
		expect(map.shorten(SOLO)).toBe(SOLO.slice(0, MIN_PREFIX));
		expect(map.expand(SOLO)).toBe(SOLO);
	});
});
