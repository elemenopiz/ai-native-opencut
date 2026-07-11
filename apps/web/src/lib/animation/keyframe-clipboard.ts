import type {
	ElementAnimations,
	KeyframeClipboardItem,
	SelectedKeyframeRef,
} from "@/types/animation";
import type { TimelineElement } from "@/types/timeline";
import { generateUUID } from "@/utils/id";
import { getElementKeyframes } from "./keyframe-query";
import { upsertElementKeyframe } from "./keyframes";
import { supportsAnimationProperty } from "./property-registry";

/**
 * Build a portable clipboard payload from a set of selected keyframes on a
 * single element. Each item carries its property path, value, interpolation and
 * easing (bezier control points) so the curve round-trips exactly. Times are
 * normalized to an offset from the earliest keyframe in the selection, letting
 * a later paste rebase the whole set onto the playhead while preserving spacing.
 *
 * The caller is responsible for ensuring every ref points at the same element;
 * refs that don't resolve to a live keyframe are skipped.
 */
export function collectKeyframeClipboardItems({
	animations,
	selectedKeyframes,
}: {
	animations: ElementAnimations | undefined;
	selectedKeyframes: Pick<SelectedKeyframeRef, "propertyPath" | "keyframeId">[];
}): KeyframeClipboardItem[] {
	if (selectedKeyframes.length === 0) {
		return [];
	}

	const elementKeyframes = getElementKeyframes({ animations });
	const rawItems = selectedKeyframes.flatMap((ref) => {
		const keyframe = elementKeyframes.find(
			(candidate) =>
				candidate.id === ref.keyframeId &&
				candidate.propertyPath === ref.propertyPath,
		);
		if (!keyframe) {
			return [];
		}

		return [
			{
				propertyPath: keyframe.propertyPath,
				time: keyframe.time,
				value: keyframe.value,
				interpolation: keyframe.interpolation,
				easing: keyframe.easing,
			},
		];
	});

	if (rawItems.length === 0) {
		return [];
	}

	const minTime = Math.min(...rawItems.map((item) => item.time));

	return rawItems
		.map(({ time, ...item }) => ({
			...item,
			timeOffset: time - minTime,
		}))
		.sort(
			(left, right) =>
				left.timeOffset - right.timeOffset ||
				left.propertyPath.localeCompare(right.propertyPath),
		);
}

/**
 * Paste a clipboard payload onto an element, returning the element with updated
 * animations. Every item is rebased to `time + item.timeOffset`, clamped to the
 * element's duration. Items whose property the target element doesn't support
 * (e.g. `transform.*` onto an audio element) are skipped, so pasting across
 * different element types is safe. Interpolation and easing are preserved; each
 * pasted keyframe gets a fresh id so it never collides with the source.
 */
export function applyKeyframeClipboardToElement({
	element,
	time,
	items,
}: {
	element: TimelineElement;
	time: number;
	items: KeyframeClipboardItem[];
}): TimelineElement {
	let nextAnimations = element.animations;

	for (const item of items) {
		if (
			!supportsAnimationProperty({
				element,
				propertyPath: item.propertyPath,
			})
		) {
			continue;
		}

		const keyframeTime = Math.max(
			0,
			Math.min(time + item.timeOffset, element.duration),
		);

		nextAnimations = upsertElementKeyframe({
			animations: nextAnimations,
			propertyPath: item.propertyPath,
			time: keyframeTime,
			value: item.value,
			interpolation: item.interpolation,
			easing: item.easing,
			keyframeId: generateUUID(),
		});
	}

	if (nextAnimations === element.animations) {
		return element;
	}

	return { ...element, animations: nextAnimations };
}
