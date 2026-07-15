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
	AiMicIcon,
	TextIcon,
	Image01Icon,
	ArrowRight01Icon,
	Bookmark01Icon,
	Delete02Icon,
	FilmRoll01Icon,
	StopIcon,
} from "@hugeicons/core-free-icons";
import { aiClient } from "@/lib/ai-client";
import {
	isFeatureAvailable,
	retiredFeatureMessage,
} from "@/lib/local-ai/retired-features";
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
import { TemplatePanel } from "@/components/editor/ai/template-panel";
import { ComingSoon } from "@/components/editor/panels/assets/views/coming-soon";
import { BRollSuggestionsPanel } from "@/components/editor/ai/broll-suggestions-panel";
import { YouTubeReelsPanel } from "@/components/editor/youtube/youtube-reels-panel";
import { AIDubbingPanel } from "@/components/editor/panels/assets/views/ai-dubbing";
import { AutoChaptersPanel } from "@/components/editor/panels/assets/views/auto-chapters";
import { SmartReframePanel } from "@/components/editor/panels/assets/views/smart-reframe";
import { MotionTrackingPanel } from "@/components/editor/panels/assets/views/motion-tracking";
import { ABTestingPanel } from "@/components/editor/panels/assets/views/ab-testing";
import { ScriptToVideoPanel } from "@/components/editor/panels/assets/views/script-to-video";
import { ShortsComposerPanel } from "@/components/editor/panels/assets/views/shorts-composer";
import { SceneDetectionPanel } from "@/components/editor/panels/assets/views/scene-detection";
import { ThumbnailGenPanel } from "@/components/editor/panels/assets/views/thumbnail-gen";

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

interface WorkflowStep {
	id: string;
	label: string;
	description: string;
	icon: typeof SparklesIcon;
	action: string;
	isCompleted?: boolean;
}

type StudioMode =
	| "chat"
	| "workflow"
	| "transcript"
	| "templates"
	| "ideas"
	| "broll"
	| "youtube-reels"
	| "dubbing"
	| "chapters"
	| "reframe"
	| "tracking"
	| "ab-testing"
	| "script-to-video"
	| "shorts"
	| "scenes"
	| "thumbnail";

// ----- Workflow Steps -----

const VIDEO_WORKFLOWS: {
	id: string;
	title: string;
	description: string;
	steps: WorkflowStep[];
}[] = [
	{
		id: "youtube",
		title: "YouTube video",
		description: "Plan, script, and produce a YouTube video",
		steps: [
			{
				id: "brainstorm",
				label: "Brainstorm the idea",
				description:
					"Describe your topic and audience. AI helps refine your angle.",
				icon: SparklesIcon,
				action: "brainstorm",
			},
			{
				id: "outline",
				label: "Create an outline",
				description:
					"AI generates a structured outline with key points and timestamps.",
				icon: TextIcon,
				action: "outline",
			},
			{
				id: "script",
				label: "Write the script",
				description:
					"Turn the outline into a full script with intro, body, and CTA.",
				icon: TextIcon,
				action: "script",
			},
			{
				id: "record",
				label: "Record and import",
				description:
					"Record your video following the script, then import it here.",
				icon: AiMicIcon,
				action: "import",
			},
			{
				id: "transcribe",
				label: "Transcribe and edit",
				description: "Transcribe the recording, then edit text to edit video.",
				icon: AiMicIcon,
				action: "transcribe",
			},
			{
				id: "polish",
				label: "Polish with AI",
				description:
					"Remove fillers, silences, add subtitles, generate thumbnail.",
				icon: Image01Icon,
				action: "polish",
			},
		],
	},
	{
		id: "short",
		title: "Short-form content",
		description: "TikTok, Reels, or YouTube Shorts",
		steps: [
			{
				id: "hook",
				label: "Craft the hook",
				description: "AI helps write a 3-second hook that stops the scroll.",
				icon: SparklesIcon,
				action: "hook",
			},
			{
				id: "script",
				label: "Script the content",
				description:
					"Keep it tight — AI structures your message for 30-60 seconds.",
				icon: TextIcon,
				action: "script-short",
			},
			{
				id: "record",
				label: "Record vertically",
				description: "Film in 9:16 portrait mode following the script.",
				icon: AiMicIcon,
				action: "import",
			},
			{
				id: "edit",
				label: "Fast-cut edit",
				description: "Remove silences and filler for punchy pacing.",
				icon: SparklesIcon,
				action: "fast-edit",
			},
			{
				id: "subtitles",
				label: "Add bold subtitles",
				description: "Most viewers watch muted — add animated captions.",
				icon: TextIcon,
				action: "subtitles",
			},
		],
	},
	{
		id: "podcast",
		title: "Podcast episode",
		description: "Record, clean, and clip a podcast",
		steps: [
			{
				id: "plan",
				label: "Plan the episode",
				description:
					"AI helps structure topics, questions, and talking points.",
				icon: SparklesIcon,
				action: "plan-podcast",
			},
			{
				id: "import",
				label: "Import recording",
				description: "Import your podcast recording.",
				icon: AiMicIcon,
				action: "import",
			},
			{
				id: "clean",
				label: "Clean the audio",
				description: "Remove background noise and normalize levels.",
				icon: SparklesIcon,
				action: "clean-audio",
			},
			{
				id: "transcribe",
				label: "Transcribe and find clips",
				description: "Transcribe to easily navigate and find the best moments.",
				icon: TextIcon,
				action: "transcribe",
			},
			{
				id: "clip",
				label: "Create highlight clips",
				description: "AI identifies the best segments for social media clips.",
				icon: Image01Icon,
				action: "highlights",
			},
		],
	},
];

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
	const savedIdeas = useAIStore((s) => s.savedIdeas);
	const removeIdea = useAIStore((s) => s.removeIdea);
	const clearIdeas = useAIStore((s) => s.clearIdeas);
	const messages = useAIStore((s) => s.studioMessages);
	const addMessage = useAIStore((s) => s.addStudioMessage);
	const updateMessage = useAIStore((s) => s.updateStudioMessage);
	const clearMessages = useAIStore((s) => s.clearStudioMessages);
	const transcriptSegments = useTranscriptStore((s) => s.segments);
	const hasTranscript = transcriptSegments.length > 0;

	// ── Orchestrator (Director API) ──
	const editor = useEditor();
	const director = useDirector();

	// Cost-preview approval gate (concept: cost-preview gate). Pending confirmation
	// for a gated verb the chat agent proposed but paused on — it runs only after
	// the user approves the estimate.
	const approvalThresholdCredits = useStudioSettingsStore(
		(s) => s.approvalThresholdCredits,
	);
	const [chatApproval, setChatApproval] = useState<AgentApproval | null>(null);

	const [mode, setMode] = useState<StudioMode>("chat");
	const [inputValue, setInputValue] = useState("");
	const [isThinking, setIsThinking] = useState(false);
	const thinkingMessage = useThinkingMessage(isThinking);
	const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
	const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
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
			// fresh one starts after each tool step. `thinkId`/`textId` are the two
			// bubbles for the CURRENT turn (reasoning, then the answer text).
			const live = { textId: "", textBuf: "", thinkId: "", thinkBuf: "" };
			const commitLive = () => {
				live.textId = "";
				live.textBuf = "";
				live.thinkId = "";
				live.thinkBuf = "";
			};
			// callId → the message id of its "running…" chip, so tool_finish can
			// update the same bubble in place.
			const toolMsgIds = new Map<string, string>();
			let streamedText = false;
			// One persistent "spent X of $Y" bubble, updated in place as budgeted
			// generations run, so the running budget stays visible without spamming.
			let budgetMsgId = "";

			const onEvent = (event: DirectorEvent) => {
				switch (event.type) {
					case "thinking_delta": {
						live.thinkBuf += event.text;
						const content = `> 💭 ${live.thinkBuf}`;
						if (!live.thinkId) {
							live.thinkId = crypto.randomUUID();
							addMessage({ id: live.thinkId, role: "assistant", content });
						} else {
							updateMessage(live.thinkId, content);
						}
						break;
					}
					case "text_delta": {
						streamedText = true;
						// Once the answer text starts, this turn's reasoning is done.
						live.thinkId = "";
						live.textBuf += event.text;
						if (!live.textId) {
							live.textId = crypto.randomUUID();
							addMessage({
								id: live.textId,
								role: "assistant",
								content: live.textBuf,
							});
						} else {
							updateMessage(live.textId, live.textBuf);
						}
						break;
					}
					case "tool_start": {
						commitLive();
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
							addMessage({ id: budgetMsgId, role: "assistant", content });
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
						content: `⏹ ${result.finalMessage || "Stopped."}`,
					});
				} else if (!streamedText && result.finalMessage) {
					// Nothing streamed (local brain, or a text-less close) — add the
					// final summary as its own bubble.
					addMessage({
						id: crypto.randomUUID(),
						role: "assistant",
						content: result.finalMessage,
					});
				}
				// The run paused on a gated verb — surface the cost dialog so the
				// user can approve (or dismiss) the exact proposed spend.
				if (result.awaitingApproval) {
					setChatApproval(result.awaitingApproval);
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
					content: isRelayIssue
						? `${detail} Check ANTHROPIC_API_KEY / GEMINI_API_KEY / DIRECTOR_MODEL in apps/web/.env.local.`
						: isConfigIssue
							? detail
							: `Something went wrong: ${detail || "Unknown error"}.`,
				});
			} finally {
				abortRef.current = null;
				setIsThinking(false);
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

	const handleStepClick = (stepId: string) => {
		setCompletedSteps((prev) => {
			const next = new Set(prev);
			if (next.has(stepId)) {
				next.delete(stepId);
			} else {
				next.add(stepId);
			}
			return next;
		});
	};

	const activeWorkflow = VIDEO_WORKFLOWS.find((w) => w.id === selectedWorkflow);

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
				{/* Tab strip — scrolls horizontally so every panel stays reachable. */}
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
					{/* Reel templates call /api/template/generate, a retired-stack-only
					    route (see lib/local-ai/retired-features.ts) — kept visible with
					    a "Coming soon" placeholder (see the mode render below) rather
					    than hidden, so it isn't a dead end. */}
					<Button
						variant={mode === "templates" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-[10px] px-2"
						onClick={() => setMode("templates")}
					>
						Templates
					</Button>
					<Button
						variant={mode === "ideas" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-[10px] px-2 gap-1"
						onClick={() => setMode("ideas")}
					>
						Ideas
						{savedIdeas.length > 0 && (
							<span className="bg-primary text-primary-foreground rounded-full text-[8px] size-4 flex items-center justify-center font-bold">
								{savedIdeas.length}
							</span>
						)}
					</Button>
					{hasTranscript && (
						<Button
							variant={mode === "broll" ? "secondary" : "ghost"}
							size="sm"
							className="h-6 text-[10px] px-2"
							onClick={() => setMode("broll")}
						>
							B-Roll
						</Button>
					)}
					{/* Dubbing is retired with the Python TTS chain (see
					    lib/local-ai/retired-features.ts). */}
					{hasTranscript && isFeatureAvailable("dubbing") && (
						<Button
							variant={mode === "dubbing" ? "secondary" : "ghost"}
							size="sm"
							className="h-6 text-[10px] px-2"
							onClick={() => setMode("dubbing")}
						>
							Dub
						</Button>
					)}
					{hasTranscript && (
						<Button
							variant={mode === "chapters" ? "secondary" : "ghost"}
							size="sm"
							className="h-6 text-[10px] px-2"
							onClick={() => setMode("chapters")}
						>
							Chapters
						</Button>
					)}
					<Button
						variant={mode === "workflow" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-[10px] px-2"
						onClick={() => setMode("workflow")}
					>
						Workflows
					</Button>
					{/* YouTube import ran on the retired stack's yt-dlp service. */}
					{isFeatureAvailable("youtubeImport") && (
						<Button
							variant={mode === "youtube-reels" ? "secondary" : "ghost"}
							size="sm"
							className="h-6 text-[10px] px-2"
							onClick={() => setMode("youtube-reels")}
						>
							YT Reels
						</Button>
					)}
					<Button
						variant={mode === "reframe" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-[10px] px-2"
						onClick={() => setMode("reframe")}
					>
						Reframe
					</Button>
					<Button
						variant={mode === "tracking" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-[10px] px-2"
						onClick={() => setMode("tracking")}
					>
						Tracking
					</Button>
					<Button
						variant={mode === "ab-testing" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-[10px] px-2"
						onClick={() => setMode("ab-testing")}
					>
						A/B Test
					</Button>
					{/* Script-to-video is retired with the Python stack. */}
					{isFeatureAvailable("scriptToVideo") && (
						<Button
							variant={mode === "script-to-video" ? "secondary" : "ghost"}
							size="sm"
							className="h-6 text-[10px] px-2"
							onClick={() => setMode("script-to-video")}
						>
							Script→Video
						</Button>
					)}
					<Button
						variant={mode === "shorts" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-[10px] px-2"
						onClick={() => setMode("shorts")}
					>
						Shorts
					</Button>
					<Button
						variant={mode === "scenes" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-[10px] px-2"
						onClick={() => setMode("scenes")}
					>
						Scenes
					</Button>
					<Button
						variant={mode === "thumbnail" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-[10px] px-2"
						onClick={() => setMode("thumbnail")}
					>
						Thumbnail
					</Button>
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

						{messages.map((msg) => (
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
													h1: ({ children }) => (
														<h3 className="text-sm font-bold mt-2 mb-1">
															{children}
														</h3>
													),
													h2: ({ children }) => (
														<h4 className="text-xs font-bold mt-2 mb-1">
															{children}
														</h4>
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
														const isBlock = className?.includes("language-");
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
										<div className="flex items-center gap-1 mt-2 pt-1.5 border-t border-border/50">
											<Button
												variant="ghost"
												size="sm"
												className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground gap-1"
												onClick={() => {
													saveIdea(msg.content);
													toast.success("Idea saved", {
														description: "View it in the Ideas tab.",
														action: {
															label: "View",
															onClick: () => setMode("ideas"),
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
									</div>
								)}
							</div>
						))}

						{isThinking && (
							<div className="mx-2 my-1">
								<div className="border border-dashed border-primary/30 rounded-lg px-3 py-2.5 bg-primary/[0.03]">
									<div className="flex items-center gap-2">
										<Spinner className="size-3 text-primary/60" />
										<span className="text-[11px] text-primary/70 font-medium animate-pulse">
											{thinkingMessage}
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

			{/* ── Templates Mode ── */}
			{mode === "templates" &&
				(isFeatureAvailable("templates") ? (
					<TemplatePanel className="flex-1 min-h-0" />
				) : (
					<ComingSoon
						title="Templates"
						description={retiredFeatureMessage("templates")}
						className="flex-1 min-h-0"
					/>
				))}

			{/* ── B-Roll Mode ── */}
			{mode === "broll" && <BRollSuggestionsPanel className="flex-1 min-h-0" />}

			{/* ── Dubbing Mode ── */}
			{mode === "dubbing" && isFeatureAvailable("dubbing") && (
				<div className="flex-1 min-h-0 overflow-y-auto">
					<AIDubbingPanel />
				</div>
			)}

			{/* ── Auto Chapters Mode ── */}
			{mode === "chapters" && (
				<div className="flex-1 min-h-0 overflow-y-auto">
					<AutoChaptersPanel />
				</div>
			)}

			{/* ── YouTube Reels Mode ── */}
			{mode === "youtube-reels" && isFeatureAvailable("youtubeImport") && (
				<div className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
					<YouTubeReelsPanel />
				</div>
			)}

			{/* ── Smart Reframe Mode ── */}
			{mode === "reframe" && <SmartReframePanel className="flex-1 min-h-0" />}

			{/* ── Motion Tracking Mode ── */}
			{mode === "tracking" && (
				<MotionTrackingPanel className="flex-1 min-h-0" />
			)}

			{/* ── A/B Testing Mode ── */}
			{mode === "ab-testing" && <ABTestingPanel className="flex-1 min-h-0" />}

			{/* ── Script-to-Video Mode ── */}
			{mode === "script-to-video" && isFeatureAvailable("scriptToVideo") && (
				<ScriptToVideoPanel className="flex-1 min-h-0" />
			)}

			{/* ── Shorts Composer Mode ── */}
			{mode === "shorts" && <ShortsComposerPanel className="flex-1 min-h-0" />}

			{/* ── Scene Detection Mode ── */}
			{mode === "scenes" && <SceneDetectionPanel className="flex-1 min-h-0" />}

			{/* ── Thumbnail Generator Mode ── */}
			{mode === "thumbnail" && <ThumbnailGenPanel className="flex-1 min-h-0" />}

			{/* ── Ideas Mode ── */}
			{mode === "ideas" && (
				<div className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
					{savedIdeas.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
							<HugeiconsIcon
								icon={Bookmark01Icon}
								className="size-8 text-muted-foreground/30"
							/>
							<p className="text-xs font-medium">No saved ideas yet</p>
							<p className="text-[10px] text-muted-foreground leading-relaxed">
								Chat with AI and hit &ldquo;Save idea&rdquo; on any response to
								collect it here.
							</p>
							<Button
								variant="outline"
								size="sm"
								className="h-7 text-[11px] mt-2"
								onClick={() => setMode("chat")}
							>
								<HugeiconsIcon icon={SparklesIcon} className="size-3 mr-1" />
								Start brainstorming
							</Button>
						</div>
					) : (
						<>
							<div className="flex items-center justify-between px-1 mb-2">
								<p className="text-[11px] text-muted-foreground">
									{savedIdeas.length} saved idea
									{savedIdeas.length !== 1 ? "s" : ""}
								</p>
								<Button
									variant="ghost"
									size="sm"
									className="h-6 text-[10px] px-1.5 text-muted-foreground"
									onClick={clearIdeas}
								>
									<HugeiconsIcon
										icon={Delete02Icon}
										className="size-3 mr-0.5"
									/>
									Clear all
								</Button>
							</div>
							<div className="flex flex-col gap-2">
								{savedIdeas.map((idea) => (
									<div
										key={idea.id}
										className="rounded-lg border px-3 py-2.5 group relative"
									>
										<div className="text-xs leading-relaxed line-clamp-6 pr-6">
											<ReactMarkdown
												components={{
													p: ({ children }) => (
														<p className="mb-1 last:mb-0">{children}</p>
													),
													strong: ({ children }) => (
														<strong className="font-semibold">
															{children}
														</strong>
													),
													ul: ({ children }) => (
														<ul className="list-disc pl-4 mb-1 space-y-0.5">
															{children}
														</ul>
													),
													ol: ({ children }) => (
														<ol className="list-decimal pl-4 mb-1 space-y-0.5">
															{children}
														</ol>
													),
													li: ({ children }) => <li>{children}</li>,
												}}
											>
												{idea.content.length > 500
													? `${idea.content.slice(0, 500)}...`
													: idea.content}
											</ReactMarkdown>
										</div>
										<div className="flex items-center justify-between mt-2 pt-1.5 border-t border-border/50">
											<span className="text-[9px] text-muted-foreground">
												{new Date(idea.savedAt).toLocaleDateString(undefined, {
													month: "short",
													day: "numeric",
													hour: "2-digit",
													minute: "2-digit",
												})}
											</span>
											<Button
												variant="ghost"
												size="sm"
												className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
												onClick={() => removeIdea(idea.id)}
											>
												<HugeiconsIcon icon={Delete02Icon} className="size-3" />
											</Button>
										</div>
									</div>
								))}
							</div>
						</>
					)}
				</div>
			)}

			{/* ── Workflow Mode ── */}
			{mode === "workflow" && !activeWorkflow && (
				<div className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
					<p className="text-[11px] text-muted-foreground px-1 mb-2">
						Follow a step-by-step guide to create your video from idea to
						export.
					</p>
					{VIDEO_WORKFLOWS.map((workflow) => (
						<button
							key={workflow.id}
							type="button"
							onClick={() => setSelectedWorkflow(workflow.id)}
							className="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left hover:bg-accent transition-colors w-full mb-2"
						>
							<HugeiconsIcon
								icon={SparklesIcon}
								className="size-4 text-primary mt-0.5 shrink-0"
							/>
							<div className="flex-1 min-w-0">
								<p className="text-xs font-medium">{workflow.title}</p>
								<p className="text-[10px] text-muted-foreground mt-0.5">
									{workflow.description}
								</p>
								<Badge variant="secondary" className="text-[9px] mt-1.5">
									{workflow.steps.length} steps
								</Badge>
							</div>
							<HugeiconsIcon
								icon={ArrowRight01Icon}
								className="size-3.5 text-muted-foreground mt-1 shrink-0"
							/>
						</button>
					))}
				</div>
			)}

			{/* ── Active Workflow ── */}
			{mode === "workflow" && activeWorkflow && (
				<div className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
					<div className="flex items-center gap-2 px-1 mb-1">
						<button
							type="button"
							onClick={() => setSelectedWorkflow(null)}
							className="text-[10px] text-muted-foreground hover:text-foreground"
						>
							Workflows
						</button>
						<span className="text-[10px] text-muted-foreground">/</span>
						<span className="text-[11px] font-medium">
							{activeWorkflow.title}
						</span>
					</div>

					{/* Progress */}
					<div className="flex items-center gap-2 px-1 mb-2">
						<div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
							<div
								className="h-full bg-primary rounded-full transition-all"
								style={{
									width: `${(completedSteps.size / activeWorkflow.steps.length) * 100}%`,
								}}
							/>
						</div>
						<span className="text-[10px] text-muted-foreground tabular-nums">
							{completedSteps.size}/{activeWorkflow.steps.length}
						</span>
					</div>

					{/* Steps */}
					<div className="flex flex-col gap-2">
						{activeWorkflow.steps.map((step, index) => {
							const isCompleted = completedSteps.has(step.id);
							const isActive =
								!isCompleted &&
								(index === 0 ||
									completedSteps.has(activeWorkflow.steps[index - 1].id));

							return (
								<button
									key={step.id}
									type="button"
									onClick={() => handleStepClick(step.id)}
									className={cn(
										"flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all",
										isCompleted && "border-green-500/30 bg-green-500/5",
										isActive && "border-primary/30 bg-primary/5",
										!isCompleted && !isActive && "opacity-60",
									)}
								>
									<div
										className={cn(
											"flex items-center justify-center size-5 rounded-full text-[9px] font-bold shrink-0 mt-0.5",
											isCompleted
												? "bg-green-500 text-white"
												: isActive
													? "bg-primary text-primary-foreground"
													: "bg-muted text-muted-foreground",
										)}
									>
										{isCompleted ? "\u2713" : index + 1}
									</div>

									<div className="flex-1 min-w-0">
										<p
											className={cn(
												"text-[11px] font-medium",
												isCompleted && "line-through text-muted-foreground",
											)}
										>
											{step.label}
										</p>
										<p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
											{step.description}
										</p>
									</div>
								</button>
							);
						})}

						{/* Ask AI about this step */}
						{isConnected && (
							<Button
								variant="outline"
								size="sm"
								className="h-7 text-[11px] mt-1"
								onClick={() => {
									setMode("chat");
									const currentStep = activeWorkflow.steps.find(
										(step) => !completedSteps.has(step.id),
									);
									if (currentStep) {
										setInputValue(
											`Help me with "${currentStep.label}" for my ${activeWorkflow.title}. ${currentStep.description}`,
										);
										requestAnimationFrame(() => inputRef.current?.focus());
									}
								}}
							>
								<HugeiconsIcon icon={SparklesIcon} className="size-3 mr-1" />
								Ask AI about next step
							</Button>
						)}
					</div>
				</div>
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
