/**
 * `runProgram`'s contract: the two modes, the primitive surface's argument
 * validation, the derived-data accessors, undo batching, and the
 * guarded-return discipline (a program failure is a RESULT, never a throw).
 *
 * Driven against a hand-rolled {@link ProgramPrimitiveApi} rather than the
 * real `DirectorApi`, so these stay fast and isolated — the real-api path is
 * covered end to end in `cut-on-beat.program.test.ts`, which is where a
 * wiring mismatch would actually show up.
 */

import { describe, expect, it } from "bun:test";
import type { BeatGrid } from "@/stores/beat-grid-store";
import type { TimelineTrack } from "@/types/timeline";
import type { AssetTranscript } from "@/lib/search/asset-transcript";
import type { TranscriptionResult } from "@/types/ai";
import {
	DEFAULT_UNDO_NAME,
	describeProgramSurface,
	runProgram,
	type ProgramUndoScope,
} from "./executor";
import type { PrimitiveResult, ProgramPrimitiveApi } from "./primitives";

/** Records every verb call and lets one be forced to fail. */
function makeRecordingApi(failOn?: {
	verb: string;
	message: string;
}): ProgramPrimitiveApi & { calls: Array<{ verb: string; input: unknown }> } {
	const calls: Array<{ verb: string; input: unknown }> = [];
	const verb =
		(name: string, data?: unknown) =>
		(input: unknown): PrimitiveResult => {
			calls.push({ verb: name, input });
			if (failOn?.verb === name) {
				return { ok: false, message: failOn.message };
			}
			return { ok: true, message: `${name} ok`, data };
		};
	return {
		calls,
		trim: verb("trim"),
		move: verb("move"),
		split: verb("split", { newSlotIds: ["real_split_id"] }),
		reorder: verb("reorder"),
		remove: verb("remove"),
		addClip: verb("addClip", { elementId: "real_clip_id" }),
		addText: verb("addText", { elementId: "real_text_id" }),
		applyTransition: verb("applyTransition"),
		applyEffect: verb("applyEffect", { effectId: "real_effect_id" }),
		animateItem: verb("animateItem"),
	} as unknown as ProgramPrimitiveApi & {
		calls: Array<{ verb: string; input: unknown }>;
	};
}

/** A `CommandManager`-shaped spy — the executor's undo scope is typed to accept the real one verbatim. */
function makeUndoSpy(): ProgramUndoScope & { events: string[] } {
	const events: string[] = [];
	return {
		events,
		beginTransaction(meta) {
			events.push(`begin:${meta?.origin}:${meta?.name}`);
		},
		commitTransaction() {
			events.push("commit");
		},
		rollbackTransaction() {
			events.push("rollback");
		},
	};
}

// ── fixture timeline ─────────────────────────────────────────────────────────

const TRACKS = [
	{
		id: "t_video",
		type: "video",
		elements: [
			{
				id: "v1",
				type: "video",
				name: "one",
				mediaId: "m1",
				startTime: 0,
				duration: 4,
				trimStart: 0,
				trimEnd: 0,
				generation: { prompt: "a shot" },
			},
			{
				id: "v2",
				type: "video",
				name: "two",
				mediaId: "m2",
				startTime: 4,
				duration: 4,
				trimStart: 0.5,
				trimEnd: 0,
			},
			// A gap before this one — `scenes()` must report two scenes.
			{
				id: "v3",
				type: "video",
				name: "three",
				mediaId: "m3",
				startTime: 10,
				duration: 2,
				trimStart: 0,
				trimEnd: 0,
			},
		],
	},
	{
		id: "t_audio",
		type: "audio",
		elements: [
			{
				id: "song",
				type: "audio",
				name: "song",
				mediaId: "m_song",
				startTime: 0,
				duration: 30,
				trimStart: 0,
				trimEnd: 0,
			},
		],
	},
] as unknown as TimelineTrack[];

const GRID: BeatGrid = {
	elementId: "song",
	trackId: "t_audio",
	mediaId: "m_song",
	beats: [1, 2, 3],
	downbeats: [2],
	bpm: 120,
	energyClass: "energetic",
	analyzedAt: 0,
};

const TRANSCRIPT: AssetTranscript = {
	mediaId: "m2",
	segments: [
		{ start: 0.5, end: 1.5, text: "hello there" },
		{ start: 2, end: 2.5, text: "   " },
	],
	language: "en",
	durationSec: 10,
	engine: "test",
	createdAt: 0,
};

const WORDS: TranscriptionResult = {
	language: "en",
	duration: 10,
	segments: [
		{
			id: 0,
			text: "hello there",
			start: 0.5,
			end: 1.5,
			words: [
				{ word: "hello", start: 0.5, end: 0.9, confidence: 0.99 },
				{ word: "there", start: 1.0, end: 1.5, confidence: 0.97 },
			],
		},
	],
};

const DATA = {
	tracks: () => TRACKS,
	beatGrid: () => GRID,
	transcripts: (id: string) => (id === "m2" ? TRANSCRIPT : undefined),
	words: (id: string) => (id === "m2" ? WORDS : undefined),
};

// ── modes ────────────────────────────────────────────────────────────────────

describe("runProgram — modes", () => {
	it("defaults to dry-run and applies nothing", () => {
		const api = makeRecordingApi();
		const result = runProgram({
			source: 'trim({ slotId: "v1", duration: 3 })',
			api,
			data: DATA,
		});
		expect(result.mode).toBe("dry-run");
		expect(result.ok).toBe(true);
		expect(result.ops).toEqual([
			{ index: 0, verb: "trim", args: { slotId: "v1", duration: 3 } },
		]);
		expect(api.calls.length).toBe(0);
		expect(result.message).toContain("nothing applied");
	});

	it("applies in apply mode and records each verb's own result", () => {
		const api = makeRecordingApi();
		const result = runProgram({
			source: 'trim({ slotId: "v1", duration: 3 })\nremove({ slotId: "v2" })',
			mode: "apply",
			api,
			data: DATA,
		});
		expect(result.ok).toBe(true);
		expect(api.calls.map((c) => c.verb)).toEqual(["trim", "remove"]);
		expect(result.ops[0].result).toEqual({ ok: true, message: "trim ok" });
	});

	it("refuses apply mode with no api, before anything runs", () => {
		const result = runProgram({
			source: 'trim({ slotId: "v1" })',
			mode: "apply",
		});
		expect(result.ok).toBe(false);
		expect(result.failure?.kind).toBe("host");
		expect(result.ops).toEqual([]);
	});

	it("returns placeholder ids in dry-run and real ones when applied", () => {
		const dry = runProgram({
			source:
				'let r = split({ slotId: "v1", atTime: 2 })\nlog(r.newSlotIds[0])',
			data: DATA,
		});
		expect(dry.logs).toEqual(["dry-run:split:0"]);

		const applied = runProgram({
			source:
				'let r = split({ slotId: "v1", atTime: 2 })\nlog(r.newSlotIds[0])',
			mode: "apply",
			api: makeRecordingApi(),
			data: DATA,
		});
		expect(applied.logs).toEqual(["real_split_id"]);
	});

	it("stops at the first failed primitive and names it", () => {
		const api = makeRecordingApi({ verb: "remove", message: 'No slot "v9".' });
		const result = runProgram({
			source: `
trim({ slotId: "v1", duration: 3 })
remove({ slotId: "v9" })
trim({ slotId: "v2", duration: 1 })`,
			mode: "apply",
			api,
			data: DATA,
		});
		expect(result.ok).toBe(false);
		expect(result.failure?.kind).toBe("primitive");
		expect(result.failure?.verb).toBe("remove");
		expect(result.failure?.opIndex).toBe(1);
		// The third call never happened — all-or-nothing, not best-effort.
		expect(api.calls.length).toBe(2);
		expect(result.ops.length).toBe(2);
	});
});

// ── undo batching ────────────────────────────────────────────────────────────

describe("runProgram — undo batching", () => {
	it("wraps an applied run in one agent-tagged transaction", () => {
		const undo = makeUndoSpy();
		runProgram({
			source: 'trim({ slotId: "v1", duration: 3 })\ntrim({ slotId: "v2" })',
			mode: "apply",
			api: makeRecordingApi(),
			undo,
			data: DATA,
		});
		expect(undo.events).toEqual([`begin:agent:${DEFAULT_UNDO_NAME}`, "commit"]);
	});

	it("rolls the transaction back when the run fails", () => {
		const undo = makeUndoSpy();
		runProgram({
			source: 'trim({ slotId: "v1" })\nlog(nope)',
			mode: "apply",
			api: makeRecordingApi(),
			undo,
			data: DATA,
		});
		expect(undo.events).toEqual([
			`begin:agent:${DEFAULT_UNDO_NAME}`,
			"rollback",
		]);
	});

	it("never opens a transaction for a dry run or an unparseable program", () => {
		const dryUndo = makeUndoSpy();
		runProgram({
			source: 'trim({ slotId: "v1" })',
			undo: dryUndo,
			data: DATA,
		});
		expect(dryUndo.events).toEqual([]);

		const badUndo = makeUndoSpy();
		const result = runProgram({
			source: "let = = =",
			mode: "apply",
			api: makeRecordingApi(),
			undo: badUndo,
		});
		expect(result.failure?.kind).toBe("parse");
		expect(badUndo.events).toEqual([]);
	});

	it("honours a caller-supplied undo label", () => {
		const undo = makeUndoSpy();
		runProgram({
			source: 'trim({ slotId: "v1" })',
			mode: "apply",
			api: makeRecordingApi(),
			undo,
			undoName: "beat cut",
			data: DATA,
		});
		expect(undo.events[0]).toBe("begin:agent:beat cut");
	});
});

// ── primitive argument validation ────────────────────────────────────────────

describe("primitives — argument validation", () => {
	const cases: Array<[string, string, string]> = [
		[
			"missing required field",
			"trim({ duration: 1 })",
			'trim() requires "slotId"',
		],
		[
			"unknown field",
			'trim({ slotId: "v1", nope: 1 })',
			'trim() has no argument "nope"',
		],
		[
			"wrong type",
			'trim({ slotId: "v1", duration: "4s" })',
			"must be a number, got string",
		],
		["non-object argument", 'trim("v1")', "takes a single object argument"],
		["no argument at all", "trim()", "needs one object argument"],
		[
			"too many arguments",
			'trim({ slotId: "v1" }, 2)',
			"takes exactly one object argument",
		],
	];

	for (const [name, source, expected] of cases) {
		it(`rejects ${name}`, () => {
			const result = runProgram({ source, data: DATA });
			expect(result.ok).toBe(false);
			expect(result.failure?.kind).toBe("runtime");
			expect(result.failure?.message).toContain(expected);
		});
	}

	it("rejects a non-finite number before it reaches the timeline", () => {
		// `1/0` is refused at the operator, so the only route to Infinity is a
		// host value; NaN is reachable through `0 * undefined`-shaped paths in
		// other languages but not this one — the guard is belt-and-braces and
		// this asserts it is wired, using a literal the parser will accept.
		const result = runProgram({
			source: 'trim({ slotId: "v1", duration: 1e308 * 10 })',
			data: DATA,
		});
		expect(result.ok).toBe(false);
		expect(result.failure?.message).toContain("infinite");
	});

	it("treats an undefined field as omitted, not as an error", () => {
		const result = runProgram({
			source: 'let o = {}\ntrim({ slotId: "v1", duration: o.missing })',
			data: DATA,
		});
		expect(result.ok).toBe(true);
		expect(result.ops[0].args).toEqual({ slotId: "v1" });
	});

	it("caps the number of operations, naming the cap", () => {
		const result = runProgram({
			source: 'for (x of [1,2,3,4,5]) { trim({ slotId: "v1", duration: x }) }',
			limits: { maxOperations: 3 },
			data: DATA,
		});
		expect(result.failure?.cap).toBe("operations");
		expect(result.failure?.limit).toBe(3);
		// The op that tripped the cap is still logged — "what was it doing".
		expect(result.ops.length).toBe(4);
	});
});

// ── derived data ─────────────────────────────────────────────────────────────

describe("derived data — accessors", () => {
	it("clips() reports geometry, trims, slot-ness and track scope", () => {
		const result = runProgram({
			source: `
let all = clips()
let video = clips({ trackId: "t_video" })
log(len(all), len(video))
log(video[0].id, video[0].startSec, video[0].endSec, video[0].isSlot)
log(video[1].trimStart, video[1].isSlot)`,
			data: DATA,
		});
		expect(result.ok).toBe(true);
		expect(result.logs).toEqual(["4 3", "v1 0 4 true", "0.5 false"]);
	});

	it("tracks() lists the timeline's tracks", () => {
		const result = runProgram({
			source: "for (t of tracks()) { log(t.id, t.kind, t.elementCount) }",
			data: DATA,
		});
		expect(result.logs).toEqual(["t_video video 3", "t_audio audio 1"]);
	});

	it("beats() projects the grid onto timeline time with downbeat flags", () => {
		const result = runProgram({
			source: "for (b of beats()) { log(b.time, b.isDownbeat) }",
			data: DATA,
		});
		expect(result.logs).toEqual(["1 false", "2 true", "3 false"]);
	});

	it("scenes() breaks on a gap, not on every clip boundary", () => {
		const result = runProgram({
			source: `for (s of scenes({ trackId: "t_video" })) {
  log(s.index, s.startSec, s.endSec, len(s.clipIds))
}`,
			data: DATA,
		});
		expect(result.logs).toEqual(["0 0 8 2", "1 10 12 1"]);
	});

	it("speech() projects transcript segments through the clip's trim onto the timeline", () => {
		// v2 sits at 4s with trimStart 0.5, so an asset-relative 0.5–1.5 lands
		// at 4.0–5.0 on the timeline. The whitespace-only segment is dropped.
		const result = runProgram({
			source: "for (s of speech()) { log(s.startSec, s.endSec, s.text) }",
			data: DATA,
		});
		expect(result.logs).toEqual(["4 5 hello there"]);
	});

	it("words() returns ASSET-RELATIVE word timings", () => {
		const result = runProgram({
			source: 'for (w of words({ mediaId: "m2" })) { log(w.word, w.startSec) }',
			data: DATA,
		});
		expect(result.logs).toEqual(["hello 0.5", "there 1"]);
	});

	it("loudness() reuses mix-read's curve over caller-supplied PCM", () => {
		const sampleRate = 100;
		const samples = new Float32Array(sampleRate);
		samples.fill(0.5);
		const result = runProgram({
			source:
				'let curve = loudness({ mediaId: "m1", intervalSec: 0.5 })\nlog(len(curve), curve[0].atSec, round(curve[0].levelDb))',
			data: { ...DATA, pcm: () => ({ samples, sampleRate }) },
		});
		expect(result.ok).toBe(true);
		// Two 0.5s windows; 0.5 amplitude is about -6 dBFS.
		expect(result.logs).toEqual(["2 0.25 -6"]);
	});

	it("names the MISSING SOURCE rather than pretending the answer is empty", () => {
		for (const [accessor, source] of [
			["clips", "log(len(clips()))"],
			["beats", "log(len(beats()))"],
			["speech", "log(len(speech()))"],
			["words", 'log(len(words({ mediaId: "m2" })))'],
			["loudness", 'log(len(loudness({ mediaId: "m1" })))'],
		]) {
			const result = runProgram({ source, data: {} });
			expect(`${accessor}:${result.ok}`).toBe(`${accessor}:false`);
			expect(result.failure?.message).toContain(`${accessor}() is unavailable`);
		}
	});

	it("distinguishes 'no grid analyzed' from 'no beats in view'", () => {
		const result = runProgram({
			source: "log(len(beats()))",
			data: { tracks: () => TRACKS, beatGrid: () => null },
		});
		expect(result.ok).toBe(false);
		expect(result.failure?.message).toContain("no analyzed beat grid");
	});

	it("refuses an unknown trackId with the live ids inlined", () => {
		const result = runProgram({
			source: 'log(len(clips({ trackId: "nope" })))',
			data: DATA,
		});
		expect(result.failure?.message).toContain("t_video");
	});

	it("hands the program a CLONE, so a mutation cannot corrupt the timeline", () => {
		const result = runProgram({
			source: `
let cs = clips({ trackId: "t_video" })
cs[0].startSec = 999
log(clips({ trackId: "t_video" })[0].startSec)`,
			data: DATA,
		});
		expect(result.logs).toEqual(["0"]);
		expect(TRACKS[0].elements[0].startTime).toBe(0);
	});
});

describe("describeProgramSurface", () => {
	it("enumerates exactly what a program in this context could call", () => {
		const surface = describeProgramSurface(DATA);
		expect(surface.primitives).toContain("trim");
		expect(surface.primitives.length).toBe(10);
		// `loudness` is absent: DATA wires no PCM source, so a program in this
		// context could not actually call it.
		expect(surface.data).toEqual([
			"beats",
			"clips",
			"scenes",
			"speech",
			"tracks",
			"words",
		]);
		expect(describeProgramSurface().data).toEqual([]);
		expect(surface.helpers).toContain("roundSec");
		expect(surface.constants).toEqual(["EPSILON"]);
	});
});
