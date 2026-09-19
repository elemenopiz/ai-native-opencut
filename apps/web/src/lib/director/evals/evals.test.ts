/**
 * Director eval harness v0 — DETERMINISTIC tier (P8 of
 * `docs/plans/2026-07-19-director-northstar.md`).
 *
 * Wires `fixtures.ts` + `runner.ts` + `assertions.ts` into `bun test` so the
 * three scripted scenarios run in the normal battery, guarding loop
 * machinery, verb dispatch, and timeline invariants across prompt/brain
 * changes (prod runs Kimi k2.6, local dev often Gemini — this tier is brain-
 * agnostic: it drives the frontier loop with a scripted, mocked model, so it
 * catches loop/prompt/verb regressions independent of which brain answers in
 * production). See `evals/README.md` for how to add a scenario and the note
 * on the scored (real-model) tier that comes later.
 *
 * Mock hygiene: `runner.ts` reassigns `global.fetch` per run (the same seam
 * `agent-streaming.test.ts`/`agent-budget.test.ts`/`agent-gemini.test.ts`
 * use — see `runner.ts`'s header comment for why no better seam exists).
 * `mock.restore()` does NOT undo a plain property assignment, so — exactly
 * like those files — we capture the original `fetch` once and restore it by
 * hand in `afterEach`, every test, unconditionally.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { useBeatGridStore } from "@/stores/beat-grid-store";
import {
	activeToolNamesForPhase,
	deriveDirectorPhase,
	RECENT_TAKE_WINDOW_MS,
} from "../phase-scope";
import {
	brokenVerbScenario,
	clarifyScenario,
	scenarios,
	teaserScenario,
	tightenScenario,
} from "./fixtures";
import {
	DRAFT_CUT_SCENARIO_EXPECTED_DURATION_SEC,
	DRAFT_CUT_SCENARIO_EXPECTED_SUMMARY,
	draftCutScenario,
} from "./draft-cut-scenario";
import { challengeDemoScenario } from "./challenge-demo-scenario";
import {
	CUT_ON_BEAT_FIXTURE_HISTORY_LENGTH,
	cutOnBeatScenario,
} from "./craft-cut-on-beat-scenario";
import {
	TIGHTEN_SCENARIO_EXPECTED_CLIP_DURATION_SEC,
	TIGHTEN_SCENARIO_TARGET_SEC,
	tightenToLengthScenario,
} from "./craft-tighten-to-length-scenario";
import {
	EXPECTED_DUCK_KEYFRAMES,
	duckMusicScenario,
} from "./craft-duck-music-scenario";
import { multiStepUndoScenario } from "./storyboard-undo-scenario";
import { generationFailureScenario } from "./generation-failure-scenario";
import {
	APPLY_EDIT_FIXTURE_HISTORY_LENGTH,
	applyEditScenario,
} from "./apply-edit-scenario";
import { runScenario } from "./runner";
import {
	assertKnownVerbs,
	assertNoUnhandledErrors,
	assertScenario,
} from "./assertions";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	// The beat grid lives in a real, module-global zustand store
	// (`stores/beat-grid-store.ts`) — `cutOnBeatScenario` seeds one directly
	// (bypassing every Director verb, the same way `fixtures.ts`'s
	// `insertClip` bypasses verbs for hand-placed footage); reset it after
	// every test so a grid seeded here never leaks into another test file,
	// mirroring `director-craft.test.ts`'s own `afterEach`.
	useBeatGridStore.getState().reset();
});

// `draftCutScenario` and the newer scenarios below each live in their own
// file — combined here rather than folded into `fixtures.ts`'s own
// `scenarios` export to avoid a circular import (each scenario file imports
// `toolTurn`/`closeTurn`/etc FROM `fixtures.ts`; `fixtures.ts` would
// otherwise need to import the scenario objects back).
const allScenarios = [
	...scenarios,
	draftCutScenario,
	challengeDemoScenario,
	cutOnBeatScenario,
	tightenToLengthScenario,
	duckMusicScenario,
	multiStepUndoScenario,
	generationFailureScenario,
	applyEditScenario,
];

describe("Director eval harness — deterministic tier", () => {
	for (const scenario of allScenarios) {
		test(`${scenario.id}: ${scenario.description}`, async () => {
			const run = await runScenario(scenario);
			const violations = assertScenario(run, scenario.expect);

			if (violations.length > 0) {
				const detail = violations
					.map((v) => `  [${v.code}] ${v.message}`)
					.join("\n");
				throw new Error(
					`Scenario "${scenario.id}" failed ${violations.length} invariant(s):\n${detail}`,
				);
			}
		});
	}

	test("teaser scenario's steps are exactly storyboard → generate (no extra/missing calls)", async () => {
		const run = await runScenario(teaserScenario);
		expect(run.steps.map((s) => s.action)).toEqual(["storyboard", "generate"]);
		expect(run.steps.every((s) => s.ok)).toBe(true);
		expect(run.reelAfter.slots).toHaveLength(3);
		expect(run.reelAfter.slots.every((s) => s.takeCount > 0)).toBe(true);
	});

	test("tighten scenario's getTimeline call surfaces the uploaded clips getReel() alone would hide", async () => {
		const run = await runScenario(tightenScenario);
		// The one reel slot `setupMixedTimeline` reserved, captured BEFORE the
		// run mutated anything — the id the scripted `trim` call should have used.
		const slotId = run.reelBefore.slots[0]?.id as string;
		expect(slotId).toBeDefined();

		// The regression this locks in: getReel() sees only the generative slot;
		// getTimeline's OWN response (not just the final timeline snapshot) must
		// have reported the uploaded clips too, or the "fix" is a no-op.
		const getTimelineStep = run.events.find(
			(e) => e.type === "tool_finish" && e.step.action === "getTimeline",
		);
		expect(getTimelineStep).toBeDefined();

		const uploadedClipCount = run.timelineBefore?.tracks
			.flatMap((t) => t.elements)
			.filter((el) => !el.isGenerative).length;
		expect(uploadedClipCount).toBe(2);

		// Trim landed on the generative slot, not a hallucinated id.
		const trimStep = run.steps.find((s) => s.action === "trim");
		expect(trimStep?.ok).toBe(true);
		expect(trimStep?.args.slotId).toBe(slotId);
	});

	test("draftCut scenario: one undo entry, exact chat summary, gap marked, zero generation", async () => {
		const run = await runScenario(draftCutScenario);

		// draftCut is the only call this scenario scripts; it must succeed.
		expect(run.steps.map((s) => s.action)).toEqual(["draftCut"]);
		const draftCutStep = run.steps[0];
		expect(draftCutStep?.ok).toBe(true);

		// stage-6 chat summary — exact string, matching `story/run.ts`'s
		// `buildDraftCutSummary` for this fixture's inventory/treatment.
		expect(draftCutStep?.message).toBe(DRAFT_CUT_SCENARIO_EXPECTED_SUMMARY);
		expect(draftCutStep?.message).toContain("1 gap marked for cutaways.");

		// timeline invariants: two clips added (the gap section produced zero
		// ops), total duration lands exactly where the cursor math predicts.
		const elements = run.timelineAfter?.tracks.flatMap((t) => t.elements) ?? [];
		expect(elements.filter((el) => !el.isGenerative)).toHaveLength(2);
		expect(run.timelineAfter?.totalDurationSec).toBe(
			DRAFT_CUT_SCENARIO_EXPECTED_DURATION_SEC,
		);

		// ONE undo entry for the whole assembled cut, tagged agent/draftCut —
		// the fixture starts a fresh CommandManager (0 history), so this run's
		// single entry is exactly index 0.
		expect(run.fake.editor.command.getHistoryLength()).toBe(1);
		expect(run.fake.editor.command.peekUndoOrigin()).toBe("agent");
		expect(run.fake.editor.command.peekUndoName()).toBe("draftCut");

		// zero-generation invariant, independently re-checked here (not just
		// via assertScenario's expect.mustNotGenerate sweep above).
		expect(
			run.steps.some((s) => ["generate", "reroll", "remix"].includes(s.action)),
		).toBe(false);
	});

	test("challenge-demo scenario assembles a real multi-track cut (video + text + music) and exports", async () => {
		const run = await runScenario(challengeDemoScenario);

		// END STATE: three real tracks, not just "3 slots in the reel" — the
		// whole point of "assembles a real multi-track cut" (see the scenario's
		// own header) is that `getTimeline` shows video+text+audio, each with the
		// right element count.
		const tracks = run.timelineAfter?.tracks ?? [];
		const videoTrack = tracks.find((t) => t.kind === "video");
		const textTrack = tracks.find((t) => t.kind === "text");
		const audioTrack = tracks.find((t) => t.kind === "audio");
		expect(videoTrack?.elementCount).toBe(3);
		expect(textTrack?.elementCount).toBe(1);
		expect(audioTrack?.elementCount).toBe(1);

		// The export step's own result MESSAGE is the one place this scenario has
		// to assert on a call's outcome rather than persisted state — there's no
		// separate "exported files" store in `fake-editor.ts` for a render to
		// land in (and `AgentToolStep` — what the agent LOOP records — carries
		// only `ok`/`message`, not the verb's full `DirectorResult.data`), so the
		// render outcome is only ever observable via `export`'s own reported
		// text. This is a structural necessity (nothing else could observe it,
		// and the loop itself doesn't retain more than this), not a
		// route-preference assertion the future refactor would break.
		const exportStep = run.steps.find((s) => s.action === "export");
		expect(exportStep?.ok).toBe(true);
		expect(exportStep?.message).toMatch(/Exported/);
		expect(exportStep?.message).toMatch(/MP4/i);
		expect(exportStep?.message).toMatch(/15\.0s/);

		// PHASE-BOUNDARY GUARANTEE (item 3 of the task brief): the same phase
		// gates `docs/plans/2026-09-18-director-autonomy-architecture.md` §5
		// marks for removal ("Remove phase gating... safe only after [programs
		// land]") currently promise something concrete about THIS exact run's
		// trajectory. Folded into this scenario's own dedicated test (rather
		// than a 7th top-level scenario) because it needs checkpoints along ONE
		// run's real state, not a fresh script of its own — `phase-scope.ts`'s
		// own unit coverage (`phase-scope.test.ts`) already pins the pure
		// waterfall logic against synthetic stubs; this is the SAME logic
		// applied to a real DirectorApi a real scripted run produced, which is
		// what "what does the gate currently guarantee" (§6) actually means.
		const freshProject = challengeDemoScenario.setup();
		expect(deriveDirectorPhase(freshProject.director)).toBe("briefing");
		expect(activeToolNamesForPhase("briefing")).toContain("storyboard");
		expect(activeToolNamesForPhase("briefing")).not.toContain("export");

		const newestTakeAt = Math.max(
			0,
			...run.reelAfter.slots.flatMap((s) =>
				s.takes.map((t) => t.createdAt ?? 0),
			),
		);
		expect(newestTakeAt).toBeGreaterThan(0);

		// Immediately after generation, a freshly-rendered reel still counts as
		// "production" (it's still being judged) — export/trim are NOT yet on
		// the active menu even though every slot is technically "ready".
		expect(deriveDirectorPhase(run.director, newestTakeAt + 1)).toBe(
			"production",
		);
		expect(activeToolNamesForPhase("production")).not.toContain("export");
		expect(activeToolNamesForPhase("production")).not.toContain("trim");
		expect(activeToolNamesForPhase("production")).toContain("generate");

		// Well past the "just rendered" window, the same state reads as
		// "polish" — export/trim/cutOnBeat become reachable, storyboard/
		// proposeReel (re-deciding scope) do not.
		const wellAfter = newestTakeAt + RECENT_TAKE_WINDOW_MS + 1_000;
		expect(deriveDirectorPhase(run.director, wellAfter)).toBe("polish");
		const polishTools = activeToolNamesForPhase("polish");
		expect(polishTools).toContain("export");
		expect(polishTools).toContain("trim");
		expect(polishTools).toContain("cutOnBeat");
		expect(polishTools).not.toContain("storyboard");
		expect(polishTools).not.toContain("proposeReel");
	});

	test("cutOnBeat scenario snaps the join exactly onto the beat, as one undo entry", async () => {
		const run = await runScenario(cutOnBeatScenario);

		// RESULTING TIMELINE STATE — cut positions/durations, not the verb call.
		const clipOne = run.fake.find("el_clip_one")?.element;
		const clipTwo = run.fake.find("el_clip_two")?.element;
		expect(clipOne?.duration).toBeCloseTo(4.0, 5);
		expect(clipTwo?.startTime).toBeCloseTo(4.0, 5);
		expect(clipTwo?.trimStart).toBeCloseTo(0.1, 5);
		expect(clipTwo?.duration).toBeCloseTo(4.9, 5);

		// One undo entry for the whole snap (both touched elements merged into
		// one op each — see `cutOnBeat`'s own doc comment on `mergeArgs`).
		expect(run.fake.editor.command.getHistoryLength()).toBe(
			CUT_ON_BEAT_FIXTURE_HISTORY_LENGTH + 1,
		);
		expect(run.fake.editor.command.peekUndoOrigin()).toBe("agent");

		// And it genuinely undoes cleanly — the whole point of "one undo step".
		const undoResult = run.director.undo();
		expect(undoResult.ok).toBe(true);
		expect(run.fake.find("el_clip_one")?.element.duration).toBeCloseTo(3.9, 5);
		expect(run.fake.find("el_clip_two")?.element.startTime).toBeCloseTo(3.9, 5);
	});

	test("applyEdit scenario: dry-run changes nothing, apply lands both trims as one undo entry, widened targeting reaches plain footage", async () => {
		const run = await runScenario(applyEditScenario);

		// The one reel slot `setupApplyEditProject` reserved, captured BEFORE the
		// run mutated anything (same pattern `tightenScenario`'s own test uses).
		const slotId = run.reelBefore.slots[0]?.id as string;
		expect(slotId).toBeDefined();

		// RESULTING TIMELINE STATE, not the verb call: the plain (non-slot) clip
		// trimmed by 1s — proof `findSlotOrElement`'s widening actually reached
		// plain placed footage, which `findSlot` alone could never resolve.
		const plainClip = run.fake.find("el_plain_clip")?.element;
		expect(plainClip?.trimStart).toBeCloseTo(1, 5);
		expect(plainClip?.duration).toBeCloseTo(7, 5);

		// The generative slot ALSO trimmed, by the SAME program, in the SAME
		// run — proof the widening is additive: the pre-existing slot path
		// still resolves exactly as it did before `findSlotOrElement` existed.
		const slotEl = run.fake.find(slotId)?.element;
		expect(slotEl?.duration).toBeCloseTo(8, 5);
		expect(slotEl?.trimStart).toBeCloseTo(0, 5); // untouched — trim omitted it

		// ONE new undo entry total across BOTH applyEdit calls: the dry-run call
		// must have contributed zero (it never opens a transaction — see
		// `program/executor.ts`'s `runProgram`, which only takes `undo` in
		// `"apply"` mode), and the apply call's two `trim()` primitive calls
		// must have collapsed into exactly one entry, not two.
		expect(run.fake.editor.command.getHistoryLength()).toBe(
			APPLY_EDIT_FIXTURE_HISTORY_LENGTH + 1,
		);
		expect(run.fake.editor.command.peekUndoOrigin()).toBe("agent");
		expect(run.fake.editor.command.peekUndoName()).toBe("applyEdit");

		// And it genuinely undoes cleanly, both elements at once — the whole
		// point of "one undo step".
		const undoResult = run.director.undo();
		expect(undoResult.ok).toBe(true);
		expect(run.fake.find("el_plain_clip")?.element.trimStart).toBe(0);
		expect(run.fake.find("el_plain_clip")?.element.duration).toBe(8);
		expect(run.fake.find(slotId)?.element.duration).toBe(10);
	});

	test("tightenToLength scenario shrinks both clips to the exact proportional split", async () => {
		const run = await runScenario(tightenToLengthScenario);

		const clipOne = run.fake.find("el_tighten_one")?.element;
		const clipTwo = run.fake.find("el_tighten_two")?.element;
		expect(clipOne?.duration).toBeCloseTo(
			TIGHTEN_SCENARIO_EXPECTED_CLIP_DURATION_SEC,
			5,
		);
		expect(clipOne?.startTime).toBeCloseTo(0, 5);
		expect(clipTwo?.duration).toBeCloseTo(
			TIGHTEN_SCENARIO_EXPECTED_CLIP_DURATION_SEC,
			5,
		);
		// Re-packed contiguously right after clip one's new (shorter) end.
		expect(clipTwo?.startTime).toBeCloseTo(
			TIGHTEN_SCENARIO_EXPECTED_CLIP_DURATION_SEC,
			5,
		);
		expect(run.timelineAfter?.totalDurationSec).toBe(
			TIGHTEN_SCENARIO_TARGET_SEC,
		);
	});

	test("duckMusicUnderSpeech scenario produces the exact keyframe curve and leaves the voiceover untouched", async () => {
		const run = await runScenario(duckMusicScenario);

		const music = run.fake.find("el_music_bed")?.element as unknown as {
			volumeKeyframes?: Array<{ time: number; value: number }>;
		};
		expect(music.volumeKeyframes).toBeDefined();
		expect(music.volumeKeyframes).toHaveLength(EXPECTED_DUCK_KEYFRAMES.length);
		music.volumeKeyframes?.forEach((kf, i) => {
			expect(kf.time).toBeCloseTo(EXPECTED_DUCK_KEYFRAMES[i].time, 4);
			expect(kf.value).toBeCloseTo(EXPECTED_DUCK_KEYFRAMES[i].value, 4);
		});

		// duckMusicUnderSpeech targets MUSIC elements, never the speech source
		// itself — the voiceover clip must carry no keyframes of its own.
		const voiceover = run.fake.find("el_voiceover_line")
			?.element as unknown as {
			volumeKeyframes?: unknown;
		};
		expect(voiceover.volumeKeyframes).toBeUndefined();
	});

	test("multi-step undo scenario: one undo after a 3-shot storyboard reverts all three atomically", async () => {
		const run = await runScenario(multiStepUndoScenario);

		expect(run.reelAfter.slots).toHaveLength(0);
		expect(run.timelineAfter?.totalDurationSec).toBe(0);
		// Back to a clean slate: nothing left to undo from this run.
		expect(run.fake.editor.command.canUndo()).toBe(false);
	});

	test("generation-failure scenario: one slot fails, the other is unaffected, no unhandled step error", async () => {
		const run = await runScenario(generationFailureScenario);

		// The generate STEP itself is `ok: true` (a partial failure is a
		// designed, reported outcome, never a thrown/unhandled error) — this is
		// the one call-result field this scenario leans on, because "did the
		// verb itself blow up vs. degrade gracefully" can only be read off the
		// step's own ok flag.
		const generateStep = run.steps.find((s) => s.action === "generate");
		expect(generateStep?.ok).toBe(true);

		// The load-bearing assertions: each slot's OWN persisted status.
		const [harborSlot, failingSlot] = run.reelAfter.slots;
		expect(harborSlot?.status).toBe("ready");
		expect(harborSlot?.takeCount).toBeGreaterThan(0);
		expect(failingSlot?.status).toBe("failed");

		// And the generic sweep (assertGenericInvariants, always run below) must
		// NOT flag this as an unhandled error — proving the harness tells a
		// reported failure apart from a crash.
		const violations = assertScenario(run, generationFailureScenario.expect);
		expect(violations).toEqual([]);
	});

	test("clarify scenario makes zero tool calls and stops in exactly one model round-trip", async () => {
		const run = await runScenario(clarifyScenario);
		expect(run.steps).toHaveLength(0);
		expect(run.modelCallCount).toBe(1);
		expect(run.awaitingApproval).toBe(false);
		expect(run.finalMessage.length).toBeGreaterThan(0);
	});

	describe("negative fixture — proves the harness can actually fail", () => {
		test("a scripted call to a non-catalog verb is flagged, not silently accepted", async () => {
			const run = await runScenario(brokenVerbScenario);

			// The loop itself survives (executeTool degrades gracefully) — but the
			// step recorded ok:false, and BOTH invariant checks must catch it.
			const unknownStep = run.steps.find(
				(s) => s.action === "deleteEverything",
			);
			expect(unknownStep?.ok).toBe(false);

			const knownVerbViolations = assertKnownVerbs(run);
			expect(knownVerbViolations.length).toBeGreaterThan(0);
			expect(knownVerbViolations[0]?.code).toBe("unknown-verb");

			const errorViolations = assertNoUnhandledErrors(run);
			expect(errorViolations.length).toBeGreaterThan(0);

			// And the full scenario-level sweep (what the 3 real scenarios above
			// are held to) must also fail this fixture — proving `assertScenario`
			// isn't vacuously green.
			const allViolations = assertScenario(run, {});
			expect(allViolations.length).toBeGreaterThan(0);
		});
	});
});
