"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { cn } from "@/utils/ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SparklesIcon,
	TextIcon,
	Image01Icon,
	ArrowLeft01Icon,
	ArrowRight01Icon,
	Bookmark01Icon,
	Delete02Icon,
	FilmRoll01Icon,
	AiMicIcon,
	CropIcon,
	CursorMove01Icon,
	Analytics01Icon,
	AnalyticsUpIcon,
	Video01Icon,
	Video02Icon,
	Scissor01Icon,
	ClockIcon,
	LeftToRightListDashIcon,
} from "@hugeicons/core-free-icons";
import { isFeatureAvailable } from "@/lib/local-ai/retired-features";
import { useAIStatus } from "@/hooks/use-ai-status";
import { useAIStore } from "@/stores/ai-store";
import { useTranscriptStore } from "@/stores/transcript-store";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { TemplatePanel } from "@/components/editor/ai/template-panel";
import { BRollSuggestionsPanel } from "@/components/editor/ai/broll-suggestions-panel";
import { YouTubeReelsPanel } from "@/components/editor/youtube/youtube-reels-panel";
import { EngagementPanel } from "@/components/editor/youtube/engagement-panel";
import { AIDubbingPanel } from "@/components/editor/panels/assets/views/ai-dubbing";
import { AutoChaptersPanel } from "@/components/editor/panels/assets/views/auto-chapters";
import { SmartReframePanel } from "@/components/editor/panels/assets/views/smart-reframe";
import { MotionTrackingPanel } from "@/components/editor/panels/assets/views/motion-tracking";
import { ABTestingPanel } from "@/components/editor/panels/assets/views/ab-testing";
import { ScriptToVideoPanel } from "@/components/editor/panels/assets/views/script-to-video";
import { ShortsComposerPanel } from "@/components/editor/panels/assets/views/shorts-composer";
import { SceneDetectionPanel } from "@/components/editor/panels/assets/views/scene-detection";
import { ThumbnailGenPanel } from "@/components/editor/panels/assets/views/thumbnail-gen";

// This file hosts the 12 "operations on existing media" panels that used to
// be bolted onto Director's chat tab (see the Director-revamp design doc,
// Item 4 / PARTITION row D). Director itself (`./director.tsx`) is chat-only
// now; everything here is reached through this sibling "Tools" tab instead.

// ----- Types -----

interface WorkflowStep {
	id: string;
	label: string;
	description: string;
	icon: typeof SparklesIcon;
	action: string;
	isCompleted?: boolean;
}

type ToolMode =
	| "grid"
	| "templates"
	| "ideas"
	| "workflow"
	| "broll"
	| "youtube-reels"
	| "dubbing"
	| "chapters"
	| "reframe"
	| "tracking"
	| "ab-testing"
	| "engagement"
	| "script-to-video"
	| "shorts"
	| "scenes"
	| "thumbnail";

interface ToolTile {
	mode: Exclude<ToolMode, "grid">;
	label: string;
	description: string;
	icon: typeof SparklesIcon;
	badge?: number;
}

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

// ----- Component -----

export function ToolsView() {
	const { isConnected } = useAIStatus();
	const hasTranscript = useTranscriptStore((s) => s.segments.length > 0);
	const savedIdeas = useAIStore((s) => s.savedIdeas);
	const removeIdea = useAIStore((s) => s.removeIdea);
	const clearIdeas = useAIStore((s) => s.clearIdeas);

	const setActiveTab = useAssetsPanelStore((s) => s.setActiveTab);
	const requestDirectorPrompt = useAssetsPanelStore(
		(s) => s.requestDirectorPrompt,
	);
	// Deep link from Director chat's "Save idea" toast, or any future caller —
	// opens straight into a specific panel instead of landing on the grid.
	const pendingToolsPanel = useAssetsPanelStore((s) => s.pendingToolsPanel);
	const clearPendingToolsPanel = useAssetsPanelStore(
		(s) => s.clearPendingToolsPanel,
	);

	const [mode, setMode] = useState<ToolMode>("grid");
	const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
	const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());

	useEffect(() => {
		if (!pendingToolsPanel) return;
		setMode(pendingToolsPanel.panel as ToolMode);
		clearPendingToolsPanel();
	}, [pendingToolsPanel, clearPendingToolsPanel]);

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

	// Same visibility gating the panels had as tab-strip buttons on
	// director.tsx before the split: hasTranscript for panels that operate on
	// a transcript, isFeatureAvailable for panels retired with the old Python
	// stack (see lib/local-ai/retired-features.ts).
	const tiles: ToolTile[] = [
		{
			mode: "templates",
			label: "Templates",
			description: "Start from a reel structure template.",
			icon: SparklesIcon,
		},
		{
			mode: "ideas",
			label: "Ideas",
			description: "Saved brainstorms from Director chat.",
			icon: Bookmark01Icon,
			badge: savedIdeas.length || undefined,
		},
		{
			mode: "workflow",
			label: "Workflows",
			description: "Step-by-step guides from idea to export.",
			icon: LeftToRightListDashIcon,
		},
		...(hasTranscript
			? [
					{
						mode: "broll" as const,
						label: "B-Roll",
						description: "AI-suggested cutaway shots for your transcript.",
						icon: FilmRoll01Icon,
					},
				]
			: []),
		...(isFeatureAvailable("youtubeImport")
			? [
					{
						mode: "youtube-reels" as const,
						label: "YouTube Reels",
						description: "Import and clip YouTube videos into reels.",
						icon: Video02Icon,
					},
				]
			: []),
		...(hasTranscript && isFeatureAvailable("dubbing")
			? [
					{
						mode: "dubbing" as const,
						label: "Dubbing",
						description: "AI voice dubbing for your transcript.",
						icon: AiMicIcon,
					},
				]
			: []),
		...(hasTranscript
			? [
					{
						mode: "chapters" as const,
						label: "Chapters",
						description: "Auto-generate chapter markers from your transcript.",
						icon: ClockIcon,
					},
				]
			: []),
		{
			mode: "reframe",
			label: "Reframe",
			description: "Smart-crop footage to a new aspect ratio.",
			icon: CropIcon,
		},
		{
			mode: "tracking",
			label: "Tracking",
			description: "Track and follow subjects across the frame.",
			icon: CursorMove01Icon,
		},
		{
			mode: "ab-testing",
			label: "A/B Test",
			description: "Compare take variants side by side.",
			icon: Analytics01Icon,
		},
		{
			mode: "engagement",
			label: "Engagement Score",
			description: "Check your video's engagement score before publishing.",
			icon: AnalyticsUpIcon,
		},
		...(isFeatureAvailable("scriptToVideo")
			? [
					{
						mode: "script-to-video" as const,
						label: "Script→Video",
						description: "Turn a script into a generated rough cut.",
						icon: TextIcon,
					},
				]
			: []),
		{
			mode: "shorts",
			label: "Shorts",
			description: "Compose a vertical short from your footage.",
			icon: Video01Icon,
		},
		{
			mode: "scenes",
			label: "Scenes",
			description: "Detect scene changes and split at cuts.",
			icon: Scissor01Icon,
		},
		{
			mode: "thumbnail",
			label: "Thumbnail",
			description: "Generate a thumbnail image for your video.",
			icon: Image01Icon,
		},
	];

	const currentTile = tiles.find((t) => t.mode === mode);

	return (
		<div className="relative flex h-full flex-col overflow-hidden">
			{/* Header */}
			<div className="bg-background h-11 shrink-0 px-4 pr-2 flex items-center justify-between border-b">
				{mode === "grid" ? (
					<span className="text-xs font-medium">Tools</span>
				) : (
					<button
						type="button"
						onClick={() => {
							setMode("grid");
							setSelectedWorkflow(null);
						}}
						className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
					>
						<HugeiconsIcon icon={ArrowLeft01Icon} className="size-3.5" />
						{currentTile?.label ?? "Tools"}
					</button>
				)}
			</div>

			{/* ── Grid launcher ── */}
			{mode === "grid" && (
				<div className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
					<p className="text-[11px] text-muted-foreground px-1 mb-2">
						Operations on your existing media — pick a tool to open it.
					</p>
					<div className="grid grid-cols-2 gap-2">
						{tiles.map((tile) => (
							<button
								key={tile.mode}
								type="button"
								onClick={() => setMode(tile.mode)}
								className="flex flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left hover:bg-accent transition-colors"
							>
								<div className="flex items-center justify-between w-full">
									<HugeiconsIcon
										icon={tile.icon}
										className="size-4 text-primary"
									/>
									{!!tile.badge && (
										<span className="bg-primary text-primary-foreground rounded-full text-[8px] size-4 flex items-center justify-center font-bold">
											{tile.badge}
										</span>
									)}
								</div>
								<p className="text-[11px] font-medium">{tile.label}</p>
								<p className="text-[9px] text-muted-foreground leading-snug">
									{tile.description}
								</p>
							</button>
						))}
					</div>
				</div>
			)}

			{/* ── Templates ── */}
			{mode === "templates" && <TemplatePanel className="flex-1 min-h-0" />}

			{/* ── B-Roll ── */}
			{mode === "broll" && <BRollSuggestionsPanel className="flex-1 min-h-0" />}

			{/* ── Dubbing ── */}
			{mode === "dubbing" && isFeatureAvailable("dubbing") && (
				<div className="flex-1 min-h-0 overflow-y-auto">
					<AIDubbingPanel />
				</div>
			)}

			{/* ── Auto Chapters ── */}
			{mode === "chapters" && (
				<div className="flex-1 min-h-0 overflow-y-auto">
					<AutoChaptersPanel />
				</div>
			)}

			{/* ── YouTube Reels ── */}
			{mode === "youtube-reels" && isFeatureAvailable("youtubeImport") && (
				<div className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
					<YouTubeReelsPanel />
				</div>
			)}

			{/* ── Smart Reframe ── */}
			{mode === "reframe" && <SmartReframePanel className="flex-1 min-h-0" />}

			{/* ── Motion Tracking ── */}
			{mode === "tracking" && (
				<MotionTrackingPanel className="flex-1 min-h-0" />
			)}

			{/* ── A/B Testing ── */}
			{mode === "ab-testing" && <ABTestingPanel className="flex-1 min-h-0" />}

			{/* ── Engagement Score ── */}
			{mode === "engagement" && (
				<div className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
					<EngagementPanel />
				</div>
			)}

			{/* ── Script-to-Video ── */}
			{mode === "script-to-video" && isFeatureAvailable("scriptToVideo") && (
				<ScriptToVideoPanel className="flex-1 min-h-0" />
			)}

			{/* ── Shorts Composer ── */}
			{mode === "shorts" && <ShortsComposerPanel className="flex-1 min-h-0" />}

			{/* ── Scene Detection ── */}
			{mode === "scenes" && <SceneDetectionPanel className="flex-1 min-h-0" />}

			{/* ── Thumbnail Generator ── */}
			{mode === "thumbnail" && <ThumbnailGenPanel className="flex-1 min-h-0" />}

			{/* ── Ideas ── */}
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
								onClick={() => setActiveTab("director")}
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

			{/* ── Workflows ── */}
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
										{isCompleted ? "✓" : index + 1}
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

						{/* Ask AI about this step — hands off to Director chat, since
						    Tools and Director are separate panel tabs (see
						    `requestDirectorPrompt` in assets-panel-store.ts). */}
						{isConnected && (
							<Button
								variant="outline"
								size="sm"
								className="h-7 text-[11px] mt-1"
								onClick={() => {
									const currentStep = activeWorkflow.steps.find(
										(step) => !completedSteps.has(step.id),
									);
									if (currentStep) {
										requestDirectorPrompt(
											`Help me with "${currentStep.label}" for my ${activeWorkflow.title}. ${currentStep.description}`,
										);
									} else {
										setActiveTab("director");
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
		</div>
	);
}
