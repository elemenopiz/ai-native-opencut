"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/utils/ui";
import type { ImageSize, ImageQuality } from "@/lib/studio/image-generator";
import {
	IMAGE_PRESETS,
	IMAGE_PRESET_ORDER,
	STORYBOARD_PANEL_OPTIONS,
	type ImagePresetId,
} from "@/lib/studio/image-presets";
import { ImageLightbox } from "@/components/studio/image-lightbox";
import { STUDIO_IMAGE_DND_TYPE, type StudioImageDrag } from "@/lib/studio/dnd";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";
import { useEditor } from "@/hooks/use-editor";
import { EnhancePromptButton } from "@/components/editor/ai/enhance-prompt-button";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";
import { gateOn402 } from "@/lib/credits/client-gate";
import { useCreditsStore } from "@/stores/credits-store";
import { toast } from "sonner";

/** OpenAI returns up to a handful per call; fan out for big batches. */
const BATCH_CHUNK = 4;
const BATCH_OPTIONS = [1, 4, 8, 16];

interface GeneratedStill {
	id: string;
	imageUrl: string;
	revisedPrompt?: string;
}

interface ImagePanelProps {
	onSelectImage?: (url: string) => void;
	className?: string;
}

const SIZES: { value: ImageSize; label: string }[] = [
	{ value: "1024x1024", label: "1:1 Square" },
	{ value: "1536x1024", label: "3:2 Landscape" },
	{ value: "1024x1536", label: "2:3 Portrait" },
];

const QUALITIES: { value: ImageQuality; label: string }[] = [
	{ value: "high", label: "High" },
	{ value: "medium", label: "Medium" },
	{ value: "low", label: "Low (draft)" },
];

export function ImagePanel({ onSelectImage, className }: ImagePanelProps) {
	// Sticky size/quality — last choice persists as the default.
	const {
		imageSize: size,
		imageQuality: quality,
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

	const preset = IMAGE_PRESETS[presetId];

	// Push freshly generated stills into the project's Assets so they live
	// alongside uploaded media — taggable as "AI", draggable back into Generate
	// as a reference. Best-effort: the stills grid here still works regardless.
	async function importStillsToAssets(images: GeneratedStill[]) {
		if (images.length === 0) return;
		let projectId: string | null = null;
		try {
			projectId = editor.project.getActive().metadata.id;
		} catch {
			projectId = null;
		}
		if (!projectId) return;

		const baseName = prompt.trim().slice(0, 32) || "AI image";
		const { added } = await addItemsToProjectMedia({
			editor,
			projectId,
			source: "ai",
			items: images.map((img, i) => ({
				url: img.imageUrl,
				name: images.length > 1 ? `${baseName} ${i + 1}` : baseName,
				kind: "image" as const,
			})),
		});
		if (added > 0) {
			toast.success(`Added ${added} image${added === 1 ? "" : "s"} to Assets.`);
		}
	}

	function selectPreset(id: ImagePresetId) {
		setPresetId(id);
		setSettings({ imageSize: IMAGE_PRESETS[id].recommendedSize });
	}

	async function handleGenerate() {
		if (!prompt.trim()) return;
		setGenerating(true);
		setError(null);

		const finalPrompt = preset.buildPrompt(prompt, { panels });
		const total = preset.allowsMultiple ? n : 1;
		setProgress({ done: 0, total });

		// Fan out into parallel chunks so big batches arrive progressively.
		const chunks: number[] = [];
		for (let remaining = total; remaining > 0; remaining -= BATCH_CHUNK) {
			chunks.push(Math.min(BATCH_CHUNK, remaining));
		}

		let received = 0;
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
						// Drop them into Assets as they arrive (fire-and-forget).
						void importStillsToAssets(data.images);
					} catch (err) {
						setError(err instanceof Error ? err.message : "Generation failed");
					}
				}),
			);
		} finally {
			setGenerating(false);
			setProgress(null);
		}
	}

	return (
		<div className={cn("flex flex-col gap-4", className)}>
			<div className="space-y-1">
				<h3 className="text-sm font-medium">Image generation</h3>
				<p className="text-xs text-muted-foreground">{preset.description}</p>
			</div>

			{/* Preset selector */}
			<div className="flex gap-2">
				{IMAGE_PRESET_ORDER.map((id) => (
					<button
						key={id}
						onClick={() => selectPreset(id)}
						className={cn(
							"flex-1 px-2 py-1.5 rounded-md text-xs font-medium border transition-colors",
							presetId === id
								? "bg-primary text-primary-foreground border-primary"
								: "border-border text-muted-foreground hover:border-foreground",
						)}
					>
						{IMAGE_PRESETS[id].label}
					</button>
				))}
			</div>

			<div className="space-y-1.5">
				<div className="flex items-center justify-between">
					<Label className="text-xs">
						{presetId === "storyboard"
							? "Scene"
							: presetId === "character-sheet"
								? "Character"
								: "Prompt"}
					</Label>
					<EnhancePromptButton
						mode="image"
						getPrompt={() => prompt}
						setPrompt={setPrompt}
					/>
				</div>
				<Textarea
					placeholder={preset.placeholder}
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					rows={3}
					className="resize-none text-sm"
				/>
			</div>

			{/* Storyboard: panel count */}
			{presetId === "storyboard" && (
				<div className="space-y-1.5">
					<Label className="text-xs">Panels</Label>
					<div className="flex gap-2">
						{STORYBOARD_PANEL_OPTIONS.map((count) => (
							<button
								key={count}
								onClick={() => setPanels(count)}
								className={cn(
									"flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors",
									panels === count
										? "bg-primary text-primary-foreground border-primary"
										: "border-border text-muted-foreground hover:border-foreground",
								)}
							>
								{count}
							</button>
						))}
					</div>
				</div>
			)}

			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-1.5">
					<Label className="text-xs">Size</Label>
					<Select
						value={size}
						onValueChange={(v) => setSettings({ imageSize: v as ImageSize })}
					>
						<SelectTrigger className="h-8 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{SIZES.map((s) => (
								<SelectItem key={s.value} value={s.value} className="text-xs">
									{s.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-1.5">
					<Label className="text-xs">Quality</Label>
					<Select
						value={quality}
						onValueChange={(v) =>
							setSettings({ imageQuality: v as ImageQuality })
						}
					>
						<SelectTrigger className="h-8 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{QUALITIES.map((q) => (
								<SelectItem key={q.value} value={q.value} className="text-xs">
									{q.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{preset.allowsMultiple && (
				<div className="space-y-1.5">
					<Label className="text-xs">Variations</Label>
					<div className="flex gap-1">
						{BATCH_OPTIONS.map((count) => (
							<button
								key={count}
								onClick={() => setN(count)}
								className={cn(
									"flex-1 h-8 rounded text-xs border transition-colors",
									n === count
										? "bg-primary text-primary-foreground border-primary"
										: "border-border text-muted-foreground hover:border-foreground",
								)}
							>
								{count}
							</button>
						))}
					</div>
					<p className="text-xs text-muted-foreground">
						Generate a batch, then scroll through and drag your pick to the
						visionboard.
					</p>
				</div>
			)}

			<div className="flex items-center gap-3">
				{generating && progress && (
					<span className="text-xs text-muted-foreground">
						{progress.done}/{progress.total}
					</span>
				)}
				<Button
					className="ml-auto"
					size="sm"
					disabled={!prompt.trim() || generating}
					onClick={handleGenerate}
				>
					{generating
						? "Generating…"
						: presetId === "storyboard"
							? "Generate board"
							: presetId === "character-sheet"
								? "Generate sheet"
								: "Generate"}
				</Button>
			</div>

			{error && <p className="text-xs text-destructive">{error}</p>}

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
							}}
							onClick={() => setLightboxIndex(i)}
							className="relative group rounded overflow-hidden border bg-muted cursor-pointer"
						>
							<img
								src={still.imageUrl}
								alt={still.revisedPrompt ?? prompt}
								className={cn(
									"w-full pointer-events-none",
									preset.allowsMultiple
										? "aspect-video object-cover"
										: "object-contain",
								)}
							/>
							{onSelectImage && (
								<div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1">
									<Button
										size="sm"
										className="text-xs h-7"
										onClick={(e) => {
											e.stopPropagation();
											onSelectImage(still.imageUrl);
										}}
									>
										Use as reference
									</Button>
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
