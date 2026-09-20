/**
 * THE THIN-INVENTORY SEAM — "brief → draftCut" when the footage inventory
 * cannot cover what was asked. `draft-cut-scenario.ts` already proves ONE
 * marked gap (a single section with no matching b-roll) doesn't break the
 * run; this scenario pushes that to the edge case the task brief calls out
 * explicitly: an inventory so thin that NOTHING in it matches, so the whole
 * treatment comes back as gaps. The Story Engine's own contract (see
 * `story/treatment.ts`'s system prompt: "When a section's narrative need has
 * NO matching material anywhere in the inventory, leave materialRefs EMPTY
 * and say so... instead of inventing footage") makes this a VALID, expected
 * treatment shape — not a parse failure — so the run must still terminate
 * cleanly: zero clips placed, zero duration, every section reported as a
 * gap, a friendly summary, no exception, no generation (ADR-007 holds even
 * when there's nothing real to assemble).
 *
 * This is the regression this scenario actually guards: a future change to
 * `story/assembly.ts`/`story/run.ts` that assumes "at least one clip" (e.g.
 * indexing `assemblyPlan.ops[0]` unchecked, or dividing by `clipCount`) would
 * throw or produce garbage on an all-gap treatment instead of degrading to
 * the same honest "here's what I couldn't do" message a thin inventory
 * deserves.
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

/** Same `fake-editor.ts` media-stub patch `draft-cut-scenario.ts` uses. */
function patchMedia(fake: FakeEditor, assets: FakeMediaAsset[]): void {
	const media = fake.editor.media as unknown as {
		getAssets: () => unknown[];
		getAssetById: (id: string) => unknown;
	};
	media.getAssets = () => assets;
	media.getAssetById = (id: string) => assets.find((a) => a.id === id);
}

/** Both sections come back with an EMPTY `materialRefs` — a totally thin
 *  inventory, not the one-gap-among-two case `draft-cut-scenario.ts` covers.
 *  A 45s ask against footage that (per the scripted Treatment) matches
 *  nothing at all. */
const TREATMENT_JSON = JSON.stringify({
	logline: "A recap that the library can't actually cover yet.",
	sections: [
		{
			intent: "hook — GAP: no matching footage in the library",
			targetSec: 20,
			materialRefs: [],
			order: 0,
		},
		{
			intent: "wrap-up — GAP: no matching footage in the library",
			targetSec: 25,
			materialRefs: [],
			order: 1,
		},
	],
});

/** The exact chat-register summary for an all-gap treatment — 0 clips, 2
 *  gaps, per `story/run.ts`'s `buildDraftCutSummary`. `buildDraftCutSummary`
 *  always appends "— led with the {first section's intent}" when the first
 *  (by `order`) section has a non-empty `intent`, whether or not that
 *  section actually placed a clip — so the hook section's own gap-noting
 *  intent text rides along verbatim into the summary. */
export const THIN_INVENTORY_SCENARIO_EXPECTED_SUMMARY =
	"Cut a 0s draft from 0 clips — led with the hook — GAP: no matching " +
	"footage in the library. 2 gaps marked for cutaways.";

function setupThinInventoryProject() {
	const fake = makeFakeEditor();
	// One real asset exists in the project (so this isn't "an empty media
	// library", which would be a different, less interesting case) — it just
	// doesn't match what the (scripted) Treatment decided the recap needs.
	patchMedia(fake, [
		{ id: "a1", type: "video", name: "unrelated-b-roll.mp4", duration: 8 },
	]);

	const director = createDirectorApi(fake.editor, {
		transcripts: () => undefined,
		storyEngine: {
			relay: async () => TREATMENT_JSON,
			getUnderstanding: async () => [],
		},
	});

	return { fake, director };
}

export const thinInventoryDraftCutScenario: EvalScenario = {
	id: "thin-inventory-draft-cut-all-gaps",
	description:
		"Footage inventory that matches NOTHING the brief asks for: draftCut " +
		"must still terminate cleanly — zero clips, every section reported as " +
		"a marked gap, an honest summary, no crash, no invented footage " +
		"(ADR-007), no approval pause.",
	userMessage: "cut me a 45-second recap from my footage",
	setup: setupThinInventoryProject,
	turns: () => [
		toolTurn(
			"I'll see what I can assemble from your footage.",
			"t1",
			"draftCut",
			{ instruction: "cut me a 45-second recap from my footage" },
		),
		closeTurn(
			"I couldn't find footage that matches this brief yet — both sections " +
				"came back as gaps. Upload more source material and I'll try again.",
		),
	],
	expect: {
		mustCallVerbs: ["draftCut"],
		orderedVerbPrefix: ["draftCut"],
		durationBoundsSec: [0, 0],
		mustNotAwaitApproval: true,
		mustNotGenerate: true,
	},
};
