import { describe, expect, it } from "bun:test";
import {
	REPLAY_VERBATIM_MESSAGE_COUNT,
	buildTruncationNotice,
	deriveConversationTitle,
	getConversation,
	listConversationsForProject,
	saveConversation,
	splitForReplay,
	type DirectorConversationMessage,
	type DirectorConversationRecord,
} from "./director-conversation-store";

// ── pure logic: no IndexedDB required, runs everywhere ──────────────────────

describe("deriveConversationTitle", () => {
	it("trims and collapses whitespace", () => {
		expect(
			deriveConversationTitle("  storyboard a  reel  about coffee  "),
		).toBe("storyboard a reel about coffee");
	});

	it("falls back to 'New chat' for empty input", () => {
		expect(deriveConversationTitle("   ")).toBe("New chat");
		expect(deriveConversationTitle("")).toBe("New chat");
	});

	it("truncates long first messages with an ellipsis", () => {
		const long = "a".repeat(120);
		const title = deriveConversationTitle(long);
		expect(title.length).toBe(60);
		expect(title.endsWith("…")).toBe(true);
	});
});

function msg(
	id: string,
	role: "user" | "assistant",
	content: string,
	createdAt: number,
): DirectorConversationMessage {
	return { id, role, content, createdAt };
}

describe("splitForReplay — reopen replay-cap policy", () => {
	it("replays everything verbatim when under the cap", () => {
		const messages = Array.from({ length: 5 }, (_, i) =>
			msg(`m${i}`, i % 2 === 0 ? "user" : "assistant", `turn ${i}`, i),
		);
		const split = splitForReplay(messages);
		expect(split.truncated).toBe(false);
		expect(split.prefix).toEqual([]);
		expect(split.visible).toEqual(messages);
	});

	it("keeps exactly REPLAY_VERBATIM_MESSAGE_COUNT visible when over the cap", () => {
		const total = REPLAY_VERBATIM_MESSAGE_COUNT + 7;
		const messages = Array.from({ length: total }, (_, i) =>
			msg(`m${i}`, i % 2 === 0 ? "user" : "assistant", `turn ${i}`, i),
		);
		const split = splitForReplay(messages);
		expect(split.truncated).toBe(true);
		expect(split.visible.length).toBe(REPLAY_VERBATIM_MESSAGE_COUNT);
		expect(split.prefix.length).toBe(7);
		// visible is the TAIL (most recent), prefix is the head (oldest).
		expect(split.visible[0]?.id).toBe(`m${7}`);
		expect(split.prefix[split.prefix.length - 1]?.id).toBe(`m${6}`);
		// No message is dropped or duplicated across the split.
		expect([...split.prefix, ...split.visible]).toEqual(messages);
	});

	it("is exactly at the boundary → not truncated", () => {
		const messages = Array.from(
			{ length: REPLAY_VERBATIM_MESSAGE_COUNT },
			(_, i) => msg(`m${i}`, "user", `turn ${i}`, i),
		);
		const split = splitForReplay(messages);
		expect(split.truncated).toBe(false);
		expect(split.visible.length).toBe(REPLAY_VERBATIM_MESSAGE_COUNT);
	});
});

describe("buildTruncationNotice", () => {
	it("is deterministic and reports counts + first-line topics", () => {
		const prefix = [
			msg("a", "user", "Storyboard a 3-shot reel about coffee\nextra", 1),
			msg("b", "assistant", "Sure, on it.", 2),
			msg("c", "user", "Generate all slots, 2 takes each", 3),
		];
		const notice = buildTruncationNotice(prefix);
		expect(notice).toContain("3 messages");
		expect(notice).toContain("2 earlier turns");
		expect(notice).toContain('"Storyboard a 3-shot reel about coffee"');
		expect(notice).toContain('"Generate all slots, 2 takes each"');
		// Never includes the assistant turn's content — only user-turn topics.
		expect(notice).not.toContain("Sure, on it.");
		// Pure — same input, same output.
		expect(buildTruncationNotice(prefix)).toBe(notice);
	});

	it("handles a prefix with no user turns gracefully", () => {
		const prefix = [msg("a", "assistant", "housekeeping note", 1)];
		const notice = buildTruncationNotice(prefix);
		expect(notice).toBe(
			"Earlier messages summarized: 1 message across 0 earlier turns",
		);
	});
});

// ── I/O: fail-soft when IndexedDB is unavailable (bun test has none, like
// SSR / private mode — mirrors user-memory-store.test.ts's approach) ────────

describe("director-conversation-store — migration safety / absence handling", () => {
	it("reads resolve to empty when storage is unavailable, never throw", async () => {
		expect(await getConversation("nope")).toBeUndefined();
		expect(await listConversationsForProject("proj-1")).toEqual([]);
	});

	it("writes no-op (never throw) when storage is unavailable", async () => {
		const record: DirectorConversationRecord = {
			id: "c1",
			projectId: "proj-1",
			title: "hello",
			createdAt: 1,
			updatedAt: 1,
			messages: [],
		};
		await expect(saveConversation(record)).resolves.toBeUndefined();
		// Still nothing there — the write silently no-op'd.
		expect(await getConversation("c1")).toBeUndefined();
	});
});

// Round-trip + eviction against a real (fake) IndexedDB live in a SEPARATE
// file — `director-conversation-store.roundtrip.test.ts` — see that file's
// header for why it can't share this one (module-level `dbPromise` caching).
