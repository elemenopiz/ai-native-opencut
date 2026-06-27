"use client";

import { useEffect, useRef, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import type { StudioTake } from "@/hooks/use-studio-generation";

interface CompareDialogProps {
	takes: StudioTake[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onStar?: (takeId: string, starred: boolean) => void;
	onPromote?: (takeId: string) => void;
	onAddToTimeline?: (videoUrl: string, prompt: string) => void;
}

/**
 * Side-by-side comparison of selected takes with synchronised playback — the
 * "curate the winner" surface. All videos scrub, play, and pause together so
 * differences between seeds/resolutions are easy to spot.
 */
export function CompareDialog({
	takes,
	open,
	onOpenChange,
	onStar,
	onPromote,
	onAddToTimeline,
}: CompareDialogProps) {
	const videoRefs = useRef<Array<HTMLVideoElement | null>>([]);
	const [playing, setPlaying] = useState(false);

	// Reset transport whenever the comparison set changes.
	useEffect(() => {
		setPlaying(false);
		videoRefs.current.forEach((v) => {
			if (v) v.currentTime = 0;
		});
	}, [takes]);

	const syncAll = (fn: (v: HTMLVideoElement) => void) => {
		videoRefs.current.forEach((v) => {
			if (v) fn(v);
		});
	};

	const togglePlay = () => {
		if (playing) {
			syncAll((v) => v.pause());
			setPlaying(false);
		} else {
			syncAll((v) => {
				v.currentTime = 0;
				void v.play();
			});
			setPlaying(true);
		}
	};

	const restart = () => {
		syncAll((v) => {
			v.currentTime = 0;
			if (playing) void v.play();
		});
	};

	// Pick a column count that keeps each take reasonably large.
	const cols = takes.length <= 2 ? takes.length : takes.length <= 4 ? 2 : 3;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-5xl">
				<DialogHeader>
					<DialogTitle>Compare takes</DialogTitle>
					<DialogDescription>
						{takes.length} takes, played in sync. Star or promote the winner.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-center gap-2 pb-3">
					<Button size="sm" onClick={togglePlay} className="text-xs h-8">
						{playing ? "Pause all" : "Play all"}
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={restart}
						className="text-xs h-8"
					>
						Restart
					</Button>
				</div>

				<div
					className="grid gap-3 max-h-[60vh] overflow-y-auto"
					style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
				>
					{takes.map((take, i) => (
						<div
							key={take.takeId}
							className={cn(
								"rounded-lg border bg-card overflow-hidden flex flex-col",
								take.starred && "border-yellow-500/60",
							)}
						>
							<div className="aspect-video bg-muted">
								{take.videoUrl ? (
									<video
										ref={(el) => {
											videoRefs.current[i] = el;
										}}
										src={take.videoUrl}
										className="w-full h-full object-cover"
										loop
										muted
										playsInline
										onEnded={() => setPlaying(false)}
									/>
								) : (
									<div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
										No preview
									</div>
								)}
							</div>

							<div className="px-2 py-1.5 space-y-1.5 flex-1 flex flex-col">
								<div className="flex gap-1 flex-wrap">
									<Badge variant="secondary" className="text-xs">
										{take.resolution}
									</Badge>
									{take.seed != null && (
										<Badge variant="outline" className="text-xs font-mono">
											#{take.seed}
										</Badge>
									)}
								</div>

								<div className="flex gap-1 flex-wrap mt-auto pt-1">
									{onStar && (
										<Button
											size="sm"
											variant="ghost"
											className="text-xs h-6 px-2"
											onClick={() => onStar(take.takeId, !take.starred)}
										>
											{take.starred ? "★" : "☆"}
										</Button>
									)}
									{onPromote && take.resolution !== "1080p" && (
										<Button
											size="sm"
											variant="ghost"
											className="text-xs h-6 px-2"
											onClick={() => onPromote(take.takeId)}
										>
											1080p
										</Button>
									)}
									{onAddToTimeline && take.videoUrl && (
										<Button
											size="sm"
											variant="ghost"
											className="text-xs h-6 px-2"
											onClick={() =>
												onAddToTimeline(take.videoUrl!, take.prompt)
											}
										>
											→ Timeline
										</Button>
									)}
								</div>
							</div>
						</div>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
