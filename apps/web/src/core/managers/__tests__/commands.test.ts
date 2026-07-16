import { describe, expect, it } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import type { Command } from "@/lib/commands";

/**
 * Origin tagging + nested-transaction semantics (A2, poach:
 * palmier-mcp-schema-spec.md §"Agent-scoped undo"). These are unit tests on
 * `CommandManager` in isolation — no `EditorCore`/Director needed — covering
 * the primitive the Director choke point (`director-api.ts`'s
 * `withAgentOrigin`/`withAgentBatch`) is built on.
 */

let seq = 0;
function fakeCommand(label = "cmd"): Command {
	const id = ++seq;
	let applied = false;
	return {
		execute: () => {
			applied = true;
		},
		undo: () => {
			applied = false;
		},
		redo: () => {
			applied = true;
		},
		getDescription: () => `${label}#${id}`,
		// exposed for assertions only
		isApplied: () => applied,
	} as unknown as Command & { isApplied: () => boolean };
}

describe("CommandManager origin tagging", () => {
	it('defaults a plain execute() to origin "user" (existing UI paths need no churn)', () => {
		const cm = new CommandManager();
		cm.execute({ command: fakeCommand() });
		expect(cm.peekUndoOrigin()).toBe("user");
	});

	it('tags a transaction explicitly opened with origin "agent"', () => {
		const cm = new CommandManager();
		cm.beginTransaction({ origin: "agent", name: "testVerb" });
		cm.execute({ command: fakeCommand() });
		cm.commitTransaction();
		expect(cm.peekUndoOrigin()).toBe("agent");
		expect(cm.peekUndoName()).toBe("testVerb");
	});

	it("pushOrigin tags lone (non-transactional) commands without batching them", () => {
		const cm = new CommandManager();
		const pop = cm.pushOrigin("agent", "generate");
		cm.execute({ command: fakeCommand() });
		cm.execute({ command: fakeCommand() });
		pop();
		// Two SEPARATE entries, not one batch — pushOrigin never groups.
		expect(cm.getHistoryLength()).toBe(2);
		expect(cm.peekUndoOrigin()).toBe("agent");
	});

	it("pop() only affects commands executed while it was active", () => {
		const cm = new CommandManager();
		const pop = cm.pushOrigin("agent");
		cm.execute({ command: fakeCommand() });
		pop();
		cm.execute({ command: fakeCommand() }); // after pop → back to "user"
		expect(cm.peekUndoOrigin()).toBe("user");
		cm.undo();
		expect(cm.peekUndoOrigin()).toBe("agent");
	});
});

describe("CommandManager nested transactions", () => {
	it("an inner beginTransaction()/commitTransaction() (no meta) nests inside an outer agent-tagged one — ONE history entry, outer origin/name wins", () => {
		const cm = new CommandManager();
		cm.beginTransaction({ origin: "agent", name: "storyboard" });
		cm.execute({ command: fakeCommand() });
		// A verb's own explicit wrap (mirrors storyboard/acceptProposal/reorder).
		cm.beginTransaction();
		cm.execute({ command: fakeCommand() });
		cm.execute({ command: fakeCommand() });
		cm.commitTransaction(); // inner commit: merges into outer, no flush yet
		expect(cm.getHistoryLength()).toBe(0);
		cm.commitTransaction(); // outer commit: NOW it flushes
		expect(cm.getHistoryLength()).toBe(1);
		expect(cm.peekUndoOrigin()).toBe("agent");
		expect(cm.peekUndoName()).toBe("storyboard");
	});

	it("an inner rollbackTransaction() discards only its own frame, not the outer one", () => {
		const cm = new CommandManager();
		cm.beginTransaction({ origin: "agent", name: "storyboard" });
		cm.execute({ command: fakeCommand() }); // survives (outer frame)
		cm.beginTransaction();
		cm.execute({ command: fakeCommand() }); // discarded (inner frame)
		cm.rollbackTransaction();
		cm.commitTransaction();
		expect(cm.getHistoryLength()).toBe(1);
		expect(cm.peekUndoOrigin()).toBe("agent");
	});

	it('beginTransaction() with no meta, called while an ambient agent origin is active, inherits it (so a synchronous cluster wrapped post-await still tags "agent")', () => {
		const cm = new CommandManager();
		const pop = cm.pushOrigin("agent", "remix");
		cm.beginTransaction();
		cm.execute({ command: fakeCommand() });
		cm.execute({ command: fakeCommand() });
		cm.commitTransaction();
		pop();
		expect(cm.getHistoryLength()).toBe(1); // batched into ONE entry
		expect(cm.peekUndoOrigin()).toBe("agent");
		expect(cm.peekUndoName()).toBe("remix");
	});

	it("a multi-command transaction commits as exactly one history entry", () => {
		const cm = new CommandManager();
		cm.beginTransaction({ origin: "agent", name: "storyboard" });
		cm.execute({ command: fakeCommand() });
		cm.execute({ command: fakeCommand() });
		cm.execute({ command: fakeCommand() });
		cm.commitTransaction();
		expect(cm.getHistoryLength()).toBe(1);
	});
});

describe("CommandManager undo/redo origin bookkeeping", () => {
	it("moves the origin-tagged entry between the undo and redo stacks intact", () => {
		const cm = new CommandManager();
		cm.beginTransaction({ origin: "agent", name: "trim" });
		cm.execute({ command: fakeCommand() });
		cm.commitTransaction();
		cm.undo();
		expect(cm.peekRedoOrigin()).toBe("agent");
		cm.redo();
		expect(cm.peekUndoOrigin()).toBe("agent");
	});
});
