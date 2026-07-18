/**
 * Apply-layer tests — pure `planAutoCut` mapping/ripple math plus one
 * command-stack `applyAutoCut` single-undo test. The analysis engine is never
 * called here; segments are hand-authored mocks in SOURCE seconds.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type { EditorCore } from "@/core";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import type { EditSegment } from "./types";

/**
 * Order-dependence guard: `EditorCore` (from "@/core") and "./apply" (via
 * `TracksSnapshotCommand` from "@/lib/commands/timeline") both transitively
 * import `@/core/managers/media-manager`, which statically imports the real
 * `@/services/proxy` barrel (chaining into proxy-encoder-controller.ts ->
 * proxy-generator.ts). Plain static imports here would cache the real chain
 * in bun test's shared module registry before
 * proxy-encoder-controller.test.ts's own `mock.module()` can take effect, if
 * that file runs later in the same `bun test` invocation. Mock the barrel
 * and import dynamically, AFTER the mock (mirrors
 * media-manager-decode-reprobe.test.ts's barrel mock + "Import AFTER the
 * mocks" convention). Proxy generation itself is never exercised here.
 */
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

const { EditorCore: EditorCoreClass } = await import("@/core");
const { applyAutoCut, planAutoCut } = await import("./apply");

// ── EditorCore.getInstance mock (TracksSnapshotCommand reaches for it) ────────

const originalGetInstance = EditorCoreClass.getInstance;

function mockEditorCore(editor: unknown): void {
	(
		EditorCoreClass as unknown as { getInstance: () => EditorCore }
	).getInstance = () => editor as EditorCore;
}

afterEach(() => {
	(
		EditorCoreClass as unknown as {
			getInstance: typeof EditorCoreClass.getInstance;
		}
	).getInstance = originalGetInstance;
});

// ── fixtures ──────────────────────────────────────────────────────────────────

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

const keep = (start: number, end: number): EditSegment => ({
	start,
	end,
	action: { type: "keep" },
});
const cut = (start: number, end: number): EditSegment => ({
	start,
	end,
	action: { type: "cut" },
});
const speed = (start: number, end: number, s: number): EditSegment => ({
	start,
	end,
	action: { type: "speed", speed: s },
});

// ── pure planAutoCut ──────────────────────────────────────────────────────────

describe("planAutoCut source→timeline mapping", () => {
	test("nonzero trimStart/trimEnd: kept spans map to timeline seconds and pack from the element start", () => {
		// Source [0,9]; visible window [2,8] → timeline [10,16].
		const element = video({
			id: "a",
			startTime: 10,
			duration: 6,
			trimStart: 2,
			trimEnd: 1,
			sourceDuration: 9,
		});
		const downstream = video({ id: "b", startTime: 16, duration: 3 });
		const segments = [
			keep(0, 2), // before the window — ignored
			cut(2, 3), // silence at the visible start
			keep(3, 5),
			cut(5, 6), // silence mid-clip
			keep(6, 9), // trailing keep, clamped to visEnd = 8
		];

		const plan = planAutoCut({
			tracks: [trackWith([element, downstream])],
			elementId: "a",
			segments,
		});
		if (!plan) throw new Error("expected a plan");

		expect(plan.summary).toEqual({
			removedCount: 2,
			removedSeconds: 2,
			appliedAs: "cut",
		});

		const els = plan.tracks[0].elements;
		// Two kept pieces + the downstream element.
		expect(els).toHaveLength(3);

		// Piece 1: source [3,5] → timeline start 10, duration 2, trimEnd 9-5=4.
		expect(els[0].id).toBe("a"); // first piece keeps the original id
		expect(els[0].startTime).toBe(10);
		expect(els[0].duration).toBe(2);
		expect(els[0].trimStart).toBe(3);
		expect(els[0].trimEnd).toBe(4);

		// Piece 2: source [6,8] → packed at timeline 12, duration 2, trimStart 6.
		expect(els[1].id).not.toBe("a");
		expect(els[1].startTime).toBe(12);
		expect(els[1].duration).toBe(2);
		expect(els[1].trimStart).toBe(6);
		expect(els[1].trimEnd).toBe(1);

		// Downstream ripples left by the 2s removed.
		expect(els[2].id).toBe("b");
		expect(els[2].startTime).toBe(14);
	});

	test("cut at both element edges: leading + trailing silence trimmed, one middle piece", () => {
		const element = video({ id: "a", startTime: 0, duration: 4 });
		const downstream = video({ id: "b", startTime: 4, duration: 2 });
		const segments = [cut(0, 1), keep(1, 3), cut(3, 4)];

		const plan = planAutoCut({
			tracks: [trackWith([element, downstream])],
			elementId: "a",
			segments,
		});
		if (!plan) throw new Error("expected a plan");

		expect(plan.summary.removedCount).toBe(2);
		expect(plan.summary.removedSeconds).toBe(2);

		const els = plan.tracks[0].elements;
		expect(els).toHaveLength(2);
		expect(els[0].startTime).toBe(0);
		expect(els[0].duration).toBe(2);
		expect(els[0].trimStart).toBe(1);
		expect(els[0].trimEnd).toBe(1);
		// Downstream slides left by 2s.
		expect(els[1].id).toBe("b");
		expect(els[1].startTime).toBe(2);
	});

	test("segments fully outside the visible window are a no-op", () => {
		// Visible window [3,5]; the only cut sits before it.
		const element = video({
			id: "a",
			startTime: 5,
			duration: 2,
			trimStart: 3,
			trimEnd: 1,
			sourceDuration: 6,
		});
		const downstream = video({ id: "b", startTime: 7, duration: 2 });
		const segments = [cut(0, 2), keep(2, 6)];

		const plan = planAutoCut({
			tracks: [trackWith([element, downstream])],
			elementId: "a",
			segments,
		});
		if (!plan) throw new Error("expected a plan");

		expect(plan.summary).toEqual({
			removedCount: 0,
			removedSeconds: 0,
			appliedAs: "cut",
		});
		const els = plan.tracks[0].elements;
		expect(els).toHaveLength(2);
		// Element unchanged.
		expect(els[0].id).toBe("a");
		expect(els[0].startTime).toBe(5);
		expect(els[0].duration).toBe(2);
		expect(els[0].trimStart).toBe(3);
		expect(els[0].trimEnd).toBe(1);
		// Downstream unmoved.
		expect(els[1].startTime).toBe(7);
	});

	test("entire visible window cut: element removed, downstream closes the whole gap", () => {
		const element = video({ id: "a", startTime: 2, duration: 3 });
		const downstream = video({ id: "b", startTime: 5, duration: 2 });
		const plan = planAutoCut({
			tracks: [trackWith([element, downstream])],
			elementId: "a",
			segments: [cut(0, 3)],
		});
		if (!plan) throw new Error("expected a plan");

		expect(plan.summary.removedCount).toBe(1);
		expect(plan.summary.removedSeconds).toBe(3);
		const els = plan.tracks[0].elements;
		expect(els).toHaveLength(1);
		expect(els[0].id).toBe("b");
		expect(els[0].startTime).toBe(2);
	});

	test("speed segments are downgraded to keep (not removed) in v1", () => {
		const element = video({ id: "a", startTime: 0, duration: 4 });
		const segments = [keep(0, 1), speed(1, 3, 4), keep(3, 4)];
		const plan = planAutoCut({
			tracks: [trackWith([element])],
			elementId: "a",
			segments,
		});
		if (!plan) throw new Error("expected a plan");

		expect(plan.summary.appliedAs).toBe("cut");
		expect(plan.summary.removedSeconds).toBe(0);
		expect(plan.summary.removedCount).toBe(0);
		// Untouched single element (no playbackRate plumbing invented).
		expect(plan.tracks[0].elements).toHaveLength(1);
		expect(plan.tracks[0].elements[0].duration).toBe(4);
		expect(plan.tracks[0].elements[0]).not.toHaveProperty("playbackRate");
	});

	test("unknown element id → null", () => {
		const plan = planAutoCut({
			tracks: [trackWith([video({ id: "a", startTime: 0, duration: 4 })])],
			elementId: "missing",
			segments: [cut(0, 1)],
		});
		expect(plan).toBeNull();
	});
});

// ── applyAutoCut single-undo ─────────────────────────────────────────────────

describe("applyAutoCut single undo", () => {
	function harness(initial: TimelineTrack[]) {
		let tracks = initial;
		const command = new CommandManager();
		const editor = {
			timeline: {
				getTracks: () => tracks,
				updateTracks: (next: TimelineTrack[]) => {
					tracks = next;
				},
			},
			command,
		};
		mockEditorCore(editor);
		return {
			editor,
			command,
			getTracks: () => tracks,
		};
	}

	test("one undo restores the exact prior tracks", () => {
		const initial = [
			trackWith([
				video({ id: "a", startTime: 0, duration: 4 }),
				video({ id: "b", startTime: 4, duration: 2 }),
			]),
		];
		const snapshot = structuredClone(initial);
		const h = harness(initial);

		const summary = applyAutoCut({
			editor: h.editor as unknown as EditorCore,
			elementId: "a",
			segments: [cut(0, 1), keep(1, 3), cut(3, 4)],
		});

		expect(summary).toEqual({
			removedCount: 2,
			removedSeconds: 2,
			appliedAs: "cut",
		});
		// Exactly one undoable entry was pushed.
		expect(h.command.getHistoryLength()).toBe(1);
		// The edit landed: element carved + downstream rippled.
		const after = h.getTracks();
		expect(after[0].elements).toHaveLength(2);
		expect(after[0].elements[1].startTime).toBe(2);

		// Single undo restores the EXACT prior state.
		h.command.undo();
		expect(h.command.getHistoryLength()).toBe(0);
		expect(h.getTracks()).toEqual(snapshot);
	});

	test("a no-op edit makes no history entry", () => {
		const initial = [
			trackWith([video({ id: "a", startTime: 0, duration: 4 })]),
		];
		const h = harness(initial);

		const summary = applyAutoCut({
			editor: h.editor as unknown as EditorCore,
			elementId: "a",
			segments: [keep(0, 4)],
		});

		expect(summary?.removedSeconds).toBe(0);
		expect(h.command.getHistoryLength()).toBe(0);
	});

	test("missing element → null summary, no history entry", () => {
		const initial = [
			trackWith([video({ id: "a", startTime: 0, duration: 4 })]),
		];
		const h = harness(initial);
		const summary = applyAutoCut({
			editor: h.editor as unknown as EditorCore,
			elementId: "nope",
			segments: [cut(0, 1)],
		});
		expect(summary).toBeNull();
		expect(h.command.getHistoryLength()).toBe(0);
	});
});
