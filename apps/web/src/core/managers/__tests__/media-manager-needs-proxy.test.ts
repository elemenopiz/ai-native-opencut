import { describe, expect, it, mock } from "bun:test";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/types/assets";

/**
 * needsProxy() is the gate for background H.264 proxy generation. Two ways in:
 * - resolution: above 1920×1080 (the original perf case), any codec;
 * - portability: a passthrough non-H.264 asset (`passthrough` marker set at
 *   ingest — see PassthroughCodec in services/storage/types.ts) at ANY
 *   resolution, because other browsers may not decode the original and the
 *   proxy is the guaranteed-portable fallback.
 * H.264 originals and ingest-transcoded ("normalized") assets carry no marker
 * and keep the resolution-only behavior.
 *
 * Order-dependence guard: `MediaManager` (from
 * "@/core/managers/media-manager") statically imports the real
 * `@/services/proxy` barrel (chaining into proxy-encoder-controller.ts ->
 * proxy-generator.ts). A plain static import here would cache the real chain
 * in bun test's shared module registry before
 * proxy-encoder-controller.test.ts's own `mock.module()` can take effect, if
 * that file runs later in the same `bun test` invocation. Mock the barrel
 * and import dynamically, AFTER the mock (mirrors
 * media-manager-decode-reprobe.test.ts's barrel mock + "Import AFTER the
 * mocks" convention). `needsProxy()` is a pure function — proxy generation
 * itself is never exercised here.
 */
mock.module("@/services/proxy", () => ({
	generateProxyOffThread: async () => ({
		file: new File([new Uint8Array([1])], "proxy.mp4", { type: "video/mp4" }),
		width: 1280,
		height: 720,
	}),
	isProxyCancelledError: (error: unknown) =>
		error instanceof Error &&
		(error.message === "Proxy generation cancelled" ||
			error.name === "AbortError"),
}));

const { MediaManager } = await import("@/core/managers/media-manager");

function makeEditor(): EditorCore {
	return {} as unknown as EditorCore;
}

function videoAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "m1",
		name: "clip.mp4",
		type: "video",
		file: new File([new Uint8Array([1])], "clip.mp4", { type: "video/mp4" }),
		width: 1920,
		height: 1080,
		...overrides,
	} as MediaAsset;
}

describe("needsProxy — passthrough non-H.264 assets always proxy", () => {
	const manager = new MediaManager(makeEditor());

	it("passthrough non-H.264 at ≤1080p → true (the cross-browser fallback case)", () => {
		expect(
			manager.needsProxy(
				videoAsset({ passthrough: { codec: "hvc1.1.6.L120.90" } }),
			),
		).toBe(true);
	});

	it("passthrough non-H.264 even below 1080p (e.g. 1280×720) → true", () => {
		expect(
			manager.needsProxy(
				videoAsset({
					width: 1280,
					height: 720,
					passthrough: { codec: "vp09.00.10.08" },
				}),
			),
		).toBe(true);
	});

	it("passthrough marker without dimensions still → true (proxy generation reads the file, not the dims)", () => {
		expect(
			manager.needsProxy(
				videoAsset({
					width: undefined,
					height: undefined,
					passthrough: { codec: "hvc1.1.6.L120.90" },
				}),
			),
		).toBe(true);
	});

	it("H.264 original at ≤1080p (no marker) → false, unchanged", () => {
		expect(manager.needsProxy(videoAsset())).toBe(false);
	});

	it("ingest-transcoded (normalized) asset at ≤1080p → false, unchanged", () => {
		expect(
			manager.needsProxy(
				videoAsset({
					normalized: { originalName: "GX010042.mp4", originalCodec: "hevc" },
				}),
			),
		).toBe(false);
	});

	it(">1080p still → true regardless of any marker (original resolution gate intact)", () => {
		expect(manager.needsProxy(videoAsset({ width: 3840, height: 2160 }))).toBe(
			true,
		);
		expect(
			manager.needsProxy(
				videoAsset({
					width: 3840,
					height: 2160,
					passthrough: { codec: "hvc1.1.6.L120.90" },
				}),
			),
		).toBe(true);
	});

	it("non-video assets never proxy, marker or not", () => {
		expect(
			manager.needsProxy(
				videoAsset({
					type: "audio",
					passthrough: { codec: "hvc1.1.6.L120.90" },
				}),
			),
		).toBe(false);
	});

	it("missing dimensions without a marker → false, unchanged", () => {
		expect(
			manager.needsProxy(videoAsset({ width: undefined, height: undefined })),
		).toBe(false);
	});
});
