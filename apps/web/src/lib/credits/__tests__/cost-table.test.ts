import { describe, expect, it } from "bun:test";
import { costFor, isFreeAction } from "../cost-table";

/**
 * The cost table is the server-authoritative price list. These assertions pin
 * the researched rates + the rounding/minimum rules so a stray edit can't
 * silently change what a paid action costs.
 */
describe("costFor — video", () => {
	it("charges rate × seconds (default 5s)", () => {
		expect(costFor("byteplus-seedance", "video")).toBe(50); // 10 × 5
		expect(costFor("byteplus-seedance", "video", { seconds: 8 })).toBe(80);
		expect(costFor("runway", "video", { seconds: 5 })).toBe(175); // 35 × 5
		expect(costFor("pika", "video", { seconds: 5 })).toBe(25); // 5 × 5
		expect(costFor("google-veo", "video", { seconds: 5 })).toBe(100); // 20 × 5
	});

	it("rounds fractional seconds UP (ceil)", () => {
		expect(costFor("pika", "video", { seconds: 0.5 })).toBe(3); // ceil(2.5)
		expect(costFor("byteplus-seedance", "video", { seconds: 0.11 })).toBe(2); // ceil(1.1)
	});

	it("charges at least 1 credit for any paid video", () => {
		expect(costFor("pika", "video", { seconds: 0.0001 })).toBe(1);
	});

	it("throws on an unknown video backend (fail loud, never $0)", () => {
		expect(() => costFor("no-such-backend", "video")).toThrow();
	});
});

describe("costFor — image", () => {
	it("charges the flat rate × count", () => {
		expect(costFor("openai-gpt-image", "image")).toBe(4);
		expect(costFor("openai-gpt-image", "image", { count: 3 })).toBe(12);
		expect(costFor("ideogram", "image", { count: 2 })).toBe(6); // 3 × 2
	});

	it("treats count < 1 as 1", () => {
		expect(costFor("bfl-flux", "image", { count: 0 })).toBe(4);
	});

	it("throws on an unknown image backend", () => {
		expect(() => costFor("no-such-image", "image")).toThrow();
	});
});

describe("costFor — free actions", () => {
	it("prices enhance-prompt and infographic at 0", () => {
		expect(costFor("byteplus-seedance", "enhance-prompt")).toBe(0);
		expect(costFor("byteplus-seedance", "infographic")).toBe(0);
	});

	it("isFreeAction reflects the free set", () => {
		expect(isFreeAction("enhance-prompt")).toBe(true);
		expect(isFreeAction("infographic")).toBe(true);
		expect(isFreeAction("video")).toBe(false);
		expect(isFreeAction("image")).toBe(false);
	});
});
