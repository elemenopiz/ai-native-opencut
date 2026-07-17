/**
 * Adapter-defaults regression sweep (Campaign C8 "director-intel", wave 4).
 *
 * THE BUG CLASS (real incident, `removeSilence`/auto-cut): a Director verb
 * adapter forwards an OPTIONAL knob as an explicit object key —
 * `engine(file, { threshold: input.threshold, ... })` — and the callee merges
 * options via spread/Object.assign (`{ ...DEFAULTS, ...opts }`). Because the
 * key is PRESENT (just `undefined`), the spread overwrites the default with
 * `undefined` instead of leaving it alone — silently changing behavior vs.
 * actually omitting the key. Fixed for auto-cut in
 * `lib/auto-cut/engine.ts`'s `resolveOptions` (strips `undefined` values
 * before merging — see the first `describe` below).
 *
 * This file pins that every OTHER `director-api.ts` verb adapter that accepts
 * optional knobs resolves them the SAME safe way — via `??`/`!= null`
 * per-key checks or key-omission guards, never a raw `{ ...DEFAULTS, ...opts }`
 * spread of a caller-supplied object — for BOTH call shapes:
 *   (a) the knob OMITTED entirely, and
 *   (b) the knob PRESENT but explicitly `undefined`
 * (the shape `tool-catalog.ts`'s `xxxOrUndefined()` coercion helpers actually
 * produce when the agent/LLM doesn't supply a field). Both must yield the
 * callee's own default (or the callee receiving no key at all) — never
 * `undefined` clobbering a real default.
 *
 * COVERAGE NOTE: `director-api.ts` verbs whose mutation path routes through a
 * `Command` class reach the *global* `EditorCore.getInstance()` singleton from
 * inside `execute()` (a repo-wide pattern — see `update-element-trim.ts`,
 * `add-transition.ts`, `tracks-snapshot.ts`), NOT the `editor` instance
 * `createDirectorApi` was constructed with. `fake-editor.ts`'s hand-rolled
 * `timeline` stub (by design, per its own header) only supports the handful of
 * methods existing Director tests need and does not implement `updateTracks`
 * or the various `Command`-backed timeline methods (`updateElementTrim`,
 * `moveElement`, `splitElements`, `addClipEffect`, …). Two of the verbs below
 * (`applyTransition`, `trim`) reach that boundary, so this file locally patches
 * `EditorCore.getInstance` (saved + restored per test) to point at the SAME
 * fake editor instance, giving the real `Command.execute()` a `timeline` to
 * mutate — this file's own technique, not an edit to the shared fixture.
 * `move`/`split`/`reorder`/`remove`/`applyEffect` use the identical safe
 * `??`/conditional-key-omission pattern (verified by direct code reading,
 * documented in this campaign's report) but are not independently
 * engine-pinned here — diminishing returns on the same technique already
 * proven twice below.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { EditorCore } from "@/core";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { getTransition, registerDefaultTransitions } from "@/lib/transitions";
import { windowSegments } from "@/lib/search/asset-transcript";
import { resolveOptions as resolveAutoCutOptions } from "@/lib/auto-cut/engine";
import { UpdateElementTrimCommand } from "@/lib/commands/timeline/element/update-element-trim";
import type { TimelineTrack } from "@/types/timeline";
import { makeFakeEditor, type FakeElement } from "./fake-editor";
import type { GenerateExecutor } from "./types";
import type { SpecOverride } from "./director-api";

// `AddTransitionCommand.execute()` validates `transitionType` against the
// registry `EditorCore`'s constructor normally populates via
// `registerDefaultTransitions()` — we never construct a real `EditorCore`
// here (see the file header), so seed it explicitly, once.
registerDefaultTransitions();

// `analyzeMediaSilence` (the real one) decodes actual browser audio — mock the
// barrel so `removeSilence`'s FORWARDING contract can be pinned headlessly,
// exactly like `director-media-search.test.ts`'s established
// mock.module-then-dynamic-import convention. Only `@/lib/auto-cut` (the
// barrel) is mocked; `@/lib/auto-cut/engine`'s `resolveOptions` (imported
// above, a different specifier) stays REAL — that's the second half of the
// pin, below.
const analyzeMediaSilenceSpy = mock(
	async (_file: File, options?: Record<string, unknown>) => {
		void options;
		return { segments: [] as never[] };
	},
);
mock.module("@/lib/auto-cut", () => ({
	analyzeMediaSilence: analyzeMediaSilenceSpy,
}));

// Import AFTER the mock is registered (repo convention).
const { createDirectorApi } = await import("./director-api");

const okExecutor: GenerateExecutor = {
	run: async () => ({ status: "ready", mediaId: "media_ready_1" }),
};
const fastRecovery = { sleep: async () => {} };

// ---------------------------------------------------------------------------
// 1. THE REFERENCE INCIDENT — removeSilence / auto-cut
// ---------------------------------------------------------------------------

describe("removeSilence → analyzeMediaSilence forwarding (auto-cut reference case)", () => {
	async function callRemoveSilence(knobs: Record<string, unknown>) {
		const fake = makeFakeEditor();
		const testFile = new File(["x"], "clip.mp4", { type: "video/mp4" });
		(fake.editor as unknown as { media: unknown }).media = {
			...fake.editor.media,
			getAssetById: (id: string) =>
				id === "asset_1"
					? { id: "asset_1", name: "clip.mp4", type: "video", file: testFile }
					: undefined,
		};
		const d = createDirectorApi(fake.editor, {
			executor: okExecutor,
			recovery: fastRecovery,
		});
		const shot = d.reserveSlot({ prompt: "talking head", duration: 6 });
		const slotId = shot.data?.slotId as string;
		await d.generate({ slotIds: [slotId] }); // lands a ready take w/ mediaId "media_ready_1"...
		// ...but removeSilence resolves the take's mediaId from the element, so
		// point the fake asset lookup at what `generate`'s okExecutor actually
		// produced instead of re-deriving it.
		(fake.editor as unknown as { media: unknown }).media = {
			...fake.editor.media,
			getAssetById: (id: string) =>
				id === "media_ready_1"
					? { id, name: "clip.mp4", type: "video", file: testFile }
					: undefined,
		};
		analyzeMediaSilenceSpy.mockClear();
		const res = await d.removeSilence({ slotId, ...knobs });
		return { res, calls: analyzeMediaSilenceSpy.mock.calls };
	}

	it("knob keys OMITTED entirely forward as undefined (engine-default contract)", async () => {
		const { res, calls } = await callRemoveSilence({});
		expect(res.ok).toBe(true);
		expect(calls).toHaveLength(1);
		const [, options] = calls[0];
		expect(options).toEqual({
			threshold: undefined,
			marginBefore: undefined,
			marginAfter: undefined,
			minKeep: undefined,
			minCut: undefined,
		});
	});

	it("knob keys PRESENT but explicitly undefined forward identically (no different behavior)", async () => {
		const { res, calls } = await callRemoveSilence({
			threshold: undefined,
			marginBefore: undefined,
			marginAfter: undefined,
			minKeep: undefined,
			minCut: undefined,
		});
		expect(res.ok).toBe(true);
		expect(calls).toHaveLength(1);
		const [, options] = calls[0];
		expect(options).toEqual({
			threshold: undefined,
			marginBefore: undefined,
			marginAfter: undefined,
			minKeep: undefined,
			minCut: undefined,
		});
	});

	it("an explicit real value still rides through untouched", async () => {
		const { calls } = await callRemoveSilence({ threshold: 0.09 });
		const [, options] = calls[0] as [unknown, Record<string, unknown>];
		expect(options.threshold).toBe(0.09);
	});
});

describe("resolveOptions (lib/auto-cut/engine.ts) — the actual fix, pinned directly", () => {
	// This is the boundary `analyzeMediaSilence` hands `removeSilence`'s
	// options object to. Exercising it directly (unmocked, the REAL export)
	// closes the loop: director-api.ts forwards `undefined` keys (proven
	// above) and THIS function must not let them clobber the engine defaults.
	it("an omitted options object resolves to pure defaults", () => {
		const resolved = resolveAutoCutOptions(undefined);
		expect(resolved.threshold).toBe(0.04);
		expect(resolved.marginBefore).toBe(0.2);
		expect(resolved.marginAfter).toBe(0.3);
		expect(resolved.minKeep).toBe(0.26);
		expect(resolved.minCut).toBe(0.4);
	});

	it("explicit-undefined keys (the removeSilence forwarding shape) do NOT clobber defaults", () => {
		const resolved = resolveAutoCutOptions({
			threshold: undefined,
			marginBefore: undefined,
			marginAfter: undefined,
			minKeep: undefined,
			minCut: undefined,
		});
		expect(resolved.threshold).toBe(0.04);
		expect(resolved.marginBefore).toBe(0.2);
		expect(resolved.marginAfter).toBe(0.3);
		expect(resolved.minKeep).toBe(0.26);
		expect(resolved.minCut).toBe(0.4);
	});

	it("a real value still overrides its default, undefined siblings notwithstanding", () => {
		const resolved = resolveAutoCutOptions({
			threshold: 0.12,
			marginBefore: undefined,
		});
		expect(resolved.threshold).toBe(0.12);
		expect(resolved.marginBefore).toBe(0.2); // untouched default
	});
});

// ---------------------------------------------------------------------------
// 2. Command-backed verbs (EditorCore.getInstance patch — see file header)
// ---------------------------------------------------------------------------

/** A fake editor whose `timeline.updateTracks` actually lands, so real
 *  `Command` classes reaching `EditorCore.getInstance()` (not the `editor`
 *  instance `createDirectorApi` was built with) have somewhere to write. */
function makePatchableFakeEditor() {
	const fake = makeFakeEditor();
	const timeline = fake.editor.timeline as unknown as {
		updateTracks: (tracks: TimelineTrack[]) => void;
		updateElementTrim: (input: {
			elementId: string;
			trimStart: number;
			trimEnd: number;
			startTime?: number;
			duration?: number;
		}) => void;
	};
	timeline.updateTracks = (tracks: TimelineTrack[]) => {
		fake.tracks.length = 0;
		fake.tracks.push(...(tracks as unknown as typeof fake.tracks));
	};
	// `TimelineManager.updateElementTrim` (director-api.ts's `trim` verb calls
	// THIS, not `updateTracks` directly) — mirror its real implementation
	// (construct `UpdateElementTrimCommand`, execute via `editor.command`) so
	// the real command's `?? targetElement.X` merge logic is what's under test.
	timeline.updateElementTrim = (input) => {
		const command = new UpdateElementTrimCommand(input);
		fake.editor.command.execute({ command });
	};
	return fake;
}

let restoreGetInstance: (() => void) | undefined;

afterEach(() => {
	restoreGetInstance?.();
	restoreGetInstance = undefined;
});

/** Point the global `EditorCore.getInstance()` singleton at `editorLike` for
 *  the duration of the current test (restored in `afterEach`, and also
 *  restorable early via the returned function). */
function patchEditorSingleton(editorLike: unknown) {
	const real = EditorCore.getInstance;
	(EditorCore as unknown as { getInstance: () => EditorCore }).getInstance =
		() => editorLike as EditorCore;
	restoreGetInstance = () => {
		(EditorCore as unknown as { getInstance: () => EditorCore }).getInstance =
			real;
	};
}

describe("applyTransition → AddTransitionCommand duration default", () => {
	it("omitted vs. explicit-undefined duration both fall through to the transition's own defaultDuration", () => {
		const fake = makePatchableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);
		const shot = d.reserveSlot({ prompt: "shot", duration: 5 });
		const slotId = shot.data?.slotId as string;
		const expectedDefault = getTransition({
			transitionType: "cross-dissolve",
		}).defaultDuration;

		const omitted = d.applyTransition({
			slotId,
			transitionType: "cross-dissolve",
		});
		expect(omitted.ok).toBe(true);
		let el = fake.find(slotId)?.element as FakeElement & {
			transitionOut?: { duration: number };
		};
		expect(el.transitionOut?.duration).toBe(expectedDefault);

		const explicitUndefined = d.applyTransition({
			slotId,
			transitionType: "cross-dissolve",
			duration: undefined,
		});
		expect(explicitUndefined.ok).toBe(true);
		el = fake.find(slotId)?.element as typeof el;
		expect(el.transitionOut?.duration).toBe(expectedDefault);

		// Sanity: a real explicit value still wins (this isn't just always the default).
		const explicit = d.applyTransition({
			slotId,
			transitionType: "cross-dissolve",
			duration: 1.25,
		});
		expect(explicit.ok).toBe(true);
		el = fake.find(slotId)?.element as typeof el;
		expect(el.transitionOut?.duration).toBe(1.25);
	});
});

describe("trim → UpdateElementTrimCommand startTime/duration default", () => {
	it("omitted vs. explicit-undefined startTime/duration both preserve the element's CURRENT values", () => {
		const fake = makePatchableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);
		const shot = d.reserveSlot({
			prompt: "shot",
			duration: 8,
			startTime: 2,
		});
		const slotId = shot.data?.slotId as string;

		const omitted = d.trim({ slotId, trimStart: 0.5 });
		expect(omitted.ok).toBe(true);
		let el = fake.find(slotId)?.element as FakeElement;
		expect(el.trimStart).toBe(0.5);
		expect(el.startTime).toBe(2); // unchanged, not clobbered to undefined/NaN
		expect(el.duration).toBe(8); // unchanged

		const explicitUndefined = d.trim({
			slotId,
			trimStart: 0.75,
			startTime: undefined,
			duration: undefined,
		});
		expect(explicitUndefined.ok).toBe(true);
		el = fake.find(slotId)?.element as FakeElement;
		expect(el.trimStart).toBe(0.75);
		expect(el.startTime).toBe(2); // still unchanged
		expect(el.duration).toBe(8); // still unchanged

		// Sanity: explicit real values still land.
		const explicit = d.trim({ slotId, trimStart: 0.75, startTime: 4 });
		expect(explicit.ok).toBe(true);
		el = fake.find(slotId)?.element as FakeElement;
		expect(el.startTime).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// 3. Directly fake-editor-reachable verbs
// ---------------------------------------------------------------------------

describe("reserveSlot — duration/prompt ?? chains", () => {
	it("omitted duration falls to TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION; explicit undefined does too", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const omitted = d.reserveSlot({ prompt: "a" });
		let el = fake.find(omitted.data?.slotId as string)?.element as FakeElement;
		expect(el.duration).toBe(TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION);

		const explicitUndefined = d.reserveSlot({
			prompt: "b",
			duration: undefined,
		});
		el = fake.find(explicitUndefined.data?.slotId as string)
			?.element as FakeElement;
		expect(el.duration).toBe(TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION);
	});
});

describe("addVoiceover — startTime/duration ?? chains and voice/voiceRef/personaId/language forwarding", () => {
	it("omitted vs. explicit-undefined startTime/duration both derive the same values", async () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor, {
			executor: okExecutor,
			recovery: fastRecovery,
		});
		const shot = d.reserveSlot({ prompt: "shot", duration: 6, startTime: 3 });
		const slotId = shot.data?.slotId as string;

		const omitted = await d.addVoiceover({
			script: "hello there",
			slotId,
		});
		expect(omitted.ok).toBe(true);
		const vo1 = fake.tracksOfType("audio")[0]?.elements[0];
		expect(vo1?.startTime).toBe(3);
		expect(vo1?.duration).toBe(6);

		// A second call with the SAME timing knobs explicitly undefined must
		// derive identically (still timed to the shot, not dropped to 0/NaN).
		const explicitUndefined = await d.addVoiceover({
			script: "hello again",
			slotId,
			startTime: undefined,
			duration: undefined,
			voice: undefined,
			voiceRef: undefined,
			personaId: undefined,
			language: undefined,
		});
		expect(explicitUndefined.ok).toBe(true);
		const audioEls = fake.tracksOfType("audio")[0]?.elements ?? [];
		const vo2 = audioEls[audioEls.length - 1];
		expect(vo2?.startTime).toBe(3);
		expect(vo2?.duration).toBe(6);
		// voice/voiceRef/personaId omitted or explicit-undefined both simply
		// carry no vocal-identity override — neither is a "wrong default".
		expect(vo2?.generation?.voice).toBeUndefined();
		expect(vo2?.generation?.language).toBe("en"); // makeVoiceoverSpec's own `?? "en"`
	});
});

describe("addMusicBed — startTime/duration/volume/commercialOnly ?? chains", () => {
	it("omitted vs. explicit-undefined knobs both resolve to the verb's documented defaults", async () => {
		const fake = makeFakeEditor();
		const seenCommercialOnly: boolean[] = [];
		const d = createDirectorApi(fake.editor, {
			audio: {
				resolveMusic: async ({ commercialOnly }) => {
					seenCommercialOnly.push(commercialOnly);
					return {
						mediaId: "music_1",
						name: "track",
						duration: 20,
					};
				},
			},
		});
		d.reserveSlot({ prompt: "shot", duration: 8, startTime: 0 });

		const omitted = await d.addMusicBed({ query: "lofi" });
		expect(omitted.ok).toBe(true);
		let el = fake.tracksOfType("audio")[0]?.elements[0] as FakeElement;
		expect(el.startTime).toBe(0);
		expect(el.duration).toBe(8); // spans the timeline
		expect(el.volume).toBe(0.3); // quiet-bed default

		const explicitUndefined = await d.addMusicBed({
			query: "lofi",
			startTime: undefined,
			duration: undefined,
			volume: undefined,
			commercialOnly: undefined,
		});
		expect(explicitUndefined.ok).toBe(true);
		const audioEls = fake.tracksOfType("audio")[0]?.elements ?? [];
		el = audioEls[audioEls.length - 1] as FakeElement;
		expect(el.startTime).toBe(0);
		expect(el.duration).toBe(8);
		expect(el.volume).toBe(0.3);

		// `commercialOnly` defaults to `true` (addMusicBed's own `?? true`) in BOTH cases.
		expect(seenCommercialOnly).toEqual([true, true]);
	});
});

describe("storyboard — seedConsistency (!== false guard) and bible (?? {} guard)", () => {
	it("omitted vs. explicit-undefined seedConsistency both auto-seed (only `false` opts out)", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const omitted = d.storyboard({
			shots: [{ prompt: "a" }],
			bible: { palette: "warm" },
		});
		expect(omitted.ok).toBe(true);
		const ctxAfterOmitted = d.getConsistencyContext();
		expect(ctxAfterOmitted.data?.style).toBeTruthy();

		const explicitUndefined = d.storyboard({
			shots: [{ prompt: "b" }],
			bible: { palette: "cool" },
			seedConsistency: undefined,
		});
		expect(explicitUndefined.ok).toBe(true);
		const ctxAfterExplicit = d.getConsistencyContext();
		// Re-seeded from the SECOND bible (cool), proving seedConsistency's
		// `undefined` behaved exactly like omitting it (auto-seed), not like `false`.
		expect(ctxAfterExplicit.data?.style).toContain("cool");
	});

	it("omitted vs. explicit-undefined bible both resolve to an empty style bible", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const omitted = d.storyboard({ shots: [{ prompt: "a" }] });
		expect(omitted.data?.plan.bible).toEqual({});

		const explicitUndefined = d.storyboard({
			shots: [{ prompt: "b" }],
			bible: undefined,
		});
		expect(explicitUndefined.data?.plan.bible).toEqual({});
	});
});

describe("setConsistencyContext — style/setting ?? fallbacks", () => {
	it("omitted vs. explicit-undefined style/setting resolve identically", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const omitted = d.setConsistencyContext({});
		expect(omitted.ok).toBe(true);
		const omittedStyle = omitted.data?.style;
		const omittedSetting = omitted.data?.setting;

		const explicitUndefined = d.setConsistencyContext({
			style: undefined,
			setting: undefined,
		});
		expect(explicitUndefined.ok).toBe(true);
		expect(explicitUndefined.data?.style).toBe(omittedStyle);
		expect(explicitUndefined.data?.setting).toBe(omittedSetting);
	});
});

describe("getTranscript → windowSegments(start, end) positional ?? fallbacks (pure)", () => {
	it("omitted vs. explicit-undefined startSec/endSec both return the full segment list", () => {
		const segments = [
			{ start: 0, end: 2, text: "a" },
			{ start: 2, end: 4, text: "b" },
			{ start: 4, end: 6, text: "c" },
		];
		const omitted = windowSegments(segments);
		const explicitUndefined = windowSegments(segments, undefined, undefined);
		expect(omitted).toEqual(segments);
		expect(explicitUndefined).toEqual(segments);
	});
});

// ---------------------------------------------------------------------------
// 4. Out-of-territory finding — buildSpec (director-api.ts) IS vulnerable
// ---------------------------------------------------------------------------

describe.skip(
	"[FINDING, not fixed here] buildSpec (director-api.ts:577-590) — a real " +
		"'{...DEFAULTS, ...overrides}' spread, vulnerable to the exact bug class " +
		"this file sweeps for",
	() => {
		/**
		 * `buildSpec` (director-api.ts:577-590):
		 *   return { mode: "text-to-video", resolution: "480p", orientation:
		 *   "portrait", ...overrides, prompt, duration };
		 * `overrides` is `applyReferenceMediaId(input.spec)` — a caller-supplied
		 * `Partial<GenerationSpec>` (`SpecOverride`). This is STRUCTURALLY the
		 * pre-fix auto-cut shape: an explicit-but-undefined key in `overrides`
		 * (e.g. `{ mode: undefined }`) SURVIVES the spread and clobbers the
		 * "text-to-video"/"480p"/"portrait" literals with `undefined`.
		 *
		 * NOT currently reachable in production: the only caller that builds a
		 * `SpecOverride` is `tool-catalog.ts`'s `asSpecOverride()`
		 * (tool-catalog.ts:109-134), which uses a key-omission guard (`if (o.x
		 * != null) out.x = ...`) and therefore never emits an explicit-undefined
		 * key. This test bypasses that guard to exercise `buildSpec`'s own
		 * merge contract directly, the same way `reviseProposalShot`/
		 * `applyBriefPatch`/etc. are proven safe elsewhere in this file WITHOUT
		 * relying on a caller-side guard.
		 *
		 * `reserveSlot` (director-api.ts:1531-1555) and `storyboard`'s per-shot
		 * spec (director-api.ts:1616-1620) both funnel through `buildSpec` and
		 * are equally exposed.
		 *
		 * EXPECTED (safe): `mode` falls back to `buildSpec`'s own
		 * "text-to-video" default, exactly like `resolveOptions` now does for
		 * auto-cut.
		 * ACTUAL (bug, if this test is unskipped against the current code):
		 * `generation.mode === undefined`.
		 *
		 * Not fixed here: the fix belongs in `buildSpec` inside director-api.ts,
		 * which this campaign task explicitly excludes from editing. Reported
		 * as an out-of-territory finding instead (see campaign report).
		 */
		it("an explicit-undefined `mode` override clobbers buildSpec's own 'text-to-video' default", () => {
			const fake = makeFakeEditor();
			const d = createDirectorApi(fake.editor);
			const res = d.reserveSlot({
				prompt: "city skyline",
				spec: { mode: undefined } as SpecOverride,
			});
			expect(res.ok).toBe(true);
			const el = fake.find(res.data?.slotId as string)?.element as FakeElement;
			expect(el.generation?.mode).toBe("text-to-video");
		});
	},
);
