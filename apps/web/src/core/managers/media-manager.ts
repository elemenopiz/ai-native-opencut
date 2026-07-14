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
import { generateProxy } from "@/services/proxy";
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
 * Fixed at "720p" rather than exposed as a knob: the "480p" preset has a
 * known odd-dimension crash in generateProxy()'s scale math (853x480 -> AVC
 * encoder rejects odd widths/heights) that is being fixed separately. 720p
 * rounds to even dimensions for every fixture/aspect-ratio tested so far.
 */
const AUTO_PROXY_RESOLUTION: ProxyResolution = "720p";

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

			this.notify();
		} catch (error) {
			console.error("Failed to load media assets:", error);
		} finally {
			this.isLoading = false;
			this.notify();
		}
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

	needsProxy(asset: MediaAsset): boolean {
		if (asset.type !== "video") return false;
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
			const result = await generateProxy({
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
