import { Command } from "@/lib/commands/base-command";
import { RemoveMediaAssetCommand } from "@/lib/commands/media/remove-media-asset";

/**
 * Batch asset delete as ONE undo-stack entry (KNOWN HOLE #3 / BUG108):
 * removing N media assets used to require calling `MediaManager.removeMediaAsset`
 * once per asset — each call runs through `editor.command.execute()`
 * independently, so an N-asset delete pushed N separate `RemoveMediaAssetCommand`
 * history entries and needed N presses of Ctrl+Z to fully undo.
 *
 * This wraps N `RemoveMediaAssetCommand` children and drives them DIRECTLY
 * (`.execute()`/`.undo()`, never `editor.command.execute()`), the same
 * "child command executed directly, not via the manager method that would
 * double-push" pattern `RemoveMediaAssetCommand` itself uses for its nested
 * `DeleteElementsCommand` — so a caller only needs ONE
 * `editor.command.execute({ command: new RemoveMediaAssetsCommand(...) })`
 * call to get one history entry no matter how many assets are deleted.
 *
 * Children are rebuilt fresh on every `execute()` (including `redo()`, which
 * just re-runs `execute()`), mirroring `RemoveMediaAssetCommand`'s own
 * rebuild-on-every-execute rule, so a child never replays a stale/undone
 * snapshot from a prior run.
 *
 * Deletes run in array order; each child snapshots asset/track/selection
 * state at the moment IT executes (i.e. after all earlier children in the
 * batch have already run), so undo — which reverses the children in REVERSE
 * order — restores state in exactly the order it was removed, the same
 * nested-snapshot chaining `BatchCommand` relies on.
 *
 * NOT currently wired to any call site: `MediaManager` (owned by another
 * territory, read-only here) only exposes a single-asset `removeMediaAsset`
 * method, and the Assets panel only offers a per-asset delete today. This
 * command exists so that whoever adds multi-select delete (UI or a future
 * Director verb) has a ready one-entry primitive instead of looping
 * `editor.media.removeMediaAsset()` and reproducing the N-entries hole. See
 * BUG108 in docs/campaigns/undo-integrity.md for the wiring gap.
 */
export class RemoveMediaAssetsCommand extends Command {
	private children: RemoveMediaAssetCommand[] = [];

	constructor(
		private projectId: string,
		private assetIds: string[],
	) {
		super();
	}

	execute(): void {
		this.children = this.assetIds.map(
			(assetId) => new RemoveMediaAssetCommand(this.projectId, assetId),
		);
		for (const child of this.children) {
			child.execute();
		}
	}

	undo(): void {
		for (const child of [...this.children].reverse()) {
			child.undo();
		}
	}

	getDescription(): string {
		return `Remove ${this.assetIds.length} media assets`;
	}
}
