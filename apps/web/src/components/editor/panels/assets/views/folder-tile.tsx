"use client";

import { useEffect, useRef } from "react";
import { ArrowRight01Icon, Folder03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { MediaFolder } from "@/types/assets";
import { cn } from "@/utils/ui";

/**
 * Folder tile — the "sibling card" to `MediaAssetDraggable`/`DraggableItem`
 * in assets.tsx. Deliberately copies that component's DOM shape (size-28
 * card / h-8 compact row, same label sizing, same `bg-accent` fill) so
 * folders read as the SAME card system rather than a new visual language,
 * per the locked Instrument-Grade Minimal direction — no new colors, no
 * glow (folders never glow; glow is reserved for active AI generation).
 *
 * Folders aren't draggable themselves (no HTML5 `draggable`) — they're only
 * a DROP TARGET for asset tiles being reorganized, so this component owns
 * no `dragstart` wiring, only `dragHandlers` (over/enter/leave/drop) the
 * caller supplies to detect an asset being dragged onto it.
 */
export interface FolderTileDragHandlers {
	onDragOver: (e: React.DragEvent) => void;
	onDragEnter: (e: React.DragEvent) => void;
	onDragLeave: (e: React.DragEvent) => void;
	onDrop: (e: React.DragEvent) => void;
}

export interface FolderTileProps {
	folder: MediaFolder;
	/** Direct assets + direct subfolders, combined — the tile's headline count. */
	itemCount: number;
	assetCount: number;
	subfolderCount: number;
	variant: "card" | "compact";
	isEditing: boolean;
	editingDraft: string;
	onDraftChange: (value: string) => void;
	onCommitRename: () => void;
	onCancelRename: () => void;
	onNavigate: () => void;
	onStartRename: () => void;
	onDelete: () => void;
	isDropTarget: boolean;
	dragHandlers: FolderTileDragHandlers;
}

export function FolderTile({
	folder,
	itemCount,
	assetCount,
	subfolderCount,
	variant,
	isEditing,
	editingDraft,
	onDraftChange,
	onCommitRename,
	onCancelRename,
	onNavigate,
	onStartRename,
	onDelete,
	isDropTarget,
	dragHandlers,
}: FolderTileProps) {
	const isCard = variant === "card";
	const inputRef = useRef<HTMLInputElement>(null);

	// Focus + select on entering edit mode — replaces the `autoFocus` attribute
	// (flagged by lint/a11y/noAutofocus) with the equivalent imperative effect.
	// BUG120: when edit mode is entered from the context menu, Radix's menu
	// teardown moves focus AFTER this effect has run (even with
	// onCloseAutoFocus prevented, unmounting the focused menu item drops focus
	// to <body>), so retry on the next tick until the input actually holds it.
	useEffect(() => {
		if (!isEditing) return;
		const grab = () => {
			const input = inputRef.current;
			if (!input) return;
			input.focus();
			input.select();
		};
		grab();
		// Radix's focus restore can land a few hundred ms after close (post
		// exit-animation), so retry past that window; stop as soon as it sticks.
		const timers = [80, 250, 450].map((ms) =>
			window.setTimeout(() => {
				if (document.activeElement !== inputRef.current) grab();
			}, ms),
		);
		return () => {
			for (const t of timers) window.clearTimeout(t);
		};
	}, [isEditing]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			onCommitRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			onCancelRename();
		}
	};

	const nameInput = (
		<input
			ref={inputRef}
			type="text"
			value={editingDraft}
			onChange={(e) => onDraftChange(e.target.value)}
			onBlur={onCommitRename}
			onKeyDown={handleKeyDown}
			onClick={(e) => e.stopPropagation()}
			className={cn(
				"w-full rounded border bg-transparent outline-none focus:ring-1 focus:ring-ring",
				isCard ? "text-center text-[0.7rem]" : "flex-1 text-left text-sm",
			)}
		/>
	);

	const nameLabel = (
		<span
			className={cn(
				"truncate text-foreground",
				isCard
					? "w-full text-center text-[0.7rem]"
					: "flex-1 text-left text-sm",
			)}
			title={folder.name}
		>
			{folder.name}
		</span>
	);

	const countTitle = `${assetCount} asset${assetCount === 1 ? "" : "s"}${
		subfolderCount > 0
			? `, ${subfolderCount} folder${subfolderCount === 1 ? "" : "s"}`
			: ""
	}`;

	if (isCard) {
		return (
			<ContextMenu>
				<ContextMenuTrigger>
					<div className="group relative size-28">
						<div className="relative flex h-auto w-full flex-col gap-1 p-1">
							<button
								type="button"
								onClick={onNavigate}
								{...dragHandlers}
								title={countTitle}
								className={cn(
									"bg-accent relative flex aspect-square w-full cursor-default flex-col items-center justify-center gap-1 overflow-hidden rounded-sm border text-muted-foreground transition-colors",
									isDropTarget &&
										"border-primary bg-primary/10 ring-1 ring-primary",
								)}
							>
								<HugeiconsIcon icon={Folder03Icon} className="size-7" />
								<span className="text-[9px] tabular-nums opacity-70">
									{itemCount}
								</span>
							</button>
							{isEditing ? nameInput : nameLabel}
						</div>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onClick={onStartRename}>Rename</ContextMenuItem>
					<ContextMenuItem variant="destructive" onClick={onDelete}>
						Delete folder
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		);
	}

	// Compact (list) row: the name sits INSIDE the clickable row here (unlike
	// the card variant, where it's a separate sibling below), so a real
	// `<button>` can only wrap it while displaying the static label — a
	// `<button>` can't legally contain an `<input>`. While editing, the row
	// drops to a plain `<div>` (the input itself is the interactive element;
	// clicking it already stops propagation, see `nameInput` above).
	const rowClassName = cn(
		"flex h-8 w-full cursor-default items-center gap-3 rounded px-1 transition-colors",
		isDropTarget && "bg-primary/10 ring-1 ring-inset ring-primary",
	);
	const rowContent = (
		<>
			<div className="flex size-6 shrink-0 items-center justify-center rounded-[0.35rem] bg-accent text-muted-foreground">
				<HugeiconsIcon icon={Folder03Icon} className="size-3.5" />
			</div>
			{isEditing ? nameInput : nameLabel}
			<span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
				{itemCount}
			</span>
		</>
	);

	return (
		<ContextMenu>
			<ContextMenuTrigger>
				<div className="group relative w-full">
					{isEditing ? (
						<div {...dragHandlers} title={countTitle} className={rowClassName}>
							{rowContent}
						</div>
					) : (
						<button
							type="button"
							onClick={onNavigate}
							{...dragHandlers}
							title={countTitle}
							className={rowClassName}
						>
							{rowContent}
						</button>
					)}
				</div>
			</ContextMenuTrigger>
			{/* BUG120: Radix restores focus to the tile trigger when the menu
			    closes, which lands AFTER Rename mounts+focuses the inline input —
			    the input's onBlur commit fires immediately and edit mode never
			    engages. Prevent the close-auto-focus (same idiom the shared
			    DropdownMenuContent applies globally in ui/dropdown-menu.tsx). */}
			<ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
				<ContextMenuItem onClick={onStartRename}>Rename</ContextMenuItem>
				<ContextMenuItem variant="destructive" onClick={onDelete}>
					Delete folder
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

/**
 * "Root / Folder / Subfolder" path — the way back up out of nested folders.
 * Only rendered when inside a folder (empty `chain` ⇒ null); Root is always
 * the implicit, always-present leftmost stop. Mirrors the muted/foreground
 * hover treatment already used by `MediaTypeFilterBar`'s tabs so it reads as
 * the same chrome family, not a new one.
 */
export function FolderBreadcrumb({
	chain,
	onNavigate,
}: {
	chain: MediaFolder[];
	onNavigate: (folderId: string | null) => void;
}) {
	if (chain.length === 0) return null;

	return (
		<div className="flex items-center gap-1 overflow-x-auto pb-2 text-xs text-muted-foreground">
			<button
				type="button"
				onClick={() => onNavigate(null)}
				className="shrink-0 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
			>
				Root
			</button>
			{chain.map((folder, index) => (
				<span key={folder.id} className="flex shrink-0 items-center gap-1">
					<HugeiconsIcon
						icon={ArrowRight01Icon}
						className="size-3 shrink-0 opacity-50"
					/>
					<button
						type="button"
						onClick={() => onNavigate(folder.id)}
						className={cn(
							"truncate rounded px-1 py-0.5 hover:bg-muted hover:text-foreground",
							index === chain.length - 1 && "font-medium text-foreground",
						)}
					>
						{folder.name}
					</button>
				</span>
			))}
		</div>
	);
}
