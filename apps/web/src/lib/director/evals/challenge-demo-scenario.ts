/**
 * The CHALLENGE DEMO PATH — `docs/plans/2026-09-18-challenge-execution-timeline.md`'s
 * locked demo: "brief → Director storyboards → generates face-locked shots →
 * assembles a real multi-track cut → ... → exports a real mp4." This harness
 * has no seam for the scoring/recut half (Virality Predictor `scoreCut`
 * doesn't exist yet — see that doc's Day 2 section), so this scenario covers
 * the half that DOES exist today end to end: brief → storyboard → generate
 * shots → assemble a multi-track cut (video + text + music) → export. That
 * doc's own §5 "Gaps that matter this week" lists "1 eval scenario total" as
 * a named risk for exactly this path — this scenario is the fix.
 *
 * Three injected seams, none of them the network:
 *  - `executor` (video generation) — the same `readyExecutor` every other
 *    scenario in this directory uses.
 *  - `audio.resolveMusic` — `addMusicBed`'s own documented injection seam
 *    (its default hits `/api/sounds/search`, browser-bound; see
 *    `director-api.ts`'s `CreateDirectorApiOptions.audio` doc comment,
 *    "the same pattern as `executor`/`exportReel`").
 *  - `project.export` — `export`'s own doc comment states the contract in as
 *    many words: "in a headless/Node unit test pass `download: false` and
 *    stub `editor.project.export`. This is NOT a fake: it calls the real
 *    export path, which simply requires a browser to execute." This is the
 *    established pattern `director-api.export.test.ts` already uses; this
 *    file's {@link patchExport} is a `fake-editor.ts`-scoped copy of it
 *    (not a `fake-editor.ts` edit — `project` isn't shared mutable module
 *    state, it's an object this file builds and only THIS scenario reads).
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor, type FakeEditor } from "../fake-editor";
import type { ExportResult } from "@/types/export";
import {
	closeTurn,
	fastRecovery,
	readyExecutor,
	toolTurn,
	type EvalScenario,
} from "./fixtures";

/**
 * `fake-editor.ts`'s `project` stub has no `export` method (`export`'s own
 * doc comment names this exact gap and prescribes this exact fix — see this
 * file's header). Mirrors `director-api.export.test.ts`'s `makeEditor`
 * helper: a fixed-size successful buffer, no cancellation/failure path —
 * this scenario's job is the assemble→export PIPELINE, not export's own
 * failure handling (that's `director-api.export.test.ts`'s job).
 */
function patchExport(fake: FakeEditor): void {
	const project = fake.editor.project as unknown as {
		export: (args: unknown) => Promise<ExportResult>;
	};
	project.export = async () => ({
		success: true,
		buffer: new ArrayBuffer(4 * 1024 * 1024), // a plausible 4MB mp4
	});
}

function setupChallengeDemoProject() {
	const fake = makeFakeEditor();
	patchExport(fake);
	const director = createDirectorApi(fake.editor, {
		executor: readyExecutor(),
		recovery: fastRecovery,
		audio: {
			resolveMusic: async () => ({
				mediaId: "media_music_neon_drive",
				name: "Neon Drive",
				duration: 999,
				license: "CC-BY",
				sourceUrl: "https://example.test/neon-drive",
			}),
		},
	});
	return { fake, director };
}

export const challengeDemoScenario: EvalScenario = {
	id: "challenge-demo-path",
	description:
		"The publicly-demoed flow: brief → storyboard 3 shots → generate them → " +
		"lay a title card + a music bed (a real SECOND and THIRD track) → export. " +
		"Regression-guards the exact sequence the challenge demo performs live.",
	userMessage:
		"make a moody 15-second night-drive teaser — three shots, add a title " +
		"card and a music bed, then export it",
	setup: setupChallengeDemoProject,
	turns: () => [
		toolTurn(
			"Storyboarding a three-shot night-drive sequence under one look.",
			"t1",
			"storyboard",
			{
				shots: [
					{
						prompt: "wide establishing shot of the skyline at dusk",
						intent: "cold open",
						duration: 5,
						importance: "hero",
					},
					{
						prompt: "close-up on neon signage reflecting in the rain",
						intent: "texture beat",
						duration: 5,
						importance: "support",
					},
					{
						prompt: "final push-in on the skyline as lights ignite",
						intent: "payoff",
						duration: 5,
						importance: "hero",
					},
				],
				bible: {
					palette: "neon-noir",
					lensMood: "anamorphic, moody, shallow DoF",
					setting: "downtown at night",
				},
				// Generous cap — this scenario is about the PIPELINE reaching export
				// clean, not the budget gate; see teaserScenario's own note in
				// fixtures.ts for why this keeps the run from pausing on approval.
				budgetUsd: 10,
			},
		),
		toolTurn("Rendering all three shots.", "t2", "generate", {
			slotIds: "all",
		}),
		toolTurn("Adding the title card over the cold open.", "t3", "addText", {
			content: "MIDNIGHT DRIVE",
			startTime: 0,
			duration: 3,
		}),
		toolTurn(
			"Laying a moody synth bed under the whole cut.",
			"t4",
			"addMusicBed",
			{ query: "moody synthwave night drive" },
		),
		toolTurn("Exporting the final cut.", "t5", "export", { download: false }),
		closeTurn(
			"Cut, scored, and exported — three shots, a title card, a synth bed, " +
				"MP4 ready to download.",
		),
	],
	expect: {
		// `mustCallVerbs`/`orderedVerbPrefix` pin the PIPELINE SHAPE (storyboard
		// before generate before assembly before export) — this is the one place
		// in this file's assertions coupled to verb identity, and deliberately
		// so: unlike the craft macros, none of `storyboard`/`generate`/`addText`/
		// `addMusicBed`/`export` are slated for removal by the architecture doc
		// (§2 "Layer 1 — Primitives" / "Layer 3 — Generation as an ordinary
		// resource" keep exactly these); this scenario's whole point IS that
		// this literal sequence is the publicly-demoed path, so protecting the
		// sequence itself is correct here, not an assertion smell.
		mustCallVerbs: [
			"storyboard",
			"generate",
			"addText",
			"addMusicBed",
			"export",
		],
		orderedVerbPrefix: [
			"storyboard",
			"generate",
			"addText",
			"addMusicBed",
			"export",
		],
		durationBoundsSec: [14, 16],
		slotCountBounds: [3, 3],
		mustNotAwaitApproval: true,
	},
};
