"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { cn } from "@/utils/ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SparklesIcon,
	SentIcon,
	TextIcon,
	Bookmark01Icon,
	Delete02Icon,
	FilmRoll01Icon,
	StopIcon,
} from "@hugeicons/core-free-icons";
import { aiClient } from "@/lib/ai-client";
import { isFeatureAvailable } from "@/lib/local-ai/retired-features";
import { useAIStatus } from "@/hooks/use-ai-status";
import { useAIStore } from "@/stores/ai-store";
import { useTranscriptStore } from "@/stores/transcript-store";
import { useEditor } from "@/hooks/use-editor";
import { useDirector } from "@/hooks/use-director";
import {
	runDirectorAgent,
	executeDirectorAction,
	type AgentApproval,
	type DirectorEvent,
} from "@/lib/director/agent";
import { formatCostRange } from "@/lib/studio/cost";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";
import { CostApprovalDialog } from "@/components/studio/cost-approval-dialog";
import { EnhancePromptButton } from "@/components/editor/ai/enhance-prompt-button";
import { serializeConsistencyContext } from "@/lib/director/consistency-prompt";
import { summarizeBrief } from "@/lib/director/director-brief";
import { getUnderstandingCaptions } from "@/lib/director/understanding-lookup";
import { toast } from "sonner";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";

// ----- Thinking Messages -----

const THINKING_MESSAGES = [
	"Rewinding the creative tape...",
	"Adjusting the white balance on this idea...",
	"Adding a dramatic zoom to my thoughts...",
	"Scrubbing through the timeline of possibilities...",
	"Applying a smooth transition between neurons...",
	"Color grading this response for maximum impact...",
	"Removing the awkward silence from my thinking...",
	"Adding B-roll to my train of thought...",
	"Stabilizing this shaky idea...",
	"Rendering a rough cut of my answer...",
	"Trimming the fat, keeping the hook...",
	"Keyframing the perfect response...",
	"De-noising my thought process...",
	"Jump cutting to the good part...",
	"Pulling focus on what matters...",
	"Adding a lens flare for dramatic effect...",
	"Speed ramping through the boring bits...",
	"Checking if this take is a keeper...",
	"Syncing audio with my brainwaves...",
	"Applying the viral filter to this answer...",
];

// ----- Agent status (Item 3 — thought bubbles) -----
//
// `thinking_delta` used to spawn its own `> 💭 …` assistant message — raw
// chain-of-thought, rendered (and savable) exactly like a real answer. It no
// longer creates a message at all: it drives the transient "thinking" status
// row instead (the dashed-spinner region below), via a short, de-jargoned
// status derived from either the tool currently running or a coarse read of
// the reasoning buffer — never the raw token stream itself.

/** Per-tool-action → a plain-language status the status row can show while
 *  that step runs. Falls back to a generic phrase for anything unlisted. */
const TOOL_STATUS_LABELS: Record<string, string> = {
	searchMedia: "Checking your library…",
	findDuplicateAssets: "Checking your library…",
	getLibraryManifest: "Checking your library…",
	getProjectInfo: "Checking your project…",
	getTimeline: "Checking the timeline…",
	getReel: "Checking the reel…",
	storyboard: "Planning the shots…",
	proposeReel: "Planning the shots…",
	reviseProposal: "Revising the plan…",
	acceptProposal: "Locking in the plan…",
	reserveSlot: "Setting up the shot…",
	setPrompt: "Refining the prompt…",
	generate: "Generating a take…",
	reroll: "Trying another take…",
	remix: "Touching up the take…",
	compareTake: "Comparing takes…",
	reviewTake: "Reviewing the footage…",
	chooseTake: "Picking the best take…",
	extractFrame: "Grabbing a frame…",
	chainFrom: "Carrying the look forward…",
	intakeReferences: "Studying your references…",
	addVoiceover: "Adding narration…",
	addMusicBed: "Adding music…",
	getTranscript: "Reading the transcript…",
	removeSilence: "Trimming the silence…",
	trim: "Trimming the clip…",
	split: "Splitting the clip…",
	move: "Repositioning the clip…",
	reorder: "Reordering the shots…",
	remove: "Removing the clip…",
	addText: "Adding text…",
	updateText: "Updating the text…",
	applyTransition: "Adding a transition…",
	applyEffect: "Applying an effect…",
	addClip: "Adding the clip…",
	export: "Exporting…",
	getBudgetStatus: "Checking the budget…",
	setBudget: "Adjusting the budget…",
	updateBrief: "Noting your preference…",
	critiqueEdit: "Reviewing the edit…",
};

function toolStatusLabel(action: string): string {
	return TOOL_STATUS_LABELS[action] ?? "Working on it…";
}

/** Coarse keyword read of the accumulating reasoning buffer → a short,
 *  de-jargoned status. Deliberately never returns the buffer itself. */
const THINKING_STATUS_RULES: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /librar|search|asset|footage/i, label: "Checking your library…" },
	{ pattern: /storyboard|plan|shot|scene/i, label: "Planning the shots…" },
	{ pattern: /generat/i, label: "Generating a take…" },
	{ pattern: /review|frame|compar/i, label: "Reviewing the footage…" },
	{ pattern: /budget|cost|credit/i, label: "Checking the budget…" },
	{ pattern: /music|voiceover|audio|narrat/i, label: "Sorting out the audio…" },
	{ pattern: /transcript|speech|dialogue/i, label: "Reading the transcript…" },
];

function deriveThinkingStatus(buf: string): string {
	for (const rule of THINKING_STATUS_RULES) {
		if (rule.pattern.test(buf)) return rule.label;
	}
	return "Thinking…";
}

function useThinkingMessage(isThinking: boolean) {
	const [index, setIndex] = useState(() =>
		Math.floor(Math.random() * THINKING_MESSAGES.length),
	);

	useEffect(() => {
		if (!isThinking) return;
		// Pick a random starting message each time thinking begins
		setIndex(Math.floor(Math.random() * THINKING_MESSAGES.length));

		const interval = setInterval(() => {
			setIndex((prev) => (prev + 1) % THINKING_MESSAGES.length);
		}, 3000);

		return () => clearInterval(interval);
	}, [isThinking]);

	return THINKING_MESSAGES[index];
}

// ----- Types -----

// Director chat is a two-mode conversational surface: freeform brainstorm/agent
// chat, or (when a transcript exists) AI-assisted transcript editing. The other
// 12 utility panels that used to hang off this switch (Templates, Ideas,
// Workflows, B-Roll, Reframe, Tracking, A/B Test, Shorts, Scenes, Thumbnail,
// Dubbing, YouTube Reels, Script→Video) now live in the sibling "Tools" tab
// (`./tools.tsx`) — see the Director-revamp design doc, Item 4.
type StudioMode = "chat" | "transcript";

// ----- Chat Prompts -----

const STARTER_PROMPTS = [
	{
		label: "Storyboard a 3-shot reel about...",
		prompt: "Storyboard a 3-shot reel, ~6s each, about ",
	},
	{
		label: "Generate all slots, 2 takes each",
		prompt: "Generate every slot in the reel with 2 takes each.",
	},
	{
		label: "Help me plan a YouTube video about...",
		prompt: "Help me plan a YouTube video. I want to make a video about ",
	},
	{
		label: "Write a script for a 60-second reel",
		prompt: "Write a script for a 60-second vertical video/reel about ",
	},
];

const TRANSCRIPT_PROMPTS = [
	{
		label: "Make it more concise",
		prompt:
			"Rewrite this transcript to be more concise. Remove redundant phrases and tighten the language while keeping the same meaning:\n\n",
	},
	{
		label: "Make it more professional",
		prompt:
			"Rewrite this transcript in a more professional and polished tone:\n\n",
	},
	{
		label: "Add more energy",
		prompt:
			"Rewrite this transcript to be more engaging and energetic, with stronger hooks and more dynamic phrasing:\n\n",
	},
	{
		label: "Fix grammar and flow",
		prompt:
			"Fix any grammar issues and improve the flow of this transcript while keeping the original meaning:\n\n",
	},
];

// ----- Component -----

export function DirectorView() {
	const { isConnected } = useAIStatus();
	const toggleSetupGuide = useAIStore((s) => s.toggleSetupGuide);
	const saveIdea = useAIStore((s) => s.saveIdea);
	const messages = useAIStore((s) => s.studioMessages);
	const addMessage = useAIStore((s) => s.addStudioMessage);
	const updateMessage = useAIStore((s) => s.updateStudioMessage);
	const clearMessages = useAIStore((s) => s.clearStudioMessages);
	const directorDraftByProject = useAIStore((s) => s.directorDraftByProject);
	const setDirectorDraft = useAIStore((s) => s.setDirectorDraft);
	const transcriptSegments = useTranscriptStore((s) => s.segments);
	const hasTranscript = transcriptSegments.length > 0;

	// Cross-tab deep links to/from the "Tools" tab (Ideas list, Workflows
	// launcher) — see `assets-panel-store.ts`. Tools and Director are separate
	// panel tabs (only the active one is mounted), so a plain callback can't
	// cross that boundary; these two small store fields do it instead.
	const openToolsPanel = useAssetsPanelStore((s) => s.openToolsPanel);
	const pendingDirectorPrompt = useAssetsPanelStore(
		(s) => s.pendingDirectorPrompt,
	);
	const clearPendingDirectorPrompt = useAssetsPanelStore(
		(s) => s.clearPendingDirectorPrompt,
	);

	// ── Orchestrator (Director API) ──
	const editor = useEditor();
	const director = useDirector();
	const projectId = editor.project.getActiveOrNull()?.metadata.id ?? "";

	// Cost-preview approval gate (concept: cost-preview gate). Pending confirmation
	// for a gated verb the chat agent proposed but paused on — it runs only after
	// the user approves the estimate.
	const approvalThresholdCredits = useStudioSettingsStore(
		(s) => s.approvalThresholdCredits,
	);
	const [chatApproval, setChatApproval] = useState<AgentApproval | null>(null);

	const [mode, setMode] = useState<StudioMode>("chat");
	// Item 5 — project-keyed draft (`ai-store`) instead of bare local state, so
	// the typed-but-unsent prompt survives a Direct↔Tools tab switch/unmount and
	// never bleeds across projects. `setInputValue` keeps the call sites below
	// unchanged; it just writes through to the store now.
	const inputValue = directorDraftByProject[projectId] ?? "";
	const setInputValue = useCallback(
		(text: string) => setDirectorDraft(projectId, text),
		[projectId, setDirectorDraft],
	);
	const [isThinking, setIsThinking] = useState(false);
	// Item 3 — the live status the "thinking" row shows during an agent run
	// (current tool, or a de-jargoned read of the reasoning stream); null falls
	// back to the idle rotating flavor message below.
	const [agentStatus, setAgentStatus] = useState<string | null>(null);
	const thinkingMessage = useThinkingMessage(isThinking);
	// Item 6 — a finished run's tool-step chip ids, keyed by a per-run id, once
	// the post-run timeout collapses them into one summary line; `expandedToolRuns`
	// tracks which of those the user has clicked open again. Render-time-only
	// grouping over the flat message list — the underlying step messages in the
	// store are never mutated or dropped.
	const [collapsedToolRuns, setCollapsedToolRuns] = useState<
		Record<string, string[]>
	>({});
	const [expandedToolRuns, setExpandedToolRuns] = useState<Set<string>>(
		new Set(),
	);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	// Live agent run: the AbortController for the in-flight chat run, so the Stop
	// button can cancel a long multi-step run cooperatively (completed steps keep
	// their effect on the reel).
	const abortRef = useRef<AbortController | null>(null);

	const handleStopAgent = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	// Compact reference context for the prompt-enhance button — read entirely from
	// state the Director already holds (no new fetches): the reel-level look, the
	// durable brief, and up to 10 primed asset captions. Empty pieces are omitted.
	const getDirectorContext = useCallback(() => {
		const consistency = director.getReel().consistency;
		const styleBible = consistency
			? serializeConsistencyContext(consistency)
			: undefined;
		let brief: string | undefined;
		try {
			const b = editor.project.getDirectorBrief();
			brief = b ? summarizeBrief(b) : undefined;
		} catch {
			brief = undefined;
		}
		const assetNotes = getUnderstandingCaptions(10);
		return {
			...(styleBible ? { styleBible } : {}),
			...(brief ? { brief } : {}),
			...(assetNotes.length ? { assetNotes } : {}),
		};
	}, [director, editor]);

	// ── Model name display ──
	const [activeModel, setActiveModel] = useState("");

	useEffect(() => {
		aiClient
			.llmStatus()
			.then((data) => {
				if (data.available) {
					setActiveModel(data.default_model || "");
				}
			})
			.catch(() => {});
	}, []);

	// Auto-scroll on new messages
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [messages, isThinking]);

	// Consume a prompt handed off from the Tools tab (e.g. Workflows' "Ask AI
	// about next step") — prefill the chat input and focus it, once.
	useEffect(() => {
		if (!pendingDirectorPrompt) return;
		setMode("chat");
		setInputValue(pendingDirectorPrompt);
		clearPendingDirectorPrompt();
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [pendingDirectorPrompt, clearPendingDirectorPrompt, setInputValue]);

	// Run the gated verb the chat agent paused on, after the user approves its
	// cost. Executes the exact proposed action deterministically (bypassing the
	// LLM) so approval spends on precisely what was previewed.
	const approveChatAction = useCallback(async () => {
		if (!chatApproval) return;
		const pending = chatApproval;
		setChatApproval(null);
		setIsThinking(true);
		try {
			const step = await executeDirectorAction(
				director,
				pending.action,
				pending.args,
			);
			addMessage({
				id: crypto.randomUUID(),
				role: "assistant",
				kind: "step",
				content: `${step.ok ? "✅" : "⚠️"} \`${step.action}\` — ${step.message}`,
			});
		} finally {
			setIsThinking(false);
		}
	}, [chatApproval, director, addMessage]);

	const handleSend = useCallback(async () => {
		const trimmed = inputValue.trim();
		if (!trimmed || isThinking) return;

		// Chat mode defaults to the frontier brain (server-side Claude via
		// /api/llm/agent), so it works without the local AI backend; the local
		// Ollama loop is the automatic fallback when no ANTHROPIC_API_KEY is set.
		// Every other mode still needs the local backend.
		if (!isConnected && mode !== "chat") {
			toast.error("AI backend is not connected", {
				description: "Start the AI backend to use the Director chat.",
			});
			return;
		}

		addMessage({
			id: crypto.randomUUID(),
			role: "user",
			content: trimmed,
		});
		setInputValue("");
		setIsThinking(true);

		// ── Agent mode: drive the reel through director-api tool calls ──
		// Chat is now agentic — the model can storyboard, generate, re-roll, and
		// pick takes via the same DirectorApi the manual UI uses, or just answer.
		// Brain: frontier Claude (native tool-calling via /api/llm/agent) by
		// default, with automatic fallback to the local Ollama text loop when no
		// ANTHROPIC_API_KEY is configured server-side.
		if (mode === "chat") {
			// Live run: stream the agent's reasoning + per-tool progress into the
			// transcript as it happens, and expose a cooperative cancel via the Stop
			// button (abortRef). All per-run UI state is local to this call so
			// concurrent renders can't cross wires.
			const controller = new AbortController();
			abortRef.current = controller;

			// A "live" bubble whose content we grow in place as tokens arrive; a
			// fresh one starts after each tool step. `textId` is the CURRENT turn's
			// answer bubble; `thinkBuf` accumulates reasoning text WITHOUT ever
			// becoming a message (Item 3 — it only drives `agentStatus`, below).
			const live = { textId: "", textBuf: "", thinkBuf: "" };
			const commitLive = () => {
				live.textId = "";
				live.textBuf = "";
				live.thinkBuf = "";
			};
			// callId → the message id of its "running…" chip, so tool_finish can
			// update the same bubble in place. Also doubles as this run's ordered
			// list of step-chip ids for Item 6's post-run collapse.
			const toolMsgIds = new Map<string, string>();
			let streamedText = false;
			// One persistent "spent X of $Y" bubble, updated in place as budgeted
			// generations run, so the running budget stays visible without spamming.
			let budgetMsgId = "";

			const onEvent = (event: DirectorEvent) => {
				switch (event.type) {
					case "thinking_delta": {
						// Item 3: raw chain-of-thought never becomes a message (no more
						// `> 💭` bubble). It only feeds the transient status row via a
						// coarse, de-jargoned read of the buffer.
						live.thinkBuf += event.text;
						setAgentStatus(deriveThinkingStatus(live.thinkBuf));
						break;
					}
					case "text_delta": {
						streamedText = true;
						// Once the answer text starts, this turn's reasoning is done —
						// the status row goes quiet (falls back to the idle flavor text).
						live.thinkBuf = "";
						setAgentStatus(null);
						live.textBuf += event.text;
						if (!live.textId) {
							live.textId = crypto.randomUUID();
							addMessage({
								id: live.textId,
								role: "assistant",
								kind: "text",
								content: live.textBuf,
							});
						} else {
							updateMessage(live.textId, live.textBuf);
						}
						break;
					}
					case "tool_start": {
						commitLive();
						setAgentStatus(toolStatusLabel(event.action));
						const id = crypto.randomUUID();
						toolMsgIds.set(event.callId, id);
						const cost = event.cost
							? ` · est. ${formatCostRange(event.cost)} (${event.cost.clips} clip${
									event.cost.clips === 1 ? "" : "s"
								})`
							: "";
						addMessage({
							id,
							role: "assistant",
							kind: "step",
							content: `⏳ \`${event.action}\`${cost} — running…`,
						});
						break;
					}
					case "tool_finish": {
						const id = toolMsgIds.get(event.callId);
						const content = `${event.step.ok ? "✅" : "⚠️"} \`${event.step.action}\` — ${event.step.message}`;
						if (id) updateMessage(id, content);
						else
							addMessage({
								id: crypto.randomUUID(),
								role: "assistant",
								kind: "step",
								content,
							});
						break;
					}
					case "budget_update": {
						// Running whole-reel spend — one bubble, updated in place. The
						// underlying reel budget stays USD-denominated internally
						// (`lib/director/budget.ts`, out of scope for the credits
						// display conversion); this only converts the RENDERED string
						// (1 credit = $0.01) so the bubble matches every other cost
						// display in the Director UI.
						const usdToCredits = (usd: number) => Math.round(usd * 100);
						const content =
							event.budgetUsd != null
								? `💰 Spent ${usdToCredits(event.spentUsd)} of ${usdToCredits(
										event.budgetUsd,
									)} credits (${usdToCredits(
										Math.max(0, event.budgetUsd - event.spentUsd),
									)} left)`
								: `💰 Spent ${usdToCredits(event.spentUsd)} credits`;
						if (!budgetMsgId) {
							budgetMsgId = crypto.randomUUID();
							addMessage({
								id: budgetMsgId,
								role: "assistant",
								kind: "step",
								content,
							});
						} else {
							updateMessage(budgetMsgId, content);
						}
						break;
					}
					case "awaiting_approval":
					case "cancelled": {
						// Approval is surfaced by the result's `awaitingApproval` (dialog);
						// cancellation by the closing note below. Just seal the live bubble.
						commitLive();
						setAgentStatus(null);
						break;
					}
				}
			};

			try {
				const result = await runDirectorAgent({
					director,
					chat: (message, system) =>
						aiClient.chat(message, system).then((r) => r.response),
					userMessage: trimmed,
					onEvent,
					signal: controller.signal,
				});
				commitLive();
				if (result.cancelled) {
					addMessage({
						id: crypto.randomUUID(),
						role: "assistant",
						kind: "step",
						content: `⏹ ${result.finalMessage || "Stopped."}`,
					});
				} else if (!streamedText && result.finalMessage) {
					// Nothing streamed (local brain, or a text-less close) — add the
					// final summary as its own bubble.
					addMessage({
						id: crypto.randomUUID(),
						role: "assistant",
						kind: "text",
						content: result.finalMessage,
					});
				}
				// The run paused on a gated verb — surface the cost dialog so the
				// user can approve (or dismiss) the exact proposed spend.
				if (result.awaitingApproval) {
					setChatApproval(result.awaitingApproval);
				} else if (!result.cancelled && toolMsgIds.size > 0) {
					// Item 6 — a settled run's tool chips collapse into one summary
					// line a few seconds later (click to expand back to the detail),
					// plus a transient toast for the outcome. Skipped while a cost
					// approval is pending (the chips are still live context for that
					// decision) or after a cancel (the partial trail stays visible).
					const runId = crypto.randomUUID();
					const stepIds = Array.from(toolMsgIds.values());
					setTimeout(() => {
						setCollapsedToolRuns((prev) => ({ ...prev, [runId]: stepIds }));
						toast.success(
							`Done — ${stepIds.length} step${stepIds.length === 1 ? "" : "s"}`,
							{ description: "Tap the summary to see what ran." },
						);
					}, 2500);
				}
			} catch (error) {
				commitLive();
				const detail = error instanceof Error ? error.message : "";
				// Relay failures and the no-brain-configured error carry their own
				// actionable explanation (the local Ollama fallback is retired, so
				// there is no silent-degrade path to hint at anymore).
				const isRelayIssue = detail.includes("Claude relay");
				const isConfigIssue = detail.includes("No Director brain");
				addMessage({
					id: crypto.randomUUID(),
					role: "assistant",
					kind: "step",
					content: isRelayIssue
						? `${detail} Check ANTHROPIC_API_KEY / GEMINI_API_KEY / DIRECTOR_MODEL in apps/web/.env.local.`
						: isConfigIssue
							? detail
							: `Something went wrong: ${detail || "Unknown error"}.`,
				});
			} finally {
				abortRef.current = null;
				setIsThinking(false);
				setAgentStatus(null);
			}
			return;
		}

		const assistantId = crypto.randomUUID();
		let messageAdded = false;

		try {
			let prompt = trimmed;
			let systemPrompt: string | undefined;

			if (mode === "transcript" && hasTranscript) {
				const fullText = transcriptSegments.map((s) => s.text).join(" ");
				systemPrompt =
					"You are a video script editor. The user has a video transcript and wants you to help edit, rewrite, or improve it. " +
					"When rewriting, preserve the key information but improve the text as requested. " +
					"Return only the improved text, not explanations.";
				if (!prompt.includes(fullText.slice(0, 50))) {
					prompt = `${prompt}\n\nTranscript:\n${fullText}`;
				}
			}

			const result = await aiClient.chatStream(
				prompt,
				(_token, accumulated) => {
					if (!messageAdded) {
						// Add the assistant message only when the first token arrives
						addMessage({
							id: assistantId,
							role: "assistant",
							kind: "text",
							content: accumulated,
						});
						messageAdded = true;
					} else {
						updateMessage(assistantId, accumulated);
					}
				},
				systemPrompt,
			);

			// Final update with complete response
			if (!result.response) {
				if (!messageAdded) {
					addMessage({
						id: assistantId,
						role: "assistant",
						kind: "text",
						content: "Here's what I suggest based on your request.",
					});
				} else {
					updateMessage(
						assistantId,
						"Here's what I suggest based on your request.",
					);
				}
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : "";
			const isOllamaDown = detail.includes("503") || detail.includes("Ollama");
			const errorContent = isOllamaDown
				? "Ollama is not running or no LLM model is loaded. Open the AI Setup guide (click the AI indicator in the header) to pull a model like `llama3.2:1b`."
				: `Something went wrong: ${detail || "Unknown error"}. Make sure the AI backend and Ollama are running with a model loaded.`;

			if (!messageAdded) {
				addMessage({
					id: assistantId,
					role: "assistant",
					kind: "step",
					content: errorContent,
				});
			} else {
				updateMessage(assistantId, errorContent);
			}
		} finally {
			setIsThinking(false);
		}
	}, [
		inputValue,
		isThinking,
		isConnected,
		mode,
		hasTranscript,
		transcriptSegments,
		addMessage,
		updateMessage,
		director,
		setInputValue,
	]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				handleSend();
			}
		},
		[handleSend],
	);

	const handleStarterPrompt = (prompt: string) => {
		setInputValue(prompt);
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			if (inputRef.current) {
				inputRef.current.selectionStart = prompt.length;
				inputRef.current.selectionEnd = prompt.length;
			}
		});
	};

	return (
		<div className="relative flex h-full flex-col overflow-hidden">
			{/* Header */}
			<div className="bg-background h-11 shrink-0 px-4 pr-2 flex items-center justify-between border-b">
				<div className="flex items-center gap-2 shrink-0">
					{activeModel && (
						<Badge
							variant="secondary"
							className="text-[10px] px-1.5 py-0 font-mono"
						>
							{activeModel}
						</Badge>
					)}
				</div>
				{/* Tab strip — Director is chat-only now (Direct + Script when a
				    transcript exists); every other panel lives in the sibling
				    "Tools" tab (see design doc Item 4 / ./tools.tsx). */}
				<div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto [&>button]:shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					<Button
						variant={mode === "chat" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-[10px] px-2 gap-1"
						onClick={() => setMode("chat")}
					>
						<HugeiconsIcon icon={FilmRoll01Icon} className="size-3" />
						Direct
					</Button>
					{(mode === "chat" || mode === "transcript") &&
						messages.length > 0 && (
							<Button
								variant="ghost"
								size="sm"
								className="h-6 text-[10px] px-1.5 text-muted-foreground"
								onClick={clearMessages}
							>
								<HugeiconsIcon icon={Delete02Icon} className="size-3" />
							</Button>
						)}
					{hasTranscript && (
						<Button
							variant={mode === "transcript" ? "secondary" : "ghost"}
							size="sm"
							className="h-6 text-[10px] px-2"
							onClick={() => setMode("transcript")}
						>
							Script
						</Button>
					)}
				</div>
			</div>

			{/* Not connected banner — points at the retired local stack's docker
			    setup, so it only renders while that stack is a supported path. */}
			{!isConnected && isFeatureAvailable("localBackendSetup") && (
				<div className="mx-2 mt-2 rounded-lg bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-500 shrink-0">
					<p className="font-medium">AI backend not connected</p>
					<p className="text-yellow-500/70 mt-0.5">
						Start the backend to use AI brainstorming.
					</p>
					<Button
						variant="outline"
						size="sm"
						className="h-6 text-[10px] mt-1.5"
						onClick={toggleSetupGuide}
					>
						Setup guide
					</Button>
				</div>
			)}

			{/* ── Chat / Transcript Mode ── */}
			{(mode === "chat" || mode === "transcript") && (
				<>
					{/* Scrollable messages — fills available space */}
					<div
						ref={scrollRef}
						className="flex-1 min-h-0 overflow-y-auto px-2 py-2"
					>
						{messages.length === 0 &&
							mode === "transcript" &&
							hasTranscript && (
								<div className="flex flex-col gap-3 py-4 px-1">
									<div className="text-center">
										<HugeiconsIcon
											icon={TextIcon}
											className="size-8 text-muted-foreground/30 mx-auto mb-2"
										/>
										<p className="text-xs font-medium">Edit script with AI</p>
										<p className="text-[10px] text-muted-foreground mt-0.5">
											Rewrite, improve, or transform your transcript
										</p>
									</div>

									<div className="rounded-md bg-muted/50 px-3 py-2 max-h-32 overflow-y-auto">
										<p className="text-[10px] text-muted-foreground leading-relaxed">
											{transcriptSegments
												.map((s) => s.text)
												.join(" ")
												.slice(0, 300)}
											{transcriptSegments.map((s) => s.text).join(" ").length >
												300 && "..."}
										</p>
									</div>

									<div className="flex flex-col gap-1.5">
										{TRANSCRIPT_PROMPTS.map((starter) => (
											<button
												key={starter.label}
												type="button"
												onClick={() => {
													const fullText = transcriptSegments
														.map((s) => s.text)
														.join(" ");
													handleStarterPrompt(starter.prompt + fullText);
												}}
												className="text-left rounded-md border px-2.5 py-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
											>
												{starter.label}
											</button>
										))}
									</div>
								</div>
							)}

						{messages.length === 0 && mode === "chat" && (
							<div className="flex flex-col gap-3 py-4 px-1">
								<div className="text-center">
									<HugeiconsIcon
										icon={SparklesIcon}
										className="size-8 text-muted-foreground/30 mx-auto mb-2"
									/>
									<p className="text-xs font-medium">Direct with AI</p>
									<p className="text-[10px] text-muted-foreground mt-0.5">
										Brainstorm scripts and ideas, or tell me to storyboard and
										generate the reel for you
									</p>
								</div>

								<div className="flex flex-col gap-1.5">
									{STARTER_PROMPTS.map((starter) => (
										<button
											key={starter.label}
											type="button"
											onClick={() => handleStarterPrompt(starter.prompt)}
											className="text-left rounded-md border px-2.5 py-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
										>
											{starter.label}
										</button>
									))}
								</div>
							</div>
						)}

						{(() => {
							// Item 6 — render-time grouping: a settled run's step-chip ids
							// collapse into one summary bubble at their first id (the
							// "anchor"); the rest of that run's ids are hidden. Expanding
							// a run (click) drops it out of this computation entirely, so
							// every original chip reappears untouched.
							const collapseSummaryByAnchor = new Map<
								string,
								{ runId: string; count: number }
							>();
							const hiddenStepMessageIds = new Set<string>();
							for (const [runId, stepIds] of Object.entries(
								collapsedToolRuns,
							)) {
								if (expandedToolRuns.has(runId) || stepIds.length === 0)
									continue;
								const [anchor, ...rest] = stepIds;
								collapseSummaryByAnchor.set(anchor, {
									runId,
									count: stepIds.length,
								});
								for (const stepId of rest) hiddenStepMessageIds.add(stepId);
							}

							return messages.map((msg) => {
								if (hiddenStepMessageIds.has(msg.id)) return null;
								const collapsed = collapseSummaryByAnchor.get(msg.id);
								if (collapsed) {
									return (
										<div key={msg.id} className="mb-3">
											<button
												type="button"
												onClick={() =>
													setExpandedToolRuns((prev) =>
														new Set(prev).add(collapsed.runId),
													)
												}
												className="w-full text-left rounded-lg bg-muted/60 mr-2 px-3 py-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
											>
												Done — {collapsed.count} step
												{collapsed.count === 1 ? "" : "s"}
											</button>
										</div>
									);
								}
								return (
									<div key={msg.id} className="mb-3">
										{msg.role === "user" ? (
											<div className="rounded-lg bg-primary text-primary-foreground ml-6 px-3 py-2 text-xs">
												{msg.content}
											</div>
										) : (
											<div className="rounded-lg bg-muted mr-2 px-3 py-2.5">
												<div className="prose-studio text-xs leading-relaxed">
													<ReactMarkdown
														components={{
															// Item 2 — down-rank h1/h2 to inline emphasis: same
															// size/weight as body text, no heading-level block
															// spacing, so a reply can't read as a wall of
															// headed sections.
															h1: ({ children }) => (
																<p className="font-semibold mb-1.5 last:mb-0">
																	{children}
																</p>
															),
															h2: ({ children }) => (
																<p className="font-semibold mb-1.5 last:mb-0">
																	{children}
																</p>
															),
															h3: ({ children }) => (
																<h4 className="text-xs font-semibold mt-1.5 mb-0.5">
																	{children}
																</h4>
															),
															p: ({ children }) => (
																<p className="mb-1.5 last:mb-0">{children}</p>
															),
															strong: ({ children }) => (
																<strong className="font-semibold text-foreground">
																	{children}
																</strong>
															),
															em: ({ children }) => (
																<em className="italic">{children}</em>
															),
															ul: ({ children }) => (
																<ul className="list-disc pl-4 mb-1.5 space-y-0.5">
																	{children}
																</ul>
															),
															ol: ({ children }) => (
																<ol className="list-decimal pl-4 mb-1.5 space-y-0.5">
																	{children}
																</ol>
															),
															li: ({ children }) => <li>{children}</li>,
															code: ({ children, className }) => {
																const isBlock =
																	className?.includes("language-");
																if (isBlock) {
																	return (
																		<pre className="bg-background rounded px-2 py-1.5 my-1.5 overflow-x-auto text-[10px] font-mono">
																			<code>{children}</code>
																		</pre>
																	);
																}
																return (
																	<code className="bg-background rounded px-1 py-0.5 text-[10px] font-mono">
																		{children}
																	</code>
																);
															},
															blockquote: ({ children }) => (
																<blockquote className="border-l-2 border-primary/40 pl-2 my-1.5 text-muted-foreground italic">
																	{children}
																</blockquote>
															),
														}}
													>
														{msg.content}
													</ReactMarkdown>
												</div>
												{/* Item 3 — "Save idea" renders ONLY on a final answer
												    bubble, never on a step/status row (tool chips,
												    budget bubble, cancel/error notes). */}
												{msg.kind !== "step" && (
													<div className="flex items-center gap-1 mt-2 pt-1.5 border-t border-border/50">
														<Button
															variant="ghost"
															size="sm"
															className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground gap-1"
															onClick={() => {
																saveIdea(msg.content);
																toast.success("Idea saved", {
																	description: "View it in the Tools tab.",
																	action: {
																		label: "View",
																		onClick: () => openToolsPanel("ideas"),
																	},
																});
															}}
														>
															<HugeiconsIcon
																icon={Bookmark01Icon}
																className="size-3"
															/>
															Save idea
														</Button>
													</div>
												)}
											</div>
										)}
									</div>
								);
							});
						})()}

						{isThinking && (
							<div className="mx-2 my-1">
								<div className="border border-dashed border-primary/30 rounded-lg px-3 py-2.5 bg-primary/[0.03]">
									<div className="flex items-center gap-2">
										<Spinner className="size-3 text-primary/60" />
										<span className="text-[11px] text-primary/70 font-medium animate-pulse">
											{agentStatus ?? thinkingMessage}
										</span>
									</div>
								</div>
							</div>
						)}
					</div>

					{/* Input — ALWAYS at bottom, outside scroll */}
					<div className="border-t px-2 py-2 shrink-0 bg-background">
						<div className="flex items-end gap-1.5">
							<textarea
								ref={inputRef}
								value={inputValue}
								onChange={(event) => setInputValue(event.target.value)}
								onKeyDown={handleKeyDown}
								placeholder={
									!isConnected && mode !== "chat"
										? "Connect AI backend first"
										: mode === "transcript"
											? "Tell AI how to edit the transcript..."
											: "Describe your video idea..."
								}
								disabled={!isConnected && mode !== "chat"}
								rows={1}
								className={cn(
									"flex-1 resize-none rounded-md border bg-transparent px-2.5 py-2 text-xs outline-none",
									"focus:ring-1 focus:ring-ring",
									"placeholder:text-muted-foreground/50",
									"disabled:opacity-50",
									"min-h-[36px] max-h-[100px]",
								)}
								style={
									{
										fieldSizing: "content",
									} as React.CSSProperties
								}
							/>
							{isThinking && mode === "chat" ? (
								// Active agent run → Stop button (cooperative cancel). Completed
								// steps keep their effect; the run halts between calls.
								<Button
									size="icon"
									variant="destructive"
									className="size-[36px] shrink-0"
									onClick={handleStopAgent}
									title="Stop the Director"
								>
									<HugeiconsIcon icon={StopIcon} className="size-3.5" />
								</Button>
							) : (
								<Button
									size="icon"
									variant={inputValue.trim() ? "default" : "secondary"}
									className="size-[36px] shrink-0"
									onClick={handleSend}
									disabled={
										!inputValue.trim() ||
										isThinking ||
										(!isConnected && mode !== "chat")
									}
								>
									{isThinking ? (
										<Spinner className="size-3.5" />
									) : (
										<HugeiconsIcon icon={SentIcon} className="size-3.5" />
									)}
								</Button>
							)}
						</div>
						<div className="mt-1 flex items-center justify-between">
							{mode === "chat" ? (
								<EnhancePromptButton
									mode="director"
									getPrompt={() => inputValue}
									setPrompt={setInputValue}
									getContext={getDirectorContext}
								/>
							) : (
								<span />
							)}
							<p className="text-[9px] text-muted-foreground">
								Enter to send &middot; Shift+Enter for new line
							</p>
							<span className="w-6" />
						</div>
					</div>
				</>
			)}

			{/* Cost-preview approval gate — chat agent's paused generate/reroll. */}
			{chatApproval && (
				<CostApprovalDialog
					open={!!chatApproval}
					onOpenChange={(o) => {
						if (!o) setChatApproval(null);
					}}
					estimate={chatApproval.estimate}
					clips={chatApproval.clips}
					onApprove={approveChatAction}
				/>
			)}
		</div>
	);
}
