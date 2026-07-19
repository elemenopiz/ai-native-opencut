import { create } from "zustand";
import type { AIBackendStatus, AIErrorType, AISuggestion } from "@/types/ai";
import {
	buildTruncationNotice,
	deriveConversationTitle,
	saveConversation,
	splitForReplay,
	type DirectorConversationMessage,
	type DirectorConversationRecord,
} from "@/services/storage/director-conversation-store";

export interface SavedIdea {
	id: string;
	content: string;
	savedAt: number;
}

export interface StudioMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	/**
	 * Distinguishes the model's actual reply ("text", the default when omitted)
	 * from an in-run status/progress row ("step" — tool-call chips, the running
	 * budget bubble, cancel/error notes). Director-revamp Item 3: only "text"
	 * bubbles get the "Save idea" footer; "step" rows never do, and never carry
	 * raw chain-of-thought either (`thinking_delta` no longer creates a message
	 * of either kind — see `director.tsx`'s `agentStatus` status row instead).
	 */
	kind?: "text" | "step";
	/**
	 * Raw technical detail for a caught-error "step" bubble (e.g. the
	 * underlying relay/HTTP error) — rendered behind a collapsed "Show
	 * details" toggle in `director.tsx`, never in the bubble's primary copy.
	 * Optional; absent on every message that isn't an error notice.
	 */
	errorDetail?: string;
}

interface AIState {
	backendStatus: AIBackendStatus | null;
	suggestions: AISuggestion[];
	commandHistory: string[];
	isCommandPanelOpen: boolean;
	isSetupGuideOpen: boolean;
	activeModel: string | null;
	hasCompletedSetup: boolean;
	lastError: string | null;
	lastErrorType: AIErrorType | null;
	consecutiveFailures: number;
	savedIdeas: SavedIdea[];
	studioMessages: StudioMessage[];
	/**
	 * Director-revamp Item 5 — the chat input draft, lifted out of `director.tsx`'s
	 * local `useState` so it survives a Direct↔Tools tab switch/unmount (panel tabs
	 * mount only the active one) without bleeding between projects. Keyed by
	 * projectId; in-memory only (no persist middleware — reload-survival is a
	 * separate, later persistence pass, not this slice's job).
	 */
	directorDraftByProject: Record<string, string>;
	/**
	 * Director-revamp Item 9 (F-local) — the conversation `studioMessages` is
	 * currently the live view of, and which project it belongs to. `null` means
	 * "no conversation started yet in this session" — `ensureConversation` mints
	 * one lazily on the first message of a fresh chat, so an empty chat that's
	 * never sent anything never creates an empty persisted record. See
	 * `services/storage/director-conversation-store.ts` for the persisted shape.
	 */
	currentConversationId: string | null;
	currentConversationProjectId: string | null;

	setBackendStatus: (status: AIBackendStatus | null) => void;
	setConnectionError: (error: string, errorType: AIErrorType) => void;
	clearError: () => void;
	addSuggestion: (suggestion: AISuggestion) => void;
	dismissSuggestion: (id: string) => void;
	clearSuggestions: () => void;
	addCommand: (command: string) => void;
	toggleCommandPanel: () => void;
	toggleSetupGuide: () => void;
	setActiveModel: (model: string | null) => void;
	setHasCompletedSetup: (completed: boolean) => void;
	saveIdea: (content: string) => void;
	removeIdea: (id: string) => void;
	clearIdeas: () => void;
	addStudioMessage: (message: StudioMessage) => void;
	updateStudioMessage: (id: string, content: string) => void;
	/** Backward-compatible: starts a fresh conversation (see `startNewConversation`
	 *  — this is NOT a destructive clear, the previous conversation stays
	 *  persisted and reopenable). */
	clearStudioMessages: () => void;
	setDirectorDraft: (projectId: string, text: string) => void;
	/**
	 * Ensure the live chat is attached to a conversation scoped to `projectId`
	 * — a no-op if it already is; mints a fresh (unpersisted-until-first-message)
	 * conversation id otherwise. Call before appending the first message of a
	 * turn so `addStudioMessage`'s write-through has somewhere to save to.
	 * Returns the (possibly new) conversation id.
	 */
	ensureConversation: (projectId: string) => string;
	/** Explicit "New chat" — same semantics as `clearStudioMessages`, but takes
	 *  the target projectId directly instead of trusting stale store state. */
	startNewConversation: (projectId: string) => void;
	/**
	 * Reopen a persisted conversation as the live chat (Director-revamp Item 9's
	 * reopen UI, `director.tsx`). Applies the replay policy: the last
	 * `REPLAY_VERBATIM_MESSAGE_COUNT` messages replay verbatim; anything older
	 * is kept out of view but NOT discarded — it's folded into a single
	 * deterministic truncation-notice row and retained in a module-scoped
	 * buffer so the next write-through never clobbers it.
	 */
	openConversation: (record: DirectorConversationRecord) => void;
	/**
	 * Director-revamp Item 9 + the EditorCore-reused-singleton project-switch
	 * gotcha: `studioMessages` was a flat, un-scoped array before this pass —
	 * switching projects left the previous project's live chat on screen.
	 * Wired into `resetProjectScopedStores` (see that file) on every project
	 * load/switch. Does NOT touch `directorDraftByProject` (already correctly
	 * keyed per project) or delete anything from IndexedDB — only resets the
	 * LIVE view so the next `ensureConversation` call starts clean for the new
	 * project.
	 */
	resetForProjectSwitch: () => void;
}

// ── Item 9 (F-local) persistence bookkeeping ─────────────────────────────────
//
// This state is intentionally NOT in the zustand store: it doesn't drive any
// render, it's just glue for the write-through below. There is only ever ONE
// live conversation at a time (the store's `currentConversationId`), so plain
// module-level variables — reset together whenever that id changes — are
// enough; no need to key them by conversation id.

/** Synthetic id for the deterministic "Earlier messages summarized: …" row
 *  `openConversation` prepends on a truncated reopen. Recognizable so it can
 *  be excluded from both persistence (it's not a real message) and the
 *  agent-context seam below. */
const TRUNCATION_NOTICE_ID = "director-conversation-truncation-notice";

/** Older messages truncated out of the live view by the current conversation's
 *  reopen (empty for a fresh/never-truncated conversation) — kept so a
 *  write-through after reopening never drops them from the persisted record. */
let truncatedPrefixMessages: DirectorConversationMessage[] = [];
/** Per-message append timestamps for the CURRENT conversation — the
 *  persisted record's per-message `createdAt` (stamped once, on append/load,
 *  never rewritten by a later edit of the same message's content). */
const messageTimestamps = new Map<string, number>();
/** The current conversation's original `createdAt`, so re-saving it on every
 *  debounced write-through doesn't drift its creation time forward. */
let activeConversationCreatedAt: number | null = null;

const PERSIST_DEBOUNCE_MS = 600;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function cancelScheduledPersist(): void {
	if (persistTimer) {
		clearTimeout(persistTimer);
		persistTimer = null;
	}
}

function schedulePersist(): void {
	cancelScheduledPersist();
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void persistCurrentConversation();
	}, PERSIST_DEBOUNCE_MS);
}

/** Write the live conversation through to IndexedDB (best-effort — the
 *  underlying store is fail-soft, see `director-conversation-store.ts`).
 *  Reconstructs the FULL message list as `[...truncatedPrefixMessages,
 *  ...visible studioMessages]` so a write-through after a truncated reopen
 *  never clobbers the older turns that aren't currently in view. */
async function persistCurrentConversation(): Promise<void> {
	const {
		currentConversationId,
		currentConversationProjectId,
		studioMessages,
	} = useAIStore.getState();
	if (!currentConversationId || !currentConversationProjectId) return;
	const visible = studioMessages.filter((m) => m.id !== TRUNCATION_NOTICE_ID);
	if (visible.length === 0 && truncatedPrefixMessages.length === 0) return;
	const now = Date.now();
	const mapped: DirectorConversationMessage[] = visible.map((m) => ({
		id: m.id,
		role: m.role,
		content: m.content,
		...(m.kind ? { kind: m.kind } : {}),
		...(m.errorDetail ? { errorDetail: m.errorDetail } : {}),
		createdAt: messageTimestamps.get(m.id) ?? now,
	}));
	const allMessages = [...truncatedPrefixMessages, ...mapped];
	const firstUser = allMessages.find((m) => m.role === "user");
	await saveConversation({
		id: currentConversationId,
		projectId: currentConversationProjectId,
		title: deriveConversationTitle(firstUser?.content ?? ""),
		createdAt: activeConversationCreatedAt ?? now,
		updatedAt: now,
		messages: allMessages,
	});
}

/**
 * SEAM — reopened/live conversation history, shaped for a future agent-loop
 * wire-up. `runDirectorAgent` (`lib/director/agent.ts`) is a stateless
 * per-turn relay today: it builds `messages` from just the current
 * `userMessage` (see that file's header comment), so a reopened conversation
 * currently only restores the VISIBLE transcript, not the model's memory of
 * it. Once `agent.ts` grows a `priorMessages` param, this is the array to
 * pass — the truncated prefix (if any) plus every visible message, in
 * chronological order, mapped to `{role, content}`, excluding the synthetic
 * truncation-notice row. Not called by the agent loop today; exported so that
 * follow-up wiring (and this pass's browser verification) can inspect it.
 */
export function getConversationHistoryForAgent(): Array<{
	role: "user" | "assistant";
	content: string;
}> {
	const { studioMessages } = useAIStore.getState();
	return [...truncatedPrefixMessages, ...studioMessages]
		.filter((m) => m.id !== TRUNCATION_NOTICE_ID)
		.map((m) => ({ role: m.role, content: m.content }));
}

export const useAIStore = create<AIState>()((set, get) => ({
	backendStatus: null,
	suggestions: [],
	commandHistory: [],
	isCommandPanelOpen: false,
	isSetupGuideOpen: false,
	activeModel: null,
	hasCompletedSetup: false,
	lastError: null,
	lastErrorType: null,
	consecutiveFailures: 0,
	savedIdeas: [],
	studioMessages: [],
	directorDraftByProject: {},
	currentConversationId: null,
	currentConversationProjectId: null,

	setBackendStatus: (status) =>
		set((state) => ({
			backendStatus: status,
			lastError: status?.error ?? null,
			lastErrorType: status?.errorType ?? null,
			// Reset on a healthy status; otherwise preserve the count (never set
			// undefined, which would make the next increment NaN forever).
			consecutiveFailures: status?.available ? 0 : state.consecutiveFailures,
		})),

	setConnectionError: (error, errorType) =>
		set((state) => ({
			backendStatus: {
				available: false,
				models: [],
				gpuAvailable: false,
				error,
				errorType,
			},
			lastError: error,
			lastErrorType: errorType,
			consecutiveFailures: state.consecutiveFailures + 1,
		})),

	clearError: () => set({ lastError: null, lastErrorType: null }),

	addSuggestion: (suggestion) =>
		set((state) => ({
			suggestions: [...state.suggestions, suggestion],
		})),

	dismissSuggestion: (id) =>
		set((state) => ({
			suggestions: state.suggestions.map((s) =>
				s.id === id ? { ...s, dismissed: true } : s,
			),
		})),

	clearSuggestions: () => set({ suggestions: [] }),

	addCommand: (command) =>
		set((state) => ({
			commandHistory: [...state.commandHistory, command],
		})),

	toggleCommandPanel: () =>
		set((state) => ({
			isCommandPanelOpen: !state.isCommandPanelOpen,
		})),

	toggleSetupGuide: () =>
		set((state) => ({
			isSetupGuideOpen: !state.isSetupGuideOpen,
		})),

	setActiveModel: (model) => set({ activeModel: model }),

	setHasCompletedSetup: (completed) => set({ hasCompletedSetup: completed }),

	saveIdea: (content) =>
		set((state) => ({
			savedIdeas: [
				...state.savedIdeas,
				{
					id: crypto.randomUUID(),
					content,
					savedAt: Date.now(),
				},
			],
		})),

	removeIdea: (id) =>
		set((state) => ({
			savedIdeas: state.savedIdeas.filter((idea) => idea.id !== id),
		})),

	clearIdeas: () => set({ savedIdeas: [] }),

	addStudioMessage: (message) => {
		// Stamp once, on append — the persisted record's per-message `createdAt`
		// (never rewritten by a later `updateStudioMessage` edit of the same id,
		// e.g. a streaming token update).
		if (!messageTimestamps.has(message.id)) {
			messageTimestamps.set(message.id, Date.now());
		}
		set((state) => ({
			studioMessages: [...state.studioMessages, message],
		}));
		schedulePersist();
	},

	updateStudioMessage: (id, content) => {
		set((state) => ({
			studioMessages: state.studioMessages.map((msg) =>
				msg.id === id ? { ...msg, content } : msg,
			),
		}));
		// Streaming tokens call this repeatedly — the debounce absorbs the burst
		// into one write a beat after the stream settles.
		schedulePersist();
	},

	clearStudioMessages: () =>
		get().startNewConversation(get().currentConversationProjectId ?? ""),

	setDirectorDraft: (projectId, text) =>
		set((state) => ({
			directorDraftByProject: {
				...state.directorDraftByProject,
				[projectId]: text,
			},
		})),

	ensureConversation: (projectId) => {
		const state = get();
		if (
			state.currentConversationId &&
			state.currentConversationProjectId === projectId
		) {
			return state.currentConversationId;
		}
		cancelScheduledPersist();
		const id = crypto.randomUUID();
		truncatedPrefixMessages = [];
		messageTimestamps.clear();
		activeConversationCreatedAt = Date.now();
		set({ currentConversationId: id, currentConversationProjectId: projectId });
		return id;
	},

	startNewConversation: (projectId) => {
		cancelScheduledPersist();
		truncatedPrefixMessages = [];
		messageTimestamps.clear();
		activeConversationCreatedAt = null;
		set({
			studioMessages: [],
			// Left null (lazy) rather than minted eagerly — an untouched "New
			// chat" never creates an empty persisted record; `ensureConversation`
			// mints one on the first real message.
			currentConversationId: null,
			currentConversationProjectId: projectId || null,
		});
	},

	openConversation: (record) => {
		cancelScheduledPersist();
		const { prefix, visible, truncated } = splitForReplay(record.messages);
		truncatedPrefixMessages = prefix;
		activeConversationCreatedAt = record.createdAt;
		messageTimestamps.clear();
		for (const m of record.messages) messageTimestamps.set(m.id, m.createdAt);

		const replayed: StudioMessage[] = visible.map((m) => ({
			id: m.id,
			role: m.role,
			content: m.content,
			...(m.kind ? { kind: m.kind } : {}),
			...(m.errorDetail ? { errorDetail: m.errorDetail } : {}),
		}));
		const studioMessages: StudioMessage[] = truncated
			? [
					{
						id: TRUNCATION_NOTICE_ID,
						role: "assistant",
						kind: "step",
						content: buildTruncationNotice(prefix),
					},
					...replayed,
				]
			: replayed;

		set({
			studioMessages,
			currentConversationId: record.id,
			currentConversationProjectId: record.projectId,
		});
	},

	resetForProjectSwitch: () => {
		cancelScheduledPersist();
		truncatedPrefixMessages = [];
		messageTimestamps.clear();
		activeConversationCreatedAt = null;
		set({
			studioMessages: [],
			currentConversationId: null,
			currentConversationProjectId: null,
		});
	},
}));
