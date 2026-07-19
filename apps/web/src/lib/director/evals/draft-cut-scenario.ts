/**
 * SE-4 eval scenario — `docs/plans/2026-07-20-story-engine-design.md`'s
 * "Eval harness gets a `draftCut` scenario" line item: a ZERO-GENERATION
 * fixture (speech-ish footage seeded via the `fake-editor.ts` pattern) that
 * drives `draftCut` end to end through the REAL `runDirectorAgent` loop, with
 * a SCRIPTED Treatment reply standing in for `draftCut`'s own internal model
 * call — never the network, same "mock only the seam" discipline this whole
 * directory follows (see `README.md` / `runner.ts`'s header).
 *
 * TWO video assets, each with ONE transcript segment starting at `0s` (a
 * whole-clip pick, so the radio-cut planner never needs a `trim` op here —
 * the `addClip → trim` pending-ref path is unit-tested directly in
 * `director-draft-cut.test.ts`, which doesn't need the full agent-loop
 * machinery this harness adds). The scripted Treatment's MIDDLE section has
 * an EMPTY `materialRefs` — the "no matching b-roll" case — so the assembled
 * plan produces exactly one `MarkedGap`, proving gaps get MARKED, never
 * invented (ADR-007), rather than this scenario accidentally being a trivial
 * all-material-found case.
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor, type FakeEditor } from "../fake-editor";
import { closeTurn, toolTurn, type EvalScenario } from "./fixtures";

interface FakeMediaAsset {
	id: string;
	type: "video" | "image" | "audio";
	name: string;
	duration: number;
}

/** `fake-editor.ts`'s `media.getAssets`/`getAssetById` are hardcoded empty/undefined (see its own file header) — this is this scenario's own `patchTrim`-style local extension (evals/README.md's "add a sibling patchX() following the same shape") so `addClip` (which `draftCut`'s assembly plan executes through) can resolve real assets. */
function patchMedia(fake: FakeEditor, assets: FakeMediaAsset[]): void {
	const media = fake.editor.media as unknown as {
		getAssets: () => unknown[];
		getAssetById: (id: string) => unknown;
	};
	media.getAssets = () => assets;
	media.getAssetById = (id: string) => assets.find((a) => a.id === id);
}

/** The user's asked-for length: 20s hook + 5s marked gap + 15s wrap-up = 40s of TIMELINE span (the gap is a real, unfilled stretch — the second clip starts AFTER it, not immediately after the first — see `story/assembly.ts`'s `runSequentialAssembly` cursor math). */
export const DRAFT_CUT_SCENARIO_EXPECTED_DURATION_SEC = 40;

const TREATMENT_JSON = JSON.stringify({
	logline: "A quick recap leading with the intro pitch.",
	sections: [
		{ intent: "hook", targetSec: 20, materialRefs: ["a1"], order: 0 },
		{
			intent: "cutaway — GAP: no matching b-roll in the library",
			targetSec: 5,
			materialRefs: [],
			order: 1,
		},
		{ intent: "wrap-up", targetSec: 15, materialRefs: ["a2"], order: 2 },
	],
});

/** The exact chat-register summary `draftCut` produces for this fixture — see `story/run.ts`'s `buildDraftCutSummary`. Exported so `evals.test.ts` can assert the precise string, not just a loose substring. */
export const DRAFT_CUT_SCENARIO_EXPECTED_SUMMARY =
	"Cut a 40s draft from 2 clips — led with the hook. 1 gap marked for cutaways.";

function setupDraftCutProject() {
	const fake = makeFakeEditor();
	patchMedia(fake, [
		{ id: "a1", type: "video", name: "intro.mp4", duration: 20 },
		{ id: "a2", type: "video", name: "outro.mp4", duration: 15 },
	]);

	const director = createDirectorApi(fake.editor, {
		transcripts: (mediaId) => {
			if (mediaId === "a1") {
				return {
					mediaId: "a1",
					segments: [{ start: 0, end: 20, text: "here is the intro pitch" }],
					language: "en",
					durationSec: 20,
					engine: "test",
					createdAt: 0,
				};
			}
			if (mediaId === "a2") {
				return {
					mediaId: "a2",
					segments: [
						{ start: 0, end: 15, text: "thanks so much for watching" },
					],
					language: "en",
					durationSec: 15,
					engine: "test",
					createdAt: 0,
				};
			}
			return undefined;
		},
		// Scripted Treatment relay — a fixed reply, never the network (see this
		// file's header). `getUnderstanding` short-circuits `draftCut`'s default
		// IndexedDB read (which fails soft in a headless test anyway — see
		// `director-draft-cut.test.ts` — but this keeps the fixture explicit).
		storyEngine: {
			relay: async () => TREATMENT_JSON,
			getUnderstanding: async () => [],
		},
	});

	return { fake, director };
}

export const draftCutScenario: EvalScenario = {
	id: "draft-cut-speech-footage",
	description:
		'Zero-generation fixture: two speech-ish video clips + "cut me a quick recap" ' +
		"drives draftCut end to end through the real agent loop — a scripted Treatment " +
		"reply (never the network) with one gap section proves gaps get MARKED, never " +
		"invented (ADR-007), and the whole assembled cut lands as one undo step.",
	userMessage:
		"cut me a quick recap from my footage, lead with the intro pitch",
	setup: setupDraftCutProject,
	turns: () => [
		toolTurn(
			"I'll assemble a first cut from your own footage — no generation.",
			"t1",
			"draftCut",
			{
				instruction:
					"cut me a quick recap from my footage, lead with the intro pitch",
			},
		),
		closeTurn(
			"Done — that's your first cut, with one gap flagged for a cutaway.",
		),
	],
	expect: {
		mustCallVerbs: ["draftCut"],
		orderedVerbPrefix: ["draftCut"],
		durationBoundsSec: [
			DRAFT_CUT_SCENARIO_EXPECTED_DURATION_SEC,
			DRAFT_CUT_SCENARIO_EXPECTED_DURATION_SEC,
		],
		mustNotAwaitApproval: true,
		mustNotGenerate: true,
	},
};
