export {
	getChannelValueAtTime,
	getNumberChannelValueAtTime,
	normalizeChannel,
} from "./interpolation";

export {
	clampAnimationsToDuration,
	cloneAnimations,
	getChannel,
	removeElementKeyframe,
	retimeElementKeyframe,
	setChannel,
	setElementKeyframeEasing,
	splitAnimationsAtTime,
	upsertElementKeyframe,
} from "./keyframes";

export {
	applyEasing,
	easingFromBezier,
	easingFromPreset,
	evaluateCubicBezier,
	matchEasingPreset,
	resolveEasingControlPoints,
	EASING_PRESETS,
	EASING_PRESET_OPTIONS,
	type EasingPresetOption,
} from "./easing";

export {
	getElementLocalTime,
	resolveColorAtTime,
	resolveNumberAtTime,
	resolveOpacityAtTime,
	resolvePlaybackRateAtTime,
	resolveTransformAtTime,
	resolveVolumeAtTime,
} from "./resolve";

export {
	coerceAnimationValueForProperty,
	getAnimationPropertyDefinition,
	getDefaultInterpolationForProperty,
	getElementBaseValueForProperty,
	isAnimationPropertyPath,
	supportsAnimationProperty,
	withElementBaseValueForProperty,
} from "./property-registry";

export {
	getElementKeyframes,
	getKeyframeAtTime,
	hasKeyframesForPath,
} from "./keyframe-query";
