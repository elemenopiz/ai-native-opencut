import {
	DEFAULT_BLEND_MODE,
	DEFAULT_OPACITY,
	DEFAULT_TRANSFORM,
} from "@/constants/timeline-constants";
import type { TimelineElement, VisualElement } from "@/types/timeline";

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
