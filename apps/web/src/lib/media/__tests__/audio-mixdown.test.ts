import { describe, expect, test } from "bun:test";
import { type CollectedAudioElement, mixAudioChannels } from "@/lib/media/audio";

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

		mixAudioChannels({ element, outputBuffer: buffer, outputLength: 8, sampleRate });

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

		mixAudioChannels({ element, outputBuffer: buffer, outputLength: 8, sampleRate });

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

		const writtenOne = Array.from(outOne.channels[0]).filter((v) => v !== 0).length;
		const writtenTwo = Array.from(outTwo.channels[0]).filter((v) => v !== 0).length;
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

		mixAudioChannels({ element, outputBuffer: buffer, outputLength: 8, sampleRate });

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

		mixAudioChannels({ element, outputBuffer: buffer, outputLength: 8, sampleRate });

		expect(Array.from(channels[0].slice(0, 4))).toEqual([0, 4, 8, 12]);
	});
});
