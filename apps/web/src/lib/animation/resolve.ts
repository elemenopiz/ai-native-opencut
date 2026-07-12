import type {
	AnimationPropertyPath,
	ElementAnimations,
} from "@/types/animation";
import type { Transform } from "@/types/timeline";
import {
	DEFAULT_OPACITY,
	DEFAULT_TRANSFORM,
} from "@/constants/timeline-constants";
import {
	getColorValueAtTime,
	getNumberChannelValueAtTime,
} from "./interpolation";
import { getColorChannelForPath } from "./color-channel";
import { getNumberChannelForPath } from "./number-channel";

export function getElementLocalTime({
	timelineTime,
	elementStartTime,
	elementDuration,
}: {
	timelineTime: number;
	elementStartTime: number;
	elementDuration: number;
}): number {
	const localTime = timelineTime - elementStartTime;
	if (localTime <= 0) {
		return 0;
	}

	if (localTime >= elementDuration) {
		return elementDuration;
	}

	return localTime;
}

/**
 * A persisted element can be missing `transform` (or carry a partial one) —
 * e.g. written through the public insert API before defaults were enforced,
 * or an old/corrupted project. A missing base transform must NEVER crash a
 * render or a project load, so fall back field-by-field to DEFAULT_TRANSFORM.
 */
function getSafeBaseTransform({
	baseTransform,
}: {
	baseTransform: Transform | undefined;
}): Transform {
	return {
		position: {
			x: baseTransform?.position?.x ?? DEFAULT_TRANSFORM.position.x,
			y: baseTransform?.position?.y ?? DEFAULT_TRANSFORM.position.y,
		},
		scale: baseTransform?.scale ?? DEFAULT_TRANSFORM.scale,
		rotate: baseTransform?.rotate ?? DEFAULT_TRANSFORM.rotate,
	};
}

export function resolveTransformAtTime({
	baseTransform,
	animations,
	localTime,
}: {
	baseTransform: Transform | undefined;
	animations: ElementAnimations | undefined;
	localTime: number;
}): Transform {
	const safeLocalTime = Math.max(0, localTime);
	const safeBase = getSafeBaseTransform({ baseTransform });
	return {
		position: {
			x: getNumberChannelValueAtTime({
				channel: getNumberChannelForPath({
					animations,
					propertyPath: "transform.position.x",
				}),
				time: safeLocalTime,
				fallbackValue: safeBase.position.x,
			}),
			y: getNumberChannelValueAtTime({
				channel: getNumberChannelForPath({
					animations,
					propertyPath: "transform.position.y",
				}),
				time: safeLocalTime,
				fallbackValue: safeBase.position.y,
			}),
		},
		scale: getNumberChannelValueAtTime({
			channel: getNumberChannelForPath({
				animations,
				propertyPath: "transform.scale",
			}),
			time: safeLocalTime,
			fallbackValue: safeBase.scale,
		}),
		rotate: getNumberChannelValueAtTime({
			channel: getNumberChannelForPath({
				animations,
				propertyPath: "transform.rotate",
			}),
			time: safeLocalTime,
			fallbackValue: safeBase.rotate,
		}),
	};
}

export function resolveOpacityAtTime({
	baseOpacity,
	animations,
	localTime,
}: {
	baseOpacity: number | undefined;
	animations: ElementAnimations | undefined;
	localTime: number;
}): number {
	return getNumberChannelValueAtTime({
		channel: getNumberChannelForPath({
			animations,
			propertyPath: "opacity",
		}),
		time: Math.max(0, localTime),
		// Same malformed-element hole as `transform`: a persisted element can be
		// missing `opacity`; never let that poison the render with undefined/NaN.
		fallbackValue: baseOpacity ?? DEFAULT_OPACITY,
	});
}

export function resolveNumberAtTime({
	baseValue,
	animations,
	propertyPath,
	localTime,
}: {
	baseValue: number;
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPropertyPath;
	localTime: number;
}): number {
	return getNumberChannelValueAtTime({
		channel: getNumberChannelForPath({ animations, propertyPath }),
		time: Math.max(0, localTime),
		fallbackValue: baseValue,
	});
}

export function resolveColorAtTime({
	baseColor,
	animations,
	propertyPath,
	localTime,
}: {
	baseColor: string;
	animations: ElementAnimations | undefined;
	propertyPath: AnimationPropertyPath;
	localTime: number;
}): string {
	return getColorValueAtTime({
		channel: getColorChannelForPath({ animations, propertyPath }),
		time: Math.max(0, localTime),
		fallbackValue: baseColor,
	});
}

export function resolveVolumeAtTime({
	baseVolume,
	animations,
	localTime,
}: {
	baseVolume: number;
	animations: ElementAnimations | undefined;
	localTime: number;
}): number {
	return getNumberChannelValueAtTime({
		channel: getNumberChannelForPath({
			animations,
			propertyPath: "volume",
		}),
		time: Math.max(0, localTime),
		fallbackValue: baseVolume,
	});
}

export function resolvePlaybackRateAtTime({
	basePlaybackRate,
	animations,
	localTime,
}: {
	basePlaybackRate: number;
	animations: ElementAnimations | undefined;
	localTime: number;
}): number {
	return getNumberChannelValueAtTime({
		channel: getNumberChannelForPath({
			animations,
			propertyPath: "playbackRate",
		}),
		time: Math.max(0, localTime),
		fallbackValue: basePlaybackRate,
	});
}
