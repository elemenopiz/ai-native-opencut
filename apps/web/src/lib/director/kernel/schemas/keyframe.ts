/**
 * `keyframe` — one animated value at one point in time on one element
 * property. Source of truth: `types/animation.ts`'s `AnimationKeyframe`
 * union ({ id, time, value, interpolation, easing? }) plus
 * `SelectedKeyframeRef` ({ trackId, elementId, propertyPath, keyframeId }),
 * which is how every keyframe command (`UpsertKeyframeCommand`,
 * `RetimeKeyframeCommand`, `SetKeyframeEasingCommand`, `RemoveKeyframeCommand`
 * in `timeline-manager.ts`) actually addresses one.
 *
 * `time` IS LOCAL, NOT TIMELINE TIME — unlike almost everything else in this
 * registry. `BaseAnimationKeyframe.time`'s own doc comment says it plainly:
 * "relative to element start time". A model that just learned startSec/endSec
 * are project-absolute has every reason to assume this is too; it is not,
 * and getting it backwards silently offsets every keyframe by the clip's
 * position on the timeline. The description says so explicitly rather than
 * trusting the unit alone to carry it.
 */

import type { KindSchema } from "../schema";

export const keyframeSchema: KindSchema = {
	kind: "keyframe",
	summary: "One animated value at one point in a clip's own local timeline.",
	fields: {
		id: {
			type: "id",
			of: "keyframe",
			description: "This keyframe's own kernel id.",
			readOnly: true,
			readOnlyReason:
				"identity, not a field — upsert with a new id to create one.",
			aliases: ["keyframeId"],
		},
		elementId: {
			type: "id",
			of: "element",
			description: "The element this keyframe animates.",
			readOnly: true,
			readOnlyReason: "a keyframe does not move between elements.",
			aliases: ["clipId", "slotId"],
		},
		propertyPath: {
			type: "enum",
			values: [
				"transform.position.x",
				"transform.position.y",
				"transform.scale",
				"transform.rotate",
				"opacity",
				"volume",
				"playbackRate",
				"color",
				"background.color",
				"background.paddingX",
				"background.paddingY",
				"background.offsetX",
				"background.offsetY",
				"background.cornerRadius",
			],
			description: "Which property on the element this keyframe drives.",
			readOnly: true,
			readOnlyReason:
				"a keyframe belongs to one channel; move the value to a keyframe on the right channel instead of relabeling this one.",
		},
		time: {
			type: "number",
			unit: "seconds, LOCAL to the element's own start — NOT project-absolute",
			description:
				"When this keyframe fires, measured from the element's own startSec (time 0 = the clip's first frame), not from the start of the project.",
		},
		value: {
			type: "number",
			description:
				"The value at this keyframe. Numeric for most properties; `color` and `background.color` keyframes carry a CSS color string instead — the declared type is the common case, actual type follows `propertyPath`.",
		},
		interpolation: {
			type: "enum",
			values: ["linear", "hold"],
			description:
				'How the segment LEAVING this keyframe is interpolated. "hold" is the only legal value for discrete (color/boolean) channels.',
		},
		easing: {
			type: "object",
			description:
				"Optional easing curve for the outgoing segment — { preset?, bezier: [x1,y1,x2,y2] }. Omitted = linear.",
		},
	},
};
