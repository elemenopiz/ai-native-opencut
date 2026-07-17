"use client";

import { useMemo, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/utils/ui";
import type { ImageSize, ImageQuality } from "@/lib/studio/image-generator";
import {
	IMAGE_PRESETS,
	IMAGE_PRESET_ORDER,
	STORYBOARD_PANEL_OPTIONS,
	type ImagePresetId,
} from "@/lib/studio/image-presets";
import { withIdentityLock } from "@/lib/studio/identity-lock";
import { ImageLightbox } from "@/components/studio/image-lightbox";
import { STUDIO_IMAGE_DND_TYPE, type StudioImageDrag } from "@/lib/studio/dnd";
import { clearDragData, setDragData } from "@/lib/drag-data";
import type { StudioTakeDragData } from "@/types/drag";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";
import { useEditor } from "@/hooks/use-editor";
import { EnhancePromptButton } from "@/components/editor/ai/enhance-prompt-button";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";
import { gateOn402 } from "@/lib/credits/client-gate";
import { apiFetch } from "@/lib/auth/unauthorized";
import { useCreditsStore } from "@/stores/credits-store";
import { useBackends } from "@/hooks/use-backends";
import { useBoardStore } from "@/stores/board-store";
import { DEFAULT_BACKEND_ID } from "@/lib/studio/backends/registry";
import { estimateImageCredits } from "@/lib/credits/estimate";
import {
	ReferenceMediaUploader,
	type ReferenceMediaItem,
} from "@/components/studio/reference-media-uploader";
import {
	ChipGrid,
	GenerationBottomBar,
	GenerationCard,
	SegmentedControl,
} from "@/components/studio/generation-bottom-bar";
import { toast } from "sonner";

/** The backend returns a handful of images per call; fan out for big batches. */
const BATCH_CHUNK = 4;
const BATCH_OPTIONS = [1, 4, 8, 16];

interface GeneratedStill {
	id: string;
	imageUrl: string;
}

interface ImagePanelProps {
	onSelectImage?: (url: string) => void;
	className?: string;
}

// Aspect ratios — the ImageSize wire values are unchanged. Full labels for the
// popover chip's tooltip; short ratio-only labels for the chip face itself
// (kept compact — the summary line on the bottom bar trigger repeats it).
const SIZES: { value: ImageSize; label: string; ratio: string }[] = [
	{ value: "1024x1024", label: "Square 1:1", ratio: "1:1" },
	{ value: "1536x1024", label: "Landscape 3:2", ratio: "3:2" },
	{ value: "1024x1536", label: "Portrait 2:3", ratio: "2:3" },
];

// Resolution — Nano Banana Pro renders at 1K/2K (4K exists but isn't exposed
// here for cost control). "low" is intentionally dropped from the picker: it
// maps to the same 1K tier as "medium", so showing it separately would just
// be a confusing duplicate of the 1K option.
const QUALITIES: { value: ImageQuality; label: string }[] = [
	{ value: "high", label: "2K" },
	{ value: "medium", label: "1K" },
];

export function ImagePanel({ onSelectImage, className }: ImagePanelProps) {
	// Sticky size/quality — last choice persists as the default.
	const {
		imageSize: size,
		imageQuality: quality,
		imageKeepFacePose,
		set: setSettings,
	} = useStudioSettingsStore();
	const editor = useEditor();
	const [presetId, setPresetId] = useState<ImagePresetId>("freeform");
	const [prompt, setPrompt] = useState("");
	const [n, setN] = useState(4);
	const [panels, setPanels] = useState(6);
	const [generating, setGenerating] = useState(false);
	const [progress, setProgress] = useState<{
		done: number;
		total: number;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [stills, setStills] = useState<GeneratedStill[]>([]);
	const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
	// Reference images — drag from Assets, drop, or browse. Only surfaced when
	// the selected backend actually conditions on a reference (identity carry /
	// omni blend); a text-only backend like Imagen never shows this row.
	const [refMedia, setRefMedia] = useState<ReferenceMediaItem[]>([]);

	const preset = IMAGE_PRESETS[presetId];

	// ── Backend-aware controls ────────────────────────────────────────────────
	// The catalog of configured image backends (Nano Banana Pro / GPT Image /
	// FLUX / Imagen / Ideogram / …), fetched the same way the video form does.
	const { backends } = useBackends("image");
	const [backendId, setBackendId] = useState<string>("");
	const selectedBackend = useMemo(() => {
		if (backends.length === 0) return undefined;
		return (
			backends.find((b) => b.id === backendId) ??
			backends.find((b) => b.id === DEFAULT_BACKEND_ID.image) ??
			backends[0]
		);
	}, [backends, backendId]);

	const availableSizes = useMemo(
		() =>
			selectedBackend?.sizes
				? SIZES.filter((s) => selectedBackend.sizes?.includes(s.value))
				: SIZES,
		[selectedBackend],
	);
	const availableQualities = useMemo(
		() =>
			selectedBackend?.qualities
				? QUALITIES.filter((q) => selectedBackend.qualities?.includes(q.value))
				: QUALITIES,
		[selectedBackend],
	);
	const showReferences =
		selectedBackend?.supportsReferenceEdits ||
		selectedBackend?.supportsOmniReference;
	const readyRefs = refMedia.filter(
		(r) => r.status === "ready" && r.kind === "image",
	);
	const refUploading = refMedia.some((r) => r.status === "uploading");

	// Live, backend-aware credits estimate for the batch about to run.
	const totalForCost = preset.allowsMultiple ? n : 1;
	const cost = estimateImageCredits(totalForCost, selectedBackend?.id);
	const modelLabel = selectedBackend?.label ?? "Auto";
	const settingsSummary = useMemo(() => {
		const ratio = SIZES.find((s) => s.value === size)?.ratio ?? size;
		const qualityLabel =
			QUALITIES.find((q) => q.value === quality)?.label ?? quality;
		const parts = [ratio, qualityLabel];
		if (preset.allowsMultiple && n > 1) parts.push(`×${n}`);
		return parts.join(" · ");
	}, [size, quality, preset.allowsMultiple, n]);

	// Push freshly generated stills into the project's Assets so they live
	// alongside uploaded media — taggable as "AI", draggable back into Generate
	// as a reference. Best-effort: the stills grid here still works regardless.
	// Returns per-item counts so callers (e.g. the Board-pin fallback below)
	// can tell how many actually landed. `silent` skips the built-in toast for
	// callers that want to compose their own message from the outcome instead.
	async function importStillsToAssets(
		images: GeneratedStill[],
		opts?: { silent?: boolean },
	): Promise<{ added: number; failed: number }> {
		if (images.length === 0) return { added: 0, failed: 0 };
		let projectId: string | null = null;
		try {
			projectId = editor.project.getActive().metadata.id;
		} catch {
			projectId = null;
		}
		if (!projectId) return { added: 0, failed: images.length };

		const baseName = prompt.trim().slice(0, 32) || "AI image";
		const { added, failed } = await addItemsToProjectMedia({
			editor,
			projectId,
			source: "ai",
			items: images.map((img, i) => ({
				url: img.imageUrl,
				name: images.length > 1 ? `${baseName} ${i + 1}` : baseName,
				kind: "image" as const,
			})),
		});
		if (added > 0 && !opts?.silent) {
			toast.success(`Added ${added} image${added === 1 ? "" : "s"} to Assets.`);
		}
		return { added, failed };
	}

	interface BoardImportResult {
		/** Landed in Board — the happy path, ready for the user to pick a winner. */
		boarded: number;
		/** Board pin failed but the (already-billed) image was saved to Assets
		 *  instead, so it's still retrievable. */
		fallenBack: number;
		/** Board pin AND the Assets fallback both failed — genuinely lost. */
		failed: number;
	}

	// Multi-image batches don't land in Assets automatically — they're parked
	// in Board so the user can star a winner (a lone image skips this and
	// keeps going straight to Assets, unchanged from before). A failed pin no
	// longer just throws and drops the paid image: it falls back to Assets so
	// it's saved *somewhere*. The caller composes its messaging from the
	// returned counts instead of assuming every image reached Board.
	async function importStillsToBoard(
		images: GeneratedStill[],
	): Promise<BoardImportResult> {
		const failedPins: GeneratedStill[] = [];
		await Promise.all(
			images.map(async (img) => {
				try {
					const res = await apiFetch("/api/studio/board", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ imageStillId: img.id }),
					});
					if (!res.ok) failedPins.push(img);
				} catch {
					failedPins.push(img);
				}
			}),
		);

		const boarded = images.length - failedPins.length;
		if (failedPins.length === 0) {
			return { boarded, fallenBack: 0, failed: 0 };
		}

		// Save the images whose Board pin failed to Assets instead of losing
		// them — one batched call so this only ever produces a single Assets
		// toast (silenced here; handleGenerate composes the combined message).
		const { added: fallenBack, failed } = await importStillsToAssets(
			failedPins,
			{ silent: true },
		);
		return { boarded, fallenBack, failed };
	}

	function selectPreset(id: ImagePresetId) {
		setPresetId(id);
		setSettings({ imageSize: IMAGE_PRESETS[id].recommendedSize });
	}

	async function handleGenerate() {
		if (!prompt.trim() || refUploading) return;
		setGenerating(true);
		setError(null);

		// Reference images (when the backend accepts them): first ready image as
		// the primary `referenceImageUrl` (single-reference backends read only
		// this), the rest as `referenceImages` (multi-reference backends blend
		// every url supplied). Same refs apply to every image in the batch.
		const refUrls = readyRefs.map((r) => r.url);
		const finalPrompt = withIdentityLock(
			preset.buildPrompt(prompt, { panels }),
			imageKeepFacePose && readyRefs.length > 0,
		);
		const total = preset.allowsMultiple ? n : 1;
		setProgress({ done: 0, total });

		const referenceImageUrl = refUrls[0];
		const referenceImages = refUrls.length > 1 ? refUrls.slice(1) : undefined;

		// Fan out into parallel chunks so big batches arrive progressively.
		const chunks: number[] = [];
		for (let remaining = total; remaining > 0; remaining -= BATCH_CHUNK) {
			chunks.push(Math.min(BATCH_CHUNK, remaining));
		}

		let received = 0;
		// Accumulated across chunks so the post-Promise.all messaging reflects
		// where the batch's images actually ended up, not just how many the
		// backend returned (see importStillsToBoard's per-image outcome).
		let boarded = 0;
		let fallenBack = 0;
		let boardFailed = 0;
		try {
			await Promise.all(
				chunks.map(async (chunkN) => {
					try {
						const res = await fetch("/api/studio/image", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								prompt: finalPrompt,
								size,
								quality,
								n: chunkN,
								referenceImageUrl,
								referenceImages,
								// Manual model pin, only once the catalog has resolved a
								// choice — omitted while loading so the server's default
								// routing is unaffected.
								model: selectedBackend?.id,
							}),
						});
						if (!res.ok) {
							// Insufficient credits (402) → open the "Out of credits" modal.
							if (await gateOn402(res)) {
								setError("Out of credits");
								return;
							}
							const data = (await res.json()) as { error?: string };
							throw new Error(data.error ?? "Image generation failed");
						}
						const data = (await res.json()) as { images: GeneratedStill[] };
						setStills((prev) => [...data.images, ...prev]);
						received += data.images.length;
						setProgress({ done: received, total });
						// Paid image settled server-side — refresh the header balance pill.
						void useCreditsStore.getState().refresh();
						// A lone image goes straight to Assets, as before. A batch (2+)
						// is held in Board instead — nothing is auto-saved until the
						// user stars a winner there, unless the pin itself fails, in
						// which case importStillsToBoard falls back to Assets so the
						// paid image is never just dropped.
						if (total === 1) {
							void importStillsToAssets(data.images);
						} else {
							const outcome = await importStillsToBoard(data.images);
							boarded += outcome.boarded;
							fallenBack += outcome.fallenBack;
							boardFailed += outcome.failed;
						}
					} catch (err) {
						setError(err instanceof Error ? err.message : "Generation failed");
					}
				}),
			);
			if (total > 1) {
				// Only point the user at Board for the images that actually made
				// it there — never claim a Board-ready count that includes
				// images that fell back to Assets or failed outright.
				if (boarded > 0) {
					toast.success(
						`${boarded} image${boarded === 1 ? "" : "s"} ready — pick your favorite`,
						{
							action: {
								label: "Open Board",
								onClick: () => useBoardStore.getState().setOpen(true),
							},
						},
					);
				}
				if (fallenBack > 0) {
					toast.success(
						`${fallenBack} image${fallenBack === 1 ? "" : "s"} saved to Assets — Board wasn't available`,
					);
				}
				// Genuinely unrecoverable only when BOTH the Board pin and the
				// Assets fallback failed for an image — surface that inline
				// rather than via a toast the user might miss.
				if (boardFailed > 0) {
					setError(
						`${boardFailed} image${boardFailed === 1 ? "" : "s"} failed to save — try generating again`,
					);
				}
			}
		} finally {
			setGenerating(false);
			setProgress(null);
		}
	}

	const submitLabel = generating
		? "Generating…"
		: presetId === "storyboard"
			? "Generate board"
			: presetId === "character-sheet"
				? "Generate sheet"
				: "Generate";

	const settingsContent = (
		<>
			{backends.length > 1 && (
				<ChipGrid
					label="Model"
					options={backends.map((b) => ({
						value: b.id,
						label: b.label,
						title: `${b.vendor} · ${b.safetyTier}`,
					}))}
					value={selectedBackend?.id ?? ""}
					onChange={setBackendId}
				/>
			)}

			<ChipGrid
				label="Aspect ratio"
				options={availableSizes.map((s) => ({
					value: s.value,
					label: s.ratio,
					title: s.label,
				}))}
				value={size}
				onChange={(v) => setSettings({ imageSize: v })}
			/>

			<div className="space-y-1.5">
				<span className="text-[13px] font-semibold text-foreground/70">
					Resolution
				</span>
				<SegmentedControl
					options={availableQualities.map((q) => ({
						value: q.value,
						label: q.label,
					}))}
					value={quality}
					onChange={(v) => setSettings({ imageQuality: v })}
				/>
			</div>

			{presetId === "storyboard" && (
				<ChipGrid
					label="Panels"
					options={STORYBOARD_PANEL_OPTIONS.map((count) => ({
						value: count,
						label: String(count),
					}))}
					value={panels}
					onChange={setPanels}
				/>
			)}
		</>
	);

	return (
		<div className={cn("flex flex-col gap-3", className)}>
			{/* Preset selector — same filled-chip tokens as the popover's ChipGrid. */}
			<div className="flex flex-wrap gap-[7px]">
				{IMAGE_PRESET_ORDER.map((id) => (
					<button
						key={id}
						type="button"
						onClick={() => selectPreset(id)}
						title={IMAGE_PRESETS[id].description}
						className={cn(
							"flex h-[30px] items-center justify-center rounded-[10px] px-3 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
							presetId === id
								? "bg-foreground/[0.16] font-semibold text-foreground"
								: "bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
						)}
					>
						{IMAGE_PRESETS[id].label}
					</button>
				))}
			</div>

			{/* References — reused verbatim from the video form's uploader, images
			    only. Hidden when the selected backend can't condition on one. */}
			{showReferences && (
				<div className="space-y-1.5">
					<div className="flex items-center justify-between gap-2">
						<span className="text-[13px] font-semibold text-foreground/70">
							References
						</span>
						<div className="flex items-center gap-2">
							{readyRefs.length > 0 && (
								<button
									type="button"
									aria-pressed={imageKeepFacePose}
									title="Keep the person's exact face and pose from the reference image — clothes, background, and setting still follow your prompt."
									onClick={() =>
										setSettings({ imageKeepFacePose: !imageKeepFacePose })
									}
									className={cn(
										"flex h-[26px] shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[11.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
										imageKeepFacePose
											? "bg-foreground/[0.16] font-semibold text-foreground"
											: "bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
									)}
								>
									<svg
										className="size-[11px] shrink-0"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth={2}
										aria-hidden="true"
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-.334-.02-.663-.062-.985z"
										/>
									</svg>
									Keep face & pose
								</button>
							)}
							<span className="text-[11.5px] text-muted-foreground">
								optional · drag, drop, or browse
							</span>
						</div>
					</div>
					<ReferenceMediaUploader
						items={refMedia}
						onChange={setRefMedia}
						accept="image"
						disabled={generating}
					/>
				</div>
			)}

			{/* One calm surface: Prompt, Variations, and the bottom bar share a
			    single hairline-divided card. The placeholder carries the
			    Prompt/Scene/Character meaning — no separate Label row. */}
			<GenerationCard>
				{/* Prompt + its tool row share one section (no hairline between them)
				    so Enhance reads as part of the composer, not a separate boxed
				    area. */}
				<div className="px-4 pb-3 pt-4">
					<Textarea
						placeholder={preset.placeholder}
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						rows={4}
						className="resize-none border-0 bg-transparent p-0 text-[14.5px] leading-relaxed shadow-none focus-visible:ring-0 min-h-24 dark:bg-transparent"
					/>
					{error && (
						<p className="pt-1 text-[11.5px] text-destructive">{error}</p>
					)}

					<div className="flex items-center gap-2 pt-1">
						<EnhancePromptButton
							mode="image"
							getPrompt={() => prompt}
							setPrompt={setPrompt}
							className="ml-auto"
						/>
					</div>
				</div>

				{preset.allowsMultiple && (
					<div className="px-4 py-3">
						<ChipGrid
							label="Variations"
							options={BATCH_OPTIONS.map((count) => ({
								value: count,
								label: String(count),
							}))}
							value={n}
							onChange={setN}
							hint="drag your pick to the board"
						/>
					</div>
				)}

				{generating && progress && (
					<div className="space-y-1.5 px-4 py-3">
						<div className="h-[3px] w-full overflow-hidden rounded-full bg-foreground/[0.12]">
							<div
								className="h-full rounded-full bg-zinc-900 transition-all duration-300 dark:bg-[#f2efe9]"
								style={{
									width: `${Math.round((progress.done / progress.total) * 100)}%`,
								}}
							/>
						</div>
						<p className="text-[11.5px] tabular-nums text-muted-foreground">
							Generating {progress.done}/{progress.total}…
						</p>
					</div>
				)}

				<GenerationBottomBar
					modelLabel={modelLabel}
					settingsSummary={settingsSummary}
					settingsContent={settingsContent}
					cost={cost}
					onSubmit={handleGenerate}
					submitDisabled={!prompt.trim() || generating || refUploading}
					busy={generating}
					submitLabel={submitLabel}
					testIdPrefix="image-gen"
				/>
			</GenerationCard>

			{/* Gallery — drag a tile to the visionboard, or click to scroll through */}
			{stills.length > 0 && (
				<div
					className={cn(
						"grid gap-2",
						preset.allowsMultiple ? "grid-cols-2" : "grid-cols-1",
					)}
				>
					{stills.map((still, i) => (
						<div
							key={still.id}
							draggable
							onDragStart={(e) => {
								const payload: StudioImageDrag = {
									kind: "image",
									imageStillId: still.id,
									imageUrl: still.imageUrl,
								};
								e.dataTransfer.setData(
									STUDIO_IMAGE_DND_TYPE,
									JSON.stringify(payload),
								);
								e.dataTransfer.effectAllowed = "copy";

								// Also carry a StudioTakeDragData payload — the app-wide drag
								// system the timeline and Assets tab already listen for — so
								// dropping a still there imports it into the project on demand.
								const baseName = prompt.trim().slice(0, 32) || "AI image";
								const dragData: StudioTakeDragData = {
									id: still.id,
									name: stills.length > 1 ? `${baseName} ${i + 1}` : baseName,
									type: "studio-take",
									url: still.imageUrl,
									kind: "image",
									takeId: still.id,
								};
								setDragData({ dataTransfer: e.dataTransfer, dragData });
							}}
							onDragEnd={() => clearDragData()}
							onClick={() => setLightboxIndex(i)}
							className="relative group rounded-xl overflow-hidden border bg-muted cursor-pointer"
						>
							<img
								src={still.imageUrl}
								alt={prompt}
								className={cn(
									"w-full pointer-events-none",
									preset.allowsMultiple
										? "aspect-video object-cover"
										: "object-contain",
								)}
							/>
							{onSelectImage && (
								<div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1">
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											onSelectImage(still.imageUrl);
										}}
										className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
									>
										Use as reference
									</button>
									<span className="text-[10px] text-white/70">
										click to expand · drag to board
									</span>
								</div>
							)}
						</div>
					))}
				</div>
			)}

			{lightboxIndex !== null && (
				<ImageLightbox
					stills={stills}
					index={lightboxIndex}
					onIndexChange={setLightboxIndex}
					onClose={() => setLightboxIndex(null)}
					onUseAsReference={onSelectImage}
				/>
			)}
		</div>
	);
}
