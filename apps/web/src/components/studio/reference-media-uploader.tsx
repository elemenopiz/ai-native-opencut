"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { getDragData } from "@/lib/drag-data";

/** A single reference attachment for Seedance omni-reference. */
export interface ReferenceMediaItem {
	id: string;
	url: string;
	kind: "image" | "video";
	name: string;
	status: "uploading" | "ready" | "error";
	error?: string;
}

// Seedance 2.0 omni-reference caps (BytePlus ModelArk): up to 9 reference
// images and 3 reference videos, 12 files total per generation.
export const MAX_OMNI_IMAGES = 9;
export const MAX_OMNI_VIDEOS = 3;
export const MAX_OMNI_TOTAL = 12;

interface ReferenceMediaUploaderProps {
	items: ReferenceMediaItem[];
	onChange: (items: ReferenceMediaItem[]) => void;
	/** id → @mention handle (e.g. "@Image1"), shown on each chip. */
	handles?: Record<string, string>;
	/** "image" restricts to images (e.g. multiframe keyframes). Default "all". */
	accept?: "all" | "image";
	disabled?: boolean;
	className?: string;
}

/**
 * Drag-and-drop / click uploader for Seedance omni-reference media. Accepts
 * images and videos, uploads each to `/api/studio/upload` (which rehosts to a
 * BytePlus-fetchable URL), and surfaces them as thumbnail chips. Reference media
 * conditions the generation regardless of text/image-to-video mode.
 */
export function ReferenceMediaUploader({
	items,
	onChange,
	handles,
	accept = "all",
	disabled,
	className,
}: ReferenceMediaUploaderProps) {
	const imagesOnly = accept === "image";
	const editor = useEditor();
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);

	const itemsRef = useRef(items);
	itemsRef.current = items;

	const imageCount = items.filter((it) => it.kind === "image").length;
	const videoCount = items.filter((it) => it.kind === "video").length;

	const capReached = useCallback((kind: "image" | "video") => {
		if (itemsRef.current.length >= MAX_OMNI_TOTAL) return true;
		return kind === "image"
			? itemsRef.current.filter((it) => it.kind === "image").length >=
					MAX_OMNI_IMAGES
			: itemsRef.current.filter((it) => it.kind === "video").length >=
					MAX_OMNI_VIDEOS;
	}, []);

	// Applies a list update both to the caller's state and to itemsRef
	// synchronously. itemsRef only reflects committed props on the next render,
	// so without this, several uploadOne calls fired back-to-back (e.g. a
	// multi-file drop) would all read the same stale itemsRef.current and
	// clobber each other's optimistic append.
	const applyChange = useCallback(
		(next: ReferenceMediaItem[]) => {
			itemsRef.current = next;
			onChange(next);
		},
		[onChange],
	);

	const uploadOne = useCallback(
		async (file: File) => {
			const id = crypto.randomUUID();
			const kind: ReferenceMediaItem["kind"] = file.type.startsWith("video/")
				? "video"
				: "image";

			// Optimistic local preview while the upload is in flight.
			const localUrl = URL.createObjectURL(file);
			applyChange([
				...itemsRef.current,
				{ id, url: localUrl, kind, name: file.name, status: "uploading" },
			]);

			try {
				const form = new FormData();
				form.append("file", file);
				const res = await fetch("/api/studio/upload", {
					method: "POST",
					body: form,
				});
				const data = (await res.json()) as { url?: string; error?: string };
				if (!res.ok || !data.url) {
					throw new Error(data.error ?? "Upload failed");
				}
				applyChange(
					itemsRef.current.map((it) =>
						it.id === id ? { ...it, url: data.url!, status: "ready" } : it,
					),
				);
				// Server URL is now in use; release the optimistic preview blob.
				URL.revokeObjectURL(localUrl);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Upload failed";
				toast.error(`Couldn't add ${file.name}: ${message}`);
				applyChange(
					itemsRef.current.map((it) =>
						it.id === id ? { ...it, status: "error", error: message } : it,
					),
				);
			}
		},
		[applyChange],
	);

	const handleFiles = useCallback(
		(files: FileList | null) => {
			if (!files) return;
			// Track counts locally so dropping 10 images in one go still caps at
			// MAX_OMNI_IMAGES instead of only checking against the pre-batch list.
			let pendingImages = imageCount;
			let pendingVideos = videoCount;
			let pendingTotal = itemsRef.current.length;

			for (const file of Array.from(files)) {
				const isImage = file.type.startsWith("image/");
				const isVideo = file.type.startsWith("video/");
				if (imagesOnly && !isImage) {
					toast.error(`${file.name}: frames must be images`);
					continue;
				}
				if (!isImage && !isVideo) {
					toast.error(`${file.name}: only images and videos are supported`);
					continue;
				}
				if (!imagesOnly && pendingTotal >= MAX_OMNI_TOTAL) {
					toast.error(`Reference limit reached (${MAX_OMNI_TOTAL} files max)`);
					break;
				}
				if (isImage && !imagesOnly && pendingImages >= MAX_OMNI_IMAGES) {
					toast.error(`${file.name}: max ${MAX_OMNI_IMAGES} reference images`);
					continue;
				}
				if (isVideo && pendingVideos >= MAX_OMNI_VIDEOS) {
					toast.error(`${file.name}: max ${MAX_OMNI_VIDEOS} reference videos`);
					continue;
				}
				if (isImage) pendingImages++;
				else pendingVideos++;
				pendingTotal++;
				void uploadOne(file);
			}
		},
		[uploadOne, imagesOnly, imageCount, videoCount],
	);

	// Drop handler that understands both OS files and clips dragged from the
	// Assets panel. Asset drags carry no FileList, so we resolve the dragged
	// media's File from the editor and upload that.
	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setDragging(false);

			if (e.dataTransfer.files?.length) {
				handleFiles(e.dataTransfer.files);
				return;
			}

			const drag = getDragData({ dataTransfer: e.dataTransfer });
			if (drag?.type === "media") {
				if (drag.mediaType === "audio") {
					toast.error("Audio can't be used as a visual reference.");
					return;
				}
				if (imagesOnly && drag.mediaType !== "image") {
					toast.error("Frames must be images.");
					return;
				}
				const dropKind = drag.mediaType === "video" ? "video" : "image";
				if (capReached(dropKind)) {
					toast.error(
						dropKind === "video"
							? `Max ${MAX_OMNI_VIDEOS} reference videos`
							: `Max ${MAX_OMNI_IMAGES} reference images`,
					);
					return;
				}
				const asset = editor.media.getAssets().find((a) => a.id === drag.id);
				if (asset?.file) {
					void uploadOne(asset.file);
					return;
				}
				toast.error("Couldn't read that asset.");
			}
		},
		[editor, handleFiles, uploadOne, imagesOnly, capReached],
	);

	const remove = useCallback(
		(id: string) => {
			applyChange(itemsRef.current.filter((it) => it.id !== id));
		},
		[applyChange],
	);

	return (
		<div className={cn("space-y-2", className)}>
			<input
				ref={inputRef}
				type="file"
				accept={imagesOnly ? "image/*" : "image/*,video/*"}
				multiple
				className="hidden"
				onChange={(e) => {
					handleFiles(e.target.files);
					e.target.value = "";
				}}
			/>

			<button
				type="button"
				disabled={disabled}
				onClick={() => inputRef.current?.click()}
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={handleDrop}
				className={cn(
					"w-full rounded-lg border border-dashed px-3 py-4 text-center transition-colors",
					dragging
						? "border-primary bg-primary/5"
						: "border-border hover:border-foreground/50",
					disabled && "opacity-50 cursor-not-allowed",
				)}
			>
				<p className="text-xs font-medium">
					{imagesOnly
						? "Drag from Assets, or drop images here"
						: "Drag from Assets, or drop images / videos here"}
				</p>
				<p className="text-[10px] text-muted-foreground mt-0.5">
					click to browse · keeps subject, style &amp; scene consistent
				</p>
				<p className="text-[10px] text-muted-foreground mt-0.5">
					{imagesOnly
						? `up to ${MAX_OMNI_IMAGES} images`
						: `up to ${MAX_OMNI_IMAGES} images (${imageCount}/${MAX_OMNI_IMAGES}) · ${MAX_OMNI_VIDEOS} videos (${videoCount}/${MAX_OMNI_VIDEOS})`}
				</p>
			</button>

			{items.length > 0 && (
				<div className="grid grid-cols-4 gap-2">
					{items.map((it) => (
						<div
							key={it.id}
							className={cn(
								"group relative aspect-square overflow-hidden rounded-md border bg-muted",
								it.status === "error" && "border-destructive",
							)}
							title={it.error ? `${it.name}: ${it.error}` : it.name}
						>
							{it.kind === "image" ? (
								// eslint-disable-next-line @next/next/no-img-element
								<img
									src={it.url}
									alt={it.name}
									className="h-full w-full object-cover"
								/>
							) : (
								<video
									src={it.url}
									className="h-full w-full object-cover"
									muted
									playsInline
								/>
							)}

							{/* Kind badge */}
							<span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[8px] font-medium uppercase text-white">
								{it.kind}
							</span>

							{/* @mention handle — what you type in the prompt */}
							{handles?.[it.id] && it.status === "ready" && (
								<span className="absolute inset-x-0 bottom-0 bg-black/70 px-1 py-0.5 text-center font-mono text-[9px] font-medium text-white">
									{handles[it.id]}
								</span>
							)}

							{it.status === "uploading" && (
								<div className="absolute inset-0 flex items-center justify-center bg-black/40">
									<span className="text-[9px] text-white">Uploading…</span>
								</div>
							)}
							{it.status === "error" && (
								<div className="absolute inset-0 flex items-center justify-center bg-destructive/40">
									<span className="text-[9px] text-white">Failed</span>
								</div>
							)}

							<button
								type="button"
								onClick={() => remove(it.id)}
								className="absolute right-0.5 top-0.5 hidden size-4 items-center justify-center rounded-full bg-black/70 text-[10px] leading-none text-white group-hover:flex"
								aria-label={`Remove ${it.name}`}
							>
								×
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
