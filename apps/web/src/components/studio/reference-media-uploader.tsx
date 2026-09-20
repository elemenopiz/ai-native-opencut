"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Cancel01Icon,
	CheckmarkBadge01Icon,
	ImageAdd02Icon,
} from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { getDragData } from "@/lib/drag-data";
import { isAssetRef } from "@/lib/studio/asset-ref";
import { uploadReferenceFile } from "@/lib/studio/reference-upload";

/** A single reference attachment for Seedance omni-reference. */
export interface ReferenceMediaItem {
	id: string;
	url: string;
	kind: "image" | "video";
	name: string;
	status: "uploading" | "ready" | "error";
	error?: string;
	/** Best-effort duration in seconds for `kind === "video"`, probed
	 *  client-side from the local blob URL at attach time (before upload
	 *  completes). Powers the video form's "Match @VideoN" duration chip. */
	durationSec?: number;
}

/** Reads a video's duration from a local (blob or remote) URL without
 *  uploading or transcoding — best-effort, resolves `undefined` on error
 *  instead of throwing so a probe failure never blocks the attach flow. */
function probeVideoDuration(url: string): Promise<number | undefined> {
	return new Promise((resolve) => {
		const video = document.createElement("video");
		video.preload = "metadata";
		video.muted = true;
		const cleanup = () => {
			video.removeEventListener("loadedmetadata", onLoaded);
			video.removeEventListener("error", onError);
		};
		const onLoaded = () => {
			const d = video.duration;
			cleanup();
			resolve(Number.isFinite(d) && d > 0 ? d : undefined);
		};
		const onError = () => {
			cleanup();
			resolve(undefined);
		};
		video.addEventListener("loadedmetadata", onLoaded);
		video.addEventListener("error", onError);
		video.src = url;
	});
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
	/** When provided, the on-thumb @handle tag becomes clickable and calls
	 *  back with that item's id — the caller inserts its handle into the
	 *  prompt (see generation-form.tsx). Omit to keep the tag a plain,
	 *  non-interactive label (existing callers unaffected). */
	onHandleClick?: (id: string) => void;
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
	onHandleClick,
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

			// Non-blocking: probe duration off the local blob so it's available
			// immediately, well before the upload round-trip finishes.
			if (kind === "video") {
				void probeVideoDuration(localUrl).then((durationSec) => {
					if (durationSec === undefined) return;
					applyChange(
						itemsRef.current.map((it) =>
							it.id === id ? { ...it, durationSec } : it,
						),
					);
				});
			}

			try {
				// Presigned direct-to-R2 when cloud storage is configured (large
				// videos never transit our server), buffered-through-server
				// fallback otherwise — see reference-upload.ts's module docstring.
				const { url } = await uploadReferenceFile(file);
				applyChange(
					itemsRef.current.map((it) =>
						it.id === id ? { ...it, url, status: "ready" } : it,
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
		<div className={cn("flex flex-wrap gap-2", className)}>
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

			{items.map((it) => (
				<div
					key={it.id}
					className={cn(
						"group relative h-20 w-[106px] shrink-0 overflow-hidden rounded-xl bg-foreground/[0.06]",
						it.status === "error" && "ring-1 ring-destructive",
					)}
					title={
						it.error
							? `${it.name}: ${it.error} — remove and re-add to retry`
							: it.name
					}
				>
					{isAssetRef(it.url) ? (
						// A verified `asset://` URI isn't browser-fetchable — show a
						// labeled badge instead of a broken <img>/<video>.
						<div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-foreground/[0.06] text-muted-foreground">
							<HugeiconsIcon
								icon={CheckmarkBadge01Icon}
								className="size-5 text-foreground/60"
							/>
							<span className="px-1 text-center text-[9px] font-medium leading-tight">
								Verified {it.kind}
							</span>
						</div>
					) : it.kind === "image" ? (
						// eslint-disable-next-line @next/next/no-img-element
						<img
							src={it.url}
							alt={it.name}
							className={cn(
								"h-full w-full object-cover",
								it.status === "uploading" && "opacity-60",
							)}
						/>
					) : (
						<video
							src={it.url}
							className={cn(
								"h-full w-full object-cover",
								it.status === "uploading" && "opacity-60",
							)}
							muted
							playsInline
						/>
					)}

					{it.status === "uploading" && (
						<div className="absolute inset-0 flex items-center justify-center">
							<Spinner className="size-4 text-white" />
						</div>
					)}

					{/* @mention handle — what you type in the prompt. Clickable when
					    `onHandleClick` is wired (video tab): inserts the handle into
					    the prompt directly from the thumb, no separate helper row. */}
					{handles?.[it.id] &&
						it.status === "ready" &&
						(onHandleClick ? (
							<button
								type="button"
								onClick={() => onHandleClick(it.id)}
								title={`Insert ${handles[it.id]} into the prompt`}
								className="absolute bottom-1 left-1 rounded bg-black/65 px-1 py-0.5 font-mono text-[9px] font-medium text-white transition-colors hover:bg-black/80"
							>
								{handles[it.id]}
							</button>
						) : (
							<span className="absolute bottom-1 left-1 rounded bg-black/65 px-1 py-0.5 font-mono text-[9px] font-medium text-white">
								{handles[it.id]}
							</span>
						))}

					<button
						type="button"
						onClick={() => remove(it.id)}
						className="absolute right-1.5 top-1.5 flex size-[18px] items-center justify-center rounded-full bg-black/70 text-white/80 opacity-0 transition-opacity group-hover:opacity-100"
						aria-label={`Remove ${it.name}`}
					>
						<HugeiconsIcon icon={Cancel01Icon} className="size-[11px]" />
					</button>
				</div>
			))}

			{!disabled && (
				<button
					type="button"
					onClick={() => inputRef.current?.click()}
					onDragOver={(e) => {
						e.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={handleDrop}
					title={
						imagesOnly
							? `Add reference images (${imageCount}/${MAX_OMNI_IMAGES})`
							: `Add reference media — up to ${MAX_OMNI_IMAGES} images (${imageCount}/${MAX_OMNI_IMAGES}) · ${MAX_OMNI_VIDEOS} videos (${videoCount}/${MAX_OMNI_VIDEOS})`
					}
					aria-label="Add reference media"
					className={cn(
						"flex h-20 w-[106px] shrink-0 items-center justify-center rounded-xl border-[1.5px] border-dashed transition-colors",
						dragging
							? "border-foreground/40 bg-foreground/[0.04]"
							: "border-foreground/[0.18] hover:border-foreground/30",
					)}
				>
					<HugeiconsIcon
						icon={ImageAdd02Icon}
						className="size-[17px] text-muted-foreground"
					/>
				</button>
			)}
		</div>
	);
}
