"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { MediaDragOverlay } from "@/components/editor/panels/assets/drag-overlay";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import {
	FolderBreadcrumb,
	FolderTile,
	type FolderTileDragHandlers,
} from "@/components/editor/panels/assets/views/folder-tile";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
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
import {
	CreateFolderCommand,
	DeleteFolderCommand,
	MoveAssetToFolderCommand,
	RenameFolderCommand,
} from "@/lib/commands/media";
import {
	extractDroppedEntries,
	filesFromDirectoryInput,
	type DroppedEntry,
} from "@/lib/media/folder-upload";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import {
	type MediaSortKey,
	type MediaSortOrder,
	type MediaTypeFilter,
	type MediaViewMode,
	useAssetsPanelStore,
} from "@/stores/assets-panel-store";
import { useSearchStore } from "@/stores/search-store";
import type { MediaAsset, MediaFolder } from "@/types/assets";
import {
	extractAndAddFrame,
	firstFrameSourceTime,
	lastFrameSourceTime,
	resolveVideoDurationSec,
	type FrameDecodeSource,
} from "@/lib/media/frame-extraction";
import type { DerivedFrom, DerivedFrameLabel } from "@/services/storage/types";
import { downloadMediaAsset } from "@/lib/media-download";
import { cn } from "@/utils/ui";
import {
	CloudUploadIcon,
	FolderAddIcon,
	FolderUploadIcon,
	GridViewIcon,
	LeftToRightListDashIcon,
	SortingOneNineIcon,
	Image02Icon,
	MusicNote03Icon,
	Video01Icon,
	SparklesIcon,
	ImageCropIcon,
	Download01Icon,
	Folder03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

/**
 * Cheap duplicate heuristic for the manual upload path: same file name AND
 * same byte size (no hashing). Good enough to flag the common "I already
 * imported this" case without the cost of content hashing; see BUG56 / W-UP-F2.
 */
export function mediaAssetSignature({
	name,
	size,
}: {
	name: string;
	size: number;
}): string {
	return `${name}::${size}`;
}

/**
 * Synchronous "does this drag carry at least one directory?" check via the
 * (webkit-originated, now broadly supported) `DataTransferItem.webkitGetAsEntry`
 * API. Deliberately synchronous and called at `drop` time only — several
 * browsers only populate `dataTransfer.items` entries reliably by drop, not
 * during `dragover`, and `webkitGetAsEntry()` itself must be called
 * synchronously within the originating event (it returns null once the task
 * queue has turned over). A false result here is always safe: the caller
 * falls through to the existing flat-file `dragProps.onDrop` path.
 */
function hasDirectoryEntry(dataTransfer: DataTransfer): boolean {
	const items = dataTransfer.items;
	if (!items) return false;
	for (let i = 0; i < items.length; i++) {
		const entry = items[i]?.webkitGetAsEntry?.();
		if (entry?.isDirectory) return true;
	}
	return false;
}

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
		currentFolderId,
		setCurrentFolderId,
	} = useAssetsPanelStore();
	const { highlightedId, registerElement } = useRevealItem(
		highlightMediaId,
		clearHighlight,
	);

	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState(0);

	// Folder nav is per-project, in-memory state (assets-panel-store). Nothing
	// unmounts MediaView on a client-side project switch (EditorCore is a
	// reused singleton — see stores/reset-project-scoped-stores.ts), so without
	// this effect a folder id from the PREVIOUS project would bleed into the
	// newly-opened one and hide everything (no folder in the new project shares
	// that id). Handled locally here rather than in the shared
	// reset-project-scoped-stores.ts seam, which this campaign doesn't own.
	const activeProjectId = activeProject?.metadata.id ?? null;
	const previousProjectIdRef = useRef(activeProjectId);
	useEffect(() => {
		if (previousProjectIdRef.current !== activeProjectId) {
			previousProjectIdRef.current = activeProjectId;
			setCurrentFolderId(null);
		}
	}, [activeProjectId, setCurrentFolderId]);

	// Folders are a project-level list, mirroring how `mediaFiles` above reads
	// `editor.media.getAssets()` directly each render (no local memo) — the
	// manager returns its live array reference, and `useEditor()` already
	// re-renders this component on any `editor.project` change. The `?? []`
	// fallback also covers a project persisted before folders existed (no
	// migration needed — it just reads back as "everything's at Root").
	const folders: MediaFolder[] = editor.project.getMediaFolders?.() ?? [];

	const foldersInCurrentView = useMemo(
		() => folders.filter((f) => (f.parentId ?? null) === currentFolderId),
		[folders, currentFolderId],
	);

	/** Direct-subfolder count per parent id, used for a folder tile's item count. */
	const folderChildCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const f of folders) {
			if (f.parentId) counts.set(f.parentId, (counts.get(f.parentId) ?? 0) + 1);
		}
		return counts;
	}, [folders]);

	/** "Root / Folder / Subfolder" chain for the current folder, cycle-safe. */
	const breadcrumbChain = useMemo(() => {
		const byId = new Map(folders.map((f) => [f.id, f]));
		const chain: MediaFolder[] = [];
		const visited = new Set<string>();
		let cursor = currentFolderId;
		while (cursor) {
			if (visited.has(cursor)) break;
			visited.add(cursor);
			const folder = byId.get(cursor);
			if (!folder) break;
			chain.unshift(folder);
			cursor = folder.parentId;
		}
		return chain;
	}, [folders, currentFolderId]);

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

			// Duplicate signal only — never blocks or dedupes the import itself.
			// Checks against the library as it stood before this batch AND against
			// files already seen earlier in this same batch (same file picked
			// twice in one selection).
			const existingSignatures = new Set(
				mediaFiles.map((asset) =>
					mediaAssetSignature({ name: asset.name, size: asset.file.size }),
				),
			);
			const seenInBatch = new Set<string>();

			for (const asset of processedAssets) {
				const signature = mediaAssetSignature({
					name: asset.name,
					size: asset.file.size,
				});
				if (existingSignatures.has(signature) || seenInBatch.has(signature)) {
					toast.info(
						`"${asset.name}" looks like a duplicate of an asset already in your library — imported anyway.`,
					);
				}
				seenInBatch.add(signature);

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
		if (hasDirectoryEntry(e.dataTransfer)) {
			e.preventDefault();
			if (!activeProject) {
				toast.error("No active project");
				return;
			}
			const entries = await extractDroppedEntries(e.dataTransfer);
			await importDroppedFolderEntries(entries);
			return;
		}
		dragProps.onDrop(e);
	};

	// ---- Folders (C33) --------------------------------------------------

	const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
	const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
	const [folderNameDraft, setFolderNameDraft] = useState("");

	const handleCreateFolder = () => {
		if (!activeProject) {
			toast.error("No active project");
			return;
		}
		const command = new CreateFolderCommand(activeProject.metadata.id, {
			name: "New folder",
			parentId: currentFolderId,
		});
		editor.command.execute({ command });
		// Drop the fresh folder straight into rename mode (pre-selected text)
		// instead of a separate name-prompt dialog — same "type over the
		// default, Enter to commit" pattern as the label inline-edit above.
		setEditingFolderId(command.getFolderId());
		setFolderNameDraft("New folder");
	};

	const handleStartFolderRename = (folder: MediaFolder) => {
		setEditingFolderId(folder.id);
		setFolderNameDraft(folder.name);
	};

	const handleCancelFolderRename = () => {
		setEditingFolderId(null);
	};

	const handleCommitFolderRename = () => {
		if (!editingFolderId || !activeProject) {
			setEditingFolderId(null);
			return;
		}
		const trimmed = folderNameDraft.trim();
		const folder = folders.find((f) => f.id === editingFolderId);
		if (trimmed && folder && trimmed !== folder.name) {
			const command = new RenameFolderCommand(
				activeProject.metadata.id,
				editingFolderId,
				trimmed,
			);
			editor.command.execute({ command });
		}
		setEditingFolderId(null);
	};

	const handleDeleteFolder = (folder: MediaFolder) => {
		if (!activeProject) {
			toast.error("No active project");
			return;
		}
		const confirmed = window.confirm(
			`Delete "${folder.name}"? Nothing inside it is deleted — its assets and subfolders move back out of the folder.`,
		);
		if (!confirmed) return;
		const command = new DeleteFolderCommand(
			activeProject.metadata.id,
			folder.id,
		);
		editor.command.execute({ command });
	};

	const handleMoveAssetToFolder = ({
		assetId,
		folderId,
	}: {
		assetId: string;
		folderId: string | null;
	}) => {
		if (!activeProject) {
			toast.error("No active project");
			return;
		}
		const command = new MoveAssetToFolderCommand(
			activeProject.metadata.id,
			assetId,
			folderId,
		);
		editor.command.execute({ command });
	};

	const makeFolderDragHandlers = (folder: MediaFolder) => ({
		onDragOver: (e: React.DragEvent) => {
			const dragData = getDragData({ dataTransfer: e.dataTransfer });
			if (dragData?.type !== "media") return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
		},
		onDragEnter: (e: React.DragEvent) => {
			const dragData = getDragData({ dataTransfer: e.dataTransfer });
			if (dragData?.type !== "media") return;
			e.preventDefault();
			setDragOverFolderId(folder.id);
		},
		onDragLeave: () => {
			setDragOverFolderId((current) =>
				current === folder.id ? null : current,
			);
		},
		onDrop: (e: React.DragEvent) => {
			const dragData = getDragData({ dataTransfer: e.dataTransfer });
			setDragOverFolderId(null);
			if (dragData?.type !== "media") return;
			e.preventDefault();
			e.stopPropagation();
			handleMoveAssetToFolder({ assetId: dragData.id, folderId: folder.id });
		},
	});

	// ---- Folder upload (C33 / Worker C's folder-upload contract) --------

	const directoryInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const input = directoryInputRef.current;
		if (!input) return;
		// Non-standard attributes with no first-class React/JSX prop — set via
		// the DOM directly, same technique as the other file inputs' imperative
		// `.click()` trigger below.
		input.setAttribute("webkitdirectory", "");
		input.setAttribute("directory", "");
	}, []);

	const openDirectoryPicker = () => directoryInputRef.current?.click();

	/**
	 * Shared tail for BOTH folder-import entry points (the directory <input>
	 * and a Finder folder dropped on the panel): build the folder tree from
	 * the distinct `path`s (deduping a repeated prefix to one created folder,
	 * scoped to THIS batch only — see CreateFolderCommand contract), then run
	 * the SAME `processMediaAssets` + signature-dedupe loop `processFiles`
	 * uses above, one file at a time (so a file that fails/gets skipped never
	 * throws off which folder the NEXT file lands in — `processMediaAssets`
	 * can return fewer assets than files went in). Each imported asset is
	 * then moved into its leaf folder via `MoveAssetToFolderCommand`.
	 */
	const importDroppedFolderEntries = async (entries: DroppedEntry[]) => {
		if (entries.length === 0) return;
		if (!activeProject) {
			toast.error("No active project");
			return;
		}
		const projectId = activeProject.metadata.id;

		setIsProcessing(true);
		setProgress(0);
		try {
			const folderIdCache = new Map<string, string>();
			const resolveFolderId = (path: string[]): string | null => {
				let parentId = currentFolderId;
				let key = "";
				for (const segment of path) {
					key = `${key}/${segment}`;
					let folderId = folderIdCache.get(key);
					if (!folderId) {
						const command = new CreateFolderCommand(projectId, {
							name: segment,
							parentId,
						});
						editor.command.execute({ command });
						folderId = command.getFolderId();
						folderIdCache.set(key, folderId);
					}
					parentId = folderId;
				}
				return parentId;
			};

			const existingSignatures = new Set(
				mediaFiles.map((asset) =>
					mediaAssetSignature({ name: asset.name, size: asset.file.size }),
				),
			);
			const seenInBatch = new Set<string>();

			let completed = 0;
			for (const entry of entries) {
				const folderId = resolveFolderId(entry.path);

				const [processed] = await processMediaAssets({ files: [entry.file] });
				completed += 1;
				setProgress(Math.round((completed / entries.length) * 100));
				// Unsupported/corrupt — processMediaAssets already toasted why.
				if (!processed) continue;

				const signature = mediaAssetSignature({
					name: processed.name,
					size: processed.file.size,
				});
				if (existingSignatures.has(signature) || seenInBatch.has(signature)) {
					toast.info(
						`"${processed.name}" looks like a duplicate of an asset already in your library — imported anyway.`,
					);
				}
				seenInBatch.add(signature);

				const newAssetId = await editor.media.addMediaAsset({
					projectId,
					asset: processed,
				});
				if (folderId) {
					const moveCommand = new MoveAssetToFolderCommand(
						projectId,
						newAssetId,
						folderId,
					);
					editor.command.execute({ command: moveCommand });
				}
			}
		} catch (error) {
			console.error("Error processing folder upload:", error);
			toast.error("Failed to process the uploaded folder");
		} finally {
			setIsProcessing(false);
			setProgress(0);
		}
	};

	const handleDirectoryInputChange = (
		event: React.ChangeEvent<HTMLInputElement>,
	) => {
		const files = event.target.files;
		if (files && files.length > 0) {
			void importDroppedFolderEntries(filesFromDirectoryInput(files));
		}
		if (event.target) {
			event.target.value = "";
		}
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

	const nonEphemeralMediaAll = useMemo(
		() => mediaFiles.filter((item) => !item.ephemeral),
		[mediaFiles],
	);

	/** Direct-asset count per folder id, computed over the WHOLE library (not
	 *  folder-scoped) — every folder tile needs its own count regardless of
	 *  which folder is currently open. */
	const folderAssetCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const item of nonEphemeralMediaAll) {
			if (item.folderId) {
				counts.set(item.folderId, (counts.get(item.folderId) ?? 0) + 1);
			}
		}
		return counts;
	}, [nonEphemeralMediaAll]);

	// Scope the grid to the current folder (root = items with no folderId).
	// Filter tabs / sort below all operate on this sub-scope, matching how a
	// real file browser's type filter reads "within this folder", not "in the
	// whole library".
	const nonEphemeralMedia = useMemo(
		() =>
			nonEphemeralMediaAll.filter(
				(item) => (item.folderId ?? null) === currentFolderId,
			),
		[nonEphemeralMediaAll, currentFolderId],
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
			<input
				ref={directoryInputRef}
				type="file"
				multiple
				style={{ display: "none" }}
				onChange={handleDirectoryInputChange}
			/>

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
						onNewFolder={handleCreateFolder}
						onUploadFolder={openDirectoryPicker}
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
				<FolderBreadcrumb
					chain={breadcrumbChain}
					onNavigate={setCurrentFolderId}
				/>

				{/* Type filter tabs */}
				{nonEphemeralMedia.length > 0 && !isDragOver && (
					<MediaTypeFilterBar
						filter={mediaTypeFilter}
						onFilterChange={setMediaTypeFilter}
						counts={typeCounts}
					/>
				)}

				{isDragOver ||
				(filteredMediaItems.length === 0 &&
					foldersInCurrentView.length === 0) ? (
					<MediaDragOverlay
						isVisible={true}
						isProcessing={isProcessing}
						progress={progress}
						onClick={openFilePicker}
						mode={isDragOver ? "drag-active" : "empty"}
					/>
				) : (
					<MediaItemList
						items={filteredMediaItems}
						mode={mediaViewMode}
						onRemove={handleRemove}
						highlightedId={highlightedId}
						registerElement={registerElement}
						folders={foldersInCurrentView}
						allFolders={folders}
						folderAssetCounts={folderAssetCounts}
						folderChildCounts={folderChildCounts}
						onNavigateToFolder={setCurrentFolderId}
						editingFolderId={editingFolderId}
						folderNameDraft={folderNameDraft}
						onFolderDraftChange={setFolderNameDraft}
						onCommitFolderRename={handleCommitFolderRename}
						onCancelFolderRename={handleCancelFolderRename}
						onStartFolderRename={handleStartFolderRename}
						onDeleteFolder={handleDeleteFolder}
						dragOverFolderId={dragOverFolderId}
						makeFolderDragHandlers={makeFolderDragHandlers}
						onMoveAssetToFolder={handleMoveAssetToFolder}
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
	// BUG35: audio assets have no width/height and fell into the 16:9 fallback,
	// rendering as a wide card instead of the expected square tile.
	const previewRatio =
		item.type === "audio" ? 1 : Math.min(Math.max(naturalRatio, 0.5), 2);

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
	folders,
	onMoveToFolder,
}: {
	item: MediaAsset;
	children: React.ReactNode;
	onRemove: ({ event, id }: { event: React.MouseEvent; id: string }) => void;
	onSetLabel: (id: string) => void;
	folders: MediaFolder[];
	onMoveToFolder: ({
		assetId,
		folderId,
	}: {
		assetId: string;
		folderId: string | null;
	}) => void;
}) {
	const requestFindSimilar = useSearchStore((s) => s.requestFindSimilar);
	const setActiveTab = useAssetsPanelStore((s) => s.setActiveTab);
	const requestRevealMedia = useAssetsPanelStore((s) => s.requestRevealMedia);
	const editor = useEditor();
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
			// Silent on success: the new frame appears directly in the library
			// grid (with its FF/LF badge), so a confirmation toast is redundant.
			requestRevealMedia(result.mediaId);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't extract the frame.",
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
				<ContextMenuItem
					icon={<HugeiconsIcon icon={Download01Icon} />}
					onClick={() => {
						try {
							downloadMediaAsset(item);
						} catch (err) {
							toast.error(
								err instanceof Error ? err.message : "Couldn't download.",
							);
						}
					}}
				>
					Download
				</ContextMenuItem>
				{folders.length > 0 && (
					<ContextMenuSub>
						<ContextMenuSubTrigger icon={<HugeiconsIcon icon={Folder03Icon} />}>
							Move to folder
						</ContextMenuSubTrigger>
						<ContextMenuSubContent>
							{item.folderId && (
								<ContextMenuItem
									onClick={() =>
										onMoveToFolder({ assetId: item.id, folderId: null })
									}
								>
									Root
								</ContextMenuItem>
							)}
							{folders
								.filter((folder) => folder.id !== item.folderId)
								.map((folder) => (
									<ContextMenuItem
										key={folder.id}
										onClick={() =>
											onMoveToFolder({ assetId: item.id, folderId: folder.id })
										}
									>
										{folder.name}
									</ContextMenuItem>
								))}
						</ContextMenuSubContent>
					</ContextMenuSub>
				)}
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
	folders,
	allFolders,
	folderAssetCounts,
	folderChildCounts,
	onNavigateToFolder,
	editingFolderId,
	folderNameDraft,
	onFolderDraftChange,
	onCommitFolderRename,
	onCancelFolderRename,
	onStartFolderRename,
	onDeleteFolder,
	dragOverFolderId,
	makeFolderDragHandlers,
	onMoveAssetToFolder,
}: {
	items: MediaAsset[];
	mode: MediaViewMode;
	onRemove: ({ event, id }: { event: React.MouseEvent; id: string }) => void;
	highlightedId: string | null;
	registerElement: (id: string, element: HTMLElement | null) => void;
	/** Folders whose parent is the CURRENTLY OPEN folder — what's rendered as tiles. */
	folders: MediaFolder[];
	/** Every folder in the project — feeds each asset's "Move to folder" submenu. */
	allFolders: MediaFolder[];
	folderAssetCounts: Map<string, number>;
	folderChildCounts: Map<string, number>;
	onNavigateToFolder: (folderId: string | null) => void;
	editingFolderId: string | null;
	folderNameDraft: string;
	onFolderDraftChange: (value: string) => void;
	onCommitFolderRename: () => void;
	onCancelFolderRename: () => void;
	onStartFolderRename: (folder: MediaFolder) => void;
	onDeleteFolder: (folder: MediaFolder) => void;
	dragOverFolderId: string | null;
	makeFolderDragHandlers: (folder: MediaFolder) => FolderTileDragHandlers;
	onMoveAssetToFolder: ({
		assetId,
		folderId,
	}: {
		assetId: string;
		folderId: string | null;
	}) => void;
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
			{/* Folder tiles first — this folder's contents, subfolders before assets,
			    same convention as a desktop file browser. */}
			{folders.map((folder) => {
				const folderTile = (
					<FolderTile
						folder={folder}
						assetCount={folderAssetCounts.get(folder.id) ?? 0}
						subfolderCount={folderChildCounts.get(folder.id) ?? 0}
						itemCount={
							(folderAssetCounts.get(folder.id) ?? 0) +
							(folderChildCounts.get(folder.id) ?? 0)
						}
						variant={isGrid ? "card" : "compact"}
						isEditing={editingFolderId === folder.id}
						editingDraft={folderNameDraft}
						onDraftChange={onFolderDraftChange}
						onCommitRename={onCommitFolderRename}
						onCancelRename={onCancelFolderRename}
						onNavigate={() => onNavigateToFolder(folder.id)}
						onStartRename={() => onStartFolderRename(folder)}
						onDelete={() => onDeleteFolder(folder)}
						isDropTarget={dragOverFolderId === folder.id}
						dragHandlers={makeFolderDragHandlers(folder)}
					/>
				);

				if (!isGrid) {
					return <div key={folder.id}>{folderTile}</div>;
				}

				return (
					<MasonryCell
						key={folder.id}
						colSpan={1}
						registerRef={() => undefined}
					>
						{folderTile}
					</MasonryCell>
				);
			})}

			{items.map((item) => {
				const content = (
					<MediaItemWithContextMenu
						item={item}
						onRemove={onRemove}
						onSetLabel={handleStartLabelEdit}
						folders={allFolders}
						onMoveToFolder={onMoveAssetToFolder}
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
				// Audio has no width/height, so it fell into the 16/9 fallback here
				// too (colSpan 2) — combined with the forced-square `previewRatio`
				// in MediaAssetDraggable above, that rendered as a two-columns-wide
				// square: 4x the area of a normal single-column tile. Audio is
				// never actually landscape, so pin it to one column — this alone
				// quarters its footprint back down to a normal tile's size and lets
				// the existing dense packing reflow the grid around it.
				const ratio =
					item.width && item.height ? item.width / item.height : 16 / 9;
				const colSpan =
					item.type !== "audio" && ratio >= LANDSCAPE_RATIO_THRESHOLD ? 2 : 1;

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
	onNewFolder,
	onUploadFolder,
}: {
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	isProcessing: boolean;
	sortBy: MediaSortKey;
	sortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
	onImport: () => void;
	onNewFolder: () => void;
	onUploadFolder: () => void;
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
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							onClick={onNewFolder}
							disabled={isProcessing}
							className="items-center justify-center"
						>
							<HugeiconsIcon icon={FolderAddIcon} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>New folder</p>
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							onClick={onUploadFolder}
							disabled={isProcessing}
							className="items-center justify-center"
						>
							<HugeiconsIcon icon={FolderUploadIcon} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Upload folder</p>
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

/** Short badge text for a derived-frame provenance ("FF" / "LF" / "FR"). */
function frameBadgeText(label: DerivedFrom["label"]): string {
	return label === "first frame" ? "FF" : label === "last frame" ? "LF" : "FR";
}

/**
 * Compact provenance badge on an extracted still's thumbnail, top-right —
 * mirrors the {@link MediaTypeBadge} chrome (rounded, uppercase, text-[9px])
 * so it reads as a type tag rather than a caption. Extracted frames aren't
 * AI-sourced, so this never collides with {@link AiBadge}.
 */
function FrameEdgePill({ derivedFrom }: { derivedFrom: DerivedFrom }) {
	return (
		<div
			className="absolute right-1 top-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-medium uppercase leading-none text-white"
			title={frameLabelText(derivedFrom.label)}
		>
			{frameBadgeText(derivedFrom.label)}
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
		// Scrolls horizontally on its own, independent of the asset grid below —
		// `overflow-x-auto` + `flex-nowrap` (flex's default) instead of letting
		// tabs wrap or clip when they overflow the panel width. `shrink-0` on
		// each tab keeps them at their natural width so they overflow into the
		// scroll area rather than getting squeezed. Same
		// `overflow-x-auto scrollbar-hidden` convention as the other horizontal
		// tab/chip rows in this codebase (e.g. text-editing-panel.tsx).
		<div className="flex items-center gap-1 overflow-x-auto pb-3 scrollbar-hidden">
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
							"flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
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
