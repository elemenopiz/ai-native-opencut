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
		element.type === "sticker"
	);
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
