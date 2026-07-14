import { describe, expect, it } from "bun:test";
import {
	allPricedOps,
	costFor,
	imageCreditsRange,
	isFreeAction,
	videoCreditsRange,
} from "../cost-table";

/**
 * The cost table is the server-authoritative price list. `costFor()` returns
 * the SALE price (COGS × founder-approved markup, rounded up) — these
 * assertions pin the shipped sale rates + the rounding/minimum rules so a
 * stray edit can't silently change what a paid action costs.
 *
 * Sale-rate derivation (see cost-table.ts for the COGS + markup tables):
 *   Seedance: 480p 7×3.0=21, 720p 15.2×2.2=33.44→34, 1080p 37.4×1.6=59.84→60
 *   kling/luma-ray: 10×2.2=22, pika: 5×2.2=11, runway: 35×(80/35)=80
 *   images: COGS×2.5 → openai-gpt-image/bfl-flux/google-imagen 4×2.5=10,
 *           google-nano-banana 14×2.5=35, ideogram 3×2.5=7.5→8
 */
describe("costFor — video", () => {
	it("charges rate × seconds (default 5s, default resolution 720p)", () => {
		expect(costFor("byteplus-seedance", "video")).toBe(170); // 34 × 5
		expect(costFor("byteplus-seedance", "video", { seconds: 8 })).toBe(272); // 34 × 8
		expect(costFor("runway", "video", { seconds: 5 })).toBe(400); // 80 × 5
		expect(costFor("pika", "video", { seconds: 5 })).toBe(55); // 11 × 5
	});

	it("Seedance's rate is resolution-degressive (480p < 720p < 1080p per-sec, thinner markup at the top)", () => {
		expect(
			costFor("byteplus-seedance", "video", { seconds: 5, resolution: "480p" }),
		).toBe(105); // 21 × 5
		expect(
			costFor("byteplus-seedance", "video", { seconds: 5, resolution: "720p" }),
		).toBe(170); // 34 × 5
		expect(
			costFor("byteplus-seedance", "video", {
				seconds: 5,
				resolution: "1080p",
			}),
		).toBe(300); // 60 × 5
	});

	it("ignores `resolution` for flat-rate (non-Seedance) backends", () => {
		const withRes = costFor("kling", "video", {
			seconds: 5,
			resolution: "1080p",
		});
		const withoutRes = costFor("kling", "video", { seconds: 5 });
		expect(withRes).toBe(withoutRes);
		expect(withRes).toBe(110); // 22 × 5
	});

	it("rounds fractional seconds UP (ceil)", () => {
		expect(costFor("pika", "video", { seconds: 0.5 })).toBe(6); // ceil(5.5)
		expect(costFor("byteplus-seedance", "video", { seconds: 0.11 })).toBe(4); // ceil(34×0.11=3.74)
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
		expect(costFor("luma-ray", "video", { seconds: 5 })).toBe(110); // 22 × 5
		expect(() => costFor("luma", "video")).toThrow();
	});

	it("prices Veo 3.1 Standard + Fast (Google, native synced audio; degressive markup — 1.6x/2.0x)", () => {
		expect(costFor("google-veo", "video", { seconds: 5 })).toBe(320); // 64 × 5
		expect(costFor("google-veo-fast", "video", { seconds: 5 })).toBe(120); // 24 × 5
	});
});

describe("videoCreditsRange / imageCreditsRange — pre-routing estimate", () => {
	it("spans the cheapest to priciest registered video backend/resolution", () => {
		// pika (11/sec) is cheapest, runway (80/sec) is priciest — wider than
		// Seedance's own 21–60 span or google-veo's 64/sec at any resolution.
		expect(videoCreditsRange(5)).toEqual({ low: 55, high: 400 });
	});

	it("narrowing to one Seedance resolution doesn't change the global range here (pika/runway still bracket it), but never throws", () => {
		expect(videoCreditsRange(5, "1080p")).toEqual({ low: 55, high: 400 });
		expect(videoCreditsRange(5, "480p")).toEqual({ low: 55, high: 400 });
	});

	it("spans the cheapest to priciest registered image backend", () => {
		// ideogram (8) is cheapest, google-nano-banana (35) is priciest.
		expect(imageCreditsRange(1)).toEqual({ low: 8, high: 35 });
		expect(imageCreditsRange(2)).toEqual({ low: 16, high: 70 });
	});

	it("never returns below 1 credit", () => {
		expect(videoCreditsRange(0.001).low).toBeGreaterThanOrEqual(1);
		expect(imageCreditsRange(0).low).toBeGreaterThanOrEqual(1);
	});
});

describe("costFor — image", () => {
	it("charges the flat sale rate × count", () => {
		expect(costFor("openai-gpt-image", "image")).toBe(10);
		expect(costFor("openai-gpt-image", "image", { count: 3 })).toBe(30);
		expect(costFor("ideogram", "image", { count: 2 })).toBe(16); // 8 × 2
	});

	it("treats count < 1 as 1", () => {
		expect(costFor("bfl-flux", "image", { count: 0 })).toBe(10);
	});

	it("throws on an unknown image backend", () => {
		expect(() => costFor("no-such-image", "image")).toThrow();
	});
});

describe("costFor — audio (COGS × 2.5 markup)", () => {
	it("charges MMAudio (COGS 0.1 cr/sec × 2.5 = 0.25 cr/sec) rounded up", () => {
		expect(costFor("fal-mmaudio", "audio", { seconds: 8 })).toBe(2); // ceil(2.0)
		expect(costFor("fal-mmaudio", "audio", { seconds: 30 })).toBe(8); // ceil(7.5)
		expect(costFor("fal-mmaudio", "audio", { seconds: 21 })).toBe(6); // ceil(5.25)
	});

	it("charges ElevenLabs Music (COGS 0.25 cr/sec × 2.5 = 0.625 cr/sec) rounded up", () => {
		expect(costFor("elevenlabs-music", "audio", { seconds: 60 })).toBe(38); // ceil(37.5)
		expect(costFor("elevenlabs-music", "audio", { seconds: 30 })).toBe(19); // ceil(18.75)
	});

	it("charges at least 1 credit for any paid audio job", () => {
		expect(costFor("fal-mmaudio", "audio", { seconds: 0.01 })).toBe(1);
	});

	it("falls back to the default 5s clip length when seconds is omitted", () => {
		expect(costFor("elevenlabs-music", "audio")).toBe(4); // ceil(0.625 × 5)
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

describe("allPricedOps — no-negative-margin sanity gate", () => {
	it("prices every registered backend/action(/resolution) at or above its COGS", () => {
		const rows = allPricedOps();
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.sale).toBeGreaterThanOrEqual(row.cogs);
		}
	});

	it("covers every backend this table knows how to bill", () => {
		const ids = allPricedOps().map((r) => r.backendId);
		expect(new Set(ids)).toEqual(
			new Set([
				"byteplus-seedance",
				"kling",
				"luma-ray",
				"pika",
				"runway",
				"google-veo",
				"google-veo-fast",
				"openai-gpt-image",
				"bfl-flux",
				"google-imagen",
				"google-nano-banana",
				"ideogram",
				"fal-mmaudio",
				"elevenlabs-music",
			]),
		);
	});
});
