import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import type { MediaFolder } from "@/types/assets";

/**
 * Reversible folder rename (campaign C33). Snapshots the prior folder list
 * (not just the prior name) so undo restores the exact array identity/order,
 * same shape as `CreateFolderCommand`/`DeleteFolderCommand`.
 */
export class RenameFolderCommand extends Command {
	private savedFolders: MediaFolder[] | null = null;
	/** Folder was already gone when execute() ran — undo() must stay a no-op. */
	private missing = false;

	constructor(
		private projectId: string,
		private folderId: string,
		private name: string,
	) {
		super();
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		const folders = editor.project.getMediaFolders();
		const exists = folders.some((f) => f.id === this.folderId);

		if (!exists) {
			console.error("Folder not found:", this.folderId);
			this.missing = true;
			return;
		}

		this.savedFolders = folders;

		editor.project.setMediaFolders({
			folders: folders.map((f) =>
				f.id === this.folderId ? { ...f, name: this.name } : f,
			),
		});
	}

	undo(): void {
		if (this.missing || !this.savedFolders) return;
		const editor = EditorCore.getInstance();
		editor.project.setMediaFolders({ folders: this.savedFolders });
	}
}
