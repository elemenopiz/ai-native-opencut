import { describe, expect, it } from "bun:test";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor } from "./fake-editor";
import type { GenerateExecutor } from "./types";

/**
 * Agent-scoped undo (A2, poach: palmier-mcp-schema-spec.md §"Agent-scoped
 * undo"). Integration coverage over a REAL `DirectorApi` + `fake-editor.ts`'s
 * real `CommandManager` wiring: every verb call lands as one origin-"agent"
 * named undo entry, `undo()`/`redo()` refuse to act on the user's own edits,
 * and the choke point (`withAgentOrigin` in `director-api.ts`) requires no
 * per-verb code to get there.
 */

const fastRecovery = { sleep: async () => {} };

function readyExecutor(): GenerateExecutor {
	return {
		run: async ({ takeId }) => ({
			status: "ready",
			mediaId: `media-${takeId}`,
		}),
	};
}

/** Simulate a manual UI edit: a bare `execute()` OUTSIDE any Director verb
 * call, exactly like `TimelineManager` methods do for a human-driven action —
 * no transaction, no ambient origin, so it lands tagged "user" (the default
 * `CommandManager` behavior existing UI paths need no churn for). */
function simulateUserEdit(editor: ReturnType<typeof makeFakeEditor>["editor"]) {
	editor.command.execute({
		command: {
			execute: () => {},
			undo: () => {},
			redo: () => {},
			getDescription: () => "Manual user edit",
			// biome-ignore lint/suspicious/noExplicitAny: minimal duck-typed Command for the test
		} as any,
	});
}

describe("Director agent-scoped undo — origin tagging", () => {
	it('a Director verb call lands tagged "agent" with no per-verb wiring', () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor);

		const res = d.reserveSlot({ prompt: "a lighthouse at dusk", duration: 5 });
		expect(res.ok).toBe(true);
		expect(editor.command.peekUndoOrigin()).toBe("agent");
		expect(editor.command.peekUndoName()).toBe("reserveSlot");
	});

	it('a manual (non-Director) command execution defaults to "user"', () => {
		const { editor } = makeFakeEditor();
		simulateUserEdit(editor);
		expect(editor.command.peekUndoOrigin()).toBe("user");
	});

	it('an external MCP call relays through the SAME DirectorApi, so it inherits "agent" for free (no separate origin plumbing needed for MCP)', () => {
		// The MCP bridge calls whatever `createDirectorApi` returns — there is no
		// second code path. Exercising the returned API object directly IS the
		// MCP-relay case; this test documents/locks that equivalence.
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor);
		d.reserveSlot({ prompt: "mcp-relayed shot", duration: 5 });
		expect(editor.command.peekUndoOrigin()).toBe("agent");
	});
});

describe("Director agent-scoped undo — refusal", () => {
	it("undo() refuses when the top of the stack is the user's edit", () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor);

		d.reserveSlot({ prompt: "agent shot", duration: 5 }); // origin "agent"
		simulateUserEdit(editor); // origin "user", now on top

		const res = d.undo();
		expect(res.ok).toBe(false);
		expect(res.message).toContain("the most recent edit is the user's");
		// Refused ⇒ nothing was undone.
		expect(editor.command.getHistoryLength()).toBe(2);
	});

	it("undo() succeeds and undoes exactly one step when the top is the agent's own edit", () => {
		const { editor, tracks } = makeFakeEditor();
		const d = createDirectorApi(editor);

		d.reserveSlot({ prompt: "shot one", duration: 5 });
		d.reserveSlot({ prompt: "shot two", duration: 5 });
		expect(editor.command.getHistoryLength()).toBe(2);
		const totalBefore = tracks.flatMap((t) => t.elements).length;
		expect(totalBefore).toBe(2);

		const res = d.undo();
		expect(res.ok).toBe(true);
		expect(res.message).toContain("Undid");
		// Stale-state note (A2 requirement 3).
		expect(res.message).toContain("may now be stale");
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(tracks.flatMap((t) => t.elements).length).toBe(1);
	});

	it("redo() refuses the mirror case: the most recently undone edit is the user's", () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor);

		simulateUserEdit(editor);
		editor.command.undo(); // now on the redo stack, origin "user"

		const res = d.redo();
		expect(res.ok).toBe(false);
		expect(res.message).toContain(
			"the most recently undone edit is the user's",
		);
	});

	it("redo() succeeds when the most recently undone edit was the agent's own", () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor);

		d.reserveSlot({ prompt: "a shot", duration: 5 });
		d.undo();
		const res = d.redo();
		expect(res.ok).toBe(true);
	});

	it('undo()/redo() report "nothing to undo/redo" on an empty stack (unchanged baseline behavior)', () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor);
		expect(d.undo().message).toBe("Nothing to undo.");
		expect(d.redo().message).toBe("Nothing to redo.");
	});
});

describe("Director agent-scoped undo — atomicity", () => {
	it("storyboard (many synchronous mutations) lands as exactly ONE history entry", () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor);

		const res = d.storyboard({
			shots: [
				{ prompt: "wide establishing shot", duration: 4 },
				{ prompt: "close-up on the hero", duration: 3 },
				{ prompt: "payoff shot", duration: 5 },
			],
		});
		expect(res.ok).toBe(true);
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.command.peekUndoOrigin()).toBe("agent");
		expect(editor.command.peekUndoName()).toBe("storyboard");

		// One undo removes ALL three shots, not just the last mutation.
		editor.command.undo();
		expect(d.getReel().slots.length).toBe(0);
	});

	it('generate\'s synchronous "no executor" placeholder batch lands as ONE entry, not one per take', async () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor); // no executor injected
		const slot = d.reserveSlot({ prompt: "a bee on a flower", duration: 4 });
		const slotId = slot.data?.slotId as string;
		expect(editor.command.getHistoryLength()).toBe(1); // reserveSlot's own entry

		const res = await d.generate({ slotIds: [slotId], alternatives: 3 });
		expect(res.ok).toBe(true);
		expect(res.data?.slotIds).toEqual([slotId]);
		// reserveSlot (1) + generate's whole 3-take placeholder batch (1) = 2.
		expect(editor.command.getHistoryLength()).toBe(2);
		expect(editor.command.peekUndoOrigin()).toBe("agent");
	});

	it("remix's pre-generation (queue) and post-generation (result) clusters each land as ONE entry — not one per mutation inside them", async () => {
		const { editor } = makeFakeEditor();
		const executor = readyExecutor();
		const d = createDirectorApi(editor, { executor, recovery: fastRecovery });
		const slot = d.reserveSlot({ prompt: "a red kite", duration: 4 });
		const slotId = slot.data?.slotId as string;
		await d.generate({ slotIds: [slotId] });
		const afterGenerate = editor.command.getHistoryLength();

		const res = await d.remix({ slotId, remixPrompt: "make it windier" });
		expect(res.ok).toBe(true);
		// remix does two mutations (addTakeToElement+updateTake "generating", then
		// updateTake-result+selectTake) separated by the REAL executor.run() await
		// — each cluster is `withAgentBatch`-wrapped into its own entry (2 total),
		// never leaking beyond that pair-per-cluster. Collapsing these two into a
		// single entry would mean holding a transaction open across that await —
		// the exact hazard `withAgentOrigin`'s doc comment explains (a concurrent
		// command could get swept into the wrong undo group); documented residual
		// gap, not a bug.
		expect(editor.command.getHistoryLength()).toBe(afterGenerate + 2);
		expect(editor.command.peekUndoOrigin()).toBe("agent");
	});
});

describe("Director agent-scoped undo — mutation delta on the atomicity-patched verbs", () => {
	it("generate still returns a MutationDelta after the atomicity batching fix", async () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor);
		const slot = d.reserveSlot({ prompt: "a paper boat", duration: 4 });
		const slotId = slot.data?.slotId as string;

		const res = await d.generate({ slotIds: [slotId] });
		expect(res.ok).toBe(true);
		expect(res.delta).toBeDefined();
		expect(res.delta?.changed?.some((s) => s.id === slotId)).toBe(true);
	});

	it("remix still returns a MutationDelta after the atomicity batching fix", async () => {
		const { editor } = makeFakeEditor();
		const executor = readyExecutor();
		const d = createDirectorApi(editor, { executor, recovery: fastRecovery });
		const slot = d.reserveSlot({ prompt: "a paper boat", duration: 4 });
		const slotId = slot.data?.slotId as string;
		await d.generate({ slotIds: [slotId] });

		const res = await d.remix({ slotId, remixPrompt: "add fog" });
		expect(res.ok).toBe(true);
		expect(res.delta).toBeDefined();
	});
});
