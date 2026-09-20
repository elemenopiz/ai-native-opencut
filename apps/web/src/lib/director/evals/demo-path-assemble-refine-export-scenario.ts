/**
 * THE DEMO PATH, end to end, over the Director's OWN-FOOTAGE pipeline:
 * brief → `draftCut` assembles a real cut from the footage inventory →
 * refine (`cutOnBeat`, as an `applyEdit` program) → export. This is the
 * sibling of `challenge-demo-scenario.ts`, which covers the GENERATIVE demo
 * path (storyboard → generate → addText → addMusicBed → export); this
 * scenario covers the FOOTAGE-based path the task brief describes ("the
 * Director drafts a cut from the footage inventory... it refines (tighten /
 * cut-on-beat)... it exports") — the two together are the full demo surface.
 *
 * Two speech-ish clips are assembled by `draftCut` with a WHOLE-CLIP pick on
 * each (no `trim` op needed for the assembly itself — see
 * `draft-cut-scenario.ts`'s header for why a segment starting at 0s never
 * needs one), chosen so the resulting join lands 0.1s off an analyzed beat —
 * the EXACT fixture shape `craft-cut-on-beat-scenario.ts` uses for its own
 * clips, reused here so `CUT_ON_BEAT_PROGRAM`'s snap has something real to do
 * on footage `draftCut` itself produced (not hand-placed).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * TODO(scoreCut): a `scoreCut` verb + UI are being built in parallel this
 * wave (an engagement/virality score over the current cut) and don't exist on
 * this branch yet — see `docs/plans/2026-09-18-challenge-execution-timeline.md`
 * §4's "score → recut → score" loop. Once it lands, the real demo sequence is
 * draftCut → cutOnBeat → scoreCut → (conditionally) another refine pass →
 * scoreCut again → export. THIS scenario stops at the recut (cutOnBeat) and
 * goes straight to export — the scoring/re-score turns slot in right between
 * the `applyEdit` turn and the `export` turn below, once that verb exists.
 * Do not script a `scoreCut` tool call here until then.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor, type FakeEditor } from "../fake-editor";
import { useBeatGridStore, type BeatGrid } from "@/stores/beat-grid-store";
import { CUT_ON_BEAT_PROGRAM } from "../program/programs/cut-on-beat";
import type { ExportResult } from "@/types/export";
import {
	closeTurn,
	insertClip,
	patchTrim,
	toolTurn,
	type EvalScenario,
} from "./fixtures";

interface FakeMediaAsset {
	id: string;
	type: "video" | "image" | "audio";
	name: string;
	duration: number;
}

/** Same `fake-editor.ts` media-stub patch `draft-cut-scenario.ts` uses (see
 *  its own header — `fake.editor.media` is hardcoded empty by default). */
function patchMedia(fake: FakeEditor, assets: FakeMediaAsset[]): void {
	const media = fake.editor.media as unknown as {
		getAssets: () => unknown[];
		getAssetById: (id: string) => unknown;
	};
	media.getAssets = () => assets;
	media.getAssetById = (id: string) => assets.find((a) => a.id === id);
}

/** Same `fake-editor.ts` export-stub patch `challenge-demo-scenario.ts` uses
 *  (see its own header — `fake.editor.project` has no `export` method). */
function patchExport(fake: FakeEditor): void {
	const project = fake.editor.project as unknown as {
		export: (args: unknown) => Promise<ExportResult>;
	};
	project.export = async () => ({
		success: true,
		buffer: new ArrayBuffer(4 * 1024 * 1024),
	});
}

/** The join `draftCut` produces sits at 3.9s; the analyzed beat is at 4.0s —
 *  identical numbers to `craft-cut-on-beat-scenario.ts`, reused deliberately
 *  so this scenario's cut-on-beat math is a known-good quantity, not a new
 *  one to debug. */
const CLIP_ONE_DURATION_SEC = 3.9;
const CLIP_TWO_DURATION_SEC = 5;
const BEAT_TIME_SEC = 4.0;
/** Total runtime is conserved by a beat SNAP (it only moves the join), so
 *  this is both the pre- and post-refine total. */
export const DEMO_PATH_TOTAL_DURATION_SEC =
	CLIP_ONE_DURATION_SEC + CLIP_TWO_DURATION_SEC;

const TREATMENT_JSON = JSON.stringify({
	logline: "A two-beat recap, cut to the music.",
	sections: [
		{
			intent: "hook",
			targetSec: CLIP_ONE_DURATION_SEC,
			materialRefs: ["a1"],
			order: 0,
		},
		{
			intent: "wrap-up",
			targetSec: CLIP_TWO_DURATION_SEC,
			materialRefs: ["a2"],
			order: 1,
		},
	],
});

function setupDemoPathProject() {
	const fake = makeFakeEditor();
	patchTrim(fake); // cutOnBeat's snap trims the join, not draftCut's own assembly.
	patchExport(fake);
	patchMedia(fake, [
		{
			id: "a1",
			type: "video",
			name: "intro.mp4",
			duration: CLIP_ONE_DURATION_SEC,
		},
		{
			id: "a2",
			type: "video",
			name: "outro.mp4",
			duration: CLIP_TWO_DURATION_SEC,
		},
	]);

	// A dedicated beat-source element, decoupled from the video clips
	// `draftCut` will place — same shape `craft-cut-on-beat-scenario.ts` uses.
	const beatSourceId = insertClip(
		fake,
		{
			id: "el_beat_source",
			type: "audio",
			name: "synth-loop.mp3",
			mediaId: "m_synth_loop",
			startTime: 0,
			duration: 20,
			trimStart: 0,
			trimEnd: 0,
		},
		{ mode: "auto", trackType: "audio" },
	);
	const grid: BeatGrid = {
		elementId: beatSourceId,
		trackId: fake.find(beatSourceId)?.track.id ?? "",
		mediaId: "m_synth_loop",
		beats: [BEAT_TIME_SEC],
		downbeats: [BEAT_TIME_SEC],
		bpm: 120,
		energyClass: "energetic",
		analyzedAt: 0,
	};
	useBeatGridStore.getState().setGrid(grid);

	const director = createDirectorApi(fake.editor, {
		transcripts: (mediaId) => {
			if (mediaId === "a1") {
				return {
					mediaId: "a1",
					segments: [
						{
							start: 0,
							end: CLIP_ONE_DURATION_SEC,
							text: "here is the intro pitch",
						},
					],
					language: "en",
					durationSec: CLIP_ONE_DURATION_SEC,
					engine: "test",
					createdAt: 0,
				};
			}
			if (mediaId === "a2") {
				return {
					mediaId: "a2",
					segments: [
						{
							start: 0,
							end: CLIP_TWO_DURATION_SEC,
							text: "thanks so much for watching",
						},
					],
					language: "en",
					durationSec: CLIP_TWO_DURATION_SEC,
					engine: "test",
					createdAt: 0,
				};
			}
			return undefined;
		},
		storyEngine: {
			relay: async () => TREATMENT_JSON,
			getUnderstanding: async () => [],
		},
	});

	return { fake, director };
}

export const demoPathAssembleRefineExportScenario: EvalScenario = {
	id: "demo-path-draftcut-cutonbeat-export",
	description:
		"The full footage-based demo path: draftCut assembles a real cut from " +
		"the inventory, cutOnBeat (applyEdit) refines the join onto an analyzed " +
		"beat, then export produces a real file — the exact seam sequence the " +
		"screen-recorded demo performs, minus the not-yet-built scoreCut step " +
		"(see this file's TODO).",
	userMessage:
		"cut me a quick recap from my footage, snap it to the beat, then export it",
	setup: setupDemoPathProject,
	turns: () => [
		toolTurn(
			"I'll assemble a first cut from your own footage — no generation.",
			"t1",
			"draftCut",
			{
				instruction: "cut me a quick recap from my footage",
			},
		),
		toolTurn("Snapping the join onto the nearest beat.", "t2", "applyEdit", {
			program: CUT_ON_BEAT_PROGRAM,
			mode: "apply",
		}),
		// TODO(scoreCut): score → recut → score would go here, before export.
		toolTurn("Exporting the final cut.", "t3", "export", { download: false }),
		closeTurn(
			"Cut from your footage, snapped to the beat, and exported — ready to watch.",
		),
	],
	expect: {
		mustCallVerbs: ["draftCut", "applyEdit", "export"],
		orderedVerbPrefix: ["draftCut", "applyEdit", "export"],
		// NOT `durationBoundsSec` here: `totalDurationSec` spans EVERY track,
		// including the 20s beat-source audio clip this fixture seeds for
		// `cutOnBeat` to read (see `setupDemoPathProject`) — it would dwarf the
		// ~8.9s video-only span this scenario actually cares about. The
		// dedicated test in `evals.test.ts` asserts the real video-track
		// numbers directly instead.
		mustNotAwaitApproval: true,
		mustNotGenerate: true,
	},
};
