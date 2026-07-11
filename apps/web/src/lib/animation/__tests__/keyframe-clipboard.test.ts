import { describe, expect, test } from "bun:test";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type {
	ElementAnimations,
	KeyframeClipboardItem,
	KeyframeEasing,
} from "@/types/animation";
import type {
	TimelineElement,
	UploadAudioElement,
	VideoElement,
} from "@/types/timeline";
import {
	applyKeyframeClipboardToElement,
	collectKeyframeClipboardItems,
} from "../keyframe-clipboard";

const EASE_IN_OUT: KeyframeEasing = {
	preset: "ease-in-out",
	bezier: [0.42, 0, 0.58, 1],
};

function buildAnimations(): ElementAnimations {
	return {
		channels: {
			"transform.scale": {
				valueKind: "number",
				keyframes: [
					{
						id: "kf-a",
						time: 2,
						value: 1,
						interpolation: "linear",
						easing: EASE_IN_OUT,
					},
					{ id: "kf-b", time: 5, value: 2, interpolation: "hold" },
				],
			},
			opacity: {
				valueKind: "number",
				keyframes: [
					{ id: "kf-c", time: 4, value: 0.5, interpolation: "linear" },
				],
			},
		},
	};
}

function buildVideoElement({
	animations,
}: {
	animations?: ElementAnimations;
}): VideoElement {
	return {
		id: "video-1",
		name: "Clip",
		type: "video",
		mediaId: "media-1",
		duration: 10,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		animations,
	};
}

function buildAudioElement(): UploadAudioElement {
	return {
		id: "audio-1",
		name: "Audio",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-2",
		duration: 10,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		volume: 1,
	};
}

function getChannelKeyframes({
	element,
	propertyPath,
}: {
	element: TimelineElement;
	propertyPath: string;
}) {
	return element.animations?.channels[propertyPath]?.keyframes ?? [];
}

describe("collectKeyframeClipboardItems", () => {
	test("normalizes times to an offset from the earliest keyframe", () => {
		const items = collectKeyframeClipboardItems({
			animations: buildAnimations(),
			selectedKeyframes: [
				{ propertyPath: "transform.scale", keyframeId: "kf-a" },
				{ propertyPath: "transform.scale", keyframeId: "kf-b" },
				{ propertyPath: "opacity", keyframeId: "kf-c" },
			],
		});

		// Earliest selected keyframe is kf-a at t=2, so offsets are 0/2/3.
		expect(items.map((item) => item.timeOffset)).toEqual([0, 2, 3]);
		expect(items.map((item) => item.propertyPath)).toEqual([
			"transform.scale",
			"opacity",
			"transform.scale",
		]);
	});

	test("preserves interpolation and easing (bezier) per keyframe", () => {
		const [first, , third] = collectKeyframeClipboardItems({
			animations: buildAnimations(),
			selectedKeyframes: [
				{ propertyPath: "transform.scale", keyframeId: "kf-a" },
				{ propertyPath: "opacity", keyframeId: "kf-c" },
				{ propertyPath: "transform.scale", keyframeId: "kf-b" },
			],
		});

		expect(first.interpolation).toBe("linear");
		expect(first.easing).toEqual(EASE_IN_OUT);
		expect(third.interpolation).toBe("hold");
	});

	test("skips refs that do not resolve to a live keyframe", () => {
		const items = collectKeyframeClipboardItems({
			animations: buildAnimations(),
			selectedKeyframes: [
				{ propertyPath: "transform.scale", keyframeId: "missing" },
			],
		});
		expect(items).toEqual([]);
	});
});

describe("applyKeyframeClipboardToElement", () => {
	const items: KeyframeClipboardItem[] = [
		{
			propertyPath: "transform.scale",
			timeOffset: 0,
			value: 1,
			interpolation: "linear",
			easing: EASE_IN_OUT,
		},
		{
			propertyPath: "transform.scale",
			timeOffset: 3,
			value: 2,
			interpolation: "hold",
		},
	];

	test("rebases the set onto the paste time, preserving spacing", () => {
		const element = applyKeyframeClipboardToElement({
			element: buildVideoElement({}),
			time: 4,
			items,
		});

		const times = getChannelKeyframes({
			element,
			propertyPath: "transform.scale",
		}).map((keyframe) => keyframe.time);
		expect(times).toEqual([4, 7]);
	});

	test("preserves easing/bezier and interpolation through the round-trip", () => {
		const collected = collectKeyframeClipboardItems({
			animations: buildAnimations(),
			selectedKeyframes: [
				{ propertyPath: "transform.scale", keyframeId: "kf-a" },
				{ propertyPath: "transform.scale", keyframeId: "kf-b" },
			],
		});
		const element = applyKeyframeClipboardToElement({
			element: buildVideoElement({}),
			time: 0,
			items: collected,
		});

		const keyframes = getChannelKeyframes({
			element,
			propertyPath: "transform.scale",
		});
		const eased = keyframes.find((keyframe) => keyframe.time === 0);
		const held = keyframes.find((keyframe) => keyframe.time === 3);
		expect(eased?.easing).toEqual(EASE_IN_OUT);
		expect(eased?.interpolation).toBe("linear");
		expect(held?.interpolation).toBe("hold");
	});

	test("assigns fresh keyframe ids so pasted keyframes never collide", () => {
		// Paste back onto the very element the keyframes came from: the source
		// keyframes stay put and the pasted ones must get new ids rather than
		// overwriting kf-a / kf-b.
		const element = applyKeyframeClipboardToElement({
			element: buildVideoElement({ animations: buildAnimations() }),
			time: 0,
			items,
		});
		const keyframes = getChannelKeyframes({
			element,
			propertyPath: "transform.scale",
		});
		const ids = keyframes.map((keyframe) => keyframe.id);
		// All ids unique (no overwrite/collision).
		expect(new Set(ids).size).toBe(ids.length);
		// Source keyframes (t=2, t=5) survive alongside the pasted ones (t=0, t=3).
		expect(
			keyframes.map((keyframe) => keyframe.time).sort((a, b) => a - b),
		).toEqual([0, 2, 3, 5]);
		// The pasted keyframes at t=0 and t=3 do not reuse the source ids.
		const pastedIds = keyframes
			.filter((keyframe) => keyframe.time === 0 || keyframe.time === 3)
			.map((keyframe) => keyframe.id);
		expect(pastedIds).not.toContain("kf-a");
		expect(pastedIds).not.toContain("kf-b");
	});

	test("clamps paste times to the element duration", () => {
		const element = applyKeyframeClipboardToElement({
			element: buildVideoElement({}),
			time: 9,
			items,
		});
		const times = getChannelKeyframes({
			element,
			propertyPath: "transform.scale",
		}).map((keyframe) => keyframe.time);
		// 9+0 => 9, 9+3 => clamped to duration 10.
		expect(times).toEqual([9, 10]);
	});

	test("skips items whose property the target element does not support", () => {
		const audio = buildAudioElement();
		const element = applyKeyframeClipboardToElement({
			element: audio,
			time: 0,
			items,
		});
		// transform.scale is not supported on audio, so nothing is written and the
		// element is returned unchanged.
		expect(element).toBe(audio);
		expect(element.animations).toBeUndefined();
	});
});
