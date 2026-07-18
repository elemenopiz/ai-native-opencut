"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	Cancel01Icon,
	GridViewIcon,
	SparklesIcon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { useBoardStore } from "@/stores/board-store";
import { useBoardItems, type BoardItem } from "@/hooks/use-board-items";
import {
	Dialog,
	DialogDescription,
	DialogPortal,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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

	// Board items carry no known width/height up front (unlike library media
	// assets) — the true aspect ratio only becomes known once the video/image
	// itself loads (see DraftCard's onLoadedMetadata/onLoad). This map is fed
	// by that callback so the masonry grid below can decide column span
	// per-item as ratios resolve, one at a time.
	const [aspectRatios, setAspectRatios] = useState<Record<string, number>>({});
	const handleAspectRatioChange = useCallback((id: string, ratio: number) => {
		setAspectRatios((prev) =>
			prev[id] === ratio ? prev : { ...prev, [id]: ratio },
		);
	}, []);

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

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogPortal>
				{/*
				 * Board browses every draft from the current session as a grid —
				 * it's a dedicated full-viewport surface like Assets/Library, not
				 * a small decision dialog, so it keeps the whole canvas rather
				 * than floating a card in the middle of it. We still route
				 * through Radix's Dialog primitive (Root + Portal + Content) so
				 * Escape-to-close and focus-trap come for free instead of a
				 * hand-rolled keydown listener — but we render Content directly
				 * instead of the shared `DialogContent`, because that component
				 * hardcodes a small centered-modal treatment behind a
				 * translucent `bg-black/10` overlay. A full-bleed surface should
				 * be fully opaque itself, not a modal floating over a
				 * see-through scrim that lets the editor bleed through.
				 */}
				<DialogPrimitive.Content
					onCloseAutoFocus={(e) => {
						e.stopPropagation();
						e.preventDefault();
					}}
					className="fixed inset-0 z-250 flex flex-col bg-surface-overlay outline-none"
				>
					<div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
						<HugeiconsIcon
							icon={SparklesIcon}
							className="size-4 text-primary"
						/>
						<DialogTitle className="text-sm font-medium leading-none">
							Board
						</DialogTitle>
						<DialogDescription className="text-2xs leading-none text-muted-foreground">
							{items.length} stored · star anything to save it to Assets
						</DialogDescription>
						<Button
							variant="ghost"
							size="sm"
							aria-label="Close board"
							onClick={() => setOpen(false)}
							className="ml-auto gap-1 text-2xs text-muted-foreground hover:text-foreground"
						>
							<HugeiconsIcon icon={Cancel01Icon} className="size-4" />
							Close
						</Button>
					</div>

					<div className="flex-1 overflow-y-auto p-5">
						{items.length === 0 ? (
							<BoardEmptyState onDismiss={() => setOpen(false)} />
						) : (
							// Pinterest-style masonry, same technique as the Assets grid
							// (apps/web/src/components/editor/panels/assets/views/assets.tsx):
							// a dense CSS grid with a fine-grained row unit, where each cell
							// spans however many rows its OWN measured content height needs
							// (see BoardMasonryCell) instead of every tile in a row being
							// stretched to the tallest one. `dense` flow lets a following
							// short/portrait tile backfill the gap a wide one leaves behind.
							<div
								style={{
									display: "grid",
									gridTemplateColumns: `repeat(auto-fill, minmax(${BOARD_MASONRY_MIN_COL_PX}px, 1fr))`,
									gridAutoRows: `${BOARD_MASONRY_ROW_UNIT_PX}px`,
									gridAutoFlow: "dense",
									// Column gap comes from the grid; the vertical gap is added
									// as exact padding inside each cell (see BoardMasonryCell)
									// so it can't stack with row-span rounding into an
									// oversized gap.
									columnGap: `${BOARD_MASONRY_GAP_PX}px`,
									rowGap: 0,
								}}
							>
								{items.map((item) => {
									// Landscape (wider than tall) gets two columns; portrait/
									// square gets one — same threshold the Assets grid uses.
									// Ratio defaults to 16:9 (single column) until the item's
									// own media reports its natural size.
									const ratio = Math.min(
										Math.max(aspectRatios[item.id] ?? 16 / 9, 0.5),
										2,
									);
									const colSpan =
										ratio >= BOARD_LANDSCAPE_RATIO_THRESHOLD ? 2 : 1;

									return (
										<BoardMasonryCell key={item.id} colSpan={colSpan}>
											<DraftCard
												item={item}
												pending={pendingIds.has(item.id)}
												aspectRatio={ratio}
												onAspectRatioChange={(r) =>
													handleAspectRatioChange(item.id, r)
												}
												onStar={() =>
													withPending(item.id, () => promoteToAssets(item))
												}
												onDismiss={() =>
													withPending(item.id, () => dismiss(item))
												}
												onPromote={
													item.kind === "take" &&
													item.take?.resolution !== "1080p"
														? () =>
																withPending(item.id, () => promoteTo1080p(item))
														: undefined
												}
											/>
										</BoardMasonryCell>
									);
								})}
							</div>
						)}
					</div>
				</DialogPrimitive.Content>
			</DialogPortal>
		</Dialog>
	);
}

/** Real empty state — matches the first-run guide's craft instead of a lone
 *  line of gray text: an icon, a title, a one-line explanation, and a
 *  primary action back to the editor where drafts actually get made. */
function BoardEmptyState({ onDismiss }: { onDismiss: () => void }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-4 text-center">
			<div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
				<HugeiconsIcon icon={GridViewIcon} className="size-5" />
			</div>
			<div className="space-y-1">
				<h3 className="text-sm font-medium text-foreground">
					Nothing on the board yet
				</h3>
				<p className="max-w-72 text-xs text-muted-foreground">
					Generate 2 or more takes at once and every batch lands here — star
					what you want to keep, dismiss the rest.
				</p>
			</div>
			<Button variant="outline" size="sm" onClick={onDismiss}>
				Back to editor
			</Button>
		</div>
	);
}

function DraftCard({
	item,
	pending,
	aspectRatio,
	onAspectRatioChange,
	onStar,
	onDismiss,
	onPromote,
}: {
	item: BoardItem;
	pending: boolean;
	/** Current (possibly still-default 16:9) render ratio — owned by the
	 *  parent so the masonry grid's column span can react to it too. */
	aspectRatio: number;
	/** Fires once the underlying video/image reports its true natural size. */
	onAspectRatioChange: (ratio: number) => void;
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
								onAspectRatioChange(videoWidth / videoHeight);
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
								onAspectRatioChange(naturalWidth / naturalHeight);
							}
						}}
					/>
				)
			) : (
				<div className="flex size-full items-center justify-center text-[11px] text-muted-foreground">
					{isFailed ? "Failed" : isPending ? "Generating…" : ""}
				</div>
			)}

			<Button
				variant="ghost"
				size="icon"
				aria-label="Dismiss"
				onClick={onDismiss}
				disabled={pending}
				className="absolute top-2 left-2 size-6 rounded-full bg-black/50 text-white/70 opacity-0 transition-opacity hover:bg-black/60 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-40"
			>
				<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
			</Button>

			{url && (
				<div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2">
					<span className="min-w-0 flex-1 truncate text-3xs text-white/80">
						{prompt}
					</span>
					<div className="flex shrink-0 items-center gap-1">
						{onPromote && (
							<Button
								variant="ghost"
								size="sm"
								onClick={onPromote}
								disabled={pending}
								className="h-5 rounded bg-white/15 px-1.5 py-0 text-3xs font-medium text-white hover:bg-white/25 disabled:pointer-events-none disabled:opacity-50"
							>
								{pending ? "…" : "1080p"}
							</Button>
						)}
						<Button
							variant="ghost"
							size="icon"
							onClick={onStar}
							disabled={pending}
							aria-label="Star — save to Assets"
							title="Star — save to Assets"
							className={cn(
								"size-5 rounded-full bg-primary text-primary-foreground",
								"hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50",
							)}
						>
							<HugeiconsIcon
								icon={StarIcon}
								className={cn("size-3", pending && "animate-pulse")}
							/>
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

// Masonry tuning — same technique and constant shapes as the Assets grid's
// MasonryCell (apps/web/src/components/editor/panels/assets/views/assets.tsx),
// just re-tuned for Board's own tile size: it fills the whole viewport with
// ~220px cards instead of a narrow side panel's 4-column layout. The column
// gap comes from the grid; the vertical gap is padding inside each cell (grid
// row gap stays 0 so it can't compound with row-span rounding). A 1px row
// unit removes rounding slack.
const BOARD_MASONRY_MIN_COL_PX = 220;
const BOARD_MASONRY_GAP_PX = 16;
const BOARD_MASONRY_ROW_UNIT_PX = 1;
const BOARD_LANDSCAPE_RATIO_THRESHOLD = 1.2;

// One masonry cell. It measures its own natural content height and spans
// however many grid rows are needed to contain it, so the CSS grid packs
// like Pinterest (mixed heights) instead of aligning every item in a row to
// a shared height. A ResizeObserver re-measures when the column width — and
// thus the aspect-ratio-driven height — changes, keeping spans correct as
// the dialog resizes or an item's aspect ratio resolves after media load.
function BoardMasonryCell({
	colSpan,
	children,
}: {
	colSpan: number;
	children: React.ReactNode;
}) {
	const innerRef = useRef<HTMLDivElement>(null);
	const [rowSpan, setRowSpan] = useState(1);

	// Measure before paint so the cell is never shown collapsed to one row
	// (which would briefly stack items on top of each other).
	useLayoutEffect(() => {
		const element = innerRef.current;
		if (!element) return;

		const update = () => {
			// Height includes the cell's bottom padding (the vertical gap), so the
			// span covers content + gap with the row gap left at 0.
			const height = element.getBoundingClientRect().height;
			if (height <= 0) return;
			const span = Math.ceil(height / BOARD_MASONRY_ROW_UNIT_PX);
			setRowSpan(Math.max(1, span));
		};

		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			style={{
				gridColumn: `span ${colSpan}`,
				gridRow: `span ${rowSpan}`,
			}}
		>
			<div
				ref={innerRef}
				style={{ paddingBottom: `${BOARD_MASONRY_GAP_PX}px` }}
			>
				{children}
			</div>
		</div>
	);
}
