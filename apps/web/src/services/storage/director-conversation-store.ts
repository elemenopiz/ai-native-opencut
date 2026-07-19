/**
 * Project-scoped Director conversation persistence — Director-revamp Item 9,
 * **F-local only** (see `apps/web/docs/plans/2026-07-19-director-revamp-design.md`,
 * GATE B, the "Both local and server side" decision). Browser-local IndexedDB
 * is the source of truth the chat UI (`director.tsx`) reads/writes for the
 * list-and-reopen affordance; F-server (a Postgres mirror + sync layer) is a
 * separate, HARD-GATED pass — this module is deliberately sync-code-free.
 *
 * The record shape is designed so a future sync layer can mirror it without a
 * reshape: client-generated ids (conversation AND message), and a per-message
 * `createdAt` — not just a conversation-level `updatedAt` — because the design
 * doc's idempotency note calls for last-write-wins *per message*, which needs
 * a timestamp on every message, not only the parent record.
 *
 * One IndexedDB database (`byorn-director-conversations`) with a single
 * object store, `conversations` (keyPath `id`, the whole record incl.
 * `messages` embedded — conversation histories here are small and bounded,
 * see the caps below, so there's no need for a second per-message store),
 * indexed by `projectId` (list this project's conversations) and `updatedAt`
 * (recency ordering / eviction).
 *
 * MIGRATION SAFETY / ABSENCE: every read fails soft to "nothing yet" and
 * every write is best-effort — mirrors `user-memory-store.ts`'s conventions
 * exactly. When IndexedDB is unavailable (SSR, tests, private mode), reads
 * resolve to `undefined`/`[]` and writes no-op, so the absence of this layer
 * is a valid state everywhere and never breaks the chat.
 */

/** One persisted chat message. Mirrors `StudioMessage` (`stores/ai-store.ts`)
 *  minus transient UI-only flags (e.g. `isStreaming`), plus `createdAt`. */
export interface DirectorConversationMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	/** See `StudioMessage.kind` — "text" (default) vs "step" (tool-run /
	 *  status rows, incl. the synthetic truncation-notice row on reopen). */
	kind?: "text" | "step";
	/** See `StudioMessage.errorDetail` — raw technical detail for a caught
	 *  error notice, kept out of `content`'s primary copy. */
	errorDetail?: string;
	/** Epoch ms this message was appended. The future sync layer's
	 *  idempotency / last-write-wins key — stamped once, never rewritten. */
	createdAt: number;
}

/** One persisted conversation, messages included. */
export interface DirectorConversationRecord {
	/** Client-generated (crypto.randomUUID()) — stable across a future sync. */
	id: string;
	projectId: string;
	/** First-user-message derived (see `deriveConversationTitle`); editable later. */
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: DirectorConversationMessage[];
}

/** Lightweight listing shape — everything but the message bodies, for the
 *  reopen popover so it never has to load full transcripts just to render a
 *  list row. */
export interface DirectorConversationSummary {
	id: string;
	projectId: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
}

const DB_NAME = "byorn-director-conversations";
const DB_VERSION = 1;
const STORE = "conversations";
const PROJECT_INDEX = "projectId";

/** Cap on stored conversations per project — oldest (by `updatedAt`) evicted
 *  once a save pushes a project past this. */
export const MAX_CONVERSATIONS_PER_PROJECT = 50;
/** Cap on messages retained per conversation — oldest trimmed on save. Well
 *  above the replay window below; this is just a hard backstop so a single
 *  marathon conversation can't grow the DB without bound. */
export const MAX_MESSAGES_PER_CONVERSATION = 400;
/** Reopen replay policy: the last N messages of a conversation replay
 *  verbatim into the live chat; anything older is summarized (see
 *  {@link buildTruncationNotice}) rather than shown. N≈20 messages ≈ the
 *  last ~10 user/assistant exchanges (a "step" tool-chip row also counts as
 *  one message, so a tool-heavy run consumes the window faster). */
export const REPLAY_VERBATIM_MESSAGE_COUNT = 20;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	const promise = new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof indexedDB === "undefined") {
			reject(new Error("IndexedDB is not available in this environment"));
			return;
		}
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onerror = () => reject(req.error);
		req.onsuccess = () => resolve(req.result);
		req.onupgradeneeded = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(STORE)) {
				const store = db.createObjectStore(STORE, { keyPath: "id" });
				store.createIndex(PROJECT_INDEX, "projectId");
				store.createIndex("updatedAt", "updatedAt");
			}
		};
	});
	// Don't memoize a FAILED open — a transient unavailability (or, in tests,
	// `indexedDB` not existing yet at the very first call) shouldn't wedge
	// every later call for the module's lifetime; the next call gets a clean
	// retry instead of an unrecoverable poisoned cache.
	promise.catch(() => {
		dbPromise = null;
	});
	dbPromise = promise;
	return promise;
}

function tx<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	return openDB().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const transaction = db.transaction(STORE, mode);
				const objectStore = transaction.objectStore(STORE);
				const req = run(objectStore);
				req.onerror = () => reject(req.error);
				req.onsuccess = () => resolve(req.result);
			}),
	);
}

// ── title derivation (pure) ───────────────────────────────────────────────

const MAX_TITLE_LENGTH = 60;

/** Derive a conversation title from its first user message. Pure, no I/O. */
export function deriveConversationTitle(firstUserMessage: string): string {
	const trimmed = firstUserMessage.trim().replace(/\s+/g, " ");
	if (!trimmed) return "New chat";
	return trimmed.length > MAX_TITLE_LENGTH
		? `${trimmed.slice(0, MAX_TITLE_LENGTH - 1)}…`
		: trimmed;
}

// ── reopen replay policy (pure) ───────────────────────────────────────────

export interface ReplaySplit {
	/** Older messages, truncated out of the live view but kept for the
	 *  next write-through so persisting after a reopen never drops them. */
	prefix: DirectorConversationMessage[];
	/** The last {@link REPLAY_VERBATIM_MESSAGE_COUNT} messages — replayed
	 *  verbatim into the live chat. */
	visible: DirectorConversationMessage[];
	truncated: boolean;
}

/**
 * Split a conversation's messages for the reopen replay policy. Pure, no I/O
 * — the caller (`ai-store.ts#openConversation`) is responsible for turning
 * this into `StudioMessage[]` and the synthetic truncation-notice row.
 */
export function splitForReplay(
	messages: DirectorConversationMessage[],
): ReplaySplit {
	if (messages.length <= REPLAY_VERBATIM_MESSAGE_COUNT) {
		return { prefix: [], visible: messages, truncated: false };
	}
	const splitPoint = messages.length - REPLAY_VERBATIM_MESSAGE_COUNT;
	return {
		prefix: messages.slice(0, splitPoint),
		visible: messages.slice(splitPoint),
		truncated: true,
	};
}

function truncationSummaryLine(content: string, maxLen = 40): string {
	const line = content.trim().split("\n")[0] ?? "";
	return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

/**
 * A deterministic, non-model-generated summary of the messages truncated out
 * of the reopen replay window ("N messages across M earlier turns — e.g.
 * "<first line>", …"). This is F-local's stand-in for item 9's real
 * summarizer.
 *
 * SEAM: a future pass can replace the body of this function with a real
 * model-generated summary (e.g. a cheap LLM call over `prefix`) without
 * touching `splitForReplay` or any call site — same input shape
 * (`DirectorConversationMessage[]`), same output shape (a single string),
 * both already wired end-to-end through `ai-store.ts#openConversation`.
 */
export function buildTruncationNotice(
	prefix: DirectorConversationMessage[],
): string {
	const userTurns = prefix.filter((m) => m.role === "user");
	const topics = userTurns
		.slice(0, 3)
		.map((m) => `"${truncationSummaryLine(m.content)}"`);
	const topicsText = topics.length ? ` — e.g. ${topics.join(", ")}` : "";
	return `Earlier messages summarized: ${prefix.length} message${
		prefix.length === 1 ? "" : "s"
	} across ${userTurns.length} earlier turn${
		userTurns.length === 1 ? "" : "s"
	}${topicsText}`;
}

// ── reads ──────────────────────────────────────────────────────────────────

/** One full conversation (messages included), or `undefined`. Never throws. */
export async function getConversation(
	id: string,
): Promise<DirectorConversationRecord | undefined> {
	try {
		const value = await tx<DirectorConversationRecord | undefined>(
			"readonly",
			(store) => store.get(id),
		);
		return value ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every conversation for a project, newest first, as lightweight summaries
 * (no message bodies) — the reopen-list UI's data source. `[]` on any
 * failure / when storage is unavailable. Never throws.
 */
export async function listConversationsForProject(
	projectId: string,
): Promise<DirectorConversationSummary[]> {
	try {
		const records = await tx<DirectorConversationRecord[]>(
			"readonly",
			(store) => store.index(PROJECT_INDEX).getAll(projectId),
		);
		return records
			.map((r) => ({
				id: r.id,
				projectId: r.projectId,
				title: r.title,
				createdAt: r.createdAt,
				updatedAt: r.updatedAt,
				messageCount: r.messages.length,
			}))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	} catch {
		return [];
	}
}

// ── writes ─────────────────────────────────────────────────────────────────

/**
 * Upsert a conversation record (caller owns id/timestamps — client-generated,
 * future-sync-friendly). Trims `messages` to
 * {@link MAX_MESSAGES_PER_CONVERSATION} (oldest dropped first) and evicts
 * this project's oldest conversations past
 * {@link MAX_CONVERSATIONS_PER_PROJECT}. Best-effort — a persistence hiccup
 * never throws into the caller (the chat turn that triggered it must not
 * break because of a storage failure).
 */
export async function saveConversation(
	record: DirectorConversationRecord,
): Promise<void> {
	const trimmed: DirectorConversationRecord =
		record.messages.length > MAX_MESSAGES_PER_CONVERSATION
			? {
					...record,
					messages: record.messages.slice(
						record.messages.length - MAX_MESSAGES_PER_CONVERSATION,
					),
				}
			: record;
	try {
		await tx("readwrite", (store) => store.put(trimmed));
		await evictOldestConversations(record.projectId);
	} catch {
		// Best-effort — a save hiccup must never break the chat turn that
		// triggered it.
	}
}

/** Delete one conversation. Best-effort. */
export async function deleteConversation(id: string): Promise<void> {
	try {
		await tx("readwrite", (store) => store.delete(id));
	} catch {
		// Best-effort.
	}
}

async function evictOldestConversations(projectId: string): Promise<void> {
	try {
		const all = await listConversationsForProject(projectId);
		if (all.length <= MAX_CONVERSATIONS_PER_PROJECT) return;
		const toDrop = [...all]
			.sort((a, b) => a.updatedAt - b.updatedAt)
			.slice(0, all.length - MAX_CONVERSATIONS_PER_PROJECT);
		await Promise.all(toDrop.map((c) => deleteConversation(c.id)));
	} catch {
		// Best-effort — an untrimmed project history is harmless.
	}
}
