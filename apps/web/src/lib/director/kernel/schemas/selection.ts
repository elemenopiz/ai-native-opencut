/**
 * `selection` — what is currently highlighted in the editor UI. Source of
 * truth: `SelectionManager`, which is a SINGLETON (one selection per editor,
 * not a collection of addressable selection objects) — reads/writes of this
 * kind target one fixed id, not many. Fields mirror the manager's own state:
 * `selectedElements: ElementRef[]`, `selectedKeyframes: SelectedKeyframeRef[]`,
 * `keyframeSelectionAnchor: SelectedKeyframeRef | null`.
 *
 * This is one of the two "fully dark" managers the design doc's §1 measured
 * at zero reachable methods — the Director could not point at anything
 * before this registry existed to describe how.
 */

import type { KindSchema } from "../schema";

export const selectionSchema: KindSchema = {
	kind: "selection",
	summary:
		"What is currently highlighted in the editor UI — how the Director points at something for a human to see.",
	fields: {
		elements: {
			type: "array",
			description:
				"The currently-selected elements, as { trackId, elementId } refs. Selecting is how a following human sees what the Director means.",
			aliases: ["selectedElements"],
		},
		keyframes: {
			type: "array",
			description:
				"The currently-selected keyframes, as { trackId, elementId, propertyPath, keyframeId } refs. Setting this clears the element selection (they are mutually exclusive selection modes), mirroring setSelectedElements/setSelectedKeyframes.",
			aliases: ["selectedKeyframes"],
		},
		keyframeAnchor: {
			type: "object",
			description:
				"The anchor keyframe for a range selection (shift-click semantics) — null when no keyframe range is anchored.",
			aliases: ["anchor", "keyframeSelectionAnchor"],
		},
	},
};
