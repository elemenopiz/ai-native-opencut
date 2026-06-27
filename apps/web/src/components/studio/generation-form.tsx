"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/utils/ui";
import type {
	VideoResolution,
	VideoOrientation,
	VideoMode,
} from "@/lib/studio/provider-adapter";
import { CameraPresetPicker } from "@/components/studio/camera-preset-picker";
import { composePromptWithCamera } from "@/lib/studio/camera-presets";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";

interface GenerationFormProps {
	onGenerate: (params: {
		prompt: string;
		referenceImageUrl?: string;
		seed?: number;
		resolution: VideoResolution;
		orientation: VideoOrientation;
		duration: number;
		mode: VideoMode;
	}) => void;
	onImageGenerate?: (prompt: string) => void;
	busy?: boolean;
	className?: string;
}

const RESOLUTIONS: { value: VideoResolution; label: string; hint: string }[] = [
	{ value: "480p", label: "480p", hint: "~$0.03–0.05/sec · fastest drafting" },
	{ value: "720p", label: "720p", hint: "~$0.07–0.10/sec · normal drafting" },
	{ value: "1080p", label: "1080p", hint: "~$0.23–0.37/sec · locked-seed finals only" },
];

const ORIENTATIONS: { value: VideoOrientation; label: string; ratio: string }[] = [
	{ value: "portrait", label: "Portrait", ratio: "9:16" },
	{ value: "landscape", label: "Landscape", ratio: "16:9" },
	{ value: "square", label: "Square", ratio: "1:1" },
];

const MODES: { value: VideoMode; label: string }[] = [
	{ value: "text-to-video", label: "Text → Video" },
	{ value: "image-to-video", label: "Image → Video" },
];

/** Small frame glyph so orientation reads at a glance. */
function OrientationGlyph({ value }: { value: VideoOrientation }) {
	const dims =
		value === "portrait"
			? { w: 10, h: 16 }
			: value === "square"
			? { w: 14, h: 14 }
			: { w: 16, h: 10 };
	return (
		<span
			className="rounded-[2px] border-2 border-current"
			style={{ width: dims.w, height: dims.h }}
		/>
	);
}

export function GenerationForm({
	onGenerate,
	onImageGenerate,
	busy,
	className,
}: GenerationFormProps) {
	// Sticky settings — last choice becomes the default next time.
	const {
		mode,
		orientation,
		resolution,
		duration,
		cameraPreset,
		seedLocked,
		set: setSettings,
	} = useStudioSettingsStore();

	// Transient per-generation inputs.
	const [prompt, setPrompt] = useState("");
	const [referenceImageUrl, setReferenceImageUrl] = useState("");
	const [seed, setSeed] = useState<string>("");
	const [imagePrompt, setImagePrompt] = useState("");

	// Seedance needs a reference frame for image-to-video.
	const needsReference = mode === "image-to-video" && !referenceImageUrl.trim();

	function handleGenerate() {
		if (!prompt.trim() || needsReference) return;
		onGenerate({
			prompt: composePromptWithCamera(prompt, cameraPreset),
			referenceImageUrl: mode === "image-to-video" ? referenceImageUrl : undefined,
			seed: seedLocked && seed ? parseInt(seed, 10) : undefined,
			resolution,
			orientation,
			duration,
			mode,
		});
	}

	return (
		<div className={cn("flex flex-col gap-4", className)}>
			{/* Mode */}
			<div className="flex gap-2">
				{MODES.map((m) => (
					<button
						key={m.value}
						onClick={() => setSettings({ mode: m.value })}
						className={cn(
							"px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
							mode === m.value
								? "bg-primary text-primary-foreground border-primary"
								: "border-border text-muted-foreground hover:border-foreground",
						)}
					>
						{m.label}
					</button>
				))}
			</div>

			{/* GPT Image reference frame generator */}
			{mode === "image-to-video" && onImageGenerate && (
				<div className="rounded-lg border border-dashed border-border p-3 space-y-2">
					<p className="text-xs font-medium text-muted-foreground">Generate reference still (GPT Image)</p>
					<div className="flex gap-2">
						<Input
							placeholder="Describe your scene, character, or product…"
							value={imagePrompt}
							onChange={(e) => setImagePrompt(e.target.value)}
							className="text-xs h-8"
						/>
						<Button
							size="sm"
							variant="outline"
							className="shrink-0 text-xs"
							disabled={!imagePrompt.trim() || busy}
							onClick={() => onImageGenerate(imagePrompt)}
						>
							Generate
						</Button>
					</div>
					{referenceImageUrl && (
						<img
							src={referenceImageUrl}
							alt="Reference frame"
							className="h-24 w-auto rounded object-cover"
						/>
					)}
					{!referenceImageUrl && (
						<Input
							placeholder="Or paste an image URL…"
							value={referenceImageUrl}
							onChange={(e) => setReferenceImageUrl(e.target.value)}
							className="text-xs h-8"
						/>
					)}
				</div>
			)}

			{/* Prompt */}
			<div className="space-y-1.5">
				<Label className="text-xs">Prompt</Label>
				<Textarea
					placeholder="Describe your shot…"
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					rows={3}
					className="resize-none text-sm"
				/>
			</div>

			{/* Camera & motion */}
			<div className="space-y-1.5">
				<Label className="text-xs">Camera motion</Label>
				<CameraPresetPicker
					value={cameraPreset}
					onChange={(v) => setSettings({ cameraPreset: v })}
				/>
			</div>

			{/* Orientation */}
			<div className="space-y-1.5">
				<Label className="text-xs">Orientation</Label>
				<div className="flex gap-2">
					{ORIENTATIONS.map((o) => (
						<button
							key={o.value}
							onClick={() => setSettings({ orientation: o.value })}
							className={cn(
								"flex-1 flex flex-col items-center gap-1 py-2 rounded-md text-xs font-medium border transition-colors",
								orientation === o.value
									? "bg-primary text-primary-foreground border-primary"
									: "border-border text-muted-foreground hover:border-foreground",
							)}
						>
							<span className="h-4 flex items-center"><OrientationGlyph value={o.value} /></span>
							<span>{o.label}</span>
							<span className="opacity-70">{o.ratio}</span>
						</button>
					))}
				</div>
			</div>

			{/* Seed */}
			<div className="space-y-1.5">
				<div className="flex items-center justify-between">
					<Label className="text-xs">Seed</Label>
					<button
						onClick={() => setSettings({ seedLocked: !seedLocked })}
						className={cn(
							"text-xs px-2 py-0.5 rounded border transition-colors",
							seedLocked
								? "border-primary text-primary bg-primary/10"
								: "border-border text-muted-foreground hover:border-foreground",
						)}
					>
						{seedLocked ? "Locked" : "Random"}
					</button>
				</div>
				<Input
					type="number"
					placeholder="Leave blank for random"
					value={seed}
					disabled={!seedLocked}
					onChange={(e) => setSeed(e.target.value)}
					className="h-8 text-xs"
				/>
				<p className="text-xs text-muted-foreground">
					Every take stores its seed, so you can promote any winner to 1080p — no upscaling.
				</p>
			</div>

			{/* Resolution */}
			<div className="space-y-1.5">
				<Label className="text-xs">Resolution</Label>
				<div className="flex gap-2">
					{RESOLUTIONS.map((r) => (
						<button
							key={r.value}
							onClick={() => setSettings({ resolution: r.value })}
							title={r.hint}
							className={cn(
								"flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors",
								resolution === r.value
									? "bg-primary text-primary-foreground border-primary"
									: "border-border text-muted-foreground hover:border-foreground",
							)}
						>
							{r.label}
						</button>
					))}
				</div>
				<p className="text-xs text-muted-foreground">
					{RESOLUTIONS.find((r) => r.value === resolution)?.hint}
				</p>
			</div>

			{/* Duration */}
			<div className="space-y-1.5">
				<div className="flex items-center justify-between">
					<Label className="text-xs">Duration</Label>
					<span className="text-xs text-muted-foreground">{duration}s</span>
				</div>
				<Slider
					min={4}
					max={15}
					step={1}
					value={[duration]}
					onValueChange={([v]) => setSettings({ duration: v })}
				/>
			</div>

			<Button
				onClick={handleGenerate}
				disabled={!prompt.trim() || needsReference || busy}
				className="w-full"
				size="sm"
			>
				{busy
					? "Generating…"
					: needsReference
					? "Add a reference frame first"
					: "Generate"}
			</Button>
		</div>
	);
}
