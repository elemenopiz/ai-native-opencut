import type { VisualElement } from "./timeline";

interface BaseDragData {
	id: string;
	name: string;
}

export interface MediaDragData extends BaseDragData {
	type: "media";
	mediaType: "image" | "video" | "audio";
	targetElementTypes?: ("video" | "image")[];
}

export interface TextDragData extends BaseDragData {
	type: "text";
	content: string;
}

export interface StickerDragData extends BaseDragData {
	type: "sticker";
	stickerId: string;
}

export interface EffectDragData extends BaseDragData {
	type: "effect";
	effectType: string;
	targetElementTypes: VisualElement["type"][];
}

/**
 * A generated take being dragged out of the Takes bin. Unlike MediaDragData it
 * doesn't reference an existing library asset — it carries the remote URL so the
 * drop target can import it into the project media on demand (e.g. dropping on
 * the Assets tab to save it).
 */
export interface StudioTakeDragData extends BaseDragData {
	type: "studio-take";
	url: string;
	kind: "video" | "image";
	takeId: string;
}

export type TimelineDragData =
	| MediaDragData
	| TextDragData
	| StickerDragData
	| EffectDragData
	| StudioTakeDragData;
