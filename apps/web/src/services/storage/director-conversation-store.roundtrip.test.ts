import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	MAX_CONVERSATIONS_PER_PROJECT,
	MAX_MESSAGES_PER_CONVERSATION,
	getConversation,
	listConversationsForProject,
	saveConversation,
	type DirectorConversationMessage,
	type DirectorConversationRecord,
} from "./director-conversation-store";

// ── I/O: round-trip + eviction, against a minimal in-memory IndexedDB fake ──
//
// bun test has no real IndexedDB (see director-conversation-store.test.ts's
// "migration safety / absence handling" block, which exercises that
// fail-soft path deliberately WITHOUT any IndexedDB). To genuinely exercise
// round-trip/eviction behavior here (not just "does it throw"), this file
// installs a small in-memory fake implementing just the IDB surface this
// module uses (open/transaction/objectStore/index, put/get/getAll/delete) —
// no new dependency, deliberately narrow.
//
// SEPARATE FILE, ON PURPOSE: `director-conversation-store.ts` memoizes its
// IndexedDB connection in a module-level `dbPromise` (same pattern as
// `user-memory-store.ts`) — once a call resolves (or rejects) it, that
// outcome is cached for the lifetime of the module. If the fail-soft tests
// (no IndexedDB) and these round-trip tests (fake IndexedDB installed) shared
// one file/module instance, whichever runs first would poison the cache for
// the other. Splitting into two files gives each its own fresh module load.

interface FakeRecord {
	[key: string]: unknown;
}

class FakeRequest<T> {
	result: T | undefined;
	error: unknown = null;
	onsuccess: (() => void) | null = null;
	onerror: (() => void) | null = null;
	succeed(result: T): void {
		this.result = result;
		queueMicrotask(() => this.onsuccess?.());
	}
}

class FakeIndex {
	constructor(
		private records: Map<string, FakeRecord>,
		private field: string,
	) {}
	getAll(query: unknown): FakeRequest<FakeRecord[]> {
		const req = new FakeRequest<FakeRecord[]>();
		const all = Array.from(this.records.values()).filter(
			(r) => r[this.field] === query,
		);
		req.succeed(all);
		return req;
	}
}

class FakeObjectStore {
	private indexes = new Map<string, string>();
	constructor(
		private records: Map<string, FakeRecord>,
		private keyPath: string,
	) {}
	createIndex(name: string, keyPath: string): void {
		this.indexes.set(name, keyPath);
	}
	put(value: FakeRecord): FakeRequest<string> {
		const req = new FakeRequest<string>();
		const key = value[this.keyPath] as string;
		this.records.set(key, JSON.parse(JSON.stringify(value)));
		req.succeed(key);
		return req;
	}
	get(key: string): FakeRequest<FakeRecord | undefined> {
		const req = new FakeRequest<FakeRecord | undefined>();
		req.succeed(this.records.get(key));
		return req;
	}
	delete(key: string): FakeRequest<undefined> {
		const req = new FakeRequest<undefined>();
		this.records.delete(key);
		req.succeed(undefined);
		return req;
	}
	index(name: string): FakeIndex {
		const field = this.indexes.get(name);
		if (!field) throw new Error(`no such index: ${name}`);
		return new FakeIndex(this.records, field);
	}
}

class FakeTransaction {
	constructor(private store: FakeObjectStore) {}
	objectStore(): FakeObjectStore {
		return this.store;
	}
}

class FakeDatabase {
	private stores = new Map<string, FakeObjectStore>();
	objectStoreNames = { contains: (name: string) => this.stores.has(name) };
	createObjectStore(name: string, opts: { keyPath: string }): FakeObjectStore {
		const store = new FakeObjectStore(new Map(), opts.keyPath);
		this.stores.set(name, store);
		return store;
	}
	transaction(name: string): FakeTransaction {
		const store = this.stores.get(name);
		if (!store) throw new Error(`no such store: ${name}`);
		return new FakeTransaction(store);
	}
}

let realIndexedDB: unknown;

beforeAll(() => {
	realIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;
	const db = new FakeDatabase();
	const fakeIndexedDB = {
		open(_name: string, _version: number) {
			const req =
				new FakeRequest<FakeDatabase>() as FakeRequest<FakeDatabase> & {
					onupgradeneeded:
						| ((event: { target: { result: FakeDatabase } }) => void)
						| null;
				};
			req.onupgradeneeded = null;
			queueMicrotask(() => {
				req.onupgradeneeded?.({ target: { result: db } });
				req.succeed(db);
			});
			return req;
		},
	};
	(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB;
});

afterAll(() => {
	(globalThis as { indexedDB: unknown }).indexedDB = realIndexedDB;
});

function msg(
	id: string,
	role: "user" | "assistant",
	content: string,
	createdAt: number,
): DirectorConversationMessage {
	return { id, role, content, createdAt };
}

describe("director-conversation-store — round-trip + eviction (fake IndexedDB)", () => {
	it("saveConversation → getConversation round-trips the full record", async () => {
		const record: DirectorConversationRecord = {
			id: "rt-conv-1",
			projectId: "rt-proj-1",
			title: "Storyboard a reel about coffee",
			createdAt: 100,
			updatedAt: 200,
			messages: [
				msg("m1", "user", "Storyboard a reel about coffee", 100),
				{ ...msg("m2", "assistant", "On it.", 150), kind: "step" },
			],
		};
		await saveConversation(record);
		const loaded = await getConversation("rt-conv-1");
		expect(loaded).toEqual(record);
	});

	it("listConversationsForProject returns only that project's conversations, newest first", async () => {
		await saveConversation({
			id: "list-conv-a",
			projectId: "rt-proj-2",
			title: "A",
			createdAt: 1,
			updatedAt: 10,
			messages: [],
		});
		await saveConversation({
			id: "list-conv-b",
			projectId: "rt-proj-2",
			title: "B",
			createdAt: 1,
			updatedAt: 30,
			messages: [msg("x", "user", "hi", 1)],
		});
		await saveConversation({
			id: "list-conv-other-project",
			projectId: "rt-proj-3",
			title: "Other project",
			createdAt: 1,
			updatedAt: 999,
			messages: [],
		});

		const list = await listConversationsForProject("rt-proj-2");
		expect(list.map((c) => c.id)).toEqual(["list-conv-b", "list-conv-a"]);
		expect(list.find((c) => c.id === "list-conv-b")?.messageCount).toBe(1);
		// No bleed from the other project.
		expect(list.some((c) => c.projectId === "rt-proj-3")).toBe(false);
	});

	it("trims messages to MAX_MESSAGES_PER_CONVERSATION, keeping the most recent", async () => {
		const total = MAX_MESSAGES_PER_CONVERSATION + 5;
		const messages = Array.from({ length: total }, (_, i) =>
			msg(`t${i}`, "user", `turn ${i}`, i),
		);
		await saveConversation({
			id: "trim-conv",
			projectId: "rt-proj-trim",
			title: "long chat",
			createdAt: 1,
			updatedAt: 2,
			messages,
		});
		const loaded = await getConversation("trim-conv");
		expect(loaded?.messages.length).toBe(MAX_MESSAGES_PER_CONVERSATION);
		// The oldest 5 were dropped; the tail is intact.
		expect(loaded?.messages[0]?.id).toBe("t5");
		expect(loaded?.messages.at(-1)?.id).toBe(`t${total - 1}`);
	});

	it("evicts the oldest conversations past MAX_CONVERSATIONS_PER_PROJECT", async () => {
		const projectId = "rt-proj-evict";
		const count = MAX_CONVERSATIONS_PER_PROJECT + 5;
		for (let i = 0; i < count; i++) {
			await saveConversation({
				id: `evict-conv-${i}`,
				projectId,
				title: `chat ${i}`,
				createdAt: i,
				updatedAt: i, // strictly increasing → oldest is conv-0
				messages: [],
			});
		}
		const list = await listConversationsForProject(projectId);
		expect(list.length).toBe(MAX_CONVERSATIONS_PER_PROJECT);
		// The 5 oldest (lowest updatedAt) were evicted.
		expect(list.some((c) => c.id === "evict-conv-0")).toBe(false);
		expect(list.some((c) => c.id === "evict-conv-4")).toBe(false);
		// The newest survive.
		expect(list.some((c) => c.id === `evict-conv-${count - 1}`)).toBe(true);
	});
});
