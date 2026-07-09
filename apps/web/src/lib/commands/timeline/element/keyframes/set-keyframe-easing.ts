import { EditorCore } from "@/core";
import {
	setElementKeyframeEasing,
	supportsAnimationProperty,
} from "@/lib/animation";
import { Command } from "@/lib/commands/base-command";
import { updateElementInTracks } from "@/lib/timeline";
import type {
	AnimationPropertyPath,
	KeyframeEasing,
} from "@/types/animation";
import type { TimelineTrack } from "@/types/timeline";

export class SetKeyframeEasingCommand extends Command {
	private savedState: TimelineTrack[] | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly propertyPath: AnimationPropertyPath;
	private readonly keyframeId: string;
	private readonly easing: KeyframeEasing | undefined;

	constructor({
		trackId,
		elementId,
		propertyPath,
		keyframeId,
		easing,
	}: {
		trackId: string;
		elementId: string;
		propertyPath: AnimationPropertyPath;
		keyframeId: string;
		easing: KeyframeEasing | undefined;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.propertyPath = propertyPath;
		this.keyframeId = keyframeId;
		this.easing = easing;
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();

		const updatedTracks = updateElementInTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			elementPredicate: (element) =>
				supportsAnimationProperty({
					element,
					propertyPath: this.propertyPath,
				}),
			update: (element) => ({
				...element,
				animations: setElementKeyframeEasing({
					animations: element.animations,
					propertyPath: this.propertyPath,
					keyframeId: this.keyframeId,
					easing: this.easing,
				}),
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
