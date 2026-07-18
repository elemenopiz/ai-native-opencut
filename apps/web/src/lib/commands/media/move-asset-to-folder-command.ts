import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";

/**
 * Reversible single-asset folder move (campaign C33). Snapshots the asset's
 * PRIOR `folderId` (not the whole asset list — `MediaManager.moveAssetToFolder`
 * already does a targeted single-asset update/persist/notify) so undo restores
 * exactly that field. Mirrors `RemoveMediaAssetCommand`'s `missing` guard for
 * an asset that's gone by the time `execute()` runs.
 */
export class MoveAssetToFolderCommand extends Command {
	private previousFolderId: string | null = null;
	/** Asset was already gone when execute() ran — undo() must stay a no-op. */
	private missing = false;

	constructor(
		private projectId: string,
		private assetId: string,
		private targetFolderId: string | null,
	) {
		super();
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		const asset = editor.media.getAssetById(this.assetId);

		if (!asset) {
			console.error("Media asset not found:", this.assetId);
			this.missing = true;
			return;
		}

		this.previousFolderId = asset.folderId ?? null;

		void editor.media.moveAssetToFolder({
			projectId: this.projectId,
			assetId: this.assetId,
			folderId: this.targetFolderId,
		});
	}

	undo(): void {
		if (this.missing) return;
		const editor = EditorCore.getInstance();
		void editor.media.moveAssetToFolder({
			projectId: this.projectId,
			assetId: this.assetId,
			folderId: this.previousFolderId,
		});
	}
}
