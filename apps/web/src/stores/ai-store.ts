import { create } from "zustand";
import type { AIBackendStatus, AIErrorType, AISuggestion } from "@/types/ai";

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
	clearStudioMessages: () => void;
	setDirectorDraft: (projectId: string, text: string) => void;
}

export const useAIStore = create<AIState>()((set) => ({
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

	addStudioMessage: (message) =>
		set((state) => ({
			studioMessages: [...state.studioMessages, message],
		})),

	updateStudioMessage: (id, content) =>
		set((state) => ({
			studioMessages: state.studioMessages.map((msg) =>
				msg.id === id ? { ...msg, content } : msg,
			),
		})),

	clearStudioMessages: () => set({ studioMessages: [] }),

	setDirectorDraft: (projectId, text) =>
		set((state) => ({
			directorDraftByProject: {
				...state.directorDraftByProject,
				[projectId]: text,
			},
		})),
}));
