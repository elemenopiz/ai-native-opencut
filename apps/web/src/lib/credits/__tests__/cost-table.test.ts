import { describe, expect, it } from "bun:test";
import {
	costFor,
	imageCreditsRange,
	isFreeAction,
	videoCreditsRange,
} from "../cost-table";

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

	it('prices the registered Luma backend id ("luma-ray", not "luma")', () => {
		// Regression pin: `GenerationBackend.id` for Luma is "luma-ray"
		// (`backends/video/luma.ts`) — this key must match exactly or every
		// Luma generation throws when the server tries to bill it.
		expect(costFor("luma-ray", "video", { seconds: 5 })).toBe(50); // 10 × 5
		expect(() => costFor("luma", "video")).toThrow();
	});
});

describe("videoCreditsRange / imageCreditsRange — pre-routing estimate", () => {
	it("spans the cheapest to priciest registered video backend", () => {
		// pika (5/sec) is cheapest, runway (35/sec) is priciest.
		expect(videoCreditsRange(5)).toEqual({ low: 25, high: 175 });
	});

	it("spans the cheapest to priciest registered image backend", () => {
		// ideogram (3) is cheapest, google-nano-banana (14) is priciest.
		expect(imageCreditsRange(1)).toEqual({ low: 3, high: 14 });
		expect(imageCreditsRange(2)).toEqual({ low: 6, high: 28 });
	});

	it("never returns below 1 credit", () => {
		expect(videoCreditsRange(0.001).low).toBeGreaterThanOrEqual(1);
		expect(imageCreditsRange(0).low).toBeGreaterThanOrEqual(1);
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

describe("costFor — audio", () => {
	it("charges MMAudio (~$0.001/sec → 0.1 credit/sec) rounded up", () => {
		expect(costFor("fal-mmaudio", "audio", { seconds: 8 })).toBe(1); // ceil(0.8)
		expect(costFor("fal-mmaudio", "audio", { seconds: 30 })).toBe(3); // ceil(3.0)
		expect(costFor("fal-mmaudio", "audio", { seconds: 21 })).toBe(3); // ceil(2.1)
	});

	it("charges ElevenLabs Music (~$0.15/min → 0.25 credit/sec ≈ 15 credits/min) rounded up", () => {
		expect(costFor("elevenlabs-music", "audio", { seconds: 60 })).toBe(15);
		expect(costFor("elevenlabs-music", "audio", { seconds: 30 })).toBe(8); // ceil(7.5)
	});

	it("charges at least 1 credit for any paid audio job", () => {
		expect(costFor("fal-mmaudio", "audio", { seconds: 0.01 })).toBe(1);
	});

	it("falls back to the default 5s clip length when seconds is omitted", () => {
		expect(costFor("elevenlabs-music", "audio")).toBe(2); // ceil(0.25 × 5)
	});

	it("throws on an unknown audio backend (fail loud, never $0)", () => {
		expect(() => costFor("no-such-audio-backend", "audio")).toThrow();
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
