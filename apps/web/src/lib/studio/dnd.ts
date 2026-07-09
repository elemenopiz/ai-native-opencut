/** Drag-and-drop constants and types shared across studio surfaces. */

/** Payload set on dataTransfer when dragging a generated image still. */
export interface StudioImageDrag {
	kind: "image";
	imageStillId: string;
	imageUrl: string;
}

/** MIME-ish key for dragging a GPT Image still onto a curation target. */
export const STUDIO_IMAGE_DND_TYPE = "application/x-studio-image";

/** MIME-ish key for dragging a pinned board tile toward the editor. */
export const STUDIO_BOARD_DND_TYPE = "application/x-studio-board-item";
