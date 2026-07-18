"use client";

import { cn } from "@/utils/ui";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AiMagicIcon,
	FilmRoll01Icon,
	Download01Icon,
	Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { useAIStore } from "@/stores/ai-store";

interface GuideStep {
	icon: typeof AiMagicIcon;
	title: string;
	description: string;
	shortcut?: string;
}

const GUIDE_STEPS: GuideStep[] = [
	{
		icon: AiMagicIcon,
		title: "Ask the Director",
		description:
			"Open the Director tab and ask for a video — it storyboards and shows the cost before spending",
		shortcut: "Director tab",
	},
	{
		icon: FilmRoll01Icon,
		title: "Generate takes",
		description: "Every clip is re-rollable — don't love one? Re-roll it",
	},
	{
		icon: Download01Icon,
		title: "Edit and export",
		description:
			"Trim, add transitions, grade with LUT color, then export with a platform preset",
	},
];

/**
 * Shows a visual guide when the editor has no content.
 *
 * BUG27: this used to be swapped in for the entire right panel (Generate /
 * Properties / Scopes — the composer), unmounting it while the guide was up.
 * It now renders as a dismissible floating card (see `app/editor/[project_id]
 * /page.tsx`) positioned away from the right panel entirely, so the composer
 * stays visible and usable the whole time. Sized to its content — not
 * `h-full` — since it's no longer stretched to fill a panel slot; a bounded
 * max-height + its own scroll keeps a long Ideas board from pushing the
 * dismiss button off a short viewport.
 */
export function EmptyEditorGuide({
	className,
	onDismiss,
}: {
	className?: string;
	onDismiss?: () => void;
}) {
	const savedIdeas = useAIStore((s) => s.savedIdeas);
	const removeIdea = useAIStore((s) => s.removeIdea);

	return (
		<div
			className={cn(
				"flex max-h-[calc(100vh-6rem)] flex-col items-center gap-6 overflow-y-auto rounded-xl border bg-background px-6 py-8 shadow-lg",
				className,
			)}
		>
			<div className="text-center">
				<h3 className="text-sm font-medium">Get started</h3>
				<p className="text-xs text-muted-foreground mt-1">
					Direct your first video
				</p>
			</div>

			<div className="flex flex-col gap-3 w-full max-w-52">
				{GUIDE_STEPS.map((step, index) => (
					<div key={step.title} className="flex items-start gap-2.5">
						<div className="flex items-center justify-center size-7 rounded-full bg-muted text-muted-foreground shrink-0 mt-0.5">
							<span className="text-[10px] font-bold">{index + 1}</span>
						</div>
						<div className="flex-1 min-w-0">
							<p className="text-xs font-medium">{step.title}</p>
							<p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">
								{step.description}
							</p>
						</div>
					</div>
				))}
			</div>

			<div className="text-center">
				<p className="text-[10px] text-muted-foreground">
					Press{" "}
					<kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">
						{typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent)
							? "⌘K"
							: "Ctrl+K"}
					</kbd>{" "}
					for AI commands
				</p>
			</div>

			{onDismiss && (
				<Button
					size="sm"
					variant="outline"
					className="text-xs"
					onClick={onDismiss}
				>
					Okay, I&apos;ve read this
				</Button>
			)}

			{/* Ideas Board */}
			{savedIdeas.length > 0 && (
				<div className="flex flex-col gap-2 w-full max-w-52 min-h-0">
					<div className="flex items-center justify-between">
						<h4 className="text-xs font-medium">
							Ideas{" "}
							<span className="text-muted-foreground">
								({savedIdeas.length})
							</span>
						</h4>
					</div>
					<ScrollArea className="flex-1 min-h-0 max-h-40">
						<div className="flex flex-col gap-1.5">
							{savedIdeas.map((idea) => (
								<div
									key={idea.id}
									className="flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs group"
								>
									<div className="flex-1 min-w-0">
										<p className="line-clamp-2 text-foreground">
											{idea.content}
										</p>
										<p className="text-[10px] text-muted-foreground mt-1">
											{new Date(idea.savedAt).toLocaleDateString(undefined, {
												month: "short",
												day: "numeric",
												hour: "2-digit",
												minute: "2-digit",
											})}
										</p>
									</div>
									<Button
										variant="ghost"
										size="icon"
										className="size-5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
										onClick={() => removeIdea(idea.id)}
									>
										<HugeiconsIcon icon={Cancel01Icon} className="size-3" />
									</Button>
								</div>
							))}
						</div>
					</ScrollArea>
				</div>
			)}
		</div>
	);
}
