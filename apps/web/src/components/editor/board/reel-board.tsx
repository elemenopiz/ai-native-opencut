"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	Cancel01Icon,
	SparklesIcon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { useBoardStore } from "@/stores/board-store";
import { useBoardItems, type BoardItem } from "@/hooks/use-board-items";

/**
 * Board — the single place batches of 2+ generations are stored. A lone
 * generation skips this entirely and goes straight to Assets; drafts kept
 * here stay until dismissed or starred into Assets.
 */
export function ReelBoard() {
	const open = useBoardStore((s) => s.open);
	const setOpen = useBoardStore((s) => s.setOpen);
	const editor = useEditor();

	let projectId: string | null = null;
	try {
		projectId = editor.project.getActive().metadata.id;
	} catch {
		projectId = null;
	}

	const { items, refetch, promoteToAssets, dismiss, promoteTo1080p } =
		useBoardItems({ editor, projectId });

	// Guards against double-clicks firing a second mutation on the same card
	// before the first resolves — e.g. two Stars = two duplicate assets plus a
	// racing DELETE, or two 1080p clicks = two independently-billed renders.
	const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

	const withPending = useCallback(
		(id: string, fn: () => Promise<void>) => {
			if (pendingIds.has(id)) return;
			setPendingIds((prev) => new Set(prev).add(id));
			fn()
				.catch((err) => {
					toast.error(err instanceof Error ? err.message : "Action failed");
				})
				.finally(() => {
					setPendingIds((prev) => {
						const next = new Set(prev);
						next.delete(id);
						return next;
					});
				});
		},
		[pendingIds],
	);

	useEffect(() => {
		if (open) void refetch();
	}, [open, refetch]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, setOpen]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-background/98 backdrop-blur">
			<div className="flex items-center gap-2 border-b px-4 py-2.5">
				<HugeiconsIcon icon={SparklesIcon} className="size-4 text-primary" />
				<span className="text-sm font-medium">Board</span>
				<span className="text-xs text-muted-foreground">
					{items.length} stored · star anything to save it to Assets
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
				{items.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						Nothing stored — batches of 2+ generations are kept here; star
						anything to save it to Assets.
					</div>
				) : (
					<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
						{items.map((item) => (
							<DraftCard
								key={item.id}
								item={item}
								pending={pendingIds.has(item.id)}
								onStar={() => withPending(item.id, () => promoteToAssets(item))}
								onDismiss={() => withPending(item.id, () => dismiss(item))}
								onPromote={
									item.kind === "take" && item.take?.resolution !== "1080p"
										? () => withPending(item.id, () => promoteTo1080p(item))
										: undefined
								}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function DraftCard({
	item,
	pending,
	onStar,
	onDismiss,
	onPromote,
}: {
	item: BoardItem;
	pending: boolean;
	onStar: () => void;
	onDismiss: () => void;
	onPromote?: () => void;
}) {
	const url = item.kind === "take" ? item.take?.videoUrl : item.image?.imageUrl;
	const isFailed = item.kind === "take" && item.take?.status === "error";
	const isPending =
		item.kind === "take" &&
		item.take?.status !== "error" &&
		!item.take?.videoUrl;
	const prompt =
		(item.kind === "take" ? item.set?.prompt : item.image?.prompt) ?? "";

	// Board items don't carry known dimensions up front, so measure the media
	// itself once it loads and render the tile at its true aspect ratio —
	// matching the Assets grid — instead of forcing 16:9 and cropping portrait
	// content. Clamp to a sane range so an extreme shape can't blow out the
	// grid row height.
	const [naturalRatio, setNaturalRatio] = useState<number | null>(null);
	const aspectRatio = Math.min(Math.max(naturalRatio ?? 16 / 9, 0.5), 2);

	return (
		<div
			className="group relative overflow-hidden rounded-lg border bg-muted"
			style={{ aspectRatio }}
		>
			{url ? (
				item.kind === "take" ? (
					<video
						src={url}
						poster={item.take?.thumbnailUrl ?? undefined}
						className="size-full object-cover"
						muted
						loop
						playsInline
						onLoadedMetadata={(e) => {
							const { videoWidth, videoHeight } = e.currentTarget;
							if (videoWidth && videoHeight) {
								setNaturalRatio(videoWidth / videoHeight);
							}
						}}
					/>
				) : (
					<img
						src={url}
						alt=""
						className="size-full object-cover"
						onLoad={(e) => {
							const { naturalWidth, naturalHeight } = e.currentTarget;
							if (naturalWidth && naturalHeight) {
								setNaturalRatio(naturalWidth / naturalHeight);
							}
						}}
					/>
				)
			) : (
				<div className="flex size-full items-center justify-center text-[11px] text-muted-foreground">
					{isFailed ? "Failed" : isPending ? "Generating…" : ""}
				</div>
			)}

			<button
				type="button"
				aria-label="Dismiss"
				onClick={onDismiss}
				disabled={pending}
				className="absolute top-2 left-2 flex size-6 items-center justify-center rounded-full bg-black/50 text-white/70 opacity-0 transition-opacity hover:text-white focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-40"
			>
				<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
			</button>

			{url && (
				<div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2">
					<span className="min-w-0 flex-1 truncate text-[10px] text-white/80">
						{prompt}
					</span>
					<div className="flex shrink-0 gap-1">
						{onPromote && (
							<button
								type="button"
								onClick={onPromote}
								disabled={pending}
								className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-white/25 disabled:pointer-events-none disabled:opacity-50"
							>
								{pending ? "…" : "1080p"}
							</button>
						)}
						<button
							type="button"
							onClick={onStar}
							disabled={pending}
							aria-label="Star — save to Assets"
							title="Star — save to Assets"
							className={cn(
								"flex size-5 items-center justify-center rounded-full",
								"bg-amber-400/90 text-black hover:bg-amber-400",
								"disabled:pointer-events-none disabled:opacity-50",
							)}
						>
							<HugeiconsIcon
								icon={StarIcon}
								className={cn("size-3", pending && "animate-pulse")}
							/>
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
