import { EditorCore } from "@/core";
import { applyKeyframeClipboardToElement } from "@/lib/animation";
import { Command } from "@/lib/commands/base-command";
import { updateElementInTracks } from "@/lib/timeline";
import type { KeyframeClipboardItem } from "@/types/animation";
import type { TimelineTrack } from "@/types/timeline";

/**
 * Paste a set of copied keyframes (curve + easing preserved) onto a target
 * element, rebasing them onto `time`. Undoable via the standard saved-state
 * snapshot, matching the sibling keyframe commands.
 */
export class PasteKeyframesCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly time: number;
	private readonly clipboardItems: KeyframeClipboardItem[];

	constructor({
		trackId,
		elementId,
		time,
		clipboardItems,
	}: {
		trackId: string;
		elementId: string;
		time: number;
		clipboardItems: KeyframeClipboardItem[];
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.time = time;
		this.clipboardItems = clipboardItems;
	}

	execute(): void {
		if (this.clipboardItems.length === 0) {
			return;
		}

		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();

		const updatedTracks = updateElementInTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			update: (element) =>
				applyKeyframeClipboardToElement({
					element,
					time: this.time,
					items: this.clipboardItems,
				}),
		});

		editor.timeline.updateTracks(updatedTracks);
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}

		const editor = EditorCore.getInstance();
		editor.timeline.updateTracks(this.savedState);
	}
}
