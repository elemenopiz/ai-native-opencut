import { Command } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import type {
	AudioElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";
import { generateUUID } from "@/utils/id";
import { updateElementInTracks } from "@/lib/timeline/track-element-update";
import {
	buildEmptyTrack,
	getHighestInsertIndexForTrack,
} from "@/lib/timeline/track-utils";
import { wouldElementOverlap } from "@/lib/timeline/element-utils";
import {
	buildSeparatedAudioElement,
	canExtractSourceAudio,
	isSourceAudioSeparated,
} from "@/lib/timeline/audio-separation";

/**
 * Toggle a video clip's source audio between "linked" (plays as part of the
 * video, the default) and "detached" (extracted onto its own standalone
 * audio-track element that can be trimmed/moved/muted independently).
 *
 * Ported from OpenCut-app/OpenCut (MIT) at tag `pre-rewrite`
 * (`commands/timeline/element/toggle-source-audio-separation.ts`), adapted to
 * our flat `TimelineTrack[]` model: placement uses our
 * `lib/timeline/track-utils.ts` + `wouldElementOverlap` helpers (first
 * available audio track with no time overlap, else a new one) instead of
 * pre-rewrite's separate `timeline/placement/*` module, and undo/redo
 * snapshots the whole track list the same way sibling commands in this
 * directory do (e.g. `ToggleElementsMutedCommand`) instead of pre-rewrite's
 * `SceneTracks` object.
 *
 * "Recover audio" (re-linking) only flips `isSourceAudioEnabled` back to
 * `true` — it deliberately does NOT delete the previously-extracted audio
 * element. That copy is, by then, an independent clip the user may have
 * already trimmed/moved/kept; silently deleting it on recover would destroy
 * those edits. This matches the pre-rewrite source's shipped behavior.
 */
export class ToggleSourceAudioSeparationCommand extends Command {
	private savedState: TimelineTrack[] | null = null;

	constructor(
		private readonly params: {
			trackId: string;
			elementId: string;
		},
	) {
		super();
	}

	execute(): void {
		const editor = EditorCore.getInstance();
		this.savedState = editor.timeline.getTracks();

		const sourceTrack = this.savedState.find(
			(track) => track.id === this.params.trackId,
		);
		const sourceElement = sourceTrack?.elements.find(
			(element) => element.id === this.params.elementId,
		);
		if (!sourceElement || sourceElement.type !== "video") {
			return;
		}
		const videoElement: VideoElement = sourceElement;

		if (isSourceAudioSeparated({ element: videoElement })) {
			editor.timeline.updateTracks(
				this.setSourceAudioEnabled({
					tracks: this.savedState,
					isSourceAudioEnabled: true,
				}),
			);
			return;
		}

		const mediaAsset = editor.media
			.getAssets()
			.find((asset) => asset.id === videoElement.mediaId);
		if (!canExtractSourceAudio(videoElement, mediaAsset)) {
			return;
		}

		const separatedAudioElement = {
			...buildSeparatedAudioElement({ sourceElement: videoElement }),
			id: generateUUID(),
		};
		const separatedElementEnd =
			separatedAudioElement.startTime + separatedAudioElement.duration;

		const targetTrack = this.savedState.find(
			(track) =>
				track.type === "audio" &&
				!wouldElementOverlap({
					elements: track.elements,
					startTime: separatedAudioElement.startTime,
					endTime: separatedElementEnd,
				}),
		);

		const tracksWithAudioElement: TimelineTrack[] = targetTrack
			? this.savedState.map((track) =>
					track.id === targetTrack.id
						? ({
								...track,
								elements: [...track.elements, separatedAudioElement],
							} as TimelineTrack)
						: track,
				)
			: this.insertNewAudioTrack({
					tracks: this.savedState,
					elements: [separatedAudioElement],
				});

		editor.timeline.updateTracks(
			this.setSourceAudioEnabled({
				tracks: tracksWithAudioElement,
				isSourceAudioEnabled: false,
			}),
		);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	private setSourceAudioEnabled({
		tracks,
		isSourceAudioEnabled,
	}: {
		tracks: TimelineTrack[];
		isSourceAudioEnabled: boolean;
	}): TimelineTrack[] {
		return updateElementInTracks({
			tracks,
			trackId: this.params.trackId,
			elementId: this.params.elementId,
			elementPredicate: (element): element is VideoElement =>
				element.type === "video",
			update: (element) =>
				({ ...element, isSourceAudioEnabled }) as VideoElement,
		});
	}

	private insertNewAudioTrack({
		tracks,
		elements,
	}: {
		tracks: TimelineTrack[];
		elements: AudioElement[];
	}): TimelineTrack[] {
		const newTrack = {
			...buildEmptyTrack({ id: generateUUID(), type: "audio" }),
			elements,
		} as TimelineTrack;

		const insertIndex = getHighestInsertIndexForTrack({
			tracks,
			trackType: "audio",
		});
		const updatedTracks = [...tracks];
		updatedTracks.splice(insertIndex, 0, newTrack);
		return updatedTracks;
	}
}
