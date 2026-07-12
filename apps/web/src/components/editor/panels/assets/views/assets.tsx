"use client";

import Image from "next/image";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { MediaDragOverlay } from "@/components/editor/panels/assets/drag-overlay";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { useEditor } from "@/hooks/use-editor";
import { useFileUpload } from "@/hooks/use-file-upload";
import { useRevealItem } from "@/hooks/use-reveal-item";
import { getDragData } from "@/lib/drag-data";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";
import { processMediaAssets } from "@/lib/media/processing";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import {
	type MediaSortKey,
	type MediaSortOrder,
	type MediaTypeFilter,
	type MediaViewMode,
	useAssetsPanelStore,
} from "@/stores/assets-panel-store";
import { useSearchStore } from "@/stores/search-store";
import { useFrameChainStore } from "@/stores/frame-chain-store";
import type { MediaAsset } from "@/types/assets";
import {
	extractAndAddFrame,
	firstFrameSourceTime,
	lastFrameSourceTime,
	resolveVideoDurationSec,
	type FrameDecodeSource,
} from "@/lib/media/frame-extraction";
import type { DerivedFrom, DerivedFrameLabel } from "@/services/storage/types";
import { dataUrlToFile } from "@/lib/media/data-url";
import { uploadReferenceFile } from "@/lib/studio/reference-upload";
import { cn } from "@/utils/ui";
import {
	CloudUploadIcon,
	GridViewIcon,
	LeftToRightListDashIcon,
	SortingOneNineIcon,
	Image02Icon,
	MusicNote03Icon,
	Video01Icon,
	SparklesIcon,
	ImageCropIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export function MediaView() {
	const editor = useEditor();
	const mediaFiles = editor.media.getAssets();
	const activeProject = editor.project.getActive();

	const {
		mediaViewMode,
		setMediaViewMode,
		highlightMediaId,
		clearHighlight,
		mediaSortBy,
		mediaSortOrder,
		setMediaSort,
		mediaTypeFilter,
		setMediaTypeFilter,
	} = useAssetsPanelStore();
	const { highlightedId, registerElement } = useRevealItem(
		highlightMediaId,
		clearHighlight,
	);

	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState(0);

	const processFiles = async ({ files }: { files: FileList }) => {
		if (!files || files.length === 0) return;
		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		setIsProcessing(true);
		setProgress(0);
		try {
			const processedAssets = await processMediaAssets({
				files,
				onProgress: (progress: { progress: number }) =>
					setProgress(progress.progress),
			});
			for (const asset of processedAssets) {
				await editor.media.addMediaAsset({
					projectId: activeProject.metadata.id,
					asset,
				});
			}
		} catch (error) {
			console.error("Error processing files:", error);
			toast.error("Failed to process files");
		} finally {
			setIsProcessing(false);
			setProgress(0);
		}
	};

	const { isDragOver, dragProps, openFilePicker, fileInputProps } =
		useFileUpload({
			accept: "image/*,video/*,audio/*",
			multiple: true,
			onFilesSelected: (files) => processFiles({ files }),
		});

	// Dragging a generated take from the Takes panel onto Assets saves it into
	// the project library. `useFileUpload`'s handlers ignore this drag (its
	// `containsFiles` guard is false whenever drag-data is present), so we layer
	// our own handlers on top and delegate OS-file drags back to `dragProps`.
	const [isTakeDragOver, setIsTakeDragOver] = useState(false);

	const isTakeDrag = (e: React.DragEvent) =>
		getDragData({ dataTransfer: e.dataTransfer })?.type === "studio-take";

	const handlePanelDragEnter = (e: React.DragEvent) => {
		if (isTakeDrag(e)) {
			e.preventDefault();
			setIsTakeDragOver(true);
			return;
		}
		dragProps.onDragEnter(e);
	};

	const handlePanelDragOver = (e: React.DragEvent) => {
		if (isTakeDrag(e)) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			setIsTakeDragOver(true);
			return;
		}
		dragProps.onDragOver(e);
	};

	const handlePanelDragLeave = (e: React.DragEvent) => {
		if (isTakeDrag(e)) {
			setIsTakeDragOver(false);
			return;
		}
		dragProps.onDragLeave(e);
	};

	const handlePanelDrop = async (e: React.DragEvent) => {
		const dragData = getDragData({ dataTransfer: e.dataTransfer });
		if (dragData?.type === "studio-take") {
			e.preventDefault();
			setIsTakeDragOver(false);
			if (!activeProject) {
				toast.error("No active project");
				return;
			}
			const { added } = await addItemsToProjectMedia({
				editor,
				projectId: activeProject.metadata.id,
				items: [
					{ url: dragData.url, name: dragData.name, kind: dragData.kind },
				],
				source: "ai",
			});
			if (added > 0) toast.success("Saved to assets.");
			else toast.error("Could not save to assets.");
			return;
		}
		dragProps.onDrop(e);
	};

	const handleRemove = async ({
		event,
		id,
	}: {
		event: React.MouseEvent;
		id: string;
	}) => {
		event.stopPropagation();

		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		await editor.media.removeMediaAsset({
			projectId: activeProject.metadata.id,
			id,
		});
	};

	const handleSort = ({ key }: { key: MediaSortKey }) => {
		if (mediaSortBy === key) {
			setMediaSort(key, mediaSortOrder === "asc" ? "desc" : "asc");
		} else {
			setMediaSort(key, "asc");
		}
	};

	const nonEphemeralMedia = useMemo(
		() => mediaFiles.filter((item) => !item.ephemeral),
		[mediaFiles],
	);

	const typeCounts = useMemo(() => {
		const counts = { all: 0, video: 0, image: 0, audio: 0, ai: 0 };
		for (const item of nonEphemeralMedia) {
			counts.all++;
			if (item.type === "video") counts.video++;
			else if (item.type === "image") counts.image++;
			else if (item.type === "audio") counts.audio++;
			if (item.source === "ai") counts.ai++;
		}
		return counts;
	}, [nonEphemeralMedia]);

	const filteredMediaItems = useMemo(() => {
		const filtered =
			mediaTypeFilter === "all"
				? nonEphemeralMedia
				: mediaTypeFilter === "ai"
					? nonEphemeralMedia.filter((item) => item.source === "ai")
					: nonEphemeralMedia.filter((item) => item.type === mediaTypeFilter);

		const sorted = [...filtered];
		sorted.sort((a, b) => {
			let valueA: string | number;
			let valueB: string | number;

			switch (mediaSortBy) {
				case "name":
					valueA = a.name.toLowerCase();
					valueB = b.name.toLowerCase();
					break;
				case "type":
					valueA = a.type;
					valueB = b.type;
					break;
				case "duration":
					valueA = a.duration || 0;
					valueB = b.duration || 0;
					break;
				case "size":
					valueA = a.file.size;
					valueB = b.file.size;
					break;
				default:
					return 0;
			}

			if (valueA < valueB) return mediaSortOrder === "asc" ? -1 : 1;
			if (valueA > valueB) return mediaSortOrder === "asc" ? 1 : -1;
			return 0;
		});

		return sorted;
	}, [nonEphemeralMedia, mediaTypeFilter, mediaSortBy, mediaSortOrder]);

	return (
		<>
			<input {...fileInputProps} />

			<PanelView
				title="Assets"
				actions={
					<MediaActions
						mediaViewMode={mediaViewMode}
						setMediaViewMode={setMediaViewMode}
						isProcessing={isProcessing}
						sortBy={mediaSortBy}
						sortOrder={mediaSortOrder}
						onSort={handleSort}
						onImport={openFilePicker}
					/>
				}
				className={cn(
					isDragOver && "bg-accent/30",
					isTakeDragOver && "bg-primary/10 ring-2 ring-inset ring-primary",
				)}
				onDragEnter={handlePanelDragEnter}
				onDragOver={handlePanelDragOver}
				onDragLeave={handlePanelDragLeave}
				onDrop={handlePanelDrop}
			>
				{/* Type filter tabs */}
				{nonEphemeralMedia.length > 0 && !isDragOver && (
					<MediaTypeFilterBar
						filter={mediaTypeFilter}
						onFilterChange={setMediaTypeFilter}
						counts={typeCounts}
					/>
				)}

				{isDragOver || filteredMediaItems.length === 0 ? (
					<MediaDragOverlay
						isVisible={true}
						isProcessing={isProcessing}
						progress={progress}
						onClick={openFilePicker}
					/>
				) : (
					<MediaItemList
						items={filteredMediaItems}
						mode={mediaViewMode}
						onRemove={handleRemove}
						highlightedId={highlightedId}
						registerElement={registerElement}
					/>
				)}
			</PanelView>
		</>
	);
}

function MediaAssetDraggable({
	item,
	preview,
	isHighlighted,
	variant,
	isRounded,
}: {
	item: MediaAsset;
	preview: React.ReactNode;
	isHighlighted: boolean;
	variant: "card" | "compact";
	isRounded?: boolean;
}) {
	const editor = useEditor();

	// Render the thumbnail at the media's true aspect ratio so portrait clips
	// preview as portrait instead of being letterbox-cropped into 16:9. Clamp to
	// a sane range so an extreme panorama can't blow out the grid row height.
	const naturalRatio =
		item.width && item.height ? item.width / item.height : 16 / 9;
	const previewRatio = Math.min(Math.max(naturalRatio, 0.5), 2);

	const addElementAtTime = ({
		asset,
		startTime,
	}: {
		asset: MediaAsset;
		startTime: number;
	}) => {
		const duration =
			asset.duration ?? TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration,
			startTime,
		});
		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	return (
		<DraggableItem
			name={item.name}
			preview={preview}
			dragData={{
				id: item.id,
				type: "media",
				mediaType: item.type,
				name: item.name,
				...(item.type !== "audio" && {
					targetElementTypes: ["video", "image"] as const,
				}),
			}}
			shouldShowPlusOnDrag={false}
			onAddToTimeline={({ currentTime }) =>
				addElementAtTime({ asset: item, startTime: currentTime })
			}
			variant={variant}
			isRounded={isRounded}
			isHighlighted={isHighlighted}
			// Grid cards fill the column width and take their height from the
			// media's own ratio; the compact (list) variant ignores both.
			{...(variant === "card" && {
				aspectRatio: previewRatio,
				containerClassName: "w-full",
			})}
		/>
	);
}

function MediaItemWithContextMenu({
	item,
	children,
	onRemove,
	onSetLabel,
}: {
	item: MediaAsset;
	children: React.ReactNode;
	onRemove: ({ event, id }: { event: React.MouseEvent; id: string }) => void;
	onSetLabel: (id: string) => void;
}) {
	const requestFindSimilar = useSearchStore((s) => s.requestFindSimilar);
	const setActiveTab = useAssetsPanelStore((s) => s.setActiveTab);
	const requestRevealMedia = useAssetsPanelStore((s) => s.requestRevealMedia);
	const editor = useEditor();
	const setPendingFirstFrame = useFrameChainStore(
		(s) => s.setPendingFirstFrame,
	);
	const canExtractFrame = item.type === "video" && (!!item.file || !!item.url);

	async function handleExtractFrame(kind: "first" | "last") {
		let projectId: string;
		try {
			projectId = editor.project.getActive().metadata.id;
		} catch {
			toast.error("No active project to add the frame to.");
			return;
		}
		const label: DerivedFrameLabel =
			kind === "first" ? "first frame" : "last frame";
		const source: FrameDecodeSource = {
			videoFile: item.file,
			videoUrl: item.url,
			name: item.name,
		};
		const toastId = toast.loading("Extracting frame…");
		// Library assets are the FULL source (no trim), so a synthetic full-span
		// element gives the right first/last source time. A LAST-frame extraction
		// needs the real duration: some containers report none at import (the
		// asset is stored without one), and a 0-duration span would silently
		// resolve "last" to t=0 — the FIRST frame. Probe the container instead.
		let timeSec: number;
		if (kind === "first") {
			timeSec = firstFrameSourceTime({
				startTime: 0,
				duration: item.duration ?? 0,
				trimStart: 0,
			});
		} else {
			const durationSec = await resolveVideoDurationSec(source, item.duration);
			if (!durationSec) {
				toast.error(
					`Couldn't determine the duration of "${item.name}" — can't locate its last frame.`,
					{ id: toastId },
				);
				return;
			}
			timeSec = lastFrameSourceTime({
				startTime: 0,
				duration: durationSec,
				trimStart: 0,
			});
		}
		try {
			const result = await extractAndAddFrame({
				editor,
				projectId,
				source,
				sourceAssetId: item.id,
				sourceName: item.name,
				timeSec,
				label,
			});
			toast.success(`Added "${result.name}" to your library.`, {
				id: toastId,
				action: {
					label:
						kind === "first" ? "Use in Generate" : "Use as next first frame",
					onClick: () => {
						void (async () => {
							const uploadingId = toast.loading(
								"Preparing frame for Generate…",
							);
							try {
								const file = dataUrlToFile(result.dataUrl, result.name);
								const { url } = await uploadReferenceFile(file);
								setPendingFirstFrame({ url, label: result.name });
								// Neutral on purpose: whether the frame can seed the next
								// generation depends on the model selected IN the form (First/Last
								// support) — the form surfaces an inline warning when it can't.
								toast.success("Frame sent to Generate.", {
									id: uploadingId,
								});
							} catch (err) {
								toast.error(
									err instanceof Error
										? err.message
										: "Couldn't prepare the frame.",
									{ id: uploadingId },
								);
							}
						})();
					},
				},
				// Secondary: reveal + flash-highlight the new frame in the library.
				cancel: {
					label: "Reveal",
					onClick: () => requestRevealMedia(result.mediaId),
				},
			});
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't extract the frame.",
				{ id: toastId },
			);
		}
	}

	return (
		<ContextMenu>
			<ContextMenuTrigger>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => onSetLabel(item.id)}>
					{item.label ? "Edit label" : "Add label"}
				</ContextMenuItem>
				{item.type !== "audio" && (
					<ContextMenuItem
						onClick={() => {
							requestFindSimilar(item.id);
							setActiveTab("search");
						}}
					>
						Find similar clips
					</ContextMenuItem>
				)}
				{canExtractFrame && (
					<>
						<ContextMenuItem
							icon={<HugeiconsIcon icon={ImageCropIcon} />}
							onClick={() => void handleExtractFrame("first")}
						>
							Extract first frame
						</ContextMenuItem>
						<ContextMenuItem
							icon={<HugeiconsIcon icon={ImageCropIcon} />}
							onClick={() => void handleExtractFrame("last")}
						>
							Extract last frame
						</ContextMenuItem>
					</>
				)}
				<ContextMenuItem>Export clips</ContextMenuItem>
				<ContextMenuItem
					variant="destructive"
					onClick={(event) => onRemove({ event, id: item.id })}
				>
					Delete
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function MediaItemList({
	items,
	mode,
	onRemove,
	highlightedId,
	registerElement,
}: {
	items: MediaAsset[];
	mode: MediaViewMode;
	onRemove: ({ event, id }: { event: React.MouseEvent; id: string }) => void;
	highlightedId: string | null;
	registerElement: (id: string, element: HTMLElement | null) => void;
}) {
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const isGrid = mode === "grid";

	const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
	const [labelDraft, setLabelDraft] = useState("");

	const handleStartLabelEdit = (id: string) => {
		const asset = items.find((i) => i.id === id);
		setLabelDraft(asset?.label ?? "");
		setEditingLabelId(id);
	};

	const handleSaveLabel = async () => {
		if (!editingLabelId || !activeProject) return;
		const trimmed = labelDraft.trim();
		await editor.media.updateMediaAsset({
			projectId: activeProject.metadata.id,
			id: editingLabelId,
			updates: { label: trimmed || undefined },
		});
		setEditingLabelId(null);
	};

	const handleLabelKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleSaveLabel();
		} else if (e.key === "Escape") {
			setEditingLabelId(null);
		}
	};

	return (
		<div
			className={cn(!isGrid && "flex flex-col gap-1")}
			// Pinterest-style masonry on a 4-column grid. Landscape items span two
			// columns; everything else spans one and simply runs taller. Each cell
			// spans a computed number of thin rows (see MasonryCell) so items of any
			// shape pack tightly with no leftover row-height gaps. `dense` flow lets
			// narrow items backfill the holes a wide item leaves in a row.
			style={
				isGrid
					? {
							display: "grid",
							gridTemplateColumns: `repeat(${MASONRY_COLUMNS}, minmax(0, 1fr))`,
							gridAutoRows: `${MASONRY_ROW_UNIT_PX}px`,
							gridAutoFlow: "dense",
							// Column gap comes from the grid; the vertical gap is added as
							// exact padding inside each cell (see MasonryCell) so it can't
							// stack with row-span rounding into an oversized gap.
							columnGap: `${MASONRY_COLUMN_GAP_PX}px`,
							rowGap: 0,
						}
					: undefined
			}
		>
			{items.map((item) => {
				const content = (
					<MediaItemWithContextMenu
						item={item}
						onRemove={onRemove}
						onSetLabel={handleStartLabelEdit}
					>
						<div className={isGrid ? "flex flex-col" : "flex items-center"}>
							<MediaAssetDraggable
								item={item}
								preview={
									<MediaPreview
										item={item}
										variant={isGrid ? "grid" : "compact"}
									/>
								}
								variant={isGrid ? "card" : "compact"}
								isRounded={isGrid ? false : undefined}
								isHighlighted={highlightedId === item.id}
							/>
							{/* Label display / edit */}
							<MediaLabelRow
								item={item}
								isEditing={editingLabelId === item.id}
								draft={labelDraft}
								onDraftChange={setLabelDraft}
								onStartEdit={() => handleStartLabelEdit(item.id)}
								onSave={handleSaveLabel}
								onKeyDown={handleLabelKeyDown}
								compact={!isGrid}
							/>
							{/* Provenance: extracted-frame → source clip (reveal on click) */}
							{item.derivedFrom && (
								<MediaProvenanceRow
									derivedFrom={item.derivedFrom}
									compact={!isGrid}
								/>
							)}
						</div>
					</MediaItemWithContextMenu>
				);

				if (!isGrid) {
					return (
						<div
							key={item.id}
							ref={(element) => registerElement(item.id, element)}
						>
							{content}
						</div>
					);
				}

				// Landscape (wider than tall) gets two columns; portrait/square one.
				const ratio =
					item.width && item.height ? item.width / item.height : 16 / 9;
				const colSpan = ratio >= LANDSCAPE_RATIO_THRESHOLD ? 2 : 1;

				return (
					<MasonryCell
						key={item.id}
						colSpan={colSpan}
						registerRef={(element) => registerElement(item.id, element)}
					>
						{content}
					</MasonryCell>
				);
			})}
		</div>
	);
}

// Masonry tuning. Columns are separated by MASONRY_COLUMN_GAP_PX; the vertical
// gap is padding inside each cell (grid row gap stays 0 so it can't compound
// with row-span rounding). A 1px row unit removes rounding slack, and the
// vertical gap is kept a touch under the column gap so it reads evenly.
const MASONRY_COLUMNS = 4;
const MASONRY_COLUMN_GAP_PX = 8;
const MASONRY_ROW_GAP_PX = 6;
const MASONRY_ROW_UNIT_PX = 1;
const LANDSCAPE_RATIO_THRESHOLD = 1.2;

// One masonry cell. It measures its own natural content height and spans however
// many grid rows are needed to contain it, so the CSS grid packs like Pinterest
// (mixed heights) instead of aligning every item in a row to a shared height.
// A ResizeObserver re-measures when the column width — and thus the aspect-ratio
// driven height — changes, keeping spans correct as the panel resizes.
function MasonryCell({
	colSpan,
	registerRef,
	children,
}: {
	colSpan: number;
	registerRef: (element: HTMLElement | null) => void;
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
			const span = Math.ceil(height / MASONRY_ROW_UNIT_PX);
			setRowSpan(Math.max(1, span));
		};

		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			ref={registerRef}
			style={{
				gridColumn: `span ${colSpan}`,
				gridRow: `span ${rowSpan}`,
			}}
		>
			<div ref={innerRef} style={{ paddingBottom: `${MASONRY_ROW_GAP_PX}px` }}>
				{children}
			</div>
		</div>
	);
}

function MediaLabelRow({
	item,
	isEditing,
	draft,
	onDraftChange,
	onStartEdit,
	onSave,
	onKeyDown,
	compact = false,
}: {
	item: MediaAsset;
	isEditing: boolean;
	draft: string;
	onDraftChange: (v: string) => void;
	onStartEdit: () => void;
	onSave: () => void;
	onKeyDown: (e: React.KeyboardEvent) => void;
	compact?: boolean;
}) {
	if (isEditing) {
		return (
			<input
				autoFocus
				type="text"
				value={draft}
				onChange={(e) => onDraftChange(e.target.value)}
				onBlur={onSave}
				onKeyDown={onKeyDown}
				placeholder="e.g. Drone shot, Cam A"
				className={cn(
					"w-full rounded border bg-transparent outline-none focus:ring-1 focus:ring-ring",
					compact ? "h-5 px-1 text-[9px]" : "mt-0.5 px-1 py-0.5 text-[10px]",
				)}
			/>
		);
	}

	if (item.label) {
		return (
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onStartEdit();
				}}
				className={cn(
					"truncate rounded text-left font-medium text-muted-foreground hover:bg-muted",
					compact
						? "ml-1 shrink-0 bg-muted/40 px-1.5 py-0.5 text-[9px]"
						: "mt-0.5 w-full bg-muted/60 px-1 py-0.5 text-[10px]",
				)}
				title={`Label: ${item.label} (click to edit)`}
			>
				{item.label}
			</button>
		);
	}

	// No custom label: render nothing so the item reserves no extra vertical
	// space (an always-present hover "+ Add label" button left a phantom gap
	// that broke the masonry's even spacing). Labels are still added via the
	// right-click context menu.
	return null;
}

export function formatDuration({ duration }: { duration: number }) {
	const min = Math.floor(duration / 60);
	const sec = Math.floor(duration % 60);
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

function MediaDurationBadge({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<div className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-xs text-white">
			{formatDuration({ duration })}
		</div>
	);
}

function MediaDurationLabel({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<span className="text-xs opacity-70">{formatDuration({ duration })}</span>
	);
}

function MediaTypePlaceholder({
	icon,
	label,
	duration,
	variant,
}: {
	icon: IconSvgElement;
	label: string;
	duration?: number;
	variant: "muted" | "bordered";
}) {
	const iconClassName = cn("size-6", variant === "bordered" && "mb-1");

	return (
		<div
			className={cn(
				"text-muted-foreground flex size-full flex-col items-center justify-center rounded",
				variant === "muted" ? "bg-muted/30" : "border",
			)}
		>
			<HugeiconsIcon icon={icon} className={iconClassName} />
			<span className="text-xs">{label}</span>
			<MediaDurationLabel duration={duration} />
		</div>
	);
}

function MediaPreview({
	item,
	variant = "grid",
}: {
	item: MediaAsset;
	variant?: "grid" | "compact";
}) {
	const shouldShowDurationBadge = variant === "grid";
	const showAiBadge = shouldShowDurationBadge && item.source === "ai";

	if (item.type === "image") {
		return (
			<div className="relative flex size-full items-center justify-center">
				<Image
					src={item.url ?? ""}
					alt={item.name}
					fill
					sizes="100vw"
					className="object-cover"
					loading="lazy"
					unoptimized
				/>
				{shouldShowDurationBadge && <MediaTypeBadge type="image" />}
				{showAiBadge && <AiBadge />}
				{shouldShowDurationBadge && item.derivedFrom && (
					<FrameEdgePill derivedFrom={item.derivedFrom} />
				)}
			</div>
		);
	}

	if (item.type === "video") {
		if (item.thumbnailUrl) {
			return (
				<div className="relative size-full">
					<Image
						src={item.thumbnailUrl}
						alt={item.name}
						fill
						sizes="100vw"
						className="rounded object-cover"
						loading="lazy"
						unoptimized
					/>
					{shouldShowDurationBadge && (
						<>
							<MediaTypeBadge type="video" />
							<MediaDurationBadge duration={item.duration} />
						</>
					)}
					{showAiBadge && <AiBadge />}
				</div>
			);
		}

		return (
			<MediaTypePlaceholder
				icon={Video01Icon}
				label="Video"
				duration={item.duration}
				variant="muted"
			/>
		);
	}

	if (item.type === "audio") {
		return (
			<MediaTypePlaceholder
				icon={MusicNote03Icon}
				label="Audio"
				duration={item.duration}
				variant="bordered"
			/>
		);
	}

	return (
		<MediaTypePlaceholder icon={Image02Icon} label="Unknown" variant="muted" />
	);
}

function MediaActions({
	mediaViewMode,
	setMediaViewMode,
	isProcessing,
	sortBy,
	sortOrder,
	onSort,
	onImport,
}: {
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	isProcessing: boolean;
	sortBy: MediaSortKey;
	sortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
	onImport: () => void;
}) {
	return (
		<div className="flex gap-1.5">
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							onClick={() =>
								setMediaViewMode(mediaViewMode === "grid" ? "list" : "grid")
							}
							disabled={isProcessing}
							className="items-center justify-center"
						>
							{mediaViewMode === "grid" ? (
								<HugeiconsIcon icon={LeftToRightListDashIcon} />
							) : (
								<HugeiconsIcon icon={GridViewIcon} />
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>
							{mediaViewMode === "grid"
								? "Switch to list view"
								: "Switch to grid view"}
						</p>
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<DropdownMenu>
						<TooltipTrigger asChild>
							<DropdownMenuTrigger asChild>
								<Button
									size="icon"
									variant="ghost"
									disabled={isProcessing}
									className="items-center justify-center"
								>
									<HugeiconsIcon icon={SortingOneNineIcon} />
								</Button>
							</DropdownMenuTrigger>
						</TooltipTrigger>
						<DropdownMenuContent align="end">
							<SortMenuItem
								label="Name"
								sortKey="name"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="Type"
								sortKey="type"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="Duration"
								sortKey="duration"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="File size"
								sortKey="size"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
						</DropdownMenuContent>
					</DropdownMenu>
					<TooltipContent>
						<p>
							Sort by {sortBy} (
							{sortOrder === "asc" ? "ascending" : "descending"})
						</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			<Button
				variant="outline"
				onClick={onImport}
				disabled={isProcessing}
				size="sm"
				className="items-center justify-center gap-1.5"
			>
				<HugeiconsIcon icon={CloudUploadIcon} />
				Import
			</Button>
		</div>
	);
}

function SortMenuItem({
	label,
	sortKey,
	currentSortBy,
	currentSortOrder,
	onSort,
}: {
	label: string;
	sortKey: MediaSortKey;
	currentSortBy: MediaSortKey;
	currentSortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
}) {
	const isActive = currentSortBy === sortKey;
	const arrow = isActive ? (currentSortOrder === "asc" ? "↑" : "↓") : "";

	return (
		<DropdownMenuItem onClick={() => onSort({ key: sortKey })}>
			{label} {arrow}
		</DropdownMenuItem>
	);
}

const TYPE_BADGE_STYLES: Record<string, string> = {
	video: "bg-blue-500/80",
	image: "bg-emerald-500/80",
	audio: "bg-amber-500/80",
};

function AiBadge() {
	return (
		<div className="absolute right-1 top-1 flex items-center gap-0.5 rounded bg-violet-500/85 px-1 py-0.5 text-[9px] font-medium uppercase leading-none text-white">
			<HugeiconsIcon icon={SparklesIcon} className="size-2.5" />
			AI
		</div>
	);
}

/** Human label for a derived-frame provenance ("First frame" / "Last frame" / "Frame"). */
function frameLabelText(label: DerivedFrom["label"]): string {
	return label === "first frame"
		? "First frame"
		: label === "last frame"
			? "Last frame"
			: "Frame";
}

/**
 * Edge pill on an extracted still's thumbnail. Its position MIRRORS where the
 * frame sits in the source clip: a first-frame extract pins bottom-LEFT, a
 * last/playhead extract pins bottom-RIGHT. Matches the {@link MediaDurationBadge}
 * chrome (bg-black/70, white, rounded, text-xs). Extracted frames are images, so
 * this never collides with the video duration badge.
 */
function FrameEdgePill({ derivedFrom }: { derivedFrom: DerivedFrom }) {
	const isFirst = derivedFrom.label === "first frame";
	return (
		<div
			className={cn(
				"absolute bottom-1 flex items-center gap-0.5 rounded bg-black/70 px-1 text-xs leading-5 text-white",
				isFirst ? "left-1" : "right-1",
			)}
		>
			<HugeiconsIcon icon={ImageCropIcon} className="size-3" />
			{frameLabelText(derivedFrom.label)}
		</div>
	);
}

/**
 * Provenance line under an extracted frame's name: "↳ from «source asset»".
 * Clicking reveals + flash-highlights the SOURCE asset (same reveal seam as the
 * timeline "Reveal media"). In list/compact rows it prefixes the frame label
 * inline (there's no thumbnail pill there). One truncated, muted line.
 */
function MediaProvenanceRow({
	derivedFrom,
	compact = false,
}: {
	derivedFrom: DerivedFrom;
	compact?: boolean;
}) {
	const editor = useEditor();
	const requestRevealMedia = useAssetsPanelStore((s) => s.requestRevealMedia);
	const source = editor.media.getAssetById(derivedFrom.assetId);
	const sourceName = source?.name ?? "a removed clip";
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				requestRevealMedia(derivedFrom.assetId);
			}}
			title={`${frameLabelText(derivedFrom.label)} of ${sourceName} — click to reveal the source`}
			className={cn(
				"flex w-full items-center gap-1 truncate text-left text-xs text-muted-foreground hover:text-foreground",
				compact ? "ml-1" : "mt-0.5",
			)}
		>
			{compact && (
				<HugeiconsIcon icon={ImageCropIcon} className="size-3 shrink-0" />
			)}
			<span className="truncate">
				{compact ? `${frameLabelText(derivedFrom.label)} · ` : "↳ "}
				from {sourceName}
			</span>
		</button>
	);
}

function MediaTypeBadge({ type }: { type: string }) {
	return (
		<div
			className={cn(
				"absolute left-1 top-1 rounded px-1 py-0.5 text-[9px] font-medium uppercase leading-none text-white",
				TYPE_BADGE_STYLES[type] ?? "bg-black/60",
			)}
		>
			{type === "image" ? "IMG" : type === "video" ? "MP4" : type.toUpperCase()}
		</div>
	);
}

const FILTER_TABS: {
	key: MediaTypeFilter;
	label: string;
	icon: IconSvgElement;
}[] = [
	{ key: "all", label: "All", icon: GridViewIcon },
	{ key: "video", label: "Videos", icon: Video01Icon },
	{ key: "image", label: "Images", icon: Image02Icon },
	{ key: "audio", label: "Audio", icon: MusicNote03Icon },
	{ key: "ai", label: "AI", icon: SparklesIcon },
];

function MediaTypeFilterBar({
	filter,
	onFilterChange,
	counts,
}: {
	filter: MediaTypeFilter;
	onFilterChange: (f: MediaTypeFilter) => void;
	counts: Record<MediaTypeFilter, number>;
}) {
	return (
		<div className="flex items-center gap-1 pb-3">
			{FILTER_TABS.map((tab) => {
				const isActive = filter === tab.key;
				const count = counts[tab.key];
				if (tab.key !== "all" && count === 0) return null;

				return (
					<button
						key={tab.key}
						type="button"
						onClick={() => onFilterChange(tab.key)}
						className={cn(
							"flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
							isActive
								? "bg-primary text-primary-foreground"
								: "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
						)}
					>
						<HugeiconsIcon icon={tab.icon} className="size-3" />
						{tab.label}
						<span
							className={cn(
								"ml-0.5 text-[9px] tabular-nums",
								isActive
									? "text-primary-foreground/70"
									: "text-muted-foreground/60",
							)}
						>
							{count}
						</span>
					</button>
				);
			})}
		</div>
	);
}
