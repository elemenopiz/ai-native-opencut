import { describe, expect, it } from "bun:test";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor } from "./fake-editor";
import type { WatchBackData } from "./types";
import {
	clampAndDedupeTimes,
	describeClipAt,
	downscaleSize,
	WATCH_BACK_LONG_EDGE_PX,
	WATCH_BACK_MAX_FRAMES,
	type RenderedWatchBackFrame,
	type WatchBackRenderInput,
} from "./watch-back";

/**
 * The `watchBack` verb: render the COMPOSITED timeline (not a slot's source
 * media — that's `reviewTake`/`extractFrame`) at requested times and return
 * decoded frames + captions. The actual canvas render is browser-bound, so
 * these tests inject a fake `render` (same injectable-seam pattern as
 * `director-frame-extraction.test.ts`'s `frames.decode`).
 */

/** The fields every VISUAL element needs beyond {type, mediaId, name} — the
 *  fake editor's `insertElement` is typed against the REAL `EditorCore`
 *  timeline surface, which requires a full valid element (same precedent as
 *  `director-craft.test.ts`'s `visualBase`). */
const visualBase = {
	trimStart: 0,
	trimEnd: 0,
	transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
	opacity: 1,
};

function addClip(
	fake: ReturnType<typeof makeFakeEditor>,
	name: string,
	startTime: number,
	duration: number,
) {
	fake.editor.timeline.insertElement({
		element: {
			type: "video",
			mediaId: `media_${name}`,
			name,
			startTime,
			duration,
			...visualBase,
		},
		placement: { mode: "auto", trackType: "video" },
	});
}

/** A fake renderer that echoes back one 1x1 data URL per requested time and
 * records every call's input for assertions. */
function fakeRenderer(calls: WatchBackRenderInput[]) {
	return async (
		input: WatchBackRenderInput,
	): Promise<RenderedWatchBackFrame[]> => {
		calls.push(input);
		return input.times.map((time) => ({
			time,
			dataUrl: `data:image/jpeg;base64,frame-at-${time}`,
		}));
	};
}

describe("watchBack verb", () => {
	it("renders the requested times, clamping to the timeline span", async () => {
		const fake = makeFakeEditor({ fps: 30 });
		addClip(fake, "Clip A", 0, 5);
		addClip(fake, "Clip B", 5, 5);

		const calls: WatchBackRenderInput[] = [];
		const director = createDirectorApi(fake.editor, {
			watchBack: { render: fakeRenderer(calls) },
		});

		// 1s lands in Clip A, 7s lands unambiguously in Clip B (5s would sit on
		// the boundary between the two, which is a describeClipAt tie-break, not
		// what this test is about).
		const res = await director.watchBack({ times: [1, 20, 7] });

		expect(res.ok).toBe(true);
		const data = res.data as WatchBackData;
		// 20s is past the 10s timeline — clamped to the last decodable frame
		// (duration - 1/fps), and results come back sorted ascending.
		expect(data.times[0]).toBe(1);
		expect(data.times[1]).toBe(7);
		// Rounded to 2 decimals for de-dup (see clampAndDedupeTimes) — still
		// well within a still frame's needed precision.
		expect(data.times[2]).toBeCloseTo(10 - 1 / 30, 2);
		expect(data.frames).toHaveLength(3);
		expect(
			data.frames.every((f) => f.startsWith("data:image/jpeg;base64,")),
		).toBe(true);
		// Captions name the clip on screen at each sampled time.
		expect(data.captions[0]).toContain("Clip A");
		expect(data.captions[1]).toContain("Clip B");

		// Rendered at the project's real canvas size, downscaled target requested.
		expect(calls).toHaveLength(1);
		expect(calls[0].canvasSize).toEqual({ width: 1080, height: 1920 });
		expect(calls[0].targetSize.height).toBe(WATCH_BACK_LONG_EDGE_PX);
		expect(calls[0].useProxy).toBe(true);
	});

	it("de-duplicates near-duplicate times and caps to WATCH_BACK_MAX_FRAMES", async () => {
		const fake = makeFakeEditor({ fps: 30 });
		addClip(fake, "Clip A", 0, 100);

		const calls: WatchBackRenderInput[] = [];
		const director = createDirectorApi(fake.editor, {
			watchBack: { render: fakeRenderer(calls) },
		});

		const requested = [1, 1.001, 2, 3, 4, 5]; // 6 requested, one near-dupe
		const res = await director.watchBack({ times: requested });

		expect(res.ok).toBe(true);
		const data = res.data as WatchBackData;
		expect(data.times.length).toBeLessThanOrEqual(WATCH_BACK_MAX_FRAMES);
		expect(calls[0].times.length).toBeLessThanOrEqual(WATCH_BACK_MAX_FRAMES);
		// 1 and 1.001 collapse to one entry, so the first 4 distinct times win.
		expect(data.times).toEqual([1, 2, 3, 4]);
	});

	it("fails honestly when the timeline is empty", async () => {
		const fake = makeFakeEditor();
		const director = createDirectorApi(fake.editor, {
			watchBack: { render: fakeRenderer([]) },
		});

		const res = await director.watchBack({ times: [0] });
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/empty/i);
	});

	it("fails honestly when the render seam throws", async () => {
		const fake = makeFakeEditor();
		addClip(fake, "Clip A", 0, 5);
		const director = createDirectorApi(fake.editor, {
			watchBack: {
				render: async () => {
					throw new Error("canvas boom");
				},
			},
		});

		const res = await director.watchBack({ times: [0] });
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/canvas boom/);
	});

	it("is read-only — no mutation delta on success", async () => {
		const fake = makeFakeEditor();
		addClip(fake, "Clip A", 0, 5);
		const director = createDirectorApi(fake.editor, {
			watchBack: { render: fakeRenderer([]) },
		});

		const res = await director.watchBack({ times: [0] });
		expect(res.ok).toBe(true);
		expect(res.delta).toBeUndefined();
	});
});

describe("clampAndDedupeTimes", () => {
	it("clamps into [0, maxTime], drops non-finite input, sorts, and caps", () => {
		expect(
			clampAndDedupeTimes([-5, 3, 100, Number.NaN, 1, 3.001], 10, 4),
		).toEqual([0, 1, 3, 10]);
	});

	it("de-duplicates times that round to the same value", () => {
		expect(clampAndDedupeTimes([2, 2.001, 2.009], 10, 10)).toEqual([2, 2.01]);
	});

	it("returns an empty array for an empty or all-invalid request", () => {
		expect(clampAndDedupeTimes([], 10, 4)).toEqual([]);
		expect(
			clampAndDedupeTimes([Number.NaN, Number.POSITIVE_INFINITY], 10, 4),
		).toEqual([]);
	});
});

describe("downscaleSize", () => {
	it("scales the long edge down to the target, preserving aspect ratio", () => {
		expect(downscaleSize({ width: 1080, height: 1920 }, 512)).toEqual({
			width: 288,
			height: 512,
		});
		expect(downscaleSize({ width: 1920, height: 1080 }, 512)).toEqual({
			width: 512,
			height: 288,
		});
	});

	it("never upscales a canvas already smaller than the target", () => {
		expect(downscaleSize({ width: 100, height: 200 }, 512)).toEqual({
			width: 100,
			height: 200,
		});
	});
});

describe("describeClipAt", () => {
	it("names the video element covering the given time", () => {
		const fake = makeFakeEditor();
		addClip(fake, "Intro", 0, 5);
		addClip(fake, "Outro", 5, 5);
		const tracks = fake.editor.timeline.getTracks();

		expect(describeClipAt(tracks, 2)).toBe("Intro");
		expect(describeClipAt(tracks, 7)).toBe("Outro");
	});

	it("returns undefined when nothing is on screen", () => {
		const fake = makeFakeEditor();
		addClip(fake, "Intro", 0, 5);
		const tracks = fake.editor.timeline.getTracks();

		expect(describeClipAt(tracks, 9)).toBeUndefined();
	});
});
