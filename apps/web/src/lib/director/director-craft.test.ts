import { afterEach, describe, expect, it } from "bun:test";
import type { TimelineTrack } from "@/types/timeline";
import { useBeatGridStore, type BeatGrid } from "@/stores/beat-grid-store";
import { makeFakeEditor, type FakeElement } from "./fake-editor";

/** The fields every VISUAL element needs beyond {type, mediaId, name} — the
 *  fake editor's `insertElement` is typed against the REAL `EditorCore`
 *  timeline surface, which requires a full valid element (same precedent as
 *  `director-remove-background.test.ts`'s `visualBase`). */
const visualBase = {
	trimStart: 0,
	trimEnd: 0,
	transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
	opacity: 1,
};

/** The fields every AUDIO element needs beyond {type, sourceType, mediaId, name}. */
const audioBase = {
	trimStart: 0,
	trimEnd: 0,
};

/**
 * Wiring tests for the P5 craft verbs (`cutOnBeat`/`tightenToLength`/
 * `duckMusicUnderSpeech` — `lib/director/craft/*`) exposed through
 * `director-api.ts`'s `executeCraftPlan`. Each verb's own planner is already
 * unit-tested in `lib/director/craft/*.test.ts` (pure, no editor) — these
 * tests pin the EXECUTION half: gathering the digest off a real (fake)
 * timeline, running the plan, and applying it as one undo step.
 *
 * `trim`/`move` land via `UpdateElementTrimCommand`/`MoveElementCommand`,
 * `animateItem`'s keyframe path via `UpsertKeyframeCommand` — all three reach
 * the global `EditorCore.getInstance()` singleton from inside `execute()`
 * (same repo-wide pattern documented in `adapter-defaults.test.ts` and
 * `director-animate-item.test.ts`), not the `editor` instance
 * `createDirectorApi` was constructed with. This file extends the shared
 * `fake-editor.ts` stub with all three commands (mirroring both those files'
 * precedent) and patches `EditorCore.getInstance` per test.
 */

const { createDirectorApi } = await import("./director-api");
const { EditorCore: EditorCoreClass } = await import("@/core");
const { UpdateElementTrimCommand } = await import(
	"@/lib/commands/timeline/element/update-element-trim"
);
const { MoveElementCommand } = await import(
	"@/lib/commands/timeline/element/move-elements"
);
const { UpsertKeyframeCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/upsert-keyframe"
);
const { BatchCommand } = await import("@/lib/commands/batch-command");

/** Same de-aliasing discipline as `director-animate-item.test.ts`'s
 *  `makeAnimatableFakeEditor` — see that file's header for why `getTracks`
 *  must return a fresh top-level array copy every call. */
function makeCraftFakeEditor() {
	const fake = makeFakeEditor();
	const timeline = fake.editor.timeline as unknown as {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
		updateElementTrim: (input: {
			elementId: string;
			trimStart: number;
			trimEnd: number;
			startTime?: number;
			duration?: number;
		}) => void;
		moveElement: (input: {
			sourceTrackId: string;
			targetTrackId: string;
			elementId: string;
			newStartTime: number;
		}) => void;
		upsertKeyframes: (input: {
			keyframes: Array<{
				trackId: string;
				elementId: string;
				propertyPath: string;
				time: number;
				value: unknown;
				interpolation?: string;
			}>;
		}) => void;
	};
	const liveGetTracks = timeline.getTracks;
	timeline.getTracks = () => [...liveGetTracks()] as TimelineTrack[];
	timeline.updateTracks = (tracks: TimelineTrack[]) => {
		fake.tracks.length = 0;
		fake.tracks.push(...(tracks as unknown as typeof fake.tracks));
	};
	timeline.updateElementTrim = (input) => {
		fake.editor.command.execute({
			command: new UpdateElementTrimCommand(input as never),
		});
	};
	timeline.moveElement = (input) => {
		fake.editor.command.execute({
			command: new MoveElementCommand(input as never),
		});
	};
	timeline.upsertKeyframes = ({ keyframes }) => {
		if (keyframes.length === 0) return;
		const commands = keyframes.map(
			(kf) => new UpsertKeyframeCommand(kf as never),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		fake.editor.command.execute({ command });
	};
	return fake;
}

let restoreGetInstance: (() => void) | undefined;

afterEach(() => {
	restoreGetInstance?.();
	restoreGetInstance = undefined;
	// The beat grid lives in a real, module-global zustand store — reset it
	// after every test so grids seeded here never leak into another test file.
	useBeatGridStore.getState().reset();
});

function patchEditorSingleton(editorLike: unknown) {
	const real = EditorCoreClass.getInstance;
	(EditorCoreClass as unknown as { getInstance: () => unknown }).getInstance =
		() => editorLike;
	restoreGetInstance = () => {
		(EditorCoreClass as unknown as { getInstance: () => unknown }).getInstance =
			real;
	};
}

function findByName(fake: ReturnType<typeof makeCraftFakeEditor>, id: string) {
	return fake.find(id)?.element as FakeElement & {
		startTime: number;
		duration: number;
		trimStart: number;
		volume?: number;
		animations?: {
			channels: Record<string, { keyframes: { value: number }[] } | undefined>;
		};
	};
}

// ── cutOnBeat ────────────────────────────────────────────────────────────────

describe("cutOnBeat", () => {
	function seedBeatGrid(fake: ReturnType<typeof makeCraftFakeEditor>) {
		// A dedicated beat-source element, decoupled from the video clips it's
		// snapping — 20s of source, one beat at 4.0s (SOURCE time == TIMELINE
		// time here since startTime/trimStart are both 0).
		const beatSourceId = fake.editor.timeline.insertElement({
			element: {
				type: "audio",
				sourceType: "upload",
				mediaId: "media_song",
				name: "beat source",
				volume: 1,
				startTime: 0,
				duration: 20,
				...audioBase,
			},
			placement: { mode: "auto", trackType: "audio" },
		});
		const grid: BeatGrid = {
			elementId: beatSourceId,
			trackId: fake.find(beatSourceId)?.track.id ?? "",
			mediaId: "media_song",
			beats: [4.0],
			downbeats: [4.0],
			bpm: 120,
			energyClass: "energetic",
			analyzedAt: Date.now(),
		};
		useBeatGridStore.getState().setGrid(grid);
	}

	it("needs an analyzed beat grid — coaching failure naming the reason", () => {
		const fake = makeCraftFakeEditor();
		const d = createDirectorApi(fake.editor);
		fake.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: "m1",
				name: "clip 1",
				startTime: 0,
				duration: 4,
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});
		fake.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: "m2",
				name: "clip 2",
				startTime: 4,
				duration: 4,
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});

		const result = d.cutOnBeat({});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("beat grid");
	});

	it("snaps a cut point onto the nearest beat as ONE undo entry", () => {
		const fake = makeCraftFakeEditor();
		patchEditorSingleton(fake.editor);
		seedBeatGrid(fake);
		const d = createDirectorApi(fake.editor);

		// Cut point at 3.9s; nearest beat is 4.0s (within the 0.15s default
		// tolerance) — should pull the join 0.1s later.
		const c1 = fake.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: "m1",
				name: "clip 1",
				startTime: 0,
				duration: 3.9,
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});
		const c2 = fake.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: "m2",
				name: "clip 2",
				startTime: 3.9,
				duration: 5,
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});

		const historyBefore = fake.editor.command.getHistoryLength();
		const result = d.cutOnBeat({});

		expect(result.ok).toBe(true);
		// ONE join snapped ⇒ two touched-element ops (left's tail trim, right's
		// head-trim+reposition) — `cutOnBeat`'s own "one op per element" merge.
		expect(result.data?.snappedCount).toBe(2);
		expect(fake.editor.command.getHistoryLength()).toBe(historyBefore + 1);

		const left = findByName(fake, c1);
		const right = findByName(fake, c2);
		expect(left.duration).toBeCloseTo(4.0, 5);
		expect(right.startTime).toBeCloseTo(4.0, 5);
		expect(right.trimStart).toBeCloseTo(0.1, 5);
		expect(right.duration).toBeCloseTo(4.9, 5);

		// Whole plan undoes as ONE step.
		const undoResult = d.undo();
		expect(undoResult.ok).toBe(true);
		expect(findByName(fake, c1).duration).toBeCloseTo(3.9, 5);
		expect(findByName(fake, c2).startTime).toBeCloseTo(3.9, 5);
	});

	it("fewer than two clips on the target track — coaching failure", () => {
		const fake = makeCraftFakeEditor();
		seedBeatGrid(fake);
		const d = createDirectorApi(fake.editor);
		fake.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: "m1",
				name: "clip 1",
				startTime: 0,
				duration: 4,
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});

		const result = d.cutOnBeat({});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("fewer than two clips");
	});
});

// ── tightenToLength ──────────────────────────────────────────────────────────

describe("tightenToLength", () => {
	function twoClips(fake: ReturnType<typeof makeCraftFakeEditor>) {
		const c1 = fake.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: "m1",
				name: "clip 1",
				startTime: 0,
				duration: 5,
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});
		const c2 = fake.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: "m2",
				name: "clip 2",
				startTime: 5,
				duration: 5,
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});
		return { c1, c2 };
	}

	it("no video track on the timeline — coaching failure", () => {
		const fake = makeCraftFakeEditor();
		const d = createDirectorApi(fake.editor);

		const result = d.tightenToLength({ targetSec: 5 });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("No video track");
	});

	it("proportionally tightens to the target as ONE undo entry", () => {
		const fake = makeCraftFakeEditor();
		patchEditorSingleton(fake.editor);
		const { c1, c2 } = twoClips(fake);
		const d = createDirectorApi(fake.editor);

		const historyBefore = fake.editor.command.getHistoryLength();
		const result = d.tightenToLength({ targetSec: 8 });

		expect(result.ok).toBe(true);
		expect(result.data?.shortfallSec).toBeUndefined();
		expect(result.data?.projectedDurationSec).toBeCloseTo(8, 5);
		expect(fake.editor.command.getHistoryLength()).toBe(historyBefore + 1);

		const left = findByName(fake, c1);
		const right = findByName(fake, c2);
		// Even split of the 2s excess (both clips have equal tail capacity).
		expect(left.duration).toBeCloseTo(4, 5);
		expect(right.duration).toBeCloseTo(4, 5);
		expect(right.startTime).toBeCloseTo(4, 5); // re-packed contiguously

		const undoResult = d.undo();
		expect(undoResult.ok).toBe(true);
		expect(findByName(fake, c1).duration).toBeCloseTo(5, 5);
		expect(findByName(fake, c2).startTime).toBeCloseTo(5, 5);
	});

	it("already at/under target — ok, nothing to trim, no history entry added", () => {
		const fake = makeCraftFakeEditor();
		patchEditorSingleton(fake.editor);
		twoClips(fake);
		const d = createDirectorApi(fake.editor);

		const historyBefore = fake.editor.command.getHistoryLength();
		const result = d.tightenToLength({ targetSec: 20 });

		expect(result.ok).toBe(true);
		expect(result.data?.opsApplied).toBe(0);
		expect(fake.editor.command.getHistoryLength()).toBe(historyBefore);
	});

	it("protectSpeech shields a voiceover-covered clip, reporting a shortfall instead of trimming into it", () => {
		const fake = makeCraftFakeEditor();
		patchEditorSingleton(fake.editor);
		const { c2 } = twoClips(fake);
		// Voiceover covers the whole of c2 (timeline 5–10s) — its tail capacity
		// (min-duration floor aside) drops to zero once protected.
		fake.editor.timeline.addVoiceoverSlot({ startTime: 5, duration: 5 });
		const d = createDirectorApi(fake.editor);

		// Excess needed (10 - 3 = 7s) exceeds c1's own tail capacity alone
		// (4.5s, at the 0.5s floor) once c2 is protected — a real shortfall.
		const protectedResult = d.tightenToLength({
			targetSec: 3,
			protectSpeech: true,
		});
		expect(protectedResult.ok).toBe(true);
		expect(protectedResult.data?.shortfallSec).toBeGreaterThan(0);
		expect(protectedResult.message).toContain("short of");
		// c2 must be untouched — protection held.
		expect(findByName(fake, c2).duration).toBeCloseTo(5, 5);
	});

	it("protectSpeech: false reaches the same target by trimming into the (unprotected) speech-covered clip", () => {
		const fake = makeCraftFakeEditor();
		patchEditorSingleton(fake.editor);
		const { c2 } = twoClips(fake);
		fake.editor.timeline.addVoiceoverSlot({ startTime: 5, duration: 5 });
		const d = createDirectorApi(fake.editor);

		const result = d.tightenToLength({ targetSec: 3, protectSpeech: false });

		expect(result.ok).toBe(true);
		expect(result.data?.shortfallSec).toBeUndefined();
		expect(result.data?.projectedDurationSec).toBeCloseTo(3, 5);
		// c2 WAS touched this time, unlike the protected case above.
		expect(findByName(fake, c2).duration).toBeLessThan(5);
	});
});

// ── duckMusicUnderSpeech ─────────────────────────────────────────────────────

describe("duckMusicUnderSpeech", () => {
	it("no speech on the timeline — coaching failure", () => {
		const fake = makeCraftFakeEditor();
		const d = createDirectorApi(fake.editor);
		fake.editor.timeline.insertElement({
			element: {
				type: "audio",
				sourceType: "upload",
				mediaId: "media_song",
				name: "Background Music",
				volume: 1,
				startTime: 0,
				duration: 10,
				...audioBase,
			},
			placement: { mode: "auto", trackType: "audio" },
		});

		const result = d.duckMusicUnderSpeech({});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("speech");
	});

	it("no music bed on the timeline — coaching failure", () => {
		const fake = makeCraftFakeEditor();
		const d = createDirectorApi(fake.editor);
		fake.editor.timeline.addVoiceoverSlot({ startTime: 2, duration: 3 });

		const result = d.duckMusicUnderSpeech({});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("music bed");
	});

	it("ducks the music bed under a voiceover span as ONE undo entry", () => {
		const fake = makeCraftFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);

		// Speech: voiceover-shaped audio element, timeline 2s–5s — no transcript
		// needed (mirrors `use-auto-duck.ts`'s default span mode).
		fake.editor.timeline.addVoiceoverSlot({ startTime: 2, duration: 3 });
		// Music bed: a plain (non-voiceover-named) audio element spanning the
		// whole timeline.
		const musicId = fake.editor.timeline.insertElement({
			element: {
				type: "audio",
				sourceType: "upload",
				mediaId: "media_song",
				name: "Background Music",
				volume: 1,
				startTime: 0,
				duration: 10,
				...audioBase,
			},
			placement: { mode: "auto", trackType: "audio" },
		});

		const historyBefore = fake.editor.command.getHistoryLength();
		const result = d.duckMusicUnderSpeech({});

		expect(result.ok).toBe(true);
		expect(result.data?.elementsAffected).toBe(1);
		expect(fake.editor.command.getHistoryLength()).toBe(historyBefore + 1);

		const music = findByName(fake, musicId);
		const channel = music.animations?.channels.volume;
		expect(channel).toBeDefined();
		expect(channel?.keyframes.length).toBeGreaterThan(0);
		// Ducked somewhere in the middle of the keyframe set.
		const values = channel?.keyframes.map((k) => k.value) ?? [];
		expect(Math.min(...values)).toBeLessThan(1);

		const undoResult = d.undo();
		expect(undoResult.ok).toBe(true);
		expect(
			findByName(fake, musicId).animations?.channels.volume,
		).toBeUndefined();
	});

	it("does not duck a voiceover element under itself (voiceover is excluded from music targets)", () => {
		const fake = makeCraftFakeEditor();
		const d = createDirectorApi(fake.editor);
		fake.editor.timeline.addVoiceoverSlot({ startTime: 2, duration: 3 });

		// No non-voiceover audio element exists — nothing counts as "music".
		const result = d.duckMusicUnderSpeech({});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("music bed");
	});
});
