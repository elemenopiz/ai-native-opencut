"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import type { StudioTake } from "@/hooks/use-studio-generation";

interface TakeCardProps {
	take: StudioTake;
	onStar: (takeId: string, starred: boolean) => void;
	onPromote: (takeId: string) => void;
	onPin: (takeId: string) => void;
	onAddToTimeline?: (videoUrl: string) => void;
	selected?: boolean;
	onToggleSelect?: (takeId: string) => void;
}

export function TakeCard({ take, onStar, onPromote, onPin, onAddToTimeline, selected, onToggleSelect }: TakeCardProps) {
	const [hovered, setHovered] = useState(false);
	const isPolling = take.status === "polling" || take.status === "submitting";
	const isDone = take.status === "done";
	const isError = take.status === "error";

	return (
		<div
			className={cn(
				"relative rounded-lg border bg-card overflow-hidden transition-all",
				isDone && "border-border hover:border-primary/50",
				isPolling && "border-border/50 animate-pulse",
				isError && "border-destructive/50",
				selected && "ring-2 ring-primary border-primary",
			)}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			{/* Compare selection checkbox — shown on hover or when selected */}
			{isDone && onToggleSelect && (hovered || selected) && (
				<button
					type="button"
					onClick={() => onToggleSelect(take.takeId)}
					aria-label={selected ? "Deselect for compare" : "Select for compare"}
					className={cn(
						"absolute top-2 left-2 z-10 size-5 rounded border flex items-center justify-center transition-colors",
						selected
							? "bg-primary border-primary text-primary-foreground"
							: "bg-black/50 border-white/40 text-transparent hover:border-white",
					)}
				>
					<svg className="size-3.5" viewBox="0 0 20 20" fill="currentColor">
						<path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
					</svg>
				</button>
			)}
			{/* Video / placeholder */}
			<div className="aspect-video bg-muted flex items-center justify-center">
				{isDone && take.videoUrl ? (
					<video
						src={take.videoUrl}
						className="w-full h-full object-cover"
						loop
						muted
						autoPlay={hovered}
						playsInline
					/>
				) : isPolling ? (
					<div className="flex flex-col items-center gap-2 text-muted-foreground">
						<div className="size-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
						<span className="text-xs">Generating…</span>
					</div>
				) : isError ? (
					<div className="flex flex-col items-center gap-1 text-destructive px-3 text-center">
						<span className="text-xs font-medium">Failed</span>
						<span className="text-xs text-muted-foreground">{take.error}</span>
					</div>
				) : null}
			</div>

			{/* Meta bar */}
			<div className="px-2 py-1.5 flex items-center gap-1.5">
				<Badge variant="secondary" className="text-xs shrink-0">
					{take.resolution}
				</Badge>
				{take.seed != null && (
					<Badge variant="outline" className="text-xs shrink-0 font-mono">
						#{take.seed}
					</Badge>
				)}
				<span className="text-xs text-muted-foreground truncate flex-1">
					{take.prompt}
				</span>
			</div>

			{/* Action overlay — shown on hover when done */}
			{isDone && hovered && (
				<div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2 p-3">
					<div className="flex gap-2 flex-wrap justify-center">
						<Button
							size="sm"
							variant="secondary"
							className="text-xs h-7"
							onClick={() => onStar(take.takeId, !take.starred)}
						>
							{take.starred ? "★ Starred" : "☆ Star"}
						</Button>
						<Button
							size="sm"
							variant="secondary"
							className="text-xs h-7"
							onClick={() => onPin(take.takeId)}
						>
							Pin to board
						</Button>
					</div>
					{take.resolution !== "1080p" && (
						<Button
							size="sm"
							className="text-xs h-7"
							onClick={() => onPromote(take.takeId)}
						>
							Promote to 1080p
						</Button>
					)}
					{onAddToTimeline && take.videoUrl && (
						<Button
							size="sm"
							variant="outline"
							className="text-xs h-7 border-white/30 text-white hover:bg-white/10"
							onClick={() => onAddToTimeline(take.videoUrl!)}
						>
							Add to timeline
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
