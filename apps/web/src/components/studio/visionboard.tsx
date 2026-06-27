"use client";

import { type DragEvent, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/utils/ui";
import type { StudioMediaItem } from "@/lib/studio/add-to-editor";

interface BoardTake {
	id: string;
	kind?: "take" | "image";
	takeId?: string;
	imageStillId?: string;
	notes?: string;
	position: number;
	take?: {
		videoUrl?: string;
		thumbnailUrl?: string;
		resolution?: string;
		seed?: number;
		status?: string;
	} | null;
	set?: {
		prompt?: string;
	} | null;
	image?: {
		imageUrl?: string;
		prompt?: string;
	} | null;
}

/** Payload set on dataTransfer when dragging a generated image still. */
export interface StudioImageDrag {
	kind: "image";
	imageStillId: string;
	imageUrl: string;
}

export const STUDIO_IMAGE_DND_TYPE = "application/x-studio-image";

/** Payload when dragging a pinned board tile toward the editor. */
export const STUDIO_BOARD_DND_TYPE = "application/x-studio-board-item";

interface VisionboardProps {
	className?: string;
	/** Push curated clips into the editor's media library. */
	onSendToEditor?: (items: StudioMediaItem[]) => void | Promise<void>;
}

function boardItemToMedia(item: BoardTake): StudioMediaItem | null {
	const isImage = item.kind === "image" || !!item.image;
	if (isImage && item.image?.imageUrl) {
		const name = (item.image.prompt ?? "Studio still").slice(0, 40);
		return { url: item.image.imageUrl, name, kind: "image" };
	}
	if (item.take?.videoUrl) {
		const name = (item.set?.prompt ?? "Studio clip").slice(0, 40);
		return { url: item.take.videoUrl, name, kind: "video" };
	}
	return null;
}

export function Visionboard({ className, onSendToEditor }: VisionboardProps) {
	const [items, setItems] = useState<BoardTake[]>([]);
	const [loading, setLoading] = useState(true);
	const [isPinTarget, setIsPinTarget] = useState(false);
	const [isSendTarget, setIsSendTarget] = useState(false);
	const [sending, setSending] = useState(false);

	async function refresh() {
		setLoading(true);
		try {
			const res = await fetch("/api/studio/board");
			const data = await res.json() as { items: BoardTake[] };
			setItems(data.items ?? []);
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => { refresh(); }, []);

	async function removeItem(id: string) {
		await fetch(`/api/studio/board?id=${id}`, { method: "DELETE" });
		setItems((prev) => prev.filter((i) => i.id !== id));
	}

	// ── Pin: drag a GPT Image still onto the board to curate it ───────────────
	async function handlePinDrop(e: DragEvent<HTMLDivElement>) {
		e.preventDefault();
		setIsPinTarget(false);
		const raw = e.dataTransfer.getData(STUDIO_IMAGE_DND_TYPE);
		if (!raw) return;
		let payload: StudioImageDrag;
		try {
			payload = JSON.parse(raw) as StudioImageDrag;
		} catch {
			return;
		}
		if (!payload.imageStillId) return;

		const tempId = `temp-${payload.imageStillId}`;
		setItems((prev) => [
			...prev,
			{
				id: tempId,
				kind: "image",
				imageStillId: payload.imageStillId,
				position: prev.length,
				image: { imageUrl: payload.imageUrl },
			},
		]);

		const res = await fetch("/api/studio/board", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ imageStillId: payload.imageStillId }),
		});
		if (res.ok) {
			const data = await res.json() as { item: { id: string } };
			setItems((prev) =>
				prev.map((i) => (i.id === tempId ? { ...i, id: data.item.id } : i)),
			);
		} else {
			setItems((prev) => prev.filter((i) => i.id !== tempId));
		}
	}

	function handlePinDragOver(e: DragEvent<HTMLDivElement>) {
		if (e.dataTransfer.types.includes(STUDIO_IMAGE_DND_TYPE)) {
			e.preventDefault();
			setIsPinTarget(true);
		}
	}

	const pinDropProps = {
		onDrop: handlePinDrop,
		onDragOver: handlePinDragOver,
		onDragLeave: (e: DragEvent<HTMLDivElement>) => {
			if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
				setIsPinTarget(false);
			}
		},
	};

	// ── Send: drag a board tile onto the dropzone to push it to the editor ────
	async function sendItems(media: StudioMediaItem[]) {
		if (!onSendToEditor || media.length === 0) return;
		setSending(true);
		try {
			await onSendToEditor(media);
		} finally {
			setSending(false);
		}
	}

	async function handleSendDrop(e: DragEvent<HTMLDivElement>) {
		e.preventDefault();
		setIsSendTarget(false);
		const raw = e.dataTransfer.getData(STUDIO_BOARD_DND_TYPE);
		if (!raw) return;
		try {
			const media = JSON.parse(raw) as StudioMediaItem;
			await sendItems([media]);
		} catch {
			/* ignore malformed payloads */
		}
	}

	function handleSendDragOver(e: DragEvent<HTMLDivElement>) {
		if (e.dataTransfer.types.includes(STUDIO_BOARD_DND_TYPE)) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			setIsSendTarget(true);
		}
	}

	if (loading) {
		return (
			<div className={cn("flex items-center justify-center h-32 text-muted-foreground text-sm", className)}>
				Loading board…
			</div>
		);
	}

	return (
		<div className={cn("space-y-4", className)}>
			{/* Send-to-editor dropzone */}
			{onSendToEditor && (
				<div
					onDrop={handleSendDrop}
					onDragOver={handleSendDragOver}
					onDragLeave={(e) => {
						if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
							setIsSendTarget(false);
						}
					}}
					className={cn(
						"flex items-center justify-center gap-3 rounded-xl border border-dashed px-4 py-5 text-center transition-colors",
						isSendTarget
							? "border-primary bg-primary/10"
							: "border-border bg-muted/30 hover:border-foreground/40",
					)}
				>
					<svg
						className={cn("size-5 shrink-0", isSendTarget ? "text-primary" : "text-muted-foreground")}
						fill="none" viewBox="0 0 24 24" stroke="currentColor"
					>
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
							d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
					</svg>
					<div className="text-left">
						<p className="text-sm font-medium">
							{sending ? "Sending to the editor…" : "Send to editor"}
						</p>
						<p className="text-xs text-muted-foreground">
							Drag a tile here to add it to your project's media — then drag it onto the timeline.
						</p>
					</div>
				</div>
			)}

			{/* Board grid (also the drop target for pinning GPT Image stills) */}
			<div
				{...pinDropProps}
				className={cn(
					"rounded-lg transition-shadow",
					isPinTarget && "ring-2 ring-primary ring-offset-2 ring-offset-background",
				)}
			>
				{!items.length ? (
					<div className="flex flex-col items-center justify-center h-40 gap-2 border border-dashed border-border rounded-lg">
						<p className="text-muted-foreground text-sm">No items pinned yet.</p>
						<p className="text-muted-foreground text-xs">
							Drag a generated image here, or star a take and pin it to curate your winners.
						</p>
					</div>
				) : (
					<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
						{items.map((item) => {
							const isImage = item.kind === "image" || !!item.image;
							const prompt = item.image?.prompt ?? item.set?.prompt;
							const media = boardItemToMedia(item);
							return (
								<div
									key={item.id}
									draggable={!!media}
									onDragStart={(e) => {
										if (!media) return;
										e.dataTransfer.setData(STUDIO_BOARD_DND_TYPE, JSON.stringify(media));
										e.dataTransfer.effectAllowed = "copy";
									}}
									className={cn(
										"relative rounded-lg border bg-card overflow-hidden group transition-all",
										"hover:border-primary/50 hover:shadow-md",
										media && "cursor-grab active:cursor-grabbing",
									)}
								>
									<div className="aspect-video bg-muted">
										{isImage && item.image?.imageUrl ? (
											<img src={item.image.imageUrl} alt={prompt ?? ""} className="w-full h-full object-cover pointer-events-none" />
										) : item.take?.videoUrl ? (
											<video
												src={item.take.videoUrl}
												className="w-full h-full object-cover pointer-events-none"
												loop
												muted
												playsInline
											/>
										) : item.take?.thumbnailUrl ? (
											<img src={item.take.thumbnailUrl} alt="" className="w-full h-full object-cover pointer-events-none" />
										) : (
											<div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
												No preview
											</div>
										)}
									</div>

									<div className="px-2 py-1.5 space-y-1">
										{prompt && (
											<p className="text-xs truncate text-muted-foreground">{prompt}</p>
										)}
										<div className="flex gap-1 flex-wrap">
											{isImage ? (
												<Badge variant="secondary" className="text-xs">image</Badge>
											) : (
												<>
													{item.take?.resolution && (
														<Badge variant="secondary" className="text-xs">{item.take.resolution}</Badge>
													)}
													{item.take?.seed != null && (
														<Badge variant="outline" className="text-xs font-mono">#{item.take.seed}</Badge>
													)}
												</>
											)}
										</div>
										{item.notes && <p className="text-xs text-muted-foreground italic">{item.notes}</p>}
									</div>

									{/* Hover actions */}
									<div className="absolute inset-x-0 top-0 flex justify-end p-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
										{onSendToEditor && media && (
											<button
												type="button"
												title="Send to editor"
												onClick={() => sendItems([media])}
												className="size-6 rounded bg-black/60 text-white flex items-center justify-center hover:bg-black/80"
											>
												<svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
												</svg>
											</button>
										)}
										<button
											type="button"
											title="Remove from board"
											onClick={() => removeItem(item.id)}
											className="ml-1 size-6 rounded bg-black/60 text-white flex items-center justify-center hover:bg-destructive"
										>
											<svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
												<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
											</svg>
										</button>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
