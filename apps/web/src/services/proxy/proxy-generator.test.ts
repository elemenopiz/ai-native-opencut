import { describe, expect, it } from "bun:test";
import { PROXY_PRESETS, type ProxyResolution } from "@/services/storage/types";
import { computeProxyDimensions } from "./proxy-generator";

const isEven = (n: number) => n % 2 === 0;

describe("computeProxyDimensions", () => {
	it("snaps the reported 4K→480p case to even dimensions instead of 853x480", () => {
		// Regression: min(854/3840, 480/2160) = 0.2222 → 853.3x480, and plain
		// Math.round produced an odd 853 width that the AVC encoder rejected.
		const { width, height } = computeProxyDimensions(
			3840,
			2160,
			PROXY_PRESETS["480p"],
		);
		expect(isEven(width)).toBe(true);
		expect(isEven(height)).toBe(true);
		expect(width).toBe(852);
		expect(height).toBe(480);
	});

	it("keeps every preset even for the 4K fixture (incl. the ones that used to land even by luck)", () => {
		const resolutions: ProxyResolution[] = ["480p", "720p", "1080p"];
		for (const resolution of resolutions) {
			const preset = PROXY_PRESETS[resolution];
			const { width, height } = computeProxyDimensions(3840, 2160, preset);
			expect(isEven(width)).toBe(true);
			expect(isEven(height)).toBe(true);
			// Never exceeds the target box, never upscales.
			expect(width).toBeLessThanOrEqual(preset.maxWidth);
			expect(height).toBeLessThanOrEqual(preset.maxHeight);
			expect(width).toBeLessThanOrEqual(3840);
			expect(height).toBeLessThanOrEqual(2160);
		}
	});

	it("produces even dimensions for an already-small odd source (scale = 1)", () => {
		// Odd source dimensions still break AVC even without downscaling.
		const { width, height } = computeProxyDimensions(
			641,
			361,
			PROXY_PRESETS["1080p"],
		);
		expect(isEven(width)).toBe(true);
		expect(isEven(height)).toBe(true);
		expect(width).toBe(640);
		expect(height).toBe(360);
	});

	it("floors to a non-zero even dimension for a tiny source", () => {
		const { width, height } = computeProxyDimensions(
			1,
			1,
			PROXY_PRESETS["480p"],
		);
		expect(width).toBe(2);
		expect(height).toBe(2);
	});

	it("scans a range of odd/awkward source sizes and never returns an odd or zero axis", () => {
		const sources: Array<[number, number]> = [
			[1920, 1080],
			[1921, 1081],
			[1080, 1920],
			[999, 543],
			[3841, 2161],
			[854, 481],
		];
		for (const [w, h] of sources) {
			for (const resolution of ["480p", "720p", "1080p"] as ProxyResolution[]) {
				const { width, height } = computeProxyDimensions(
					w,
					h,
					PROXY_PRESETS[resolution],
				);
				expect(isEven(width)).toBe(true);
				expect(isEven(height)).toBe(true);
				expect(width).toBeGreaterThanOrEqual(2);
				expect(height).toBeGreaterThanOrEqual(2);
			}
		}
	});
});
