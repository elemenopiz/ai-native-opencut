import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import type { MediaFolder } from "@/types/assets";
import { generateUUID } from "@/utils/id";

/**
 * Reversible folder creation (campaign C33). Snapshots the prior folder list
 * on `execute()` so `undo()` restores it verbatim — mirrors
 * `AddMediaAssetCommand`'s snapshot-array shape, but against
 * `editor.project.getMediaFolders()`/`setMediaFolders` (the `directorBrief`
 * persistence idiom) instead of `editor.media`.
 */
export class CreateFolderCommand extends Command {
	private folderId: string;
	private savedFolders: MediaFolder[] | null = null;

	constructor(
		private projectId: string,
		private options: { name: string; parentId: string | null },
	) {
		super();
		this.folderId = generateUUID();
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedFolders = [...editor.project.getMediaFolders()];

		const newFolder: MediaFolder = {
			id: this.folderId,
			name: this.options.name,
			parentId: this.options.parentId,
		};

		editor.project.setMediaFolders({
			folders: [...this.savedFolders, newFolder],
		});
	}

	undo(): void {
		if (!this.savedFolders) return;
		const editor = EditorCore.getInstance();
		editor.project.setMediaFolders({ folders: this.savedFolders });
	}

	getFolderId(): string {
		return this.folderId;
	}
}
