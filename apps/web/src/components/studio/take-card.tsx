"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import { clearDragData, setDragData } from "@/lib/drag-data";
import type { StudioTake } from "@/hooks/use-studio-generation";

interface TakeCardProps {
	take: StudioTake;
	onStar: (takeId: string, starred: boolean) => void;
	onPromote: (takeId: string) => void;
	onPin: (takeId: string) => void;
	onAddToTimeline?: (videoUrl: string) => void;
	/**
	 * Promote this take into the project's Assets library. When provided, the
	 * corner star triggers this (and marks the take saved); otherwise the star
	 * falls back to toggling the persisted starred flag.
	 */
	onSaveToAssets?: (take: StudioTake) => void;
	selected?: boolean;
	onToggleSelect?: (takeId: string) => void;
}

// Initial aspect ratio from the take's declared orientation, so a 9:16 clip
// renders portrait immediately instead of being letterboxed into 16:9. Refined
// to the video's true ratio once its metadata loads.
const RATIO_BY_ORIENTATION: Record<string, number> = {
	portrait: 9 / 16,
	landscape: 16 / 9,
	square: 1,
};

export function TakeCard({ take, onStar, onPromote, onPin, onAddToTimeline, onSaveToAssets, selected, onToggleSelect }: TakeCardProps) {
	const [hovered, setHovered] = useState(false);
	const [aspectRatio, setAspectRatio] = useState<number>(
		take.orientation ? RATIO_BY_ORIENTATION[take.orientation] ?? 16 / 9 : 16 / 9,
	);
	const isPolling = take.status === "polling" || take.status === "submitting";
	const isDone = take.status === "done";
	const isError = take.status === "error";
	const canDrag = isDone && !!take.videoUrl;

	const handleStarClick = () => {
		if (onSaveToAssets) onSaveToAssets(take);
		else onStar(take.takeId, !take.starred);
	};

	const handleDragStart = (e: React.DragEvent) => {
		if (!take.videoUrl) return;
		setDragData({
			dataTransfer: e.dataTransfer,
			dragData: {
				type: "studio-take",
				id: take.takeId,
				takeId: take.takeId,
				name: take.prompt || "Generated take",
				url: take.videoUrl,
				kind: "video",
			},
		});
		e.dataTransfer.effectAllowed = "copy";
	};

	return (
		<div
			draggable={canDrag}
			onDragStart={canDrag ? handleDragStart : undefined}
			onDragEnd={canDrag ? clearDragData : undefined}
			className={cn(
				"relative rounded-lg border bg-card overflow-hidden transition-all",
				isDone && "border-border hover:border-primary/50",
				canDrag && "cursor-grab active:cursor-grabbing",
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
			{/* Save-to-assets star — persistent corner icon. Filled = already saved. */}
			{isDone && (
				<button
					type="button"
					onClick={handleStarClick}
					aria-label={take.starred ? "Remove from assets" : "Save to assets"}
					title={take.starred ? "Saved — click to remove from assets" : "Save to assets"}
					className={cn(
						"absolute top-2 right-2 z-10 size-6 rounded-full flex items-center justify-center transition-colors",
						take.starred
							? "bg-black/40 text-amber-400"
							: "bg-black/50 text-white/70 hover:text-white",
					)}
				>
					<svg
						className="size-3.5"
						viewBox="0 0 20 20"
						fill={take.starred ? "currentColor" : "none"}
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<path
							strokeLinejoin="round"
							d="M10 2.5l2.35 4.76 5.25.76-3.8 3.7.9 5.23L10 14.98l-4.7 2.47.9-5.23-3.8-3.7 5.25-.76L10 2.5z"
						/>
					</svg>
				</button>
			)}

			{/* Video / placeholder. The container takes the clip's own aspect ratio so
			    portrait (9:16) takes preview portrait instead of being cropped to 16:9. */}
			<div
				className="bg-muted flex items-center justify-center"
				style={{ aspectRatio }}
			>
				{isDone && take.videoUrl ? (
					<video
						src={take.videoUrl}
						className="w-full h-full object-contain"
						loop
						muted
						autoPlay={hovered}
						playsInline
						preload="metadata"
						onLoadedMetadata={(e) => {
							const v = e.currentTarget;
							if (v.videoWidth && v.videoHeight) {
								setAspectRatio(v.videoWidth / v.videoHeight);
							}
						}}
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
