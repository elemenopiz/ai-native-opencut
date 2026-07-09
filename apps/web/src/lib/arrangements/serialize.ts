import type {
	TimelineTrack,
	VideoElement,
	ImageElement,
	TextElement,
	GenerationSpec,
} from "@/types/timeline";
import type {
	Arrangement,
	ArrangementRecipe,
	ArrangementSlot,
	ArrangementText,
	ArrangementCanvas,
} from "@/types/arrangement";
import { ARRANGEMENT_VERSION } from "@/types/arrangement";
import { generateUUID } from "@/utils/id";
import { buildVideoElement, buildImageElement } from "@/lib/timeline/element-utils";
import { buildEmptyTrack } from "@/lib/timeline/track-utils";
import { calculateTotalDuration } from "@/lib/timeline";
import {
	TIMELINE_CONSTANTS,
	DEFAULT_TRANSFORM,
	DEFAULT_OPACITY,
} from "@/constants/timeline-constants";

/**
 * Strip a generation recipe down to its media-free creative intent. Anything
 * that points at concrete media (reference images/videos), a persona the
 * remixer wouldn't own, or a take's specific seed is dropped.
 */
function stripRecipe(spec: GenerationSpec): ArrangementRecipe {
	const {
		referenceImageUrl: _refImg,
		referenceImages: _refImgs,
		referenceVideos: _refVids,
		personaId: _persona,
		seed: _seed,
		seedLocked: _seedLocked,
		...recipe
	} = spec;
	return recipe;
}

/** Reconstruct a full GenerationSpec from a stripped recipe (media fields left empty). */
function recipeToSpec(recipe: ArrangementRecipe): GenerationSpec {
	return { ...recipe };
}

// ── serialize ────────────────────────────────────────────────────────────────

/**
 * Serialize a timeline into a media-free {@link Arrangement}.
 *
 * PURE. Every video/image element becomes a slot (its recipe stripped of media;
 * a plain clip yields a recipe-less "upload here" slot). Text elements become
 * overlays. Audio/sticker/effect tracks are intentionally omitted — an
 * arrangement is a visual layout, not a bundle of the author's assets.
 */
export function serializeArrangement({
	tracks,
	name,
	description,
	canvas,
	fps,
}: {
	tracks: TimelineTrack[];
	name: string;
	description?: string;
	canvas?: ArrangementCanvas;
	fps?: number;
}): Arrangement {
	const slots: ArrangementSlot[] = [];
	const overlays: ArrangementText[] = [];

	let videoLane = 0;
	let textLane = 0;

	for (const track of tracks) {
		if (track.type === "video") {
			const lane = videoLane++;
			for (const element of track.elements) {
				const el = element as VideoElement | ImageElement;
				slots.push({
					id: generateUUID(),
					kind: el.type,
					lane,
					startTime: el.startTime,
					duration: el.duration,
					label: el.name,
					recipe: el.generation ? stripRecipe(el.generation) : undefined,
					transitionOut: el.transitionOut,
					transform: el.transform,
					opacity: el.opacity,
				});
			}
		} else if (track.type === "text") {
			const lane = textLane++;
			for (const element of track.elements) {
				const el = element as TextElement;
				overlays.push({
					id: generateUUID(),
					lane,
					startTime: el.startTime,
					duration: el.duration,
					content: el.content,
					fontSize: el.fontSize,
					fontFamily: el.fontFamily,
					color: el.color,
					textAlign: el.textAlign,
					fontWeight: el.fontWeight,
					fontStyle: el.fontStyle,
					background: el.background,
					transform: el.transform,
					opacity: el.opacity,
				});
			}
		}
	}

	return {
		version: ARRANGEMENT_VERSION,
		name,
		description,
		canvas,
		fps,
		totalDuration: calculateTotalDuration({ tracks }),
		slots,
		overlays,
	};
}

// ── hydrate ────────────────────────────────────────────────────────────────

/**
 * Re-create a set of timeline tracks from an {@link Arrangement}. PURE.
 *
 * Every slot becomes an EMPTY generative clip (mediaId "", no takes) carrying
 * its recipe, so the timeline is storyboarded and each slot awaits an upload or
 * a generation. Text overlays are recreated verbatim. The first video track is
 * flagged `isMain` to satisfy the editor's main-track invariant.
 */
export function hydrateArrangement({
	arrangement,
}: {
	arrangement: Arrangement;
}): TimelineTrack[] {
	const videoLaneCount = arrangement.slots.reduce(
		(max, s) => Math.max(max, s.lane + 1),
		0,
	);
	const textLaneCount = arrangement.overlays.reduce(
		(max, o) => Math.max(max, o.lane + 1),
		0,
	);

	// Always guarantee at least one video track (the main track).
	const videoTracks = Array.from(
		{ length: Math.max(1, videoLaneCount) },
		(_, i) => {
			const track = buildEmptyTrack({
				id: generateUUID(),
				type: "video",
				name: i === 0 ? "Main Track" : `Video ${i + 1}`,
			});
			if (track.type === "video") track.isMain = i === 0;
			return track;
		},
	);

	const textTracks = Array.from({ length: textLaneCount }, (_, i) =>
		buildEmptyTrack({
			id: generateUUID(),
			type: "text",
			name: textLaneCount > 1 ? `Text ${i + 1}` : "Text",
		}),
	);

	for (const slot of arrangement.slots) {
		const track = videoTracks[Math.min(slot.lane, videoTracks.length - 1)];
		if (track.type !== "video") continue;

		const duration =
			slot.duration ||
			slot.recipe?.duration ||
			TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;

		const base =
			slot.kind === "image"
				? buildImageElement({
						mediaId: "",
						name: slot.label || "Generative slot",
						duration,
						startTime: slot.startTime,
					})
				: buildVideoElement({
						mediaId: "",
						name: slot.label || "Generative slot",
						duration,
						startTime: slot.startTime,
					});

		track.elements.push({
			...base,
			id: generateUUID(),
			...(slot.transform ? { transform: slot.transform } : {}),
			...(slot.opacity !== undefined ? { opacity: slot.opacity } : {}),
			...(slot.transitionOut ? { transitionOut: slot.transitionOut } : {}),
			...(slot.recipe ? { generation: recipeToSpec(slot.recipe) } : {}),
			takes: [],
		} as VideoElement | ImageElement);
	}

	for (const overlay of arrangement.overlays) {
		const track = textTracks[Math.min(overlay.lane, textTracks.length - 1)];
		if (!track || track.type !== "text") continue;

		const textElement: TextElement = {
			id: generateUUID(),
			type: "text",
			name: overlay.content.slice(0, 40) || "Text",
			content: overlay.content,
			startTime: overlay.startTime,
			duration: overlay.duration,
			trimStart: 0,
			trimEnd: 0,
			fontSize: overlay.fontSize,
			fontFamily: overlay.fontFamily,
			color: overlay.color,
			textAlign: overlay.textAlign,
			fontWeight: overlay.fontWeight,
			fontStyle: overlay.fontStyle,
			textDecoration: "none",
			background: overlay.background ?? {
				enabled: false,
				color: "#000000",
			},
			transform: overlay.transform ?? { ...DEFAULT_TRANSFORM },
			opacity: overlay.opacity ?? DEFAULT_OPACITY,
		};
		track.elements.push(textElement);
	}

	return [...videoTracks, ...textTracks];
}
