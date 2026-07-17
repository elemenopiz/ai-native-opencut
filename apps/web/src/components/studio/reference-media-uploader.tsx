"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Cancel01Icon,
	CheckmarkBadge01Icon,
	ImageAdd02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { getDragData } from "@/lib/drag-data";
import { isAssetRef, normalizeAssetUri } from "@/lib/studio/asset-ref";
import { uploadReferenceFile } from "@/lib/studio/reference-upload";
import type { SavedVerifiedAsset } from "@/lib/studio/saved-verified-assets";

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
	/** Enables the "Add verified asset" control: paste a BytePlus
	 *  `asset://<asset_id>` URI to reference a consent-verified real-human
	 *  likeness. Opt-in (default off) so only the Seedance omni-reference
	 *  surface offers it; existing callers are unaffected. */
	allowVerifiedAsset?: boolean;
	/** The owner's saved verified assets, shown as one-click quick-picks in the
	 *  add dialog (BytePlus has no list API, so the owner pastes each once and
	 *  the parent persists it). Only meaningful with `allowVerifiedAsset`. */
	savedAssets?: SavedVerifiedAsset[];
	/** Persist a newly-pasted verified asset to the owner's shortlist. */
	onSaveAsset?: (asset: Omit<SavedVerifiedAsset, "id">) => void;
	/** Drop a saved verified asset from the owner's shortlist. */
	onRemoveSavedAsset?: (id: string) => void;
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
	allowVerifiedAsset = false,
	savedAssets,
	onSaveAsset,
	onRemoveSavedAsset,
}: ReferenceMediaUploaderProps) {
	const imagesOnly = accept === "image";
	const editor = useEditor();
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const [assetDialogOpen, setAssetDialogOpen] = useState(false);
	const [assetUri, setAssetUri] = useState("");
	const [assetLabel, setAssetLabel] = useState("");
	// Deliberately unselected until the user picks: a BytePlus asset id is
	// opaque (nothing says image vs video), and the kind decides whether the
	// URI is sent as reference_image or reference_video — a silent "image"
	// default mislabeled real video assets.
	const [assetKind, setAssetKind] = useState<"image" | "video" | null>(null);

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

	// Attach a verified real-human asset by its BytePlus URI. Unlike a file, an
	// `asset://` reference is already the value the provider wants, so it skips
	// upload/normalize entirely and lands in the list as a ready item. Returns
	// false (with a toast) when the per-kind cap is hit, so callers can bail.
	const addAssetItem = useCallback(
		(uri: string, kind: "image" | "video", label?: string): boolean => {
			if (capReached(kind)) {
				toast.error(
					kind === "video"
						? `Max ${MAX_OMNI_VIDEOS} reference videos`
						: `Max ${MAX_OMNI_IMAGES} reference images`,
				);
				return false;
			}
			applyChange([
				...itemsRef.current,
				{
					id: crypto.randomUUID(),
					url: uri,
					kind,
					name: label?.trim() || `Verified ${kind}`,
					status: "ready",
				},
			]);
			return true;
		},
		[applyChange, capReached],
	);

	// Dialog "Add reference" — validate the pasted URI, attach it, and persist
	// it to the owner's shortlist for one-click reuse next time.
	const addFromDialog = useCallback(() => {
		const uri = normalizeAssetUri(assetUri);
		if (!uri) {
			toast.error("Enter a BytePlus asset URI, e.g. asset://asset-….");
			return;
		}
		if (!assetKind) {
			toast.error(
				"Pick Portrait image or Video — the type can't be read from the asset id.",
			);
			return;
		}
		const label = assetLabel.trim();
		if (!addAssetItem(uri, assetKind, label)) return;
		// Raw (possibly empty) label — the store fills in a fallback and, on a
		// re-paste of a known URI, updates the saved kind instead of no-op'ing.
		onSaveAsset?.({ uri, kind: assetKind, label });
		setAssetUri("");
		setAssetLabel("");
		setAssetDialogOpen(false);
	}, [assetUri, assetLabel, assetKind, addAssetItem, onSaveAsset]);

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

			{!disabled && allowVerifiedAsset && (
				<>
					<button
						type="button"
						onClick={() => setAssetDialogOpen(true)}
						title="Add a verified real-human asset by its BytePlus asset:// URI"
						aria-label="Add verified real-human asset"
						className="flex h-20 w-[106px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-[1.5px] border-dashed border-foreground/[0.18] text-muted-foreground transition-colors hover:border-foreground/30"
					>
						<HugeiconsIcon
							icon={CheckmarkBadge01Icon}
							className="size-[17px]"
						/>
						<span className="text-[9px] font-medium">Verified ID</span>
					</button>

					<Dialog
						open={assetDialogOpen}
						onOpenChange={(open) => {
							setAssetDialogOpen(open);
							// Every add starts with the type unselected — carrying the
							// previous choice over is how a video got saved as "image".
							if (!open) setAssetKind(null);
						}}
					>
						<DialogContent className="sm:max-w-md">
							<DialogHeader>
								<DialogTitle>Add a verified real-human asset</DialogTitle>
								<DialogDescription>
									Paste a BytePlus asset URI from ModelArk → My assets →
									Real-human. It's sent to Seedance as a consent-verified
									reference, so a real face isn't blocked.
								</DialogDescription>
							</DialogHeader>
							<div className="space-y-3 py-1">
								{savedAssets && savedAssets.length > 0 && (
									<div className="space-y-1.5">
										<span className="text-[11px] font-medium text-muted-foreground">
											Your verified assets — click to add
										</span>
										<div className="flex flex-col gap-1">
											{savedAssets.map((a) => (
												<div
													key={a.id}
													className="flex items-center gap-1 rounded-md border border-border px-2 py-1"
												>
													<button
														type="button"
														onClick={() => {
															if (addAssetItem(a.uri, a.kind, a.label))
																setAssetDialogOpen(false);
														}}
														title={a.uri}
														className="flex min-w-0 flex-1 items-center gap-2 text-left"
													>
														<HugeiconsIcon
															icon={CheckmarkBadge01Icon}
															className="size-3.5 shrink-0 text-foreground/50"
														/>
														<span className="truncate text-[12px] font-medium">
															{a.label}
														</span>
														<span className="shrink-0 text-[10px] text-muted-foreground">
															{a.kind}
														</span>
													</button>
													{onRemoveSavedAsset && (
														<button
															type="button"
															onClick={() => onRemoveSavedAsset(a.id)}
															aria-label={`Forget ${a.label}`}
															className="shrink-0 text-muted-foreground hover:text-foreground"
														>
															<HugeiconsIcon
																icon={Cancel01Icon}
																className="size-3"
															/>
														</button>
													)}
												</div>
											))}
										</div>
										<span className="text-[11px] text-muted-foreground">
											Or add a new one:
										</span>
									</div>
								)}
								<Input
									value={assetUri}
									onChange={(e) => setAssetUri(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											addFromDialog();
										}
									}}
									placeholder="asset://asset-20260715220651-2f74b"
								/>
								<Input
									value={assetLabel}
									onChange={(e) => setAssetLabel(e.target.value)}
									placeholder="Label (optional) — e.g. Zak front"
								/>
								<div className="flex gap-2">
									{(["image", "video"] as const).map((k) => (
										<button
											key={k}
											type="button"
											onClick={() => setAssetKind(k)}
											className={cn(
												"rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
												assetKind === k
													? "border-foreground/40 bg-foreground/[0.06] text-foreground"
													: "border-border text-muted-foreground hover:text-foreground",
											)}
										>
											{k === "image" ? "Portrait image" : "Video"}
										</button>
									))}
								</div>
							</div>
							<DialogFooter>
								<DialogClose asChild>
									<Button variant="ghost">Cancel</Button>
								</DialogClose>
								<Button onClick={addFromDialog}>Add reference</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>
				</>
			)}
		</div>
	);
}
