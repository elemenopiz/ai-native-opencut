import {
	DEFAULT_BLEND_MODE,
	DEFAULT_OPACITY,
	DEFAULT_TRANSFORM,
} from "@/constants/timeline-constants";
import {
	DEFAULT_TEXT_BACKGROUND,
	DEFAULT_TEXT_ELEMENT,
} from "@/constants/text-constants";
import type {
	TextElement,
	TimelineElement,
	VisualElement,
} from "@/types/timeline";

/**
 * Dependency-light element normalization, importable from the storage layer.
 * (`element-utils` transitively imports the storage service via `lib/effects`,
 * so the load path can't import it without a cycle — the helpers live here and
 * are re-exported from `element-utils` for everyone else.)
 */

export function isVisualElement(
	element: TimelineElement,
): element is VisualElement {
	return (
		element.type === "video" ||
		element.type === "image" ||
		element.type === "text" ||
		element.type === "sticker" ||
		element.type === "shape"
	);
}

const KNOWN_ELEMENT_TYPES: ReadonlySet<TimelineElement["type"]> = new Set([
	"video",
	"image",
	"text",
	"audio",
	"sticker",
	"shape",
	"effect",
]);

/**
 * Structural gate for a persisted element, ahead of `ensureVisualElementDefaults`.
 * BUG129 — sibling corruption class to the transform-brick heal (B1): a `null`
 * element, a non-object, an element missing a string `id`, or an element with
 * a non-string/unrecognized `type` isn't a clip with missing fields, it's not
 * a usable element at all. The compositor and timeline store key elements by
 * `id` (Maps/selection sets), and every renderer, props panel, and command
 * switches on `type` — either read crashes immediately (`.type` of `null`) or
 * an unrecognized `type` silently falls through every switch, which is worse
 * than a crash (invisible, unselectable, immovable timeline debris). Elements
 * that fail this check are dropped by the caller rather than healed — there's
 * no default `id`/`type` that would be safe to fabricate.
 */
export function isPlausibleTimelineElement(
	element: unknown,
): element is TimelineElement {
	if (element === null || typeof element !== "object") return false;
	const candidate = element as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.type === "string" &&
		KNOWN_ELEMENT_TYPES.has(candidate.type as TimelineElement["type"])
	);
}

/**
 * True when `element` is a video/image/upload-audio element whose `mediaId`
 * can't resolve anything — a required source reference that's missing or not
 * a non-empty string. These types render by looking up `mediaId` in the
 * project's media list; with nothing there, the element can never produce a
 * frame. Unlike the transform-brick heal there's no safe default to
 * substitute (no "blank media" to point at), so the caller drops the element
 * outright rather than passing a permanently-black, still-occupying-timeline-
 * space element downstream. NOTE: this only catches the mediaId field being
 * structurally absent/empty. A `mediaId` that IS a string but doesn't match
 * any asset in the *loaded* project (e.g. a pasted element from another
 * project) can't be detected here — this is a pure `SerializedProject →
 * TProject` mapping with no access to the media list (media loads async,
 * after this, in `StorageService.loadProject` → `media.loadProjectMedia`).
 * See BUG130 for that follow-up.
 */
export function requiresMediaIdButMissing(element: TimelineElement): boolean {
	const hasMediaId =
		typeof (element as { mediaId?: unknown }).mediaId === "string" &&
		((element as { mediaId: string }).mediaId?.length ?? 0) > 0;

	if (element.type === "video" || element.type === "image") {
		return !hasMediaId;
	}

	if (element.type === "audio") {
		// LibraryAudioElement plays from `sourceUrl`, not project media, so it
		// has no `mediaId` requirement — only the upload variant does. A
		// persisted element with a missing/corrupt `sourceType` is treated as
		// "upload" (the stricter, more common case) rather than silently
		// passed through as if it were a library clip.
		const sourceType = (element as { sourceType?: unknown }).sourceType;
		if (sourceType === "library") return false;
		return !hasMediaId;
	}

	return false;
}

/**
 * Heal a text element missing its required text fields. `background` is the
 * critical one: the preview-overlay bounds math, the properties panel, the
 * animation registry, and the compositor's TextNode all read `background.*`
 * during React render or the frame loop, so a text element persisted without
 * it crashes the editor to its error boundary on every render (the audit's
 * B1 `paddingX`-of-undefined crash). The public insert API and the Director/
 * MCP verbs accept partial text elements, so heal here — the one seam both
 * the insert command and the storage load path share. Complete elements are
 * returned unchanged (same reference).
 */
function ensureTextElementDefaults({
	element,
}: {
	element: TextElement;
}): TextElement {
	const isComplete =
		element.background !== undefined &&
		element.content !== undefined &&
		element.fontFamily !== undefined &&
		element.fontSize !== undefined &&
		element.color !== undefined &&
		element.textAlign !== undefined &&
		element.fontWeight !== undefined &&
		element.fontStyle !== undefined &&
		element.textDecoration !== undefined;

	if (isComplete) return element;

	return {
		...element,
		background: element.background
			? { ...DEFAULT_TEXT_BACKGROUND, ...element.background }
			: DEFAULT_TEXT_BACKGROUND,
		content: element.content ?? "",
		fontFamily: element.fontFamily ?? DEFAULT_TEXT_ELEMENT.fontFamily,
		fontSize: element.fontSize ?? DEFAULT_TEXT_ELEMENT.fontSize,
		color: element.color ?? DEFAULT_TEXT_ELEMENT.color,
		textAlign: element.textAlign ?? DEFAULT_TEXT_ELEMENT.textAlign,
		fontWeight: element.fontWeight ?? DEFAULT_TEXT_ELEMENT.fontWeight,
		fontStyle: element.fontStyle ?? DEFAULT_TEXT_ELEMENT.fontStyle,
		textDecoration:
			element.textDecoration ?? DEFAULT_TEXT_ELEMENT.textDecoration,
	};
}

/**
 * Heal a visual element that is missing `transform`/`opacity`/`blendMode`
 * (or carries a partial transform). The types require these fields, but an
 * element written through the public insert API (or persisted by an old or
 * buggy writer) can lack them at runtime — and a malformed element used to
 * brick its project on every load. Non-visual elements and already-complete
 * elements are returned unchanged (same reference).
 */
export function ensureVisualElementDefaults({
	element,
}: {
	element: TimelineElement;
}): TimelineElement {
	if (!isVisualElement(element)) return element;

	if (element.type === "text") {
		element = ensureTextElementDefaults({ element });
	}

	const { transform, opacity, blendMode } = element as VisualElement & {
		transform?: Partial<VisualElement["transform"]>;
		opacity?: number;
	};

	const hasCompleteTransform =
		transform !== undefined &&
		transform.position !== undefined &&
		typeof transform.position.x === "number" &&
		typeof transform.position.y === "number" &&
		typeof transform.scale === "number" &&
		typeof transform.rotate === "number";

	if (
		hasCompleteTransform &&
		opacity !== undefined &&
		blendMode !== undefined
	) {
		return element;
	}

	return {
		...element,
		transform: hasCompleteTransform
			? element.transform
			: {
					position: {
						x: transform?.position?.x ?? DEFAULT_TRANSFORM.position.x,
						y: transform?.position?.y ?? DEFAULT_TRANSFORM.position.y,
					},
					scale: transform?.scale ?? DEFAULT_TRANSFORM.scale,
					rotate: transform?.rotate ?? DEFAULT_TRANSFORM.rotate,
				},
		opacity: opacity ?? DEFAULT_OPACITY,
		blendMode: blendMode ?? DEFAULT_BLEND_MODE,
	};
}
