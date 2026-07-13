import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import type { DirectorBrief } from "@/types/project";
import { createDirectorApi } from "./director-api";
import { buildFrontierSystemPrompt } from "./agent";

/**
 * Minimal `EditorCore` stub for the Director brief flow. It backs the brief with
 * an in-memory slot (standing in for the durable `TProject.directorBrief`) and
 * exposes just enough of `project`/`timeline`/`command`/`media` for
 * `createDirectorApi` to build a system prompt and run `chooseTake`.
 */
function makeEditor() {
	let brief: DirectorBrief = {};

	// One generative slot with two ready takes so `chooseTake` has something real
	// to select and diff.
	const element = {
		id: "slot_1",
		type: "video" as const,
		startTime: 0,
		duration: 6,
		trimStart: 0,
		trimEnd: 0,
		generation: {
			mode: "text-to-video",
			resolution: "480p",
			orientation: "portrait",
			duration: 6,
			prompt: "founder sips coffee at a sunny window",
		},
		takes: [
			{ id: "take_a", status: "ready", spec: {}, createdAt: 1 },
			{ id: "take_b", status: "ready", spec: {}, createdAt: 2 },
		],
		activeTakeId: undefined as string | undefined,
	};
	const track = { id: "track_1", type: "video", elements: [element] };

	const editor = {
		project: {
			getActiveOrNull: () => ({
				settings: { fps: 30, canvasSize: { width: 1080, height: 1920 } },
			}),
			getDirectorBrief: () => brief,
			setDirectorBrief: ({ brief: next }: { brief: DirectorBrief }) => {
				brief = next;
			},
		},
		timeline: {
			getTracks: () => [track],
			getTotalDuration: () => 6,
			selectTake: ({ takeId }: { elementId: string; takeId: string }) => {
				element.activeTakeId = takeId;
			},
		},
		command: { canUndo: () => false, canRedo: () => false },
		media: { getAssets: () => [] },
	} as unknown as EditorCore;

	return { editor, readBrief: () => brief };
}

describe("director brief verbs", () => {
	it("updateBrief persists the stated preference and getBrief reads it back", () => {
		const { editor, readBrief } = makeEditor();
		const director = createDirectorApi(editor);

		const result = director.updateBrief({
			goal: "drive signups",
			tone: "warm, handheld",
			notes: ["user prefers warm tones"],
		});

		expect(result.ok).toBe(true);
		expect(readBrief().tone).toBe("warm, handheld");
		expect(director.getBrief().data?.goal).toBe("drive signups");
		expect(director.getBrief().data?.notes).toContain(
			"user prefers warm tones",
		);
	});

	it("updateBrief sets a target duration and getBrief reads it back", () => {
		const { editor } = makeEditor();
		const director = createDirectorApi(editor);

		const result = director.updateBrief({ durationSec: 60 });

		expect(result.ok).toBe(true);
		expect(director.getBrief().data?.durationSec).toBe(60);
	});

	it("getReel reports targetDurationSec alongside the live totalDuration in ONE call", () => {
		const { editor } = makeEditor();
		const director = createDirectorApi(editor);

		director.updateBrief({ durationSec: 60 });
		const reel = director.getReel();

		// The fake editor's timeline stubs a fixed 6s total duration — the "built"
		// side of the built-vs-target comparison.
		expect(reel.totalDuration).toBe(6);
		expect(reel.targetDurationSec).toBe(60);
	});

	it("getReel omits targetDurationSec when the brief has no target duration set", () => {
		const { editor } = makeEditor();
		const director = createDirectorApi(editor);

		// No updateBrief({ durationSec }) call at all — the no-target case.
		const reel = director.getReel();
		expect(reel.targetDurationSec).toBeUndefined();
	});

	it("chooseTake appends the given rationale to the durable brief", () => {
		const { editor, readBrief } = makeEditor();
		const director = createDirectorApi(editor);

		const result = director.chooseTake({
			slotId: "slot_1",
			index: 1,
			rationale: "user prefers the warmer, handheld take",
		});

		expect(result.ok).toBe(true);
		expect(readBrief().notes).toContain(
			"user prefers the warmer, handheld take",
		);
	});

	it("chooseTake without a rationale still records a factual learned note", () => {
		const { editor, readBrief } = makeEditor();
		const director = createDirectorApi(editor);

		director.chooseTake({ slotId: "slot_1", index: 0 });

		const notes = readBrief().notes ?? [];
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/^Chose take 1\/2 for "founder sips coffee/);
	});
});

describe("director brief — injected into the system prompt across turns", () => {
	it("a preference stated in turn 1 rides in the prompt built on a later turn", () => {
		const { editor } = makeEditor();
		const director = createDirectorApi(editor);

		// Turn 1: the user states creative intent; the agent records it.
		director.updateBrief({ goal: "drive signups", tone: "warm, handheld" });

		// Turn 2: an unrelated edit that also teaches a preference.
		director.chooseTake({
			slotId: "slot_1",
			index: 1,
			rationale: "keep the handheld, warmer look",
		});

		// Turn 3: the prompt is rebuilt from durable state — the earlier intent is
		// present, so it shapes what the model generates next.
		const prompt = buildFrontierSystemPrompt(director);
		expect(prompt).toContain("DIRECTOR BRIEF");
		expect(prompt).toContain("GOAL: drive signups");
		expect(prompt).toContain("warm, handheld");
		expect(prompt).toContain("keep the handheld, warmer look");
	});

	it("shows the empty-brief nudge before any preference is set", () => {
		const { editor } = makeEditor();
		const director = createDirectorApi(editor);
		expect(buildFrontierSystemPrompt(director)).toMatch(
			/DIRECTOR BRIEF[\s\S]*empty/i,
		);
	});

	it("folds a built-vs-target pacing clause into the REEL digest when a target duration is set", () => {
		const { editor } = makeEditor();
		const director = createDirectorApi(editor);
		director.updateBrief({ durationSec: 60 });

		const prompt = buildFrontierSystemPrompt(director);
		// Fake editor's timeline stubs totalDuration=6 and one slot.
		expect(prompt).toContain("REEL (1 slots, 6.0s / 60s target):");
	});

	it("leaves the REEL digest's duration exactly as before when no target duration is set", () => {
		const { editor } = makeEditor();
		const director = createDirectorApi(editor);

		const prompt = buildFrontierSystemPrompt(director);
		expect(prompt).toContain("REEL (1 slots, 6.0s):");
		expect(prompt).not.toContain("s target)"); // no pacing clause appended
	});

	it("the brief survives a reload and still shapes the prompt", () => {
		const { editor } = makeEditor();
		const director = createDirectorApi(editor);
		director.updateBrief({ tone: "warm, handheld" });

		// Persist → reload: a brand-new editor/session loads the saved brief
		// (structured-clone boundary modeled by JSON round-trip).
		const saved = director.getBrief().data as DirectorBrief;
		const { editor: reloadedEditor } = makeEditor();
		reloadedEditor.project.setDirectorBrief({
			brief: JSON.parse(JSON.stringify(saved)),
		});
		const reloadedDirector = createDirectorApi(reloadedEditor);

		expect(buildFrontierSystemPrompt(reloadedDirector)).toContain(
			"warm, handheld",
		);
	});
});
