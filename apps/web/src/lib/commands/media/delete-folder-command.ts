import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import type { MediaFolder } from "@/types/assets";

/**
 * Reversible folder delete (campaign C33). Policy: folders are pure
 * organization, NEVER a delete cascade of assets. `execute()`:
 *  (a) every asset directly in this folder moves to root (`folderId`
 *      cleared),
 *  (b) every CHILD folder (`parentId === this folder`) is reparented to this
 *      folder's OWN `parentId` (so the tree stays connected instead of
 *      orphaning a whole subtree),
 *  (c) the folder itself is removed from the list.
 *
 * Snapshots the prior folder array AND the exact `{assetId -> prior
 * folderId}` map for every asset actually moved, so `undo()` restores both
 * verbatim — same "no-op if nothing was captured" guard shape as
 * `RemoveMediaAssetCommand`'s `missing` flag.
 */
export class DeleteFolderCommand extends Command {
	private savedFolders: MediaFolder[] | null = null;
	/** assetId -> folderId the asset had immediately before this delete (only
	 * assets that were actually moved to root are recorded here). */
	private savedAssetFolderIds: Map<string, string> = new Map();
	/** Folder was already gone when execute() ran — undo() must stay a no-op. */
	private missing = false;

	constructor(
		private projectId: string,
		private folderId: string,
	) {
		super();
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		const folders = editor.project.getMediaFolders();
		const target = folders.find((f) => f.id === this.folderId);

		if (!target) {
			console.error("Folder not found:", this.folderId);
			this.missing = true;
			return;
		}

		this.savedFolders = folders;
		this.savedAssetFolderIds = new Map();

		// (a) move every directly-contained asset to root, capturing its prior
		// folderId for undo.
		const assets = editor.media.getAssets();
		for (const asset of assets) {
			if (asset.folderId !== this.folderId) continue;
			this.savedAssetFolderIds.set(asset.id, asset.folderId);
			void editor.media.moveAssetToFolder({
				projectId: this.projectId,
				assetId: asset.id,
				folderId: null,
			});
		}

		// (b) reparent every child folder to this folder's own parent, and
		// (c) drop the folder itself.
		const nextFolders = folders
			.filter((f) => f.id !== this.folderId)
			.map((f) =>
				f.parentId === this.folderId ? { ...f, parentId: target.parentId } : f,
			);

		editor.project.setMediaFolders({ folders: nextFolders });
	}

	undo(): void {
		if (this.missing || !this.savedFolders) return;
		const editor = EditorCore.getInstance();

		editor.project.setMediaFolders({ folders: this.savedFolders });

		for (const [assetId, priorFolderId] of this.savedAssetFolderIds) {
			void editor.media.moveAssetToFolder({
				projectId: this.projectId,
				assetId,
				folderId: priorFolderId,
			});
		}
	}
}
