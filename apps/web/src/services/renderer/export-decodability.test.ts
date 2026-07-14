import { afterEach, describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/types/assets";
import { resolveExportProxyFallback } from "./export-decodability";

/**
 * `resolveExportProxyFallback` is the export-time re-check for HEVC/VP9/AV1
 * "passthrough" assets: independent of whatever the ingesting browser decided,
 * it asks THIS browser (via `VideoDecoder.isConfigSupported`) whether the
 * stored original can still be decoded, and routes undecodable-but-proxied
 * assets to their H.264 proxy instead of failing export outright.
 */

const originalVideoDecoder = (globalThis as { VideoDecoder?: unknown })
	.VideoDecoder;

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "asset-1",
		name: "clip.mov",
		type: "video",
		file: new File([], "clip.mov"),
		url: "blob://clip.mov",
		...overrides,
	} as MediaAsset;
}

function stubVideoDecoder(
	isConfigSupported: (config: { codec: string }) => Promise<{
		supported?: boolean;
	}>,
) {
	(globalThis as { VideoDecoder?: unknown }).VideoDecoder = {
		isConfigSupported,
	};
}

afterEach(() => {
	if (originalVideoDecoder === undefined) {
		delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
	} else {
		(globalThis as { VideoDecoder?: unknown }).VideoDecoder =
			originalVideoDecoder;
	}
});

describe("resolveExportProxyFallback", () => {
	test("ignores assets without a passthrough marker (normal H.264 originals)", async () => {
		stubVideoDecoder(async () => ({ supported: false }));

		const result = await resolveExportProxyFallback({
			mediaAssets: [makeAsset({ passthrough: undefined })],
		});

		expect(result.fallbackAssetIds.size).toBe(0);
		expect(result.blockingAssets).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("ignores non-video assets even if they somehow carry a passthrough marker", async () => {
		stubVideoDecoder(async () => ({ supported: false }));

		const result = await resolveExportProxyFallback({
			mediaAssets: [
				makeAsset({
					type: "image",
					passthrough: { codec: "hvc1.1.6.L120.90" },
				}),
			],
		});

		expect(result.fallbackAssetIds.size).toBe(0);
		expect(result.blockingAssets).toEqual([]);
	});

	test("decodable passthrough original: no fallback, no warning (byte-identical to before)", async () => {
		stubVideoDecoder(async () => ({ supported: true }));

		const asset = makeAsset({
			passthrough: { codec: "hvc1.1.6.L120.90" },
			proxyFile: new File([], "clip-proxy.mp4"),
			proxyUrl: "blob://clip-proxy.mp4",
		});

		const result = await resolveExportProxyFallback({ mediaAssets: [asset] });

		expect(result.fallbackAssetIds.size).toBe(0);
		expect(result.blockingAssets).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("undecodable passthrough original WITH a proxy: falls back and warns, naming the clip", async () => {
		stubVideoDecoder(async () => ({ supported: false }));

		const asset = makeAsset({
			name: "gopro-drone.mp4",
			passthrough: { codec: "hvc1.1.6.L120.90" },
			proxyFile: new File([], "gopro-drone-proxy.mp4"),
			proxyUrl: "blob://gopro-drone-proxy.mp4",
		});

		const result = await resolveExportProxyFallback({ mediaAssets: [asset] });

		expect(result.fallbackAssetIds.has(asset.id)).toBe(true);
		expect(result.blockingAssets).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("gopro-drone.mp4");
		expect(result.warnings[0]).toContain("proxy");
	});

	test("undecodable passthrough original WITHOUT a proxy: blocks export instead of silently substituting nothing", async () => {
		stubVideoDecoder(async () => ({ supported: false }));

		const asset = makeAsset({
			name: "still-generating.mp4",
			passthrough: { codec: "hvc1.1.6.L120.90" },
			proxyFile: undefined,
			proxyUrl: undefined,
		});

		const result = await resolveExportProxyFallback({ mediaAssets: [asset] });

		expect(result.fallbackAssetIds.size).toBe(0);
		expect(result.blockingAssets).toEqual([asset]);
		expect(result.warnings).toEqual([]);
	});

	test("isConfigSupported throwing (malformed codec string) is treated as unsupported, not a crash", async () => {
		stubVideoDecoder(async () => {
			throw new Error("Invalid codec string");
		});

		const asset = makeAsset({
			passthrough: { codec: "garbage" },
			proxyFile: new File([], "proxy.mp4"),
			proxyUrl: "blob://proxy.mp4",
		});

		const result = await resolveExportProxyFallback({ mediaAssets: [asset] });

		expect(result.fallbackAssetIds.has(asset.id)).toBe(true);
		expect(result.warnings).toHaveLength(1);
	});

	test("VideoDecoder undefined (guard): treated as decodable/unknown, does nothing", async () => {
		// Simulate an environment without WebCodecs support.
		delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;

		const asset = makeAsset({
			passthrough: { codec: "hvc1.1.6.L120.90" },
			proxyFile: new File([], "proxy.mp4"),
			proxyUrl: "blob://proxy.mp4",
		});

		const result = await resolveExportProxyFallback({ mediaAssets: [asset] });

		expect(result.fallbackAssetIds.size).toBe(0);
		expect(result.blockingAssets).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("multiple undecodable assets: one warning per clip, each naming its own asset", async () => {
		stubVideoDecoder(async () => ({ supported: false }));

		const assetA = makeAsset({
			id: "a",
			name: "a.mov",
			passthrough: { codec: "hvc1.1.6.L120.90" },
			proxyFile: new File([], "a-proxy.mp4"),
			proxyUrl: "blob://a-proxy.mp4",
		});
		const assetB = makeAsset({
			id: "b",
			name: "b.mov",
			passthrough: { codec: "hvc1.1.6.L120.90" },
			proxyFile: new File([], "b-proxy.mp4"),
			proxyUrl: "blob://b-proxy.mp4",
		});

		const result = await resolveExportProxyFallback({
			mediaAssets: [assetA, assetB],
		});

		expect(result.fallbackAssetIds).toEqual(new Set(["a", "b"]));
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings.some((w) => w.includes("a.mov"))).toBe(true);
		expect(result.warnings.some((w) => w.includes("b.mov"))).toBe(true);
	});
});
