import { describe, expect, test } from "bun:test";
import {
	type CollectedAudioElement,
	computeVolumeEnvelope,
	mixAudioChannels,
} from "@/lib/media/audio";
import { getNumberChannelValueAtTime } from "@/lib/animation";
import type { NumberKeyframe } from "@/types/animation";

/**
 * Minimal AudioBuffer stand-in for the fields mixAudioChannels reads. bun's test
 * runner has no Web Audio API, so we mock the shape rather than the whole API.
 */
function makeBuffer({
	data,
	sampleRate,
	channels = 1,
}: {
	data: number[];
	sampleRate: number;
	channels?: number;
}): AudioBuffer {
	const channelData = Array.from({ length: channels }, () =>
		Float32Array.from(data),
	);
	return {
		sampleRate,
		numberOfChannels: channels,
		length: data.length,
		getChannelData: (channel: number) => channelData[channel],
	} as unknown as AudioBuffer;
}

function makeOutputBuffer({
	length,
	channels = 2,
}: {
	length: number;
	channels?: number;
}): { buffer: AudioBuffer; channels: Float32Array[] } {
	const channelData = Array.from(
		{ length: channels },
		() => new Float32Array(length),
	);
	const buffer = {
		numberOfChannels: channels,
		length,
		getChannelData: (channel: number) => channelData[channel],
	} as unknown as AudioBuffer;
	return { buffer, channels: channelData };
}

function makeElement(
	overrides: Partial<CollectedAudioElement> & { buffer: AudioBuffer },
): CollectedAudioElement {
	return {
		startTime: 0,
		duration: 1,
		trimStart: 0,
		trimEnd: 0,
		muted: false,
		playbackRate: 1,
		hasVariableRate: false,
		volume: 1,
		trackVolume: 1,
		volumeKeyframes: null,
		...overrides,
	} as CollectedAudioElement;
}

describe("mixAudioChannels playbackRate handling", () => {
	const sampleRate = 4;
	const source = [10, 11, 12, 13, 14, 15, 16, 17];

	test("rate 1.0 copies source samples 1:1 into the timeline slot", () => {
		const element = makeElement({
			buffer: makeBuffer({ data: source, sampleRate }),
			duration: 1, // 1s * 4 = 4 output samples
			playbackRate: 1,
		});
		const { buffer, channels } = makeOutputBuffer({ length: 8 });

		mixAudioChannels({
			element,
			outputBuffer: buffer,
			outputLength: 8,
			sampleRate,
		});

		expect(Array.from(channels[0].slice(0, 4))).toEqual([10, 11, 12, 13]);
		// nothing written past the 4-sample (1s) slot
		expect(Array.from(channels[0].slice(4))).toEqual([0, 0, 0, 0]);
	});

	test("rate 2.0 consumes source twice as fast into the same-length slot (pitch-shift)", () => {
		const element = makeElement({
			buffer: makeBuffer({ data: source, sampleRate }),
			duration: 1, // slot length stays 4 output samples, independent of rate
			playbackRate: 2,
		});
		const { buffer, channels } = makeOutputBuffer({ length: 8 });

		mixAudioChannels({
			element,
			outputBuffer: buffer,
			outputLength: 8,
			sampleRate,
		});

		// output[i] = source[2i]: reads twice as deep into the source (index 6 vs 3)
		expect(Array.from(channels[0].slice(0, 4))).toEqual([10, 12, 14, 16]);
		expect(Array.from(channels[0].slice(4))).toEqual([0, 0, 0, 0]);
	});

	test("2x clip needs half the timeline length to play a fixed source span", () => {
		// Playing the full 8-sample source: rate 1 -> 2s slot; rate 2 -> 1s slot (half).
		const oneX = makeElement({
			buffer: makeBuffer({ data: source, sampleRate }),
			duration: 2,
			playbackRate: 1,
		});
		const twoX = makeElement({
			buffer: makeBuffer({ data: source, sampleRate }),
			duration: 1,
			playbackRate: 2,
		});

		const outOne = makeOutputBuffer({ length: 16 });
		mixAudioChannels({
			element: oneX,
			outputBuffer: outOne.buffer,
			outputLength: 16,
			sampleRate,
		});
		const outTwo = makeOutputBuffer({ length: 16 });
		mixAudioChannels({
			element: twoX,
			outputBuffer: outTwo.buffer,
			outputLength: 16,
			sampleRate,
		});

		const writtenOne = Array.from(outOne.channels[0]).filter(
			(v) => v !== 0,
		).length;
		const writtenTwo = Array.from(outTwo.channels[0]).filter(
			(v) => v !== 0,
		).length;
		expect(writtenOne).toBe(8); // 2s * 4
		expect(writtenTwo).toBe(4); // 1s * 4 -> half the length
	});

	test("startTime offsets placement in the timeline", () => {
		const element = makeElement({
			buffer: makeBuffer({ data: source, sampleRate }),
			startTime: 1, // 1s * 4 = start at output sample 4
			duration: 1,
			playbackRate: 1,
		});
		const { buffer, channels } = makeOutputBuffer({ length: 8 });

		mixAudioChannels({
			element,
			outputBuffer: buffer,
			outputLength: 8,
			sampleRate,
		});

		expect(Array.from(channels[0].slice(0, 4))).toEqual([0, 0, 0, 0]);
		expect(Array.from(channels[0].slice(4, 8))).toEqual([10, 11, 12, 13]);
	});

	test("resamples across differing source/output sample rates together with rate", () => {
		// Source at 8 Hz, output at 4 Hz -> resampleRatio 0.5; with rate 2 the
		// effective source step is (i * 2) / 0.5 = 4i.
		const element = makeElement({
			buffer: makeBuffer({
				data: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
				sampleRate: 8,
			}),
			duration: 1, // 1s * 4 output = 4 samples
			playbackRate: 2,
		});
		const { buffer, channels } = makeOutputBuffer({ length: 8 });

		mixAudioChannels({
			element,
			outputBuffer: buffer,
			outputLength: 8,
			sampleRate,
		});

		expect(Array.from(channels[0].slice(0, 4))).toEqual([0, 4, 8, 12]);
	});
});

function keyframe(
	overrides: Partial<NumberKeyframe> & { time: number; value: number },
): NumberKeyframe {
	return {
		id: `kf-${overrides.time}-${overrides.value}`,
		interpolation: "linear",
		...overrides,
	};
}

describe("mixAudioChannels gain path (static volume, track volume, automation)", () => {
	const sampleRate = 4;

	test("static clip volume 0.5 scales every mixed sample by 0.5", () => {
		const element = makeElement({
			buffer: makeBuffer({ data: [4, 4, 4, 4], sampleRate }),
			duration: 1,
			volume: 0.5,
		});
		const { buffer, channels } = makeOutputBuffer({ length: 4 });

		mixAudioChannels({
			element,
			outputBuffer: buffer,
			outputLength: 4,
			sampleRate,
		});

		expect(Array.from(channels[0])).toEqual([2, 2, 2, 2]);
		expect(Array.from(channels[1])).toEqual([2, 2, 2, 2]);
	});

	test("track volume multiplies with clip volume", () => {
		const element = makeElement({
			buffer: makeBuffer({ data: [4, 4, 4, 4], sampleRate }),
			duration: 1,
			volume: 0.5,
			trackVolume: 0.5,
		});
		const { buffer, channels } = makeOutputBuffer({ length: 4 });

		mixAudioChannels({
			element,
			outputBuffer: buffer,
			outputLength: 4,
			sampleRate,
		});

		// 0.5 (clip) * 0.5 (track) = 0.25 -> 4 * 0.25 = 1
		expect(Array.from(channels[0])).toEqual([1, 1, 1, 1]);
	});

	test("no volume channel falls back to the static volume for every sample", () => {
		const element = makeElement({
			buffer: makeBuffer({ data: [10, 10, 10, 10], sampleRate }),
			duration: 1,
			volume: 0.7,
			volumeKeyframes: null,
		});
		const { buffer, channels } = makeOutputBuffer({ length: 4 });

		mixAudioChannels({
			element,
			outputBuffer: buffer,
			outputLength: 4,
			sampleRate,
		});

		expect(Array.from(channels[0])).toEqual([7, 7, 7, 7]);
	});

	test("linear ramp 1 -> 0 across the clip is ~0.5 at midpoint and monotonically decreasing", () => {
		const element = makeElement({
			buffer: makeBuffer({ data: [8, 8, 8, 8], sampleRate }),
			duration: 1,
			volume: 1,
			volumeKeyframes: [
				keyframe({ time: 0, value: 1, interpolation: "linear" }),
				keyframe({ time: 1, value: 0, interpolation: "linear" }),
			],
		});
		const { buffer, channels } = makeOutputBuffer({ length: 4 });

		mixAudioChannels({
			element,
			outputBuffer: buffer,
			outputLength: 4,
			sampleRate,
		});

		const values = Array.from(channels[0]);
		// times sampled: 0, 0.25, 0.5, 0.75 -> gains 1, 0.75, 0.5, 0.25
		expect(values).toEqual([8, 6, 4, 2]);
		// monotonic decrease
		for (let i = 1; i < values.length; i++) {
			expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
		}
	});

	test("hold interpolation steps: value stays flat until the next keyframe, then jumps", () => {
		const element = makeElement({
			buffer: makeBuffer({ data: [4, 4, 4, 4], sampleRate }),
			duration: 1,
			volume: 1,
			volumeKeyframes: [
				keyframe({ time: 0, value: 1, interpolation: "hold" }),
				keyframe({ time: 0.5, value: 0, interpolation: "linear" }),
			],
		});
		const { buffer, channels } = makeOutputBuffer({ length: 4 });

		mixAudioChannels({
			element,
			outputBuffer: buffer,
			outputLength: 4,
			sampleRate,
		});

		// times: 0, 0.25, 0.5, 0.75 -> gains 1, 1 (held), 0 (reached kf), 0 (past last)
		expect(Array.from(channels[0])).toEqual([4, 4, 0, 0]);
	});

	test("muted flag is untouched by the gain path (still the caller's responsibility)", () => {
		const element = makeElement({
			buffer: makeBuffer({ data: [4, 4, 4, 4], sampleRate }),
			duration: 1,
			volume: 1,
			muted: true,
		});
		const { buffer, channels } = makeOutputBuffer({ length: 4 });

		mixAudioChannels({
			element,
			outputBuffer: buffer,
			outputLength: 4,
			sampleRate,
		});

		// mixAudioChannels itself never reads `muted` — createTimelineAudioBuffer
		// skips muted elements before calling it. Confirms the gain-path change
		// didn't fold muting logic into this function.
		expect(Array.from(channels[0])).toEqual([4, 4, 4, 4]);
	});

	test("overlapping clips sum AFTER gain is applied, not before", () => {
		const clipA = makeElement({
			buffer: makeBuffer({ data: [4, 4, 4, 4], sampleRate }),
			duration: 1,
			volume: 0.5,
		});
		const clipB = makeElement({
			buffer: makeBuffer({ data: [2, 2, 2, 2], sampleRate }),
			duration: 1,
			volume: 0.25,
		});
		const { buffer, channels } = makeOutputBuffer({ length: 4 });

		mixAudioChannels({
			element: clipA,
			outputBuffer: buffer,
			outputLength: 4,
			sampleRate,
		});
		mixAudioChannels({
			element: clipB,
			outputBuffer: buffer,
			outputLength: 4,
			sampleRate,
		});

		// clipA: 4 * 0.5 = 2; clipB: 2 * 0.25 = 0.5; sum = 2.5
		expect(Array.from(channels[0])).toEqual([2.5, 2.5, 2.5, 2.5]);
	});
});

describe("computeVolumeEnvelope parity with getNumberChannelValueAtTime", () => {
	test("matches the reference evaluator across linear, hold, and eased segments at many sample points", () => {
		const keyframes: NumberKeyframe[] = [
			keyframe({ time: 0.3, value: 1, interpolation: "hold" }),
			keyframe({ time: 0.9, value: 0.2, interpolation: "linear" }),
			keyframe({
				time: 1.6,
				value: 0.9,
				interpolation: "linear",
				easing: { preset: "ease-in-out", bezier: [0.42, 0, 0.58, 1] },
			}),
			keyframe({ time: 2.4, value: 0 }),
		];
		const sorted = [...keyframes].sort((a, b) => a.time - b.time);
		const fallbackValue = 1;
		const sampleRate = 1000;
		const sampleCount = 3000; // covers 0..3s, past the last keyframe too

		const envelope = computeVolumeEnvelope({
			keyframes,
			fallbackValue,
			sampleCount,
			sampleRate,
		});

		expect(envelope.length).toBe(sampleCount);

		// Spot-check across the whole range (not just at keyframe boundaries) to
		// exercise the forward-only cursor's segment transitions.
		for (let i = 0; i < sampleCount; i += 7) {
			const time = i / sampleRate;
			const expected = getNumberChannelValueAtTime({
				channel: { valueKind: "number", keyframes: sorted },
				time,
				fallbackValue,
			});
			expect(envelope[i]).toBeCloseTo(expected, 6);
		}
	});

	test("empty/undefined keyframes fill the whole envelope with the fallback value", () => {
		const envelope = computeVolumeEnvelope({
			keyframes: null,
			fallbackValue: 0.42,
			sampleCount: 5,
			sampleRate: 10,
		});
		// Float32Array storage introduces sub-float32-precision rounding, so
		// compare with tolerance rather than exact equality.
		for (const value of envelope) {
			expect(value).toBeCloseTo(0.42, 6);
		}
	});

	test("a single keyframe is a constant across the whole envelope, matching the reference evaluator", () => {
		const keyframes: NumberKeyframe[] = [keyframe({ time: 0.5, value: 0.33 })];
		const envelope = computeVolumeEnvelope({
			keyframes,
			fallbackValue: 1,
			sampleCount: 20,
			sampleRate: 10,
		});
		for (let i = 0; i < envelope.length; i++) {
			const expected = getNumberChannelValueAtTime({
				channel: { valueKind: "number", keyframes },
				time: i / 10,
				fallbackValue: 1,
			});
			expect(envelope[i]).toBeCloseTo(expected, 6);
		}
	});
});
