import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import { DeleteElementsCommand } from "@/lib/commands/timeline";
import type { MediaAsset } from "@/types/assets";
import type { AssetTranscript } from "@/lib/search/asset-transcript";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import { hasMediaId } from "@/lib/timeline/element-utils";
import { deleteEmbedding } from "@/services/search/embedding-store";
import {
	deleteTranscript,
	getTranscript,
	saveTranscript,
} from "@/services/search/asset-transcript-store";
import { deleteUnderstanding } from "@/services/search/asset-understanding-store";

/**
 * Reversible asset delete (BUG34): owns the FULL delete cascade — asset
 * removal, dependent timeline elements, and selection cleanup — as ONE
 * undo-stack entry.
 *
 * Previously `MediaManager.removeMediaAsset` ran this cascade directly and
 * only its trailing `editor.timeline.deleteElements(...)` call was a command.
 * Ctrl+Z restored clip shells pointing at a mediaId whose asset (and object
 * URLs) had already been permanently deleted — an unplayable ghost clip.
 * Folding the whole cascade into one command fixes that: undo restores the
 * asset FIRST, then restores the elements via a child `DeleteElementsCommand`,
 * so the restored clips always point at a live, playable asset.
 *
 * The child `DeleteElementsCommand` is executed/undone DIRECTLY — never via
 * `editor.timeline.deleteElements()`, which pushes its OWN history entry and
 * would turn one asset delete into two undo steps. A fresh child instance is
 * built on every `execute()` (including redo(), which just re-runs execute())
 * so it always snapshots the CURRENT track state rather than replaying a
 * stale/already-undone snapshot from a prior run.
 */
export class RemoveMediaAssetCommand extends Command {
	/** Full pre-delete asset list, restored verbatim on undo (order-preserving). */
	private savedAssets: MediaAsset[] | null = null;
	private removedAsset: MediaAsset | null = null;
	private savedTranscript: AssetTranscript | null = null;
	private deleteElementsCommand: DeleteElementsCommand | null = null;
	/** Asset was already gone when execute() ran — undo() must stay a no-op. */
	private missing = false;

	constructor(
		private projectId: string,
		private assetId: string,
	) {
		super();
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		const assets = editor.media.getAssets();
		const asset = assets.find((media) => media.id === this.assetId);

		if (!asset) {
			console.error("Media asset not found:", this.assetId);
			this.missing = true;
			return;
		}

		this.savedAssets = assets;
		this.removedAsset = asset;

		videoCache.clearVideo({ mediaId: this.assetId });

		// Aborts any in-flight proxy generation AND drops the auto-proxy
		// background-tasks entry — the existing seam MediaManager already
		// exposes for exactly this, instead of reaching into its private
		// proxyGenerators map from here.
		editor.media.cancelProxyGeneration(this.assetId);

		// Embeddings and Understanding-pass rows are cheap to regenerate, so
		// losing them on undo is an accepted tradeoff — delete fire-and-forget.
		deleteEmbedding(this.assetId).catch(() => undefined);
		deleteUnderstanding(this.assetId).catch(() => undefined);

		// Transcripts are NOT cheap to regenerate (re-transcription), so
		// capture the record before deleting it and restore it on undo.
		// Chained (not parallel) so the delete can never race ahead of the
		// read on the same IndexedDB store.
		getTranscript(this.assetId)
			.then((record) => {
				this.savedTranscript = record ?? null;
				return deleteTranscript(this.assetId);
			})
			.catch(() => undefined);

		// Deliberately do NOT revoke the asset's object URLs here (the old
		// manager code did) — undo must leave the asset's video/thumbnail/proxy
		// URLs playable. The tradeoff: a same-session delete no longer frees
		// the Blob URL immediately; it's reclaimed on page unload instead.

		editor.media.setAssets({
			assets: this.savedAssets.filter((media) => media.id !== this.assetId),
		});

		const tracks = editor.timeline.getTracks();
		const elementsToRemove: Array<{ trackId: string; elementId: string }> = [];

		for (const track of tracks) {
			for (const element of track.elements) {
				if (hasMediaId(element) && element.mediaId === this.assetId) {
					elementsToRemove.push({ trackId: track.id, elementId: element.id });
				}
			}
		}

		if (elementsToRemove.length > 0) {
			const deleteElementsCommand = new DeleteElementsCommand({
				elements: elementsToRemove,
			});
			deleteElementsCommand.execute();
			this.deleteElementsCommand = deleteElementsCommand;

			// Drop the now-deleted elements from the selection so it doesn't
			// keep stale refs to elements that no longer exist.
			const removed = new Set(
				elementsToRemove.map((e) => `${e.trackId}:${e.elementId}`),
			);
			const selection = editor.selection.getSelectedElements();
			if (selection.some((s) => removed.has(`${s.trackId}:${s.elementId}`))) {
				editor.selection.setSelectedElements({
					elements: selection.filter(
						(s) => !removed.has(`${s.trackId}:${s.elementId}`),
					),
				});
			}
		} else {
			this.deleteElementsCommand = null;
		}

		storageService
			.deleteMediaAsset({ projectId: this.projectId, id: this.assetId })
			.catch((error) => {
				console.error("Failed to delete media item:", error);
			});
	}

	undo(): void {
		if (this.missing || !this.savedAssets) return;
		const editor = EditorCore.getInstance();

		// Restore the asset FIRST so the elements restored just below (which
		// still carry the original mediaId) point at a live asset instead of a
		// dangling reference.
		editor.media.setAssets({ assets: this.savedAssets });

		this.deleteElementsCommand?.undo();

		if (this.removedAsset) {
			storageService
				.saveMediaAsset({
					projectId: this.projectId,
					mediaAsset: this.removedAsset,
				})
				.catch((error) => {
					console.error("Failed to restore media item on undo:", error);
				});
		}

		if (this.savedTranscript) {
			saveTranscript(this.savedTranscript).catch(() => undefined);
		}

		// Internally guarded (no-op if a proxy already exists or one is already
		// generating) — cheap to call unconditionally.
		editor.media.scheduleAutoProxyGeneration({
			assetId: this.assetId,
			projectId: this.projectId,
		});
	}
}
