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
		saveProxyFile: async () => {},
		deleteMediaAsset: async () => {},
	},
}));

// Proxy generation is fire-and-forget from loadProjectMedia's retry path (see
// retryIncompleteProxyGeneration): stub the real WebCodecs/mediabunny-backed
// generator with a fast, deterministic fake so tests can observe *whether*
// generation was kicked off without doing real video decode work.
// media-manager.ts calls generateProxyOffThread (off-main-thread proxy
// worker offload, part 3) rather than generateProxy directly — mock that
// export so the module registry (shared across this test run) satisfies
// media-manager's actual import.
const generateProxyCalls: string[] = [];
let generateProxyImpl: () => Promise<{
	file: File;
	width: number;
	height: number;
}> = async () => ({
	file: new File([new Uint8Array([1])], "proxy.mp4", { type: "video/mp4" }),
	width: 1280,
	height: 720,
});
mock.module("@/services/proxy", () => ({
	generateProxyOffThread: async (options: { file: File }) => {
		generateProxyCalls.push(options.file.name);
		return generateProxyImpl();
	},
	// media-manager statically imports this alongside generateProxy; the mock
	// must re-export it or the ESM binding fails at import time. Mirror the real
	// cancellation contract rather than stubbing it out.
	isProxyCancelledError: (error: unknown) =>
		error instanceof Error &&
		(error.message === "Proxy generation cancelled" ||
			error.name === "AbortError"),
}));

// Import AFTER the mocks so the manager binds the stubs (repo convention).
const { MediaManager } = await import("@/core/managers/media-manager");

/** Flush the microtask queue so fire-and-forget async work (retry proxy
 * generation, which awaits localAIScheduler.waitForIdle() then generateProxy)
 * settles before assertions run. */
async function flushAsync(times = 4): Promise<void> {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

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
	generateProxyCalls.length = 0;
	generateProxyImpl = async () => ({
		file: new File([new Uint8Array([1])], "proxy.mp4", { type: "video/mp4" }),
		width: 1280,
		height: 720,
	});
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

/**
 * Gap-close for the HEVC cross-browser decode design (Option A): proxy
 * generation only used to fire from `addMediaAsset()`, at ingest. If that run
 * was interrupted (tab/browser closed mid-generation), the asset is
 * persisted with `needsProxy() === true` and no `proxy` field forever, since
 * reopening a project goes through `loadProjectMedia`, never `addMediaAsset`.
 * `retryIncompleteProxyGeneration` re-fires `scheduleAutoProxyGeneration` on
 * every load for exactly the assets that still need one and don't have one,
 * relying on `scheduleAutoProxyGeneration`'s own idempotency guards to avoid
 * re-generating an existing proxy or duplicating in-flight work.
 */
describe("loadProjectMedia — retries proxy generation that never completed", () => {
	it("passthrough asset with no proxy yet (interrupted generation) → retries on reopen", async () => {
		assetsToLoad = [videoAsset({ passthrough: { codec: "hvc1.1.6.L120.90" } })];
		const manager = new MediaManager(makeEditor());

		await manager.loadProjectMedia({ projectId: "p1" });
		await flushAsync();

		expect(generateProxyCalls).toEqual(["GX010042.mp4"]);
		expect(manager.getAssetById("m1")?.proxy).toBeTruthy();
	});

	it("asset that already has a proxy → does NOT re-generate on reopen", async () => {
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
		await flushAsync();

		expect(generateProxyCalls).toEqual([]);
	});

	it("asset that doesn't need a proxy (H.264, ≤1080p) → never triggers generation", async () => {
		assetsToLoad = [videoAsset({ passthrough: undefined })];
		const manager = new MediaManager(makeEditor());

		await manager.loadProjectMedia({ projectId: "p1" });
		await flushAsync();

		expect(generateProxyCalls).toEqual([]);
	});

	it("more than one incomplete asset → retries each independently", async () => {
		assetsToLoad = [
			videoAsset({
				id: "m1",
				name: "a.mp4",
				file: new File([new Uint8Array([1])], "a.mp4", {
					type: "video/mp4",
				}),
				passthrough: { codec: "hvc1.1.6.L120.90" },
			}),
			videoAsset({
				id: "m2",
				name: "b.mp4",
				file: new File([new Uint8Array([1])], "b.mp4", {
					type: "video/mp4",
				}),
				width: 3840,
				height: 2160,
			}),
		];
		const manager = new MediaManager(makeEditor());

		await manager.loadProjectMedia({ projectId: "p1" });
		await flushAsync();

		expect(generateProxyCalls.sort()).toEqual(["a.mp4", "b.mp4"]);
		expect(manager.getAssetById("m1")?.proxy).toBeTruthy();
		expect(manager.getAssetById("m2")?.proxy).toBeTruthy();
	});
});
