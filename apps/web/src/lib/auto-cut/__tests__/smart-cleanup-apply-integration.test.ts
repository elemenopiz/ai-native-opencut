/**
 * Timebase-conversion regression test: proves transcript-derived filler/
 * false-start cut ranges (ASSET-RELATIVE seconds, straight out of
 * `detectFillers`/`detectFalseStarts`) flow into `planAutoCut` with ZERO
 * additional shift — no re-basing by `trimStart` anywhere in this pipeline.
 *
 * This is exactly the off-by-trim bug class the project has hit before: a
 * transcript segment's `start`/`end` are already in the same timebase as a
 * clip's `trimStart`/`trimEnd` (see `filler-detect.ts`'s TIMEBASE note and
 * `apply.ts`'s file header), so a naive "helpful" `+ trimStart` here would
 * double-apply the offset and cut the wrong part of the clip.
 */
import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

// Same barrel-mock dance as ../apply.test.ts — see that file's header comment
// for why this must happen before importing "../apply".
mock.module("@/services/proxy", () => ({
	generateProxyOffThread: async () => ({
		file: new File([new Uint8Array([1])], "proxy.mp4", { type: "video/mp4" }),
		width: 1280,
		height: 720,
	}),
	isProxyCancelledError: (error: unknown) =>
		error instanceof Error &&
		(error.message === "Proxy generation cancelled" ||
			error.name === "AbortError"),
}));

const { planAutoCut } = await import("../apply");
const { detectFalseStarts, detectFillers } = await import("../filler-detect");
const { allKeepBase, buildSmartCleanupPlan } = await import("../smart-cleanup");

function video({
	id,
	startTime,
	duration,
	trimStart = 0,
	trimEnd = 0,
	sourceDuration,
}: {
	id: string;
	startTime: number;
	duration: number;
	trimStart?: number;
	trimEnd?: number;
	sourceDuration?: number;
}): VideoElement {
	return {
		id,
		name: `Clip ${id}`,
		type: "video",
		mediaId: `media-${id}`,
		duration,
		startTime,
		trimStart,
		trimEnd,
		sourceDuration: sourceDuration ?? trimStart + duration + trimEnd,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
	};
}

function trackWith(elements: VideoElement[]): TimelineTrack {
	return {
		id: "track-1",
		name: "Main",
		type: "video",
		elements,
		isMain: true,
		muted: false,
		hidden: false,
	};
}

describe("filler/false-start cuts are apply-compatible with no re-basing", () => {
	test("transcript segments (asset-relative) feed planAutoCut directly through a trimmed element", () => {
		// Source media is 10s. Transcript (asset-relative, same as trim's
		// timebase): a filler-only segment at [4,5), embedded in speech that
		// spans the whole file.
		const segments = [
			{ start: 0, end: 4, text: "Welcome to the show" },
			{ start: 4, end: 5, text: "um" },
			{ start: 5, end: 10, text: "let's get started right away" },
		];

		const { ranges } = detectFillers(segments);
		expect(ranges).toEqual([
			{
				start: 4,
				end: 5,
				source: "filler",
				confidence: "high",
				label: "um",
			},
		]);

		const plan = buildSmartCleanupPlan(allKeepBase(10), ranges);
		expect(plan).toEqual([
			{ start: 0, end: 4, action: { type: "keep" } },
			{ start: 4, end: 5, action: { type: "cut" } },
			{ start: 5, end: 10, action: { type: "keep" } },
		]);

		// Element trims the source to its visible window [2, 8] (trimStart=2,
		// trimEnd=2), placed at timeline second 20. If this pipeline were
		// wrongly re-basing by trimStart, the cut would land at asset-relative
		// [6,7) instead of [4,5) and the math below would be off.
		const element = video({
			id: "clip",
			startTime: 20,
			duration: 6,
			trimStart: 2,
			trimEnd: 2,
			sourceDuration: 10,
		});

		const result = planAutoCut({
			tracks: [trackWith([element])],
			elementId: "clip",
			segments: plan,
		});
		if (!result) throw new Error("expected a plan");

		// Visible window [2,8]; cut [4,5) sits inside it → one 1s gap removed.
		expect(result.summary).toEqual({
			removedCount: 1,
			removedSeconds: 1,
			appliedAs: "cut",
		});

		const els = result.tracks[0].elements;
		expect(els).toHaveLength(2);
		// Piece 1: source [2,4) → timeline start 20, duration 2.
		expect(els[0].startTime).toBe(20);
		expect(els[0].duration).toBe(2);
		expect(els[0].trimStart).toBe(2);
		// Piece 2: source [5,8) → packed right after piece 1, duration 3.
		expect(els[1].startTime).toBe(22);
		expect(els[1].duration).toBe(3);
		expect(els[1].trimStart).toBe(5);
	});

	test("false-start cut range also flows straight into planAutoCut unshifted", () => {
		const segments = [
			{ start: 0, end: 1.5, text: "I want to" },
			{ start: 1.6, end: 4, text: "I want to go home now" },
		];
		const falseStarts = detectFalseStarts(segments);
		expect(falseStarts).toHaveLength(1);

		const plan = buildSmartCleanupPlan(allKeepBase(4), falseStarts);
		const element = video({ id: "clip", startTime: 0, duration: 4 });
		const result = planAutoCut({
			tracks: [trackWith([element])],
			elementId: "clip",
			segments: plan,
		});
		if (!result) throw new Error("expected a plan");
		// [0, 1.5] plus the default 0.08s postPad, clamped to the retry's start
		// (1.6) — i.e. 1.58, not the raw 1.5 attempt span.
		expect(result.summary.removedSeconds).toBeCloseTo(1.58, 5);
	});
});
