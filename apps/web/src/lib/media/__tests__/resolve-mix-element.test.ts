import { describe, expect, test } from "bun:test";
import {
	type CollectedAudioElement,
	resolveMixElement,
} from "@/lib/media/audio";
import type { stretchAudioBufferSegment } from "@/lib/media/pitch-preserving-stretch";

/** Shape-only AudioBuffer (bun has no Web Audio API). */
function fakeBuffer(tag: string): AudioBuffer {
	return { __tag: tag } as unknown as AudioBuffer;
}

function makeElement(
	overrides: Partial<CollectedAudioElement> = {},
): CollectedAudioElement {
	return {
		buffer: fakeBuffer("original"),
		startTime: 3,
		duration: 2,
		trimStart: 0.5,
		trimEnd: 0,
		muted: false,
		playbackRate: 1,
		hasVariableRate: false,
		...overrides,
	} as CollectedAudioElement;
}

type StretchFn = typeof stretchAudioBufferSegment;

describe("resolveMixElement — export-side pitch-preserving seam", () => {
	test("rate 1.0 bypasses: same element back, stretch never invoked", async () => {
		let called = 0;
		const stretch: StretchFn = async () => {
			called++;
			return fakeBuffer("stretched");
		};

		const element = makeElement({ playbackRate: 1 });
		const result = await resolveMixElement({
			element,
			sampleRate: 44100,
			stretch,
		});

		expect(result).toBe(element);
		expect(called).toBe(0);
	});

	test("variable-rate (keyframed) clips keep today's behavior: no stretch", async () => {
		let called = 0;
		const stretch: StretchFn = async () => {
			called++;
			return fakeBuffer("stretched");
		};

		const element = makeElement({ playbackRate: 2, hasVariableRate: true });
		const result = await resolveMixElement({
			element,
			sampleRate: 44100,
			stretch,
		});

		expect(result).toBe(element);
		expect(called).toBe(0);
	});

	test("constant speed change mixes the stretched buffer as a rate-1 clip", async () => {
		const stretched = fakeBuffer("stretched");
		const seen: Array<Parameters<StretchFn>[0]> = [];
		const stretch: StretchFn = async (args) => {
			seen.push(args);
			return stretched;
		};

		const element = makeElement({ playbackRate: 2 });
		const result = await resolveMixElement({
			element,
			sampleRate: 44100,
			stretch,
		});

		// The stretcher received the clip's slot geometry (this is the same
		// argument contract the preview's renderStretchedClip uses).
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			buffer: element.buffer,
			playbackRate: 2,
			trimStart: 0.5,
			duration: 2,
			targetSampleRate: 44100,
		});

		// The mixer gets a rate-1 clip whose buffer IS the timeline slot.
		expect(result.buffer).toBe(stretched);
		expect(result.playbackRate).toBe(1);
		expect(result.trimStart).toBe(0);
		expect(result.hasVariableRate).toBe(false);
		// Slot placement is unchanged.
		expect(result.startTime).toBe(element.startTime);
		expect(result.duration).toBe(element.duration);
	});

	test("stretch failure (null) falls back to the original pitch-shifted element", async () => {
		const stretch: StretchFn = async () => null;

		const element = makeElement({ playbackRate: 0.5 });
		const result = await resolveMixElement({
			element,
			sampleRate: 44100,
			stretch,
		});

		expect(result).toBe(element);
		expect(result.playbackRate).toBe(0.5);
	});
});
