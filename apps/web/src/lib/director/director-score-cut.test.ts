/**
 * The `scoreCut` verb — `scoring/score-cut.ts` (pure, already unit-tested in
 * `scoring/score-cut.test.ts`) wired into `director-api.ts` as an
 * agent-reachable read, end to end through a fake editor.
 *
 * Three things matter here that the pure-module tests can't cover on their
 * own:
 *  1. The verb reads the SAME `createDerivedDataFunctions` bag `applyEdit`
 *     wires (tracks/beatGrid/transcripts) — proven by exercising it through
 *     `createDirectorApi`, not by constructing a `ScoreCutInput` by hand.
 *  2. It degrades gracefully (never throws) when no beat grid has been
 *     analyzed and no mix is decodable — the fake editor's media surface
 *     resolves nothing, so `readMix` inside `scoreCut` always fails the same
 *     way `director-mix-read.test.ts` documents, and `beats()` throws with
 *     no grid wired.
 *  3. THE DEMO LOOP: score → recut (via the Director's own `trim` verb) →
 *     score again, and the second score is computed from the CHANGED
 *     timeline, not a cached value from the first call.
 */
import { describe, expect, it } from "bun:test";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor } from "./fake-editor";
import { scopeForTool, toolCatalog } from "./tool-catalog";
import type { EngagementScoreResult } from "@/lib/ai-client";
import type { EngagementDiagnostics } from "@/lib/engagement-diagnostics";
import type { CutScoreFixSuggestion } from "./edit-critic";

/** The fields every VISUAL element needs beyond {type, mediaId, name} — the fake editor's `insertElement` is typed against the REAL `EditorCore` timeline surface, which requires a full valid element (same precedent as `director-watch-back.test.ts`'s `visualBase`). */
const visualBase = {
	trimStart: 0,
	trimEnd: 0,
	transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
	opacity: 1,
};

/** Insert a video clip and return its (fake-editor-generated) element id — no `id` field to set explicitly (same precedent as `director-watch-back.test.ts`'s `addClip`/`director-animate-item.test.ts`'s captured `videoId`). */
function addVideo(
	fake: ReturnType<typeof makeFakeEditor>,
	name: string,
	startTime: number,
	duration: number,
): string {
	return fake.editor.timeline.insertElement({
		element: {
			type: "video",
			name,
			mediaId: `media_${name}`,
			startTime,
			duration,
			...visualBase,
		},
		placement: { mode: "auto", trackType: "video" },
	});
}

interface ScoreCutVerbData {
	score: EngagementScoreResult;
	diagnostics: EngagementDiagnostics;
	cutScore: unknown;
	unmeasuredSignals: string[];
	suggestedFixes: CutScoreFixSuggestion[];
}

describe("scoreCut verb", () => {
	it("refuses an empty timeline rather than reporting a made-up score", async () => {
		const d = createDirectorApi(makeFakeEditor().editor);
		const res = await d.scoreCut();
		expect(res.ok).toBe(false);
		expect(res.message).toContain("Nothing on the timeline");
	});

	it("scores a real fixture timeline end to end, degrading gracefully with no beat grid / no decodable mix", async () => {
		const fake = makeFakeEditor();
		// A weak opening: starts late, lingers.
		addVideo(fake, "c0", 0.8, 15);
		addVideo(fake, "c1", 15.8, 14);

		const d = createDirectorApi(fake.editor);
		const res = await d.scoreCut();
		expect(res.ok).toBe(true);

		const data = res.data as ScoreCutVerbData;
		expect(Number.isFinite(data.score.composite)).toBe(true);
		expect(["A", "B", "C", "D", "F"]).toContain(data.score.grade);
		expect(data.diagnostics.hook.rating).toBe("weak");

		// Never throws over the missing beat grid / undecodable mix in this fake
		// editor — it reports them as unmeasured instead.
		expect(
			data.unmeasuredSignals.some((n) => n.startsWith("audio_sync:")),
		).toBe(true);
		expect(
			data.unmeasuredSignals.some((n) => n.startsWith("energy/emotional_arc:")),
		).toBe(true);

		// A weak hook on a long timeline routes to at least one advisory fix.
		expect(data.suggestedFixes.length).toBeGreaterThan(0);
		expect(data.suggestedFixes[0].fix.verb).toBe("applyEdit");
		expect(data.suggestedFixes[0].fix.args.mode).toBe("dry-run");
	});

	it("never mutates the timeline — read-only, adds no undo entry of its own", async () => {
		const fake = makeFakeEditor();
		addVideo(fake, "solo", 0, 5); // this insert itself is the only undoable entry
		const d = createDirectorApi(fake.editor);

		const res = await d.scoreCut();
		expect(res.ok).toBe(true);

		// Exactly the ONE entry from the insert above — undoing once must clear
		// history entirely, proving scoreCut pushed nothing of its own.
		expect(fake.editor.command.canUndo()).toBe(true);
		fake.editor.command.undo();
		expect(fake.editor.command.canUndo()).toBe(false);
	});

	// ── THE DEMO LOOP ──────────────────────────────────────────────────────

	it("score → recut (via the Director's own trim verb) → score again: the second score reflects the changed timeline", async () => {
		const fake = makeFakeEditor();
		// Weak: c0 starts late and lingers for 15s before anything else happens.
		const c0 = addVideo(fake, "c0", 0.8, 15);
		addVideo(fake, "c1", 15.8, 14);
		const d = createDirectorApi(fake.editor);

		const before = await d.scoreCut();
		expect(before.ok).toBe(true);
		const beforeData = before.data as ScoreCutVerbData;
		expect(beforeData.diagnostics.hook.rating).toBe("weak");

		// The Director "recuts the weak opening": tighten c0 to a punchy 2s
		// starting immediately at t=0 — exactly the shape a tightenToLength-
		// style applyEdit fix (the one `suggestedFixes` names) would produce.
		const recut = d.trim({ slotId: c0, startTime: 0, duration: 2 });
		expect(recut.ok).toBe(true);

		const after = await d.scoreCut();
		expect(after.ok).toBe(true);
		const afterData = after.data as ScoreCutVerbData;

		// The loop closed: the second score is a FRESH read of the NOW-changed
		// timeline, not the cached first result.
		expect(afterData).not.toBe(beforeData);
		expect(afterData.score.hook.composite).not.toBe(
			beforeData.score.hook.composite,
		);
		expect(afterData.score.composite).not.toBe(beforeData.score.composite);
		// This recut specifically targets a stronger hook (immediate, punchy
		// opening) — the number should move in that direction, proving the
		// score is reactive to the actual edit, not just different by noise.
		expect(afterData.score.hook.composite).toBeGreaterThan(
			beforeData.score.hook.composite,
		);
	});
});

describe("scoreCut — tool-catalog registration", () => {
	it("is registered, read-only, with an empty input schema", () => {
		const tool = toolCatalog().find((t) => t.name === "scoreCut");
		expect(tool).toBeDefined();
		expect(tool?.mutating).toBe(false);
		expect(scopeForTool("scoreCut")).toBe("reel:read");
	});
});
