import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	resolveStretchDecision,
	setStretchFactoryLoaderForTests,
	shouldTimeStretch,
	stretchAudioBufferSegment,
} from "@/lib/media/pitch-preserving-stretch";

afterEach(() => {
	setStretchFactoryLoaderForTests(null);
});

describe("vendored signalsmith-stretch module", () => {
	test("public/vendor copy is byte-identical to the installed package", () => {
		// The runtime loads the VENDORED copy via a bundler-ignored native
		// import() (bundler transformation corrupts the library's stringified
		// AudioWorklet code). This guard fails when the dependency is upgraded
		// without re-vendoring: re-copy the file AND rename it to the new
		// version (update VENDORED_STRETCH_URL in pitch-preserving-stretch.ts).
		const appRoot = join(import.meta.dir, "..", "..", "..", "..");
		const vendored = readFileSync(
			join(appRoot, "public", "vendor", "signalsmith-stretch-1.3.2.mjs"),
		);
		const installed = readFileSync(
			join(
				appRoot,
				"node_modules",
				"signalsmith-stretch",
				"SignalsmithStretch.mjs",
			),
		);
		expect(vendored.equals(installed)).toBe(true);
	});
});

/** Shape-only AudioBuffer (bun has no Web Audio API). */
function fakeBuffer({
	seconds = 2,
	sampleRate = 48000,
	channels = 2,
}: {
	seconds?: number;
	sampleRate?: number;
	channels?: number;
} = {}): AudioBuffer {
	const length = Math.round(seconds * sampleRate);
	return {
		sampleRate,
		numberOfChannels: channels,
		length,
		duration: seconds,
		getChannelData: () => new Float32Array(length),
	} as unknown as AudioBuffer;
}

describe("resolveStretchDecision — the shared preview/export speed decision", () => {
	test("rate 1.0 bypasses the stretcher entirely", () => {
		expect(resolveStretchDecision({ playbackRate: 1 })).toEqual({
			mode: "bypass",
			rate: 1,
		});
	});

	test("missing/invalid rates normalize to bypass (never break the common path)", () => {
		for (const playbackRate of [
			undefined,
			null,
			0,
			-2,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(resolveStretchDecision({ playbackRate }).mode).toBe("bypass");
		}
	});

	test("constant non-1 rates stretch (pitch preserved)", () => {
		expect(resolveStretchDecision({ playbackRate: 2 })).toEqual({
			mode: "stretch",
			rate: 2,
		});
		expect(resolveStretchDecision({ playbackRate: 0.5 })).toEqual({
			mode: "stretch",
			rate: 0.5,
		});
	});

	test("keyframed (variable) speed keeps today's constant-rate pitch-shifted behavior", () => {
		expect(
			resolveStretchDecision({ playbackRate: 2, hasVariableRate: true }),
		).toEqual({ mode: "constant-fallback", rate: 2 });
	});

	test("shouldTimeStretch mirrors the decision", () => {
		expect(shouldTimeStretch({ playbackRate: 1 })).toBe(false);
		expect(shouldTimeStretch({ playbackRate: 2 })).toBe(true);
		expect(shouldTimeStretch({ playbackRate: 2, hasVariableRate: true })).toBe(
			false,
		);
	});
});

describe("stretchAudioBufferSegment fallback policy — never throws, resolves null", () => {
	test("rate 1.0 resolves null without ever loading the WASM module", async () => {
		let loaderCalled = false;
		setStretchFactoryLoaderForTests(async () => {
			loaderCalled = true;
			return null;
		});

		const result = await stretchAudioBufferSegment({
			buffer: fakeBuffer(),
			playbackRate: 1,
			trimStart: 0,
			duration: 1,
			targetSampleRate: 48000,
		});

		expect(result).toBeNull();
		expect(loaderCalled).toBe(false);
	});

	test("a rejecting module loader degrades to null (pitch-shifted fallback), not a throw", async () => {
		setStretchFactoryLoaderForTests(() =>
			Promise.reject(new Error("WASM failed to load")),
		);

		const result = await stretchAudioBufferSegment({
			buffer: fakeBuffer(),
			playbackRate: 2,
			trimStart: 0,
			duration: 1,
			targetSampleRate: 48000,
		});

		expect(result).toBeNull();
	});

	test("a loader resolving null (feature unavailable) degrades to null", async () => {
		setStretchFactoryLoaderForTests(async () => null);

		const result = await stretchAudioBufferSegment({
			buffer: fakeBuffer(),
			playbackRate: 0.5,
			trimStart: 0.25,
			duration: 1,
			targetSampleRate: 44100,
		});

		expect(result).toBeNull();
	});

	test("a factory that throws during render degrades to null", async () => {
		setStretchFactoryLoaderForTests(async () => async () => {
			throw new Error("worklet exploded");
		});

		const result = await stretchAudioBufferSegment({
			buffer: fakeBuffer(),
			playbackRate: 2,
			trimStart: 0,
			duration: 1,
			targetSampleRate: 48000,
		});

		expect(result).toBeNull();
	});

	test("oversized slots (memory guard) degrade to null before decoding", async () => {
		// Loader would succeed, but the guard must trip first.
		setStretchFactoryLoaderForTests(async () => async () => {
			throw new Error("should not be reached");
		});

		const result = await stretchAudioBufferSegment({
			buffer: fakeBuffer({ seconds: 4000 }),
			playbackRate: 2,
			trimStart: 0,
			duration: 1000,
			targetSampleRate: 48000,
		});

		expect(result).toBeNull();
	});

	test("degenerate geometry (zero duration, bad sample rate) resolves null", async () => {
		setStretchFactoryLoaderForTests(async () => async () => {
			throw new Error("should not be reached");
		});

		for (const args of [
			{ duration: 0, targetSampleRate: 48000 },
			{ duration: -1, targetSampleRate: 48000 },
			{ duration: 1, targetSampleRate: 0 },
		]) {
			const result = await stretchAudioBufferSegment({
				buffer: fakeBuffer(),
				playbackRate: 2,
				trimStart: 0,
				...args,
			});
			expect(result).toBeNull();
		}
	});
});
