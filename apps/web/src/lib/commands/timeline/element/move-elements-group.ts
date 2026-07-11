import { Command } from "@/lib/commands/base-command";
import type { TimelineTrack } from "@/types/timeline";
import { EditorCore } from "@/core";
import {
	applyGroupMoveResult,
	type GroupMoveResult,
} from "@/lib/timeline/group-move";

/** Atomically applies a resolved multi-select "group move" (see
 *  `lib/timeline/group-move.ts`) — every selected element moves together,
 *  possibly across tracks and possibly onto newly created tracks — as a
 *  single undoable history entry. Mirrors the snapshot-then-`updateTracks`
 *  pattern used by `TracksSnapshotCommand` / `DeleteElementsCommand` /
 *  `SplitElementsCommand`, rather than composing several single-element
 *  `MoveElementCommand`s in a `BatchCommand`: the plan's new-track insertion
 *  indices are computed once against a single tracks snapshot, so replaying
 *  them as independent sequential commands would need to account for
 *  indices shifting as earlier commands in the batch insert tracks — a
 *  single atomic "compute once, apply once" command sidesteps that
 *  entirely while still being a single `Command` for undo/redo. */
export class MoveElementsCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private previousSelection: { trackId: string; elementId: string }[] = [];
	private readonly result: GroupMoveResult;

	constructor(result: GroupMoveResult) {
		super();
		this.result = result;
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();
		this.previousSelection = editor.selection.getSelectedElements();

		const updatedTracks = applyGroupMoveResult({
			tracks: this.savedState,
			result: this.result,
		});

		editor.timeline.updateTracks(updatedTracks);
		editor.selection.setSelectedElements({
			elements: this.result.targetSelection,
		});
	}

	undo(): void {
		if (!this.savedState) return;
		const editor = EditorCore.getInstance();
		editor.timeline.updateTracks(this.savedState);
		editor.selection.setSelectedElements({ elements: this.previousSelection });
	}
}
