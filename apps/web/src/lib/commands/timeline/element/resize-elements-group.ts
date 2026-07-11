import { Command } from "@/lib/commands/base-command";
import type { TimelineTrack } from "@/types/timeline";
import { EditorCore } from "@/core";
import { clampAnimationsToDuration } from "@/lib/animation";
import type { GroupResizeUpdate } from "@/lib/timeline/group-resize";

/** Atomically applies a resolved multi-select "group resize" (see
 *  `lib/timeline/group-resize.ts`) — trimming one selected element's edge
 *  trims every selected element's matching edge together, each clamped by
 *  its own neighbor bound — as a single undoable history entry. Same
 *  snapshot-then-`updateTracks` shape as `UpdateElementTrimCommand`, just
 *  applied to many elements' patches at once. */
export class ResizeElementsCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private readonly updates: GroupResizeUpdate[];

	constructor(updates: GroupResizeUpdate[]) {
		super();
		this.updates = updates;
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();

		const updateByElementId = new Map(
			this.updates.map((update) => [update.elementId, update]),
		);

		const updatedTracks = this.savedState.map((track) => {
			const hasUpdates = track.elements.some((element) =>
				updateByElementId.has(element.id),
			);
			if (!hasUpdates) return track;

			return {
				...track,
				elements: track.elements.map((element) => {
					const update = updateByElementId.get(element.id);
					if (!update) return element;

					return {
						...element,
						trimStart: update.patch.trimStart,
						trimEnd: update.patch.trimEnd,
						startTime: update.patch.startTime,
						duration: update.patch.duration,
						animations: clampAnimationsToDuration({
							animations: element.animations,
							duration: update.patch.duration,
						}),
					};
				}),
			} as typeof track;
		});

		editor.timeline.updateTracks(updatedTracks);
	}

	undo(): void {
		if (!this.savedState) return;
		EditorCore.getInstance().timeline.updateTracks(this.savedState);
	}
}
