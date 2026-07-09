"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { TakeProvenanceBadge } from "@/components/editor/take-provenance-badge";
import type { Take, VideoElement, ImageElement } from "@/types/timeline";

type SlotEl = (VideoElement | ImageElement) & { id: string };

/**
 * Phase 4 — step-through take review. Walk the reel slot-by-slot and pick the
 * winning take for each. Keyboard: ←/→ move between slots, 1–9 pick a take.
 * Selection routes through `selectTake` (non-destructive — alternates stay).
 */
export function TakeReview({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const [version, setVersion] = useState(0);
	const [index, setIndex] = useState(0);

	// Re-read slots whenever the timeline changes (or the dialog opens).
	useEffect(() => {
		if (!open) return;
		const bump = () => setVersion((v) => v + 1);
		return editor.timeline.subscribe(bump);
	}, [open, editor]);

	const slots = useMemo(() => {
		const out: SlotEl[] = [];
		for (const track of editor.timeline.getTracks()) {
			for (const el of track.elements) {
				if (
					(el.type === "video" || el.type === "image") &&
					el.generation &&
					(el.takes?.length ?? 0) > 0
				) {
					out.push(el as SlotEl);
				}
			}
		}
		return out.sort((a, b) => a.startTime - b.startTime);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, version, open]);

	const clampedIndex = Math.min(index, Math.max(0, slots.length - 1));
	const slot = slots[clampedIndex];

	const selectByOrder = useCallback(
		(takeOrder: number) => {
			if (!slot) return;
			const take = slot.takes?.[takeOrder];
			if (take) editor.timeline.selectTake({ elementId: slot.id, takeId: take.id });
		},
		[slot, editor],
	);

	// Keyboard navigation while open.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowLeft") {
				setIndex((i) => Math.max(0, i - 1));
			} else if (e.key === "ArrowRight") {
				setIndex((i) => Math.min(slots.length - 1, i + 1));
			} else if (/^[1-9]$/.test(e.key)) {
				selectByOrder(Number(e.key) - 1);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, slots.length, selectByOrder]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-sm">
						Review takes
						{slots.length > 0 && (
							<span className="text-xs font-normal text-muted-foreground">
								Slot {clampedIndex + 1} of {slots.length} · ←/→ to move · 1–9 to pick
							</span>
						)}
					</DialogTitle>
				</DialogHeader>

				{!slot ? (
					<div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
						No slots with takes yet. Generate some takes first.
					</div>
				) : (
					<div className="space-y-3">
						<p className="truncate text-xs text-muted-foreground">
							{slot.generation?.prompt || slot.name}
						</p>
						<div className="grid grid-cols-3 gap-3">
							{(slot.takes ?? []).map((take, i) => (
								<TakeTile
									key={take.id}
									take={take}
									order={i + 1}
									active={slot.activeTakeId === take.id}
									onClick={() =>
										editor.timeline.selectTake({
											elementId: slot.id,
											takeId: take.id,
										})
									}
									resolveUrl={(mediaId) =>
										editor.media.getAssetById(mediaId)?.url
									}
								/>
							))}
						</div>
						<div className="flex items-center justify-between pt-1">
							<button
								type="button"
								className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
								disabled={clampedIndex === 0}
								onClick={() => setIndex((i) => Math.max(0, i - 1))}
							>
								← Previous slot
							</button>
							<button
								type="button"
								className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
								disabled={clampedIndex >= slots.length - 1}
								onClick={() =>
									setIndex((i) => Math.min(slots.length - 1, i + 1))
								}
							>
								Next slot →
							</button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function TakeTile({
	take,
	order,
	active,
	onClick,
	resolveUrl,
}: {
	take: Take;
	order: number;
	active: boolean;
	onClick: () => void;
	resolveUrl: (mediaId: string) => string | undefined;
}) {
	const url = take.thumbnailUrl ?? (take.mediaId ? resolveUrl(take.mediaId) : undefined);
	const isReady = take.status === "ready";
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"relative aspect-video overflow-hidden rounded-lg border bg-muted text-left transition-all",
				active ? "border-primary ring-2 ring-primary" : "border-border hover:border-foreground/40",
			)}
		>
			{isReady && url ? (
				take.mediaId ? (
					<video src={url} className="size-full object-cover" muted loop playsInline />
				) : (
					<img src={url} alt="" className="size-full object-cover" />
				)
			) : (
				<div className="flex size-full items-center justify-center text-[11px] text-muted-foreground">
					{take.status === "failed" ? "Failed" : "Generating…"}
				</div>
			)}
			<span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-medium text-white">
				{order}
			</span>
			{active && (
				<Badge className="absolute right-1 top-1 px-1 py-0 text-[10px]">
					Active
				</Badge>
			)}
			<TakeProvenanceBadge
				take={take}
				className="absolute inset-x-1 bottom-1 justify-start rounded bg-black/70 px-1 py-0.5"
			/>
		</button>
	);
}
