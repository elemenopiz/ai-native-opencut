import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/types/assets";

/**
 * Part 2 of the HEVC/VP9/AV1 cross-browser decode fallback design (Option A,
 * `docs/plans/2026-07-15-hevc-cross-browser-decode-design.md`): a passthrough
 * asset's codec was only ever confirmed decodable by whichever browser
 * ingested it (see PassthroughCodec in services/storage/types.ts).
 * loadProjectMedia's reprobe re-checks that on every open with a cheap
 * `VideoDecoder.isConfigSupported()` capability check — NOT a decode, NOT a
 * file re-open — and flags/warns about the assets this browser can't
 * decode, so the user learns about it on open instead of hitting the
 * VideoCache mid-scrub crash the design doc describes.
 *
 * storageService is mocked (not the real IndexedDB/OPFS-backed one) so this
 * suite can drive loadProjectMedia's reprobe branch in isolation; sonner is
 * mocked to capture the exact user-facing copy.
 */

const toastCalls: { warning: string[] } = { warning: [] };
mock.module("sonner", () => ({
	toast: {
		warning: (msg: string) => {
			toastCalls.warning.push(msg);
		},
		error: () => {},
		success: () => {},
		info: () => {},
		loading: () => "toast-id",
		dismiss: () => {},
	},
}));

let assetsToLoad: MediaAsset[] = [];
mock.module("@/services/storage/service", () => ({
	storageService: {
		loadAllMediaAssets: async () => assetsToLoad,
		loadProxyFile: async () => null,
		saveMediaAsset: async () => {},
		deleteMediaAsset: async () => {},
	},
}));

// Import AFTER the mocks so the manager binds the stubs (repo convention).
const { MediaManager } = await import("@/core/managers/media-manager");

function makeEditor(): EditorCore {
	return {} as unknown as EditorCore;
}

function videoAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "m1",
		name: "GX010042.mp4",
		type: "video",
		file: new File([new Uint8Array([1])], "GX010042.mp4", {
			type: "video/mp4",
		}),
		width: 1920,
		height: 1080,
		...overrides,
	} as MediaAsset;
}

beforeEach(() => {
	toastCalls.warning.length = 0;
	assetsToLoad = [];
	// biome-ignore lint/performance/noDelete: test cleanup of a global stub
	delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
});

describe("loadProjectMedia — proactive passthrough decodability reprobe", () => {
	it("VideoDecoder undefined (tests/SSR) → treated as decodable: no toast, no flag", async () => {
		assetsToLoad = [videoAsset({ passthrough: { codec: "hvc1.1.6.L120.90" } })];
		const manager = new MediaManager(makeEditor());

		await manager.loadProjectMedia({ projectId: "p1" });

		expect(toastCalls.warning).toEqual([]);
		expect(manager.getAssetById("m1")?.decodeUnsupported).toBeUndefined();
	});

	it("isConfigSupported() → true: no toast, no flag", async () => {
		(globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder = {
			isConfigSupported: async () => ({ supported: true }),
		};
		assetsToLoad = [videoAsset({ passthrough: { codec: "hvc1.1.6.L120.90" } })];
		const manager = new MediaManager(makeEditor());

		await manager.loadProjectMedia({ projectId: "p1" });

		expect(toastCalls.warning).toEqual([]);
		expect(manager.getAssetById("m1")?.decodeUnsupported).toBeUndefined();
	});

	it("isConfigSupported() → false, no proxy yet: flags decodeUnsupported + warns no fallback is ready", async () => {
		(globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder = {
			isConfigSupported: async () => ({ supported: false }),
		};
		assetsToLoad = [videoAsset({ passthrough: { codec: "hvc1.1.6.L120.90" } })];
		const manager = new MediaManager(makeEditor());

		await manager.loadProjectMedia({ projectId: "p1" });

		expect(manager.getAssetById("m1")?.decodeUnsupported).toBe(true);
		expect(toastCalls.warning).toHaveLength(1);
		expect(toastCalls.warning[0]).toContain("GX010042.mp4");
		expect(toastCalls.warning[0]).toContain(
			"no lower-quality proxy is available yet",
		);
	});

	it("isConfigSupported() → false, proxy already generated: warns the proxy will be used instead", async () => {
		(globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder = {
			isConfigSupported: async () => ({ supported: false }),
		};
		assetsToLoad = [
			videoAsset({
				passthrough: { codec: "hvc1.1.6.L120.90" },
				proxy: {
					resolution: "720p",
					width: 1280,
					height: 720,
					generatedAt: Date.now(),
					fileSize: 1000,
				},
			}),
		];
		const manager = new MediaManager(makeEditor());

		await manager.loadProjectMedia({ projectId: "p1" });

		expect(manager.getAssetById("m1")?.decodeUnsupported).toBe(true);
		expect(toastCalls.warning).toHaveLength(1);
		expect(toastCalls.warning[0]).toContain(
			"playing from a lower-quality proxy instead",
		);
	});

	it("H.264 original (no passthrough marker): never re-probed, no toast, no flag", async () => {
		(globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder = {
			isConfigSupported: async () => ({ supported: false }),
		};
		assetsToLoad = [videoAsset({ passthrough: undefined })];
		const manager = new MediaManager(makeEditor());

		await manager.loadProjectMedia({ projectId: "p1" });

		expect(toastCalls.warning).toEqual([]);
		expect(manager.getAssetById("m1")?.decodeUnsupported).toBeUndefined();
	});

	it("an undecodable asset never blocks or fails the load", async () => {
		(globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder = {
			isConfigSupported: async () => ({ supported: false }),
		};
		assetsToLoad = [videoAsset({ passthrough: { codec: "hvc1.1.6.L120.90" } })];
		const manager = new MediaManager(makeEditor());

		await manager.loadProjectMedia({ projectId: "p1" });

		expect(manager.isLoadingMedia()).toBe(false);
		expect(manager.getAssets()).toHaveLength(1);
	});

	it("VideoDecoder.isConfigSupported throwing is treated as decodable (never worse than before)", async () => {
		(globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder = {
			isConfigSupported: async () => {
				throw new Error("boom");
			},
		};
		assetsToLoad = [videoAsset({ passthrough: { codec: "hvc1.1.6.L120.90" } })];
		const manager = new MediaManager(makeEditor());

		await manager.loadProjectMedia({ projectId: "p1" });

		expect(toastCalls.warning).toEqual([]);
		expect(manager.getAssetById("m1")?.decodeUnsupported).toBeUndefined();
	});
});
