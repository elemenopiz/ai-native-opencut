import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import type { TScene } from "@/types/timeline";
import { buildDefaultScene } from "@/lib/scenes";
import { generateUUID } from "@/utils/id";

export class CreateSceneCommand extends Command {
	/** Generated ONCE and reused across every execute() (including redo(),
	 * which just re-runs execute()) — BUG107: `buildDefaultScene` mints its
	 * own fresh UUID internally, so without pinning the id here, an
	 * execute→undo→redo cycle would create a scene with a DIFFERENT id than
	 * the one `getSceneId()` returned after the original execute(), silently
	 * breaking any caller that captured that id (e.g. to switch into the new
	 * scene right after creating it). Same fix shape as
	 * `AddMediaAssetCommand.assetId`, which is generated once in the
	 * constructor for the identical reason. */
	private readonly sceneId: string;
	private savedScenes: TScene[] | null = null;
	private createdScene: TScene | null = null;

	constructor(
		private name: string,
		private isMain: boolean = false,
	) {
		super();
		this.sceneId = generateUUID();
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedScenes = [...editor.scenes.getScenes()];

		this.createdScene = {
			...buildDefaultScene({
				name: this.name,
				isMain: this.isMain,
			}),
			id: this.sceneId,
		};

		const updatedScenes = [...this.savedScenes, this.createdScene];
		editor.scenes.setScenes({ scenes: updatedScenes });
	}

	undo(): void {
		if (this.savedScenes) {
			const editor = EditorCore.getInstance();
			editor.scenes.setScenes({ scenes: this.savedScenes });
		}
	}

	getSceneId(): string {
		return this.sceneId;
	}
}
