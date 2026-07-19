import { describe, expect, it } from "bun:test";
import type { Command } from "@/lib/commands";
import { resolvePendingRefsInArgs } from "./director-api";
import { makeFakeEditor, type FakeEditor } from "./fake-editor";

/**
 * SE-4 tests for `director-api.ts`'s `draftCut` wiring:
 *  - `resolvePendingRefsInArgs` (module-scope, pure — see its own doc comment
 *    in `director-api.ts`) unit-tested directly with plain objects, no editor
 *    needed.
 *  - `draftCut`'s happy path, wired against a real `DirectorApi` over
 *    `fake-editor.ts`'s in-memory editor — proving the FULL pending-ref
 *    round trip (an `addClip` op followed by a `trim` op addressing
 *    `@pending:<index>`) resolves to the real element id end to end, lands
 *    as exactly ONE undo entry tagged `"agent"`/`"draftCut"`, and produces
 *    the stage-6 chat-summary string.
 *
 * NO real model call anywhere here: `storyEngine.relay` is a scripted async
 * function returning a fixed Treatment JSON string, same "mock only the
 * seam, never the network" discipline `evals/runner.ts` documents.
 */

const { createDirectorApi } = await import("./director-api");

// ── resolvePendingRefsInArgs — pure unit tests ──────────────────────────

describe("resolvePendingRefsInArgs", () => {
	it("substitutes a pending-ref token with the real element id", () => {
		const refs = new Map([[0, "el_real_abc"]]);
		const result = resolvePendingRefsInArgs(
			{ slotId: "@pending:0", trimStart: 5, trimEnd: 25 },
			refs,
		);
		expect(result).toEqual({
			args: { slotId: "el_real_abc", trimStart: 5, trimEnd: 25 },
		});
	});

	it("leaves non-pending-ref args untouched", () => {
		const result = resolvePendingRefsInArgs(
			{ slotId: "el_already_real", startTime: 3 },
			new Map(),
		);
		expect(result).toEqual({
			args: { slotId: "el_already_real", startTime: 3 },
		});
	});

	it("reports an error for a ref that never resolved (no earlier addClip produced it)", () => {
		const result = resolvePendingRefsInArgs(
			{ slotId: "@pending:9" },
			new Map(),
		);
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("@pending:9");
			expect(result.error).toContain("never resolved");
		}
	});

	it("resolves multiple pending refs across multiple arg keys in one call", () => {
		const refs = new Map([
			[0, "el_a"],
			[1, "el_b"],
		]);
		const result = resolvePendingRefsInArgs(
			{ slotId: "@pending:1", anchorId: "@pending:0" },
			refs,
		);
		expect(result).toEqual({ args: { slotId: "el_b", anchorId: "el_a" } });
	});

	it("a malformed pending-ref index (non-integer) is treated as unresolved", () => {
		const result = resolvePendingRefsInArgs(
			{ slotId: "@pending:not-a-number" },
			new Map([[0, "el_a"]]),
		);
		expect("error" in result).toBe(true);
	});
});

// ── draftCut happy path (real DirectorApi over fake-editor.ts) ──────────

interface FakeMediaAsset {
	id: string;
	type: "video" | "image" | "audio";
	name: string;
	duration: number;
}

/** Patches `fake.editor.media` (hardcoded empty by default — see `fake-editor.ts`) with a fixed asset list, mirroring `evals/fixtures.ts`'s `patchTrim`-style local extension convention (README: "add a sibling patchX() following the same shape"). */
function patchMedia(fake: FakeEditor, assets: FakeMediaAsset[]): void {
	const media = fake.editor.media as unknown as {
		getAssets: () => unknown[];
		getAssetById: (id: string) => unknown;
	};
	media.getAssets = () => assets;
	media.getAssetById = (id: string) => assets.find((a) => a.id === id);
}

/** Same lighter, self-contained `updateElementTrim` patch `evals/fixtures.ts`'s `patchTrim` uses — a direct element mutation wrapped in a real `Command` (undo/redo intact), not the full `EditorCore.getInstance()` singleton dance `director-craft.test.ts` uses for testing the production trim command's OWN semantics (irrelevant here — this file only needs pending-ref substitution + one clean apply). */
function patchTrim(fake: FakeEditor): void {
	const timeline = fake.editor.timeline as unknown as {
		updateElementTrim: (input: {
			elementId: string;
			trimStart: number;
			trimEnd: number;
			startTime?: number;
			duration?: number;
		}) => void;
	};
	timeline.updateElementTrim = (input) => {
		const located = fake.find(input.elementId);
		if (!located) return;
		const { element } = located;
		const prev = { ...element };
		const command: Command = {
			execute: () => {
				element.trimStart = input.trimStart;
				element.trimEnd = input.trimEnd;
				if (input.startTime !== undefined) element.startTime = input.startTime;
				if (input.duration !== undefined) element.duration = input.duration;
			},
			undo: () => {
				element.trimStart = prev.trimStart;
				element.trimEnd = prev.trimEnd;
				element.startTime = prev.startTime;
				element.duration = prev.duration;
			},
			redo() {
				this.execute();
			},
			getDescription: () => "Trim element",
		} as Command;
		fake.editor.command.execute({ command });
	};
}

const TREATMENT_JSON = JSON.stringify({
	logline: "A quick pitch recap.",
	sections: [{ intent: "hook", targetSec: 20, materialRefs: ["a1"], order: 0 }],
});

function setupDraftCutFixture() {
	const fake = makeFakeEditor();
	patchMedia(fake, [
		{ id: "a1", type: "video", name: "pitch.mp4", duration: 30 },
	]);
	patchTrim(fake);

	const director = createDirectorApi(fake.editor, {
		// A single segment starting at 5s (not 0) forces the radio-cut planner
		// to emit an addClip THEN a trim re-windowing it via a pending ref (see
		// `story/assembly.ts`'s "THE PENDING REF PROBLEM") — exercising the
		// exact path `resolvePendingRefsInArgs` resolves.
		transcripts: (mediaId) =>
			mediaId === "a1"
				? {
						mediaId: "a1",
						segments: [{ start: 5, end: 25, text: "here's the pitch" }],
						language: "en",
						durationSec: 30,
						engine: "test",
						createdAt: 0,
					}
				: undefined,
		storyEngine: {
			relay: async () => TREATMENT_JSON,
			getUnderstanding: async () => [],
		},
	});

	return { fake, director };
}

describe("draftCut — happy path over a real DirectorApi", () => {
	it("resolves the addClip→trim pending ref, applies as ONE undo entry, and produces the stage-6 summary", async () => {
		const { fake, director } = setupDraftCutFixture();
		const historyLengthBefore = fake.editor.command.getHistoryLength();

		const result = await director.draftCut({
			instruction: "make me a quick pitch recap",
			targetSec: 20,
		});

		expect(result.ok).toBe(true);
		expect(result.data?.stage).toBe("present");
		expect(result.data?.summary).toBe(result.message);
		expect(result.message).toMatch(
			/^Cut a \d+s draft from 1 clip — led with the hook\./,
		);

		// Exactly one new timeline element, with the trim's pending ref resolved
		// to a REAL element id (not the literal "@pending:0" token) and the
		// correct in/out points from the transcript segment.
		const allElements = fake.tracks.flatMap((t) => t.elements);
		expect(allElements).toHaveLength(1);
		const [placed] = allElements;
		expect(placed.mediaId).toBe("a1");
		expect(placed.trimStart).toBe(5);
		expect(placed.trimEnd).toBe(25);
		expect(placed.duration).toBe(20);

		// ONE undo entry, tagged agent/draftCut — the whole run is one Director turn.
		expect(fake.editor.command.getHistoryLength()).toBe(
			historyLengthBefore + 1,
		);
		expect(fake.editor.command.peekUndoOrigin()).toBe("agent");
		expect(fake.editor.command.peekUndoName()).toBe("draftCut");
	});

	it("fails gracefully (never throws) when no relay is configured", async () => {
		const fake = makeFakeEditor();
		patchMedia(fake, [
			{ id: "a1", type: "video", name: "pitch.mp4", duration: 30 },
		]);
		const director = createDirectorApi(fake.editor, {});

		const result = await director.draftCut({ instruction: "cut it" });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("not configured");
		expect(fake.tracks.flatMap((t) => t.elements)).toHaveLength(0);
	});
});
