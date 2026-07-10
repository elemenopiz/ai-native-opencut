import { describe, expect, it } from "bun:test";
import {
	buildBibleDocument,
	editBrief,
	editConsistency,
	HUMAN_BRIEF_LABEL,
	HUMAN_LOOK_LABEL,
	readBibleDocument,
	replaceBriefLists,
	restoreCheckpoint,
} from "./bible-ui";
import {
	getStoredConsistencyContext,
	storeConsistencyContext,
	withConsistencyContext,
	type ConsistencyContext,
} from "./consistency-prompt";
import { emptyProjectBible } from "./project-bible";
import type { ProjectBible } from "@/types/project";
import type { StoryboardPlan } from "./storyboard-plan";
import { makeFakeEditor } from "./fake-editor";

const ctxWarm: ConsistencyContext = {
	style: "warm amber grade",
	characters: [{ name: "Mara", descriptor: "red coat", personaId: "p1" }],
	setting: "sunlit kitchen",
};

const plan: StoryboardPlan = {
	shotCount: 1,
	shots: [{ index: 1, prompt: "a shot", duration: 6 }],
	bible: { palette: "amber", lensMood: "anamorphic" },
	totalDuration: 6,
	createdAt: 111,
};

// ── pure: buildBibleDocument ──────────────────────────────────────────────────

describe("buildBibleDocument", () => {
	it("reports isEmpty for a fresh project with nothing authored", () => {
		const doc = buildBibleDocument({
			bible: undefined,
			brief: {},
			consistency: undefined,
			plan: undefined,
		});
		expect(doc.isEmpty).toBe(true);
		expect(doc.version).toBe(0);
		expect(doc.history).toEqual([]);
		expect(doc.decisions).toEqual([]);
		expect(doc.consistency).toBeUndefined();
	});

	it("is non-empty when only the brief is set", () => {
		const doc = buildBibleDocument({
			bible: undefined,
			brief: { goal: "sell shoes" },
			consistency: undefined,
			plan: undefined,
		});
		expect(doc.isEmpty).toBe(false);
		expect(doc.brief.goal).toBe("sell shoes");
	});

	it("treats a blank consistency context (default style, no cast/setting) as empty", () => {
		const doc = buildBibleDocument({
			bible: undefined,
			brief: {},
			consistency: { style: "  ", characters: [], setting: "" },
			plan: undefined,
		});
		expect(doc.isEmpty).toBe(true);
		expect(doc.consistency).toBeUndefined();
	});

	it("surfaces consistency, plan, styleBible, roster and reverses history/decisions newest-first", () => {
		const bible: ProjectBible = {
			version: 3,
			updatedAt: 500,
			styleBible: { palette: "teal" },
			personaRosterSummary: [
				{ id: "p1", name: "Mara", descriptor: "red coat" },
			],
			decisions: [
				{ at: 1, note: "first" },
				{ at: 2, note: "second" },
			],
			history: [
				{ version: 0, at: 1, label: "a", state: {} },
				{ version: 1, at: 2, label: "b", state: {} },
			],
		};
		const doc = buildBibleDocument({
			bible,
			brief: { tone: "warm" },
			consistency: ctxWarm,
			plan,
		});
		expect(doc.isEmpty).toBe(false);
		expect(doc.consistency).toEqual(ctxWarm);
		expect(doc.plan).toEqual(plan);
		expect(doc.styleBible).toEqual({ palette: "teal" });
		expect(doc.personaRoster).toHaveLength(1);
		// Newest-first for display.
		expect(doc.decisions.map((d) => d.note)).toEqual(["second", "first"]);
		expect(doc.history.map((h) => h.version)).toEqual([1, 0]);
		expect(doc.version).toBe(3);
	});
});

// ── glue: human edits round-trip through the persisted, versioned bible ────────

describe("editBrief", () => {
	it("persists the brief AND checkpoints the bible (version bump + human label)", () => {
		const { editor } = makeFakeEditor();
		const next = editBrief(editor, { goal: "drive signups", tone: "playful" });

		expect(next.goal).toBe("drive signups");
		// Durable brief updated…
		expect(editor.project.getDirectorBrief().goal).toBe("drive signups");
		// …and mirrored onto the versioned bible.
		const bible = editor.project.getProjectBible();
		expect(bible?.brief?.goal).toBe("drive signups");
		expect(bible?.version).toBe(1);
		expect(bible?.decisions?.at(-1)?.note).toBe("Edited brief");
	});

	it("appends (not replaces) dos and notes across successive edits", () => {
		const { editor } = makeFakeEditor();
		editBrief(editor, { dos: ["handheld feel"] });
		const merged = editBrief(editor, {
			dos: ["warm tones"],
			notes: ["prefers grain"],
		});
		expect(merged.dos).toEqual(["handheld feel", "warm tones"]);
		expect(merged.notes).toEqual(["prefers grain"]);
		// A prior non-empty state was checkpointed.
		expect(editor.project.getProjectBible()?.history?.length).toBeGreaterThan(
			0,
		);
	});
});

describe("replaceBriefLists (human list add/edit/remove)", () => {
	it("REPLACES dos/donts wholesale, unlike editBrief's append", () => {
		const { editor } = makeFakeEditor();
		editBrief(editor, { dos: ["a", "b", "c"] });
		const next = replaceBriefLists(editor, { dos: ["a", "c"] });
		expect(next.dos).toEqual(["a", "c"]);
		expect(editor.project.getDirectorBrief().dos).toEqual(["a", "c"]);
		expect(editor.project.getProjectBible()?.brief?.dos).toEqual(["a", "c"]);
	});

	it("drops an emptied list and leaves untouched fields alone", () => {
		const { editor } = makeFakeEditor();
		editBrief(editor, { goal: "keep me", donts: ["shaky cam"] });
		const next = replaceBriefLists(editor, { donts: [] });
		expect(next.donts).toBeUndefined();
		expect(next.goal).toBe("keep me");
	});
});

describe("editConsistency (the 'grade is now colder' path)", () => {
	it("updates the live WeakMap so the very next provider call sees the new STYLE", () => {
		const { editor } = makeFakeEditor();
		storeConsistencyContext(editor, ctxWarm);

		editConsistency(editor, { style: "cold blue grade, overcast" });

		const live = getStoredConsistencyContext(editor);
		expect(live?.style).toBe("cold blue grade, overcast");
		// Existing cast + setting are preserved through a style-only edit.
		expect(live?.characters).toEqual(ctxWarm.characters);
		expect(live?.setting).toBe("sunlit kitchen");

		// The edit reaches the prompt exactly as studio-executor applies it.
		const wrapped = withConsistencyContext(
			"a hero pouring coffee",
			// biome-ignore lint/style/noNonNullAssertion: asserted above.
			live!,
		);
		expect(wrapped).toContain("STYLE: cold blue grade, overcast");
		expect(wrapped).toContain("SHOT: a hero pouring coffee");
	});

	it("persists the new look on the versioned bible with the human-look label", () => {
		const { editor } = makeFakeEditor();
		storeConsistencyContext(editor, ctxWarm);
		editConsistency(editor, { style: "cold blue grade" });

		const bible = editor.project.getProjectBible();
		expect(bible?.consistencyContext?.style).toBe("cold blue grade");
		expect(bible?.version).toBe(1);
		expect(bible?.decisions?.at(-1)?.note).toBe("Edited reel look");
	});
});

describe("restoreCheckpoint (one-click 'go back to Tuesday's look')", () => {
	it("re-hydrates the live consistency WeakMap from the restored checkpoint", () => {
		const { editor } = makeFakeEditor();
		storeConsistencyContext(editor, ctxWarm);
		editConsistency(editor, { style: "warm amber grade" }); // v1 (checkpoints nothing prior meaningful)
		editConsistency(editor, { style: "cold blue grade" }); // v2, checkpoints the warm state

		expect(getStoredConsistencyContext(editor)?.style).toBe("cold blue grade");

		const history = editor.project.getProjectBible()?.history ?? [];
		const warmCheckpoint = history.find(
			(h) => h.state.consistencyContext?.style === "warm amber grade",
		);
		expect(warmCheckpoint).toBeDefined();

		const result = restoreCheckpoint(
			editor,
			// biome-ignore lint/style/noNonNullAssertion: asserted above.
			warmCheckpoint!.version,
		);
		expect(result.reverted).toBe(true);
		// Live WeakMap now reads the restored (warm) look — steers future generation.
		expect(getStoredConsistencyContext(editor)?.style).toBe("warm amber grade");
	});

	it("reports reverted:false when there is nothing to restore", () => {
		const { editor } = makeFakeEditor();
		const result = restoreCheckpoint(editor);
		expect(result.reverted).toBe(false);
	});
});

describe("readBibleDocument", () => {
	it("reads the live document straight off an editor", () => {
		const { editor } = makeFakeEditor();
		editor.project.setProjectBible({ bible: emptyProjectBible(1) });
		editBrief(editor, { goal: "x" });
		const doc = readBibleDocument(editor);
		expect(doc.isEmpty).toBe(false);
		expect(doc.brief.goal).toBe("x");
		expect(doc.version).toBeGreaterThanOrEqual(1);
	});
});

// ── labels are exported for the panel's history rendering ─────────────────────

describe("human edit labels", () => {
	it("are stable constants the panel can key on", () => {
		expect(HUMAN_BRIEF_LABEL).toBe("human:brief");
		expect(HUMAN_LOOK_LABEL).toBe("human:look");
	});
});
