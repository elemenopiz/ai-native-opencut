"use client";

import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { useBoardStore } from "@/stores/board-store";
import type { Take, VideoElement, ImageElement } from "@/types/timeline";

type SlotEl = (VideoElement | ImageElement) & { id: string };

/**
 * Phase 6 — the depth view. A zoom-out "board" of the whole reel: every
 * generative slot laid out as a card with its takes, over the same scene/takes
 * data as the timeline. Click a take to make it the slot's active take. A view
 * mode, not a separate data model — closing returns to the timeline unchanged.
 */
export function ReelBoard() {
	const open = useBoardStore((s) => s.open);
	const setOpen = useBoardStore((s) => s.setOpen);
	const editor = useEditor();
	const [version, setVersion] = useState(0);

	useEffect(() => {
		if (!open) return;
		const bump = () => setVersion((v) => v + 1);
		return editor.timeline.subscribe(bump);
	}, [open, editor]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, setOpen]);

	const slots = useMemo(() => {
		const out: SlotEl[] = [];
		for (const track of editor.timeline.getTracks()) {
			for (const el of track.elements) {
				if ((el.type === "video" || el.type === "image") && el.generation) {
					out.push(el as SlotEl);
				}
			}
		}
		return out.sort((a, b) => a.startTime - b.startTime);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, version, open]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-background/98 backdrop-blur">
			<div className="flex items-center gap-2 border-b px-4 py-2.5">
				<HugeiconsIcon icon={SparklesIcon} className="size-4 text-primary" />
				<span className="text-sm font-medium">Reel board</span>
				<span className="text-xs text-muted-foreground">
					{slots.length} slot{slots.length === 1 ? "" : "s"} · zoomed out ·
					click a take to make it active
				</span>
				<button
					type="button"
					aria-label="Close board"
					onClick={() => setOpen(false)}
					className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
				>
					<HugeiconsIcon icon={Cancel01Icon} className="size-4" />
					Close
				</button>
			</div>

			<div className="flex-1 overflow-y-auto p-5">
				{slots.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						No generative slots yet. Reserve some in the Direct tab.
					</div>
				) : (
					<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
						{slots.map((slot, i) => (
							<SlotCard
								key={slot.id}
								slot={slot}
								index={i + 1}
								onSelect={(takeId) =>
									editor.timeline.selectTake({ elementId: slot.id, takeId })
								}
								resolveUrl={(mediaId) =>
									editor.media.getAssetById(mediaId)?.url
								}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function SlotCard({
	slot,
	index,
	onSelect,
	resolveUrl,
}: {
	slot: SlotEl;
	index: number;
	onSelect: (takeId: string) => void;
	resolveUrl: (mediaId: string) => string | undefined;
}) {
	const takes = slot.takes ?? [];
	return (
		<div className="rounded-xl border bg-card p-3">
			<div className="mb-2 flex items-center gap-2">
				<span className="flex size-5 items-center justify-center rounded bg-muted text-[11px] font-medium">
					{index}
				</span>
				<p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
					{slot.generation?.prompt?.trim() || "Empty slot"}
				</p>
				<span className="shrink-0 text-[10px] text-muted-foreground">
					{takes.length} take{takes.length === 1 ? "" : "s"}
				</span>
			</div>

			{takes.length === 0 ? (
				<div className="flex aspect-video items-center justify-center rounded-lg border border-dashed text-[11px] text-muted-foreground">
					Empty — generate to fill
				</div>
			) : (
				<div className="grid grid-cols-2 gap-2">
					{takes.map((take) => (
						<BoardTake
							key={take.id}
							take={take}
							active={slot.activeTakeId === take.id}
							onClick={() => onSelect(take.id)}
							resolveUrl={resolveUrl}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function BoardTake({
	take,
	active,
	onClick,
	resolveUrl,
}: {
	take: Take;
	active: boolean;
	onClick: () => void;
	resolveUrl: (mediaId: string) => string | undefined;
}) {
	const url =
		take.thumbnailUrl ?? (take.mediaId ? resolveUrl(take.mediaId) : undefined);
	const isReady = take.status === "ready";
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"relative aspect-video overflow-hidden rounded-lg border bg-muted transition-all",
				active
					? "border-primary ring-2 ring-primary"
					: "border-border hover:border-foreground/40",
			)}
		>
			{isReady && url ? (
				take.mediaId ? (
					<video
						src={url}
						className="size-full object-cover"
						muted
						loop
						playsInline
					/>
				) : (
					<img src={url} alt="" className="size-full object-cover" />
				)
			) : (
				<div className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
					{take.status === "failed" ? "Failed" : "Generating…"}
				</div>
			)}
		</button>
	);
}
