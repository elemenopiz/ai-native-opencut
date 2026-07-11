import type {
	AudioElement,
	CreateUploadAudioElement,
	TimelineElement,
	VideoElement,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { mediaSupportsAudio } from "@/lib/media/media-utils";

/**
 * "Detach/extract audio" — pulls a video clip's embedded audio out onto its
 * own standalone audio-track element (toggleable back via
 * `isSourceAudioEnabled`). Ported from OpenCut-app/OpenCut (MIT) at tag
 * `pre-rewrite` (`timeline/audio-separation/index.ts`), adapted to our flat
 * `TimelineTrack[]` model (no `SceneTracks` overlay/main/audio split) and our
 * seconds-float timing (no `MediaTime`/wasm types). Orchestration (finding a
 * placement, mutating tracks, undo) lives in
 * `lib/commands/timeline/element/toggle-source-audio-separation.ts`; this
 * file stays pure/testable, mirroring the pre-rewrite module's scope.
 */

/** Whether a video clip's own embedded audio is currently enabled (default: yes). */
export function isSourceAudioEnabled({
	element,
}: {
	element: VideoElement;
}): boolean {
	return element.isSourceAudioEnabled !== false;
}

/** Whether a video clip's audio has been detached onto its own audio element. */
export function isSourceAudioSeparated({
	element,
}: {
	element: VideoElement;
}): boolean {
	return !isSourceAudioEnabled({ element });
}

/** Can this element's audio be extracted right now? */
export function canExtractSourceAudio(
	element: TimelineElement,
	mediaAsset: MediaAsset | null | undefined,
): element is VideoElement {
	return (
		element.type === "video" &&
		element.duration > 0 &&
		isSourceAudioEnabled({ element }) &&
		mediaSupportsAudio({ media: mediaAsset })
	);
}

/** Can this element's previously-detached audio be recovered (re-linked)? */
export function canRecoverSourceAudio(
	element: TimelineElement,
): element is VideoElement {
	return element.type === "video" && isSourceAudioSeparated({ element });
}

/** Can this element's source-audio state be toggled at all (either direction)? */
export function canToggleSourceAudio(
	element: TimelineElement,
	mediaAsset: MediaAsset | null | undefined,
): element is VideoElement {
	return (
		canRecoverSourceAudio(element) || canExtractSourceAudio(element, mediaAsset)
	);
}

/** Context-menu / button label for the current toggle direction. */
export function getSourceAudioActionLabel({
	element,
}: {
	element: VideoElement;
}): "Extract audio" | "Recover audio" {
	return isSourceAudioSeparated({ element })
		? "Recover audio"
		: "Extract audio";
}

/**
 * Build the standalone audio element a video clip's audio is detached into.
 * Carries over timing/trim/speed so it starts perfectly in sync with the
 * source clip; the caller assigns a fresh `id` and places it on a track.
 *
 * Diverges from the pre-rewrite source in two ways, both required by our
 * simpler element model:
 *  - No `animations.volume` clone: our animation system ties the "volume"
 *    property path to `AudioElement` only (see `lib/animation/property-registry.ts`),
 *    so a `VideoElement` can never carry volume keyframes to begin with.
 *  - No `retime.maintainPitch`: our elements use a flat `playbackRate` number
 *    instead of pre-rewrite's `retime` object; we carry that number over directly.
 */
export function buildSeparatedAudioElement({
	sourceElement,
}: {
	sourceElement: VideoElement;
}): CreateUploadAudioElement {
	return {
		type: "audio",
		sourceType: "upload",
		mediaId: sourceElement.mediaId,
		name: `${sourceElement.name} (audio)`,
		duration: sourceElement.duration,
		startTime: sourceElement.startTime,
		trimStart: sourceElement.trimStart,
		trimEnd: sourceElement.trimEnd,
		sourceDuration: sourceElement.sourceDuration,
		volume: 1,
		muted: sourceElement.muted === true,
		playbackRate: sourceElement.playbackRate,
	};
}

/**
 * Whether an audio-capable element should actually contribute audio to
 * playback/export right now. Audio elements always do; video elements only
 * do while their source audio hasn't been detached (`isSourceAudioEnabled`)
 * AND the underlying media actually has an audio track. Consumed by
 * `lib/media/audio.ts`'s mixdown/preview collectors so a detached clip's
 * original embedded audio stops playing once a standalone copy exists
 * (otherwise both would play back at once).
 */
export function doesElementHaveEnabledAudio({
	element,
	mediaAsset,
}: {
	element: AudioElement | VideoElement;
	mediaAsset?: MediaAsset | null;
}): boolean {
	if (element.type === "audio") {
		return true;
	}

	return (
		mediaSupportsAudio({ media: mediaAsset }) &&
		isSourceAudioEnabled({ element })
	);
}
