import { toast } from "sonner";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/types/assets";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { hasMediaId } from "@/lib/timeline/element-utils";
import {
	PROXY_THRESHOLD_WIDTH,
	PROXY_THRESHOLD_HEIGHT,
	type ProxyResolution,
} from "@/services/storage/types";
import { generateProxyOffThread } from "@/services/proxy";
import { deleteEmbedding } from "@/services/search/embedding-store";
import { deleteTranscript } from "@/services/search/asset-transcript-store";
// Per-project understanding rows die with the asset; the cross-project
// user-media memory (user-memory-store, keyed by CONTENT hash) is deliberately
// left intact — its whole purpose is reuse after this asset is gone.
import { deleteUnderstanding } from "@/services/search/asset-understanding-store";
import { localAIScheduler } from "@/lib/local-ai/scheduler";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";

/**
 * Resolution used for automatic background proxy generation on ingest.
 * Bumped from "720p" to "1080p" (2026-07-15): 720p was soft enough to be
 * visible on paused/settled frames whenever the preview held onto the proxy
 * (see the settle-to-full-res fix in scene-builder.ts/preview/index.tsx) and
 * on any zoomed-in preview of a 4K/2K source. 1080p keeps proxy decode/seek
 * cheap (still a large win over full 4K) while giving the "would the proxy be
 * upscaled" guard (`proxyWouldBeUpscaled` in scene-builder.ts) a much bigger
 * box to work with, so fewer preview frames need to fall back to the
 * original mid-playback. Not exposed as a knob: the "480p" preset has a known
 * odd-dimension crash in generateProxy()'s scale math (853x480 -> AVC encoder
 * rejects odd widths/heights) that is being fixed separately — 1080p (like
 * 720p) rounds to even dimensions for every fixture/aspect-ratio tested so
 * far. This only affects NEW proxy generations: existing "720p" proxies are
 * never auto-regenerated (`scheduleAutoProxyGeneration`/`runAutoProxyGeneration`
 * are both no-ops once `asset.proxy` is set — see below).
 */
const AUTO_PROXY_RESOLUTION: ProxyResolution = "1080p";

/**
 * Cheap WebCodecs capability re-check for a passthrough asset's persisted
 * codec (see `PassthroughCodec`) — `VideoDecoder.isConfigSupported()` is a
 * config check, NOT a decode and NOT a file re-open/re-probe. Guarded for
 * environments without `VideoDecoder` (tests/SSR/older browsers): treated as
 * "unknown, assume decodable" rather than crashing or false-flagging every
 * asset, mirroring the "never make this worse than before" posture the rest
 * of the ingest pipeline uses (see normalize-media.ts / processing.ts).
 */
async function isPassthroughCodecSupported(codec: string): Promise<boolean> {
	if (typeof VideoDecoder === "undefined") return true;
	try {
		const { supported } = await VideoDecoder.isConfigSupported({ codec });
		return supported !== false;
	} catch (error) {
		console.warn("VideoDecoder.isConfigSupported check failed:", error);
		return true;
	}
}

export class MediaManager {
	private assets: MediaAsset[] = [];
	private isLoading = false;
	private listeners = new Set<() => void>();
	private proxyGenerators = new Map<string, AbortController>();

	constructor(private editor: EditorCore) {}

	async addMediaAsset({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
	}): Promise<string> {
		const newAsset: MediaAsset = {
			...asset,
			id: generateUUID(),
		};

		this.assets = [...this.assets, newAsset];
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
		} catch (error) {
			console.error("Failed to save media asset:", error);
			// Roll the optimistic asset back out of the list, then rethrow so
			// callers don't treat a failed save as success. Returning the id here
			// (the old behavior) handed back a phantom asset that no longer exists,
			// so callers counted it as added / built timeline elements referencing
			// media that was never persisted.
			this.assets = this.assets.filter((asset) => asset.id !== newAsset.id);
			this.notify();
			throw error;
		}

		// Fire-and-forget: never block asset-ready on this. Guarded internally
		// by needsProxy()/the persisted proxy field, so this is a no-op for
		// non-video/low-res assets and for assets that already have a proxy.
		this.scheduleAutoProxyGeneration({ assetId: newAsset.id, projectId });

		return newAsset.id;
	}

	async updateMediaAsset({
		projectId,
		id,
		updates,
	}: {
		projectId: string;
		id: string;
		updates: Partial<Pick<MediaAsset, "label" | "name">>;
	}): Promise<void> {
		const index = this.assets.findIndex((a) => a.id === id);
		if (index === -1) return;

		const updated = { ...this.assets[index], ...updates };
		this.assets = this.assets.map((a) => (a.id === id ? updated : a));
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: updated });
		} catch (error) {
			console.error("Failed to update media asset:", error);
		}
	}

	async removeMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const asset = this.assets.find((asset) => asset.id === id);

		videoCache.clearVideo({ mediaId: id });
		deleteEmbedding(id).catch(() => undefined);
		deleteTranscript(id).catch(() => undefined);
		deleteUnderstanding(id).catch(() => undefined);

		if (asset?.url) {
			URL.revokeObjectURL(asset.url);
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
			if (asset.proxyUrl) {
				URL.revokeObjectURL(asset.proxyUrl);
			}
		}

		const controller = this.proxyGenerators.get(id);
		if (controller) {
			controller.abort();
			this.proxyGenerators.delete(id);
		}
		useBackgroundTasksStore.getState().removeTask(`auto-proxy-${id}`);

		this.assets = this.assets.filter((asset) => asset.id !== id);
		this.notify();

		const tracks = this.editor.timeline.getTracks();
		const elementsToRemove: Array<{ trackId: string; elementId: string }> = [];

		for (const track of tracks) {
			for (const element of track.elements) {
				if (hasMediaId(element) && element.mediaId === id) {
					elementsToRemove.push({ trackId: track.id, elementId: element.id });
				}
			}
		}

		if (elementsToRemove.length > 0) {
			this.editor.timeline.deleteElements({ elements: elementsToRemove });
			// Drop the now-deleted elements from the selection so it doesn't keep
			// stale refs to elements that no longer exist.
			const removed = new Set(
				elementsToRemove.map((e) => `${e.trackId}:${e.elementId}`),
			);
			const selection = this.editor.selection.getSelectedElements();
			if (selection.some((s) => removed.has(`${s.trackId}:${s.elementId}`))) {
				this.editor.selection.setSelectedElements({
					elements: selection.filter(
						(s) => !removed.has(`${s.trackId}:${s.elementId}`),
					),
				});
			}
		}

		try {
			await storageService.deleteMediaAsset({ projectId, id });
		} catch (error) {
			console.error("Failed to delete media asset:", error);
		}
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.isLoading = true;
		this.notify();

		try {
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
			});
			this.assets = mediaAssets;

			const proxyPromises = mediaAssets
				.filter((a) => a.proxy)
				.map((a) => this.loadProxyForAsset({ assetId: a.id, projectId }));
			await Promise.all(proxyPromises);

			// Proactive cross-browser decodability re-probe (HEVC cross-browser
			// decode design, Option A part 2): a passthrough asset's codec was
			// only ever confirmed decodable by whichever browser ingested it.
			// Re-check it here — after the proxy load above, so the toast can
			// say whether a fallback proxy is actually ready — instead of
			// trusting that decision forever and letting an unsupported codec
			// surface as a mid-scrub VideoCache crash. Never blocks/fails the
			// load: this is additive reporting only.
			await this.reprobePassthroughDecodability();

			// Retry proxy generation that never completed (HEVC cross-browser
			// decode design, Option A gap-close): addMediaAsset() only fires
			// scheduleAutoProxyGeneration() once, at ingest. If that run was
			// interrupted — tab/browser closed mid-generation — the asset is
			// persisted with `needsProxy() === true` and no `proxy` field
			// forever, since reopening a project goes through this method, not
			// addMediaAsset(). For a passthrough (non-H.264) asset that never
			// got its fallback proxy, that would make the export-time "proxy
			// still being prepared" failure (see export-decodability.ts)
			// permanent on any browser that can't decode the original, instead
			// of resolving on the next open.
			//
			// Placed AFTER the reprobe above (and awaited before this fires) so
			// the two never race on `this.assets`: generateProxyForAsset's
			// completion handler rebuilds an asset from a snapshot it fetches
			// only once its own generation actually starts (post-idle-wait),
			// which must be after the reprobe's flag write has already landed,
			// not concurrent with it — otherwise a last-writer-wins update on
			// the shared assets array could silently drop the reprobe's
			// `decodeUnsupported` flag. Still fire-and-forget: never blocks load.
			this.retryIncompleteProxyGeneration({ projectId });

			this.notify();
		} catch (error) {
			console.error("Failed to load media assets:", error);
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	/**
	 * Re-fires background proxy generation for any loaded video asset that
	 * still needs one (`needsProxy()`) but doesn't have one yet — the retry
	 * path for a generation run interrupted before it could persist
	 * `asset.proxy` (closed tab/browser, crash, etc.). `addMediaAsset()` only
	 * schedules generation once, at ingest, so without this an interrupted
	 * asset would never get a second attempt.
	 *
	 * Safe to call unconditionally on every load: `scheduleAutoProxyGeneration`
	 * already no-ops per-asset when `asset.proxy` is set or generation is
	 * already in flight for that id (see its guard clause), so this never
	 * re-generates an existing proxy or duplicates a running job — it only
	 * ever starts work for assets that need a proxy and don't have one.
	 */
	private retryIncompleteProxyGeneration({
		projectId,
	}: {
		projectId: string;
	}): void {
		for (const asset of this.assets) {
			if (asset.proxy || this.isProxyGenerating(asset.id)) continue;
			if (!this.needsProxy(asset)) continue;
			this.scheduleAutoProxyGeneration({ assetId: asset.id, projectId });
		}
	}

	/**
	 * Re-checks every passthrough (non-H.264, persisted-as-original) video
	 * asset's decodability in THIS browser via a cheap WebCodecs capability
	 * check, and flags the ones that fail. Never re-opens the file, never
	 * decodes, never blocks the caller's load on a slow asset — all checks run
	 * in parallel and failures are reported, not thrown.
	 */
	private async reprobePassthroughDecodability(): Promise<void> {
		const candidates = this.assets.filter(
			(a) => a.type === "video" && a.passthrough,
		);
		if (candidates.length === 0) return;

		await Promise.all(
			candidates.map(async (asset) => {
				if (!asset.passthrough) return;
				const supported = await isPassthroughCodecSupported(
					asset.passthrough.codec,
				);
				if (supported) return;

				this.assets = this.assets.map((a) =>
					a.id === asset.id ? { ...a, decodeUnsupported: true } : a,
				);

				const hasProxyFallback = Boolean(asset.proxy);
				toast.warning(
					hasProxyFallback
						? `"${asset.name}" can't be decoded in this browser — playing from a lower-quality proxy instead.`
						: `"${asset.name}" can't be decoded in this browser and no lower-quality proxy is available yet. Try Chrome or Safari, or wait for the proxy to finish generating.`,
				);
			}),
		);
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
			if (asset.proxyUrl) {
				URL.revokeObjectURL(asset.proxyUrl);
			}
		});

		for (const [id, controller] of this.proxyGenerators) {
			controller.abort();
		}
		this.proxyGenerators.clear();

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		// Drop embedding + transcript + understanding index entries for the
		// removed assets (fire-and-forget).
		mediaIds.forEach((id) => {
			deleteEmbedding(id).catch(() => undefined);
			deleteTranscript(id).catch(() => undefined);
			deleteUnderstanding(id).catch(() => undefined);
		});

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	clearAllAssets(): void {
		videoCache.clearAll();

		for (const [, controller] of this.proxyGenerators) {
			controller.abort();
		}
		this.proxyGenerators.clear();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
			if (asset.proxyUrl) {
				URL.revokeObjectURL(asset.proxyUrl);
			}
		});

		this.assets = [];
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	getAssetById(id: string): MediaAsset | undefined {
		return this.assets.find((a) => a.id === id);
	}

	/**
	 * Whether this video should get a background H.264 preview proxy:
	 * - above 1920×1080 (the original perf case), OR
	 * - stored passthrough in a non-H.264 codec (HEVC/VP9/AV1 kept as-is because
	 *   THIS browser could decode it — see `PassthroughCodec`), at ANY
	 *   resolution: the proxy is the guaranteed-portable fallback for browsers
	 *   that can't decode the original.
	 */
	needsProxy(asset: MediaAsset): boolean {
		if (asset.type !== "video") return false;
		if (asset.passthrough) return true;
		if (!asset.width || !asset.height) return false;
		return (
			asset.width > PROXY_THRESHOLD_WIDTH ||
			asset.height > PROXY_THRESHOLD_HEIGHT
		);
	}

	isProxyGenerating(assetId: string): boolean {
		return this.proxyGenerators.has(assetId);
	}

	async generateProxyForAsset({
		assetId,
		projectId,
		resolution,
		onProgress,
	}: {
		assetId: string;
		projectId: string;
		resolution: ProxyResolution;
		onProgress?: (progress: number) => void;
	}): Promise<void> {
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset || asset.type !== "video") return;

		const existing = this.proxyGenerators.get(assetId);
		if (existing) {
			existing.abort();
			this.proxyGenerators.delete(assetId);
		}

		const controller = new AbortController();
		this.proxyGenerators.set(assetId, controller);
		this.notify();

		try {
			const result = await generateProxyOffThread({
				file: asset.file,
				resolution,
				onProgress,
				signal: controller.signal,
			});

			const proxyUrl = URL.createObjectURL(result.file);

			await storageService.saveProxyFile({
				projectId,
				assetId,
				proxyFile: result.file,
			});

			const updatedAsset: MediaAsset = {
				...asset,
				proxyFile: result.file,
				proxyUrl,
				proxy: {
					resolution,
					width: result.width,
					height: result.height,
					generatedAt: Date.now(),
					fileSize: result.file.size,
				},
			};

			this.assets = this.assets.map((a) =>
				a.id === assetId ? updatedAsset : a,
			);

			await storageService.saveMediaAsset({
				projectId,
				mediaAsset: updatedAsset,
			});

			this.notify();
		} catch (error) {
			if ((error as Error).name !== "AbortError") {
				console.error("Proxy generation failed:", error);
			}
		} finally {
			this.proxyGenerators.delete(assetId);
			this.notify();
		}
	}

	/**
	 * Auto-generate a background preview proxy for a freshly-ingested video,
	 * once the editor is idle. Synchronous/non-blocking on purpose — callers
	 * (addMediaAsset, AddMediaAssetCommand) fire this and move on immediately;
	 * asset-ready never waits on it.
	 *
	 * Idempotent: guarded by the persisted `asset.proxy` field. Project reopen
	 * goes through loadProjectMedia (which loads any existing proxy file), not
	 * through addMediaAsset, so reopening never re-triggers generation.
	 */
	scheduleAutoProxyGeneration({
		assetId,
		projectId,
	}: {
		assetId: string;
		projectId: string;
	}): void {
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset || asset.proxy || this.isProxyGenerating(assetId)) return;
		if (!this.needsProxy(asset)) return;

		void this.runAutoProxyGeneration({ assetId, projectId });
	}

	private async runAutoProxyGeneration({
		assetId,
		projectId,
	}: {
		assetId: string;
		projectId: string;
	}): Promise<void> {
		// Never start (or contend with) work during playback/scrub/export —
		// mirrors the local-AI scheduler's editor-priority gate. Once started,
		// the ~2s WebCodecs conversion runs to completion rather than being
		// interrupted mid-flight, same tradeoff LocalClip already makes for
		// queued understanding-pass requests.
		await localAIScheduler.waitForIdle();

		// Re-check after the wait: the asset may have been deleted, replaced,
		// or already proxied (e.g. a manual "Generate" click) in the meantime.
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset || asset.proxy || this.isProxyGenerating(assetId)) return;
		if (!this.needsProxy(asset)) return;

		const taskId = `auto-proxy-${assetId}`;
		const tasksStore = useBackgroundTasksStore.getState();
		tasksStore.addTask({
			id: taskId,
			type: "proxy-generation",
			label: `Generating preview proxy — ${asset.name}`,
			progress: "0%",
		});

		try {
			await this.generateProxyForAsset({
				assetId,
				projectId,
				resolution: AUTO_PROXY_RESOLUTION,
				onProgress: (progress) => {
					useBackgroundTasksStore.getState().updateTask(taskId, {
						progress: `${Math.round(progress * 100)}%`,
					});
				},
			});

			// generateProxyForAsset swallows its own errors (the asset stays
			// fully usable at full resolution) — infer success from whether a
			// proxy actually landed rather than from a thrown error.
			const finalAsset = this.assets.find((a) => a.id === assetId);
			if (finalAsset?.proxy) {
				tasksStore.updateTask(taskId, {
					status: "completed",
					completedAt: Date.now(),
					progress: "100%",
				});
			} else {
				tasksStore.updateTask(taskId, {
					status: "error",
					completedAt: Date.now(),
					error: "Proxy generation failed — using original file",
				});
			}
		} catch (error) {
			console.error("Auto proxy generation failed:", error);
			tasksStore.updateTask(taskId, {
				status: "error",
				completedAt: Date.now(),
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	async loadProxyForAsset({
		assetId,
		projectId,
	}: {
		assetId: string;
		projectId: string;
	}): Promise<void> {
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset || !asset.proxy) return;

		try {
			const proxyFile = await storageService.loadProxyFile({
				projectId,
				assetId,
			});
			if (!proxyFile) return;

			const proxyUrl = URL.createObjectURL(proxyFile);

			this.assets = this.assets.map((a) =>
				a.id === assetId ? { ...a, proxyFile, proxyUrl } : a,
			);
			this.notify();
		} catch (error) {
			console.error("Failed to load proxy:", error);
		}
	}

	async deleteProxyForAsset({
		assetId,
		projectId,
	}: {
		assetId: string;
		projectId: string;
	}): Promise<void> {
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset) return;

		const controller = this.proxyGenerators.get(assetId);
		if (controller) {
			controller.abort();
			this.proxyGenerators.delete(assetId);
		}

		if (asset.proxyUrl) {
			URL.revokeObjectURL(asset.proxyUrl);
		}

		this.assets = this.assets.map((a) =>
			a.id === assetId
				? {
						...a,
						proxyFile: undefined,
						proxyUrl: undefined,
						proxy: undefined,
					}
				: a,
		);
		this.notify();

		await storageService.deleteProxyFile({ projectId, assetId });
	}

	cancelProxyGeneration(assetId: string): void {
		const controller = this.proxyGenerators.get(assetId);
		if (controller) {
			controller.abort();
			this.proxyGenerators.delete(assetId);
			this.notify();
		}
		// No-ops if there's no matching auto-proxy task (e.g. this was a
		// manually-triggered generation, which has its own local UI progress
		// state and never adds a background-tasks-store entry).
		useBackgroundTasksStore.getState().removeTask(`auto-proxy-${assetId}`);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => fn());
	}
}
