"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/utils/ui";
import { usePersonaStore } from "@/stores/persona-store";
import { uploadReferenceFile } from "@/lib/studio/reference-upload";

interface PersonaManagerProps {
	className?: string;
}

// Soul-ID-style multi-photo intake: gate for resolution client-side, upload
// concurrently, let the user pick a primary anchor from the batch, and turn
// everything else into refImageUrls[] for the reference-still renderer (routed
// across image providers — all read persona.anchorImageUrl + refImageUrls).
const MIN_PHOTO_DIMENSION = 960;
const MAX_PHOTOS = 80;
const RECOMMENDED_PHOTOS = 20;
const MAX_CONCURRENT_UPLOADS = 4;

interface UploadedPhoto {
	id: string;
	file: File;
	previewUrl: string;
	remoteUrl?: string;
	width: number;
	height: number;
	status: "uploading" | "ready" | "error";
	error?: string;
}

/** Decode a file's pixel dimensions without ever attaching it to the DOM. */
async function readImageDimensions(
	file: File,
): Promise<{ width: number; height: number }> {
	if (typeof createImageBitmap === "function") {
		try {
			const bitmap = await createImageBitmap(file);
			const dims = { width: bitmap.width, height: bitmap.height };
			bitmap.close();
			return dims;
		} catch {
			// Some formats (e.g. HEIC in some browsers) reject createImageBitmap —
			// fall back to <img> decoding below.
		}
	}
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
			URL.revokeObjectURL(url);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Could not read image"));
		};
		img.src = url;
	});
}

export function PersonaManager({ className }: PersonaManagerProps) {
	const { personas, activePersonaId, load, create, remove, setActive } =
		usePersonaStore();

	const [name, setName] = useState("");
	const [descriptor, setDescriptor] = useState("");
	const [seed, setSeed] = useState("");
	const [anchorUrl, setAnchorUrl] = useState("");
	const [candidates, setCandidates] = useState<string[]>([]);
	const [generating, setGenerating] = useState(false);
	const [saving, setSaving] = useState(false);

	const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
	const photosRef = useRef<UploadedPhoto[]>([]);
	photosRef.current = photos;
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		void load();
	}, [load]);

	const canSave = Boolean(name.trim() && descriptor.trim() && anchorUrl.trim());
	const readyPhotos = photos.filter((p) => p.status === "ready" && p.remoteUrl);
	const uploadingCount = photos.filter((p) => p.status === "uploading").length;

	// Generated-first: turn the descriptor into a few front-facing portrait
	// candidates; the user clicks one to lock it in as the anchor. Photo upload
	// (below) is an additional source of the same anchorImageUrl field, not a
	// replacement — a persona can be created from either or both.
	async function generatePortraits() {
		if (!descriptor.trim()) {
			toast.error("Describe the character first.");
			return;
		}
		setGenerating(true);
		try {
			const res = await fetch("/api/studio/image", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: `A photorealistic front-facing portrait headshot of ${descriptor.trim()}. Neutral background, soft even studio lighting, sharp focus, looking directly at camera.`,
					size: "1024x1024",
					quality: "high",
					n: 4,
				}),
			});
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "Generation failed");
			}
			const data = (await res.json()) as {
				images: Array<{ imageUrl: string }>;
			};
			setCandidates(data.images.map((i) => i.imageUrl));
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Could not generate portraits.",
			);
		} finally {
			setGenerating(false);
		}
	}

	// Gate a freshly-picked batch of files: image type + min resolution + the
	// 80-photo cap. Accepted files get an optimistic "uploading" entry right
	// away; rejects are surfaced in one toast so a big batch doesn't spam.
	async function addPhotos(fileList: FileList | null) {
		if (!fileList || fileList.length === 0) return;
		const incoming = Array.from(fileList);
		const roomLeft = MAX_PHOTOS - photosRef.current.length;

		if (roomLeft <= 0) {
			toast.error(
				`Already at the ${MAX_PHOTOS}-photo cap. Remove some before adding more.`,
			);
			return;
		}

		const accepted: { file: File; width: number; height: number }[] = [];
		const skipped: string[] = [];

		for (const file of incoming) {
			if (accepted.length >= roomLeft) {
				skipped.push(`${file.name} (cap of ${MAX_PHOTOS} reached)`);
				continue;
			}
			if (!file.type.startsWith("image/")) {
				skipped.push(`${file.name} (not an image)`);
				continue;
			}
			try {
				const { width, height } = await readImageDimensions(file);
				if (Math.min(width, height) < MIN_PHOTO_DIMENSION) {
					skipped.push(
						`${file.name} (${width}×${height}, need ≥${MIN_PHOTO_DIMENSION}px)`,
					);
					continue;
				}
				accepted.push({ file, width, height });
			} catch {
				skipped.push(`${file.name} (couldn't read image)`);
			}
		}

		if (skipped.length > 0) {
			const preview = skipped.slice(0, 4).join("; ");
			const extra = skipped.length > 4 ? ` +${skipped.length - 4} more` : "";
			toast.error(
				`Skipped ${skipped.length} photo${skipped.length === 1 ? "" : "s"}: ${preview}${extra}`,
			);
		}

		if (accepted.length === 0) return;

		const newPhotos: UploadedPhoto[] = accepted.map(
			({ file, width, height }) => ({
				id: crypto.randomUUID(),
				file,
				previewUrl: URL.createObjectURL(file),
				width,
				height,
				status: "uploading",
			}),
		);

		setPhotos((prev) => [...prev, ...newPhotos]);
		void uploadPhotosWithPool(newPhotos);
	}

	// Small worker pool so a 20-80 photo batch doesn't fire unbounded parallel
	// requests, and a single failed upload doesn't stall or drop the rest.
	async function uploadPhotosWithPool(items: UploadedPhoto[]) {
		let index = 0;
		async function worker() {
			while (index < items.length) {
				const item = items[index++];
				try {
					const { url } = await uploadReferenceFile(item.file);
					setPhotos((prev) =>
						prev.map((p) =>
							p.id === item.id ? { ...p, remoteUrl: url, status: "ready" } : p,
						),
					);
					// First successfully uploaded photo becomes the anchor by default
					// if nothing has been picked yet (generated or manual).
					setAnchorUrl((prev) => (prev.trim() ? prev : url));
				} catch (err) {
					const message = err instanceof Error ? err.message : "Upload failed";
					setPhotos((prev) =>
						prev.map((p) =>
							p.id === item.id ? { ...p, status: "error", error: message } : p,
						),
					);
				}
			}
		}
		const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, items.length);
		await Promise.all(Array.from({ length: workerCount }, () => worker()));
	}

	function removePhoto(id: string) {
		const photo = photosRef.current.find((p) => p.id === id);
		if (photo) {
			URL.revokeObjectURL(photo.previewUrl);
			if (photo.remoteUrl && photo.remoteUrl === anchorUrl) {
				setAnchorUrl("");
			}
		}
		setPhotos((prev) => prev.filter((p) => p.id !== id));
	}

	async function handleSave() {
		if (!canSave) return;
		setSaving(true);
		try {
			// Every ready upload other than the chosen anchor rides along as a
			// reference photo — these are the "many real photos" that sharpen
			// likeness beyond the single anchor still.
			const refImageUrls = readyPhotos
				.filter((p) => p.remoteUrl !== anchorUrl.trim())
				.map((p) => p.remoteUrl as string);

			const persona = await create({
				name: name.trim(),
				descriptor: descriptor.trim(),
				anchorImageUrl: anchorUrl.trim(),
				refImageUrls: refImageUrls.length ? refImageUrls : undefined,
				seed: seed ? Number.parseInt(seed, 10) : undefined,
			});
			if (persona) {
				setActive(persona.id);
				toast.success(`Persona “${persona.name}” saved and selected.`);
				setName("");
				setDescriptor("");
				setSeed("");
				setAnchorUrl("");
				setCandidates([]);
				for (const p of photosRef.current) URL.revokeObjectURL(p.previewUrl);
				setPhotos([]);
			} else {
				toast.error("Could not save persona.");
			}
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className={cn("flex flex-col gap-4", className)}>
			<div className="space-y-1">
				<h3 className="text-sm font-medium">Personas</h3>
				<p className="text-xs text-muted-foreground">
					Reusable characters. Pick one before generating to keep the same face
					across every shot.
				</p>
			</div>

			{/* Existing personas — click to select/deselect, × to delete */}
			{personas.length > 0 && (
				<div className="grid grid-cols-3 gap-2">
					{personas.map((p) => {
						const active = p.id === activePersonaId;
						return (
							<div key={p.id} className="relative group">
								<button
									onClick={() => setActive(active ? null : p.id)}
									className={cn(
										"w-full rounded-md overflow-hidden border-2 transition-colors",
										active
											? "border-primary"
											: "border-transparent hover:border-border",
									)}
									title={p.descriptor}
								>
									<img
										src={p.anchorImageUrl}
										alt={p.name}
										className="aspect-square w-full object-cover"
									/>
									<span className="block truncate px-1 py-0.5 text-[10px] text-center">
										{p.name}
									</span>
								</button>
								<button
									onClick={() => void remove(p.id)}
									className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-black/60 text-white text-[10px] leading-none opacity-0 group-hover:opacity-100 transition-opacity"
									title="Delete persona"
								>
									×
								</button>
							</div>
						);
					})}
				</div>
			)}

			<div className="h-px bg-border" />

			{/* Create a persona */}
			<div className="space-y-3">
				<p className="text-xs font-medium text-muted-foreground">New persona</p>

				<div className="space-y-1.5">
					<Label className="text-xs">Name</Label>
					<Input
						placeholder="e.g. Nova"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="h-8 text-xs"
					/>
				</div>

				<div className="space-y-1.5">
					<Label className="text-xs">Identity descriptor</Label>
					<Textarea
						placeholder="A woman in her 30s, short silver hair, scar on left cheek, green eyes, worn orange flight jacket…"
						value={descriptor}
						onChange={(e) => setDescriptor(e.target.value)}
						rows={3}
						className="resize-none text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						Locked and woven into every shot for consistency.
					</p>
				</div>

				{/* Anchor image */}
				<div className="space-y-1.5">
					<Label className="text-xs">Anchor image</Label>
					{anchorUrl ? (
						<div className="flex items-start gap-2">
							<img
								src={anchorUrl}
								alt="Anchor"
								className="h-20 w-20 rounded object-cover border"
							/>
							<button
								onClick={() => setAnchorUrl("")}
								className="text-xs text-muted-foreground underline"
							>
								Change
							</button>
						</div>
					) : (
						<>
							<Button
								size="sm"
								variant="outline"
								className="w-full text-xs"
								disabled={!descriptor.trim() || generating}
								onClick={generatePortraits}
							>
								{generating ? "Generating portraits…" : "Generate portraits"}
							</Button>
							{candidates.length > 0 && (
								<div className="grid grid-cols-4 gap-1.5">
									{candidates.map((url) => (
										<button
											key={url}
											onClick={() => setAnchorUrl(url)}
											className="rounded overflow-hidden border hover:border-primary"
											title="Use as anchor"
										>
											<img
												src={url}
												alt="Candidate"
												className="aspect-square w-full object-cover"
											/>
										</button>
									))}
								</div>
							)}
							<Input
								placeholder="…or paste an image URL"
								value={anchorUrl}
								onChange={(e) => setAnchorUrl(e.target.value)}
								className="h-8 text-xs"
							/>
						</>
					)}
				</div>

				{/* Reference photos — Soul-ID-style multi-photo intake. Independent of
				    the anchor source above: uploads here can both supply the anchor
				    (if none is set yet) and ride along as refImageUrls[]. */}
				<div className="space-y-1.5">
					<Label className="text-xs">Reference photos</Label>
					<p className="text-xs text-muted-foreground">
						20+ clear, well-lit photos, varied angles &amp; expressions, ≥
						{MIN_PHOTO_DIMENSION}px, recent — more photos → stronger likeness.
					</p>

					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						multiple
						className="hidden"
						onChange={(e) => {
							void addPhotos(e.target.files);
							e.target.value = "";
						}}
					/>
					<Button
						size="sm"
						variant="outline"
						className="w-full text-xs"
						disabled={photos.length >= MAX_PHOTOS}
						onClick={() => fileInputRef.current?.click()}
					>
						Upload photos
					</Button>

					{photos.length > 0 && (
						<>
							<p className="text-[10px] text-muted-foreground">
								{readyPhotos.length} ready
								{uploadingCount > 0 ? ` · ${uploadingCount} uploading` : ""}
								{readyPhotos.length > 0 &&
								readyPhotos.length < RECOMMENDED_PHOTOS
									? ` · ${RECOMMENDED_PHOTOS}+ recommended for best likeness`
									: ""}
							</p>
							<div className="grid grid-cols-4 gap-1.5">
								{photos.map((photo) => {
									const isPrimary =
										photo.status === "ready" && photo.remoteUrl === anchorUrl;
									return (
										<div
											key={photo.id}
											className={cn(
												"group relative aspect-square overflow-hidden rounded border bg-muted",
												photo.status === "error" && "border-destructive",
												isPrimary && "border-primary",
											)}
											title={
												photo.status === "error"
													? photo.error
													: `${photo.width}×${photo.height}`
											}
										>
											<img
												src={photo.previewUrl}
												alt=""
												className="h-full w-full object-cover"
											/>

											{photo.status === "uploading" && (
												<div className="absolute inset-0 flex items-center justify-center bg-black/40">
													<span className="text-[9px] text-white">
														Uploading…
													</span>
												</div>
											)}
											{photo.status === "error" && (
												<div className="absolute inset-0 flex items-center justify-center bg-destructive/40 px-1 text-center">
													<span className="text-[9px] text-white">Failed</span>
												</div>
											)}

											{isPrimary && (
												<span className="absolute left-0.5 top-0.5 rounded bg-primary px-1 text-[8px] font-medium uppercase text-primary-foreground">
													Primary
												</span>
											)}
											{photo.status === "ready" && !isPrimary && (
												<button
													type="button"
													onClick={() =>
														setAnchorUrl(photo.remoteUrl as string)
													}
													className="absolute inset-x-0 bottom-0 hidden bg-black/70 py-0.5 text-center text-[8px] text-white group-hover:block"
												>
													Make primary
												</button>
											)}

											<button
												type="button"
												onClick={() => removePhoto(photo.id)}
												className="absolute top-0.5 right-0.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[10px] leading-none text-white group-hover:flex"
												aria-label="Remove photo"
											>
												×
											</button>
										</div>
									);
								})}
							</div>
						</>
					)}
				</div>

				<div className="space-y-1.5">
					<Label className="text-xs">Locked seed (optional)</Label>
					<Input
						type="number"
						placeholder="Extra cross-shot stability"
						value={seed}
						onChange={(e) => setSeed(e.target.value)}
						className="h-8 text-xs"
					/>
				</div>

				<Button
					size="sm"
					className="w-full"
					disabled={!canSave || saving}
					onClick={handleSave}
				>
					{saving ? "Saving…" : "Save persona"}
				</Button>
			</div>
		</div>
	);
}
