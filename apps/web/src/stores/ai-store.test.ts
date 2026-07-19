import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DirectorConversationMessage } from "@/services/storage/director-conversation-store";
import { getConversationHistoryForAgent, useAIStore } from "./ai-store";

// `resetForProjectSwitch` clears both the store's conversation fields AND the
// module-scoped persistence bookkeeping (truncated prefix, message
// timestamps, pending debounce timer) — using it as setup/teardown here gives
// every test a clean slate without exposing those internals just for tests.
beforeEach(() => {
	useAIStore.getState().resetForProjectSwitch();
});
afterEach(() => {
	useAIStore.getState().resetForProjectSwitch();
});

function msg(
	id: string,
	role: "user" | "assistant",
	content: string,
	createdAt: number,
): DirectorConversationMessage {
	return { id, role, content, createdAt };
}

describe("ai-store — conversation-switch logic (Director-revamp Item 9, F-local)", () => {
	it("ensureConversation mints a fresh id when none is attached yet", () => {
		expect(useAIStore.getState().currentConversationId).toBeNull();
		const id = useAIStore.getState().ensureConversation("proj-a");
		expect(id).toBeTruthy();
		expect(useAIStore.getState().currentConversationId).toBe(id);
		expect(useAIStore.getState().currentConversationProjectId).toBe("proj-a");
	});

	it("ensureConversation is a no-op when already attached to the same project", () => {
		const first = useAIStore.getState().ensureConversation("proj-a");
		const second = useAIStore.getState().ensureConversation("proj-a");
		expect(second).toBe(first);
	});

	it("ensureConversation mints a NEW id when the project differs (no bleed)", () => {
		const first = useAIStore.getState().ensureConversation("proj-a");
		useAIStore.getState().addStudioMessage({
			id: "m1",
			role: "user",
			content: "hello project A",
		});
		const second = useAIStore.getState().ensureConversation("proj-b");
		expect(second).not.toBe(first);
		expect(useAIStore.getState().currentConversationProjectId).toBe("proj-b");
	});

	it("addStudioMessage appends and updateStudioMessage edits in place", () => {
		useAIStore.getState().ensureConversation("proj-a");
		useAIStore
			.getState()
			.addStudioMessage({ id: "m1", role: "user", content: "hi" });
		useAIStore.getState().addStudioMessage({
			id: "m2",
			role: "assistant",
			kind: "text",
			content: "",
		});
		useAIStore.getState().updateStudioMessage("m2", "hello there");

		const { studioMessages } = useAIStore.getState();
		expect(studioMessages.map((m) => m.content)).toEqual(["hi", "hello there"]);
	});

	it("startNewConversation clears the live view but leaves currentConversationId lazy (null)", () => {
		useAIStore.getState().ensureConversation("proj-a");
		useAIStore
			.getState()
			.addStudioMessage({ id: "m1", role: "user", content: "hi" });
		expect(useAIStore.getState().studioMessages.length).toBe(1);

		useAIStore.getState().startNewConversation("proj-a");

		expect(useAIStore.getState().studioMessages).toEqual([]);
		expect(useAIStore.getState().currentConversationId).toBeNull();
		expect(useAIStore.getState().currentConversationProjectId).toBe("proj-a");
	});

	it("clearStudioMessages behaves like startNewConversation for the CURRENT project (backward-compatible zero-arg call)", () => {
		useAIStore.getState().ensureConversation("proj-a");
		useAIStore
			.getState()
			.addStudioMessage({ id: "m1", role: "user", content: "hi" });

		useAIStore.getState().clearStudioMessages();

		expect(useAIStore.getState().studioMessages).toEqual([]);
		expect(useAIStore.getState().currentConversationId).toBeNull();
		// It's a fresh conversation, not a destroyed one — the old messages
		// still exist wherever they were persisted (director-conversation-store
		// covers the actual persistence round-trip); this store-level test only
		// asserts the LIVE view resets, not IndexedDB (unavailable here).
		expect(useAIStore.getState().currentConversationProjectId).toBe("proj-a");
	});

	it("resetForProjectSwitch clears everything, including the project association (no bleed across a project switch)", () => {
		useAIStore.getState().ensureConversation("proj-a");
		useAIStore
			.getState()
			.addStudioMessage({ id: "m1", role: "user", content: "hi" });

		useAIStore.getState().resetForProjectSwitch();

		expect(useAIStore.getState().studioMessages).toEqual([]);
		expect(useAIStore.getState().currentConversationId).toBeNull();
		expect(useAIStore.getState().currentConversationProjectId).toBeNull();
	});
});

describe("ai-store — openConversation replay-cap wiring", () => {
	it("replays everything verbatim with no truncation notice when under the cap", () => {
		const messages = Array.from({ length: 5 }, (_, i) =>
			msg(`m${i}`, i % 2 === 0 ? "user" : "assistant", `turn ${i}`, i),
		);
		useAIStore.getState().openConversation({
			id: "conv-1",
			projectId: "proj-a",
			title: "A short chat",
			createdAt: 1,
			updatedAt: 5,
			messages,
		});

		const {
			studioMessages,
			currentConversationId,
			currentConversationProjectId,
		} = useAIStore.getState();
		expect(currentConversationId).toBe("conv-1");
		expect(currentConversationProjectId).toBe("proj-a");
		expect(studioMessages.length).toBe(5);
		expect(
			studioMessages.some(
				(m) => m.kind === "step" && m.content.startsWith("Earlier"),
			),
		).toBe(false);
	});

	it("prepends a deterministic truncation notice and caps replay at REPLAY_VERBATIM_MESSAGE_COUNT when over it", () => {
		const total = 27; // REPLAY_VERBATIM_MESSAGE_COUNT (20) + 7
		const messages = Array.from({ length: total }, (_, i) =>
			msg(`m${i}`, i % 2 === 0 ? "user" : "assistant", `turn ${i}`, i),
		);
		useAIStore.getState().openConversation({
			id: "conv-2",
			projectId: "proj-a",
			title: "A long chat",
			createdAt: 1,
			updatedAt: total,
			messages,
		});

		const { studioMessages } = useAIStore.getState();
		// 20 replayed messages + 1 synthetic notice row.
		expect(studioMessages.length).toBe(21);
		const notice = studioMessages[0];
		expect(notice?.kind).toBe("step");
		expect(notice?.content).toContain("Earlier messages summarized");
		expect(notice?.content).toContain("7 message");
		// The visible tail is the LAST 20 messages, most recent last.
		expect(studioMessages[1]?.id).toBe("m7");
		expect(studioMessages.at(-1)?.id).toBe(`m${total - 1}`);
	});

	it("reopening a different conversation replaces the live view entirely (no bleed between conversations)", () => {
		useAIStore.getState().openConversation({
			id: "conv-1",
			projectId: "proj-a",
			title: "First",
			createdAt: 1,
			updatedAt: 2,
			messages: [msg("a", "user", "first chat", 1)],
		});
		useAIStore.getState().openConversation({
			id: "conv-2",
			projectId: "proj-a",
			title: "Second",
			createdAt: 3,
			updatedAt: 4,
			messages: [msg("b", "user", "second chat", 3)],
		});

		const { studioMessages, currentConversationId } = useAIStore.getState();
		expect(currentConversationId).toBe("conv-2");
		expect(studioMessages).toEqual([
			{ id: "b", role: "user", content: "second chat" },
		]);
	});
});

describe("ai-store — getConversationHistoryForAgent seam", () => {
	it("is empty with no live conversation", () => {
		expect(getConversationHistoryForAgent()).toEqual([]);
	});

	it("includes both the truncated prefix and the visible messages, excluding the notice row", () => {
		const total = 22; // 2 over the 20-message replay cap
		const messages = Array.from({ length: total }, (_, i) =>
			msg(`m${i}`, i % 2 === 0 ? "user" : "assistant", `turn ${i}`, i),
		);
		useAIStore.getState().openConversation({
			id: "conv-3",
			projectId: "proj-a",
			title: "chat",
			createdAt: 1,
			updatedAt: total,
			messages,
		});

		const history = getConversationHistoryForAgent();
		// All 22 original messages ride the seam (prefix + visible), NONE
		// dropped and no synthetic notice row mixed in — this is what
		// `runDirectorAgent` would receive as prior turns once it grows a
		// `priorMessages` param (see the seam's doc comment in ai-store.ts).
		expect(history.length).toBe(total);
		expect(history[0]).toEqual({ role: "user", content: "turn 0" });
		// total - 1 = 21, odd → "assistant" (messages alternate user/assistant
		// starting from "user" at index 0).
		expect(history.at(-1)).toEqual({
			role: "assistant",
			content: `turn ${total - 1}`,
		});
		expect(history.some((m) => m.content.includes("Earlier"))).toBe(false);
	});
});
