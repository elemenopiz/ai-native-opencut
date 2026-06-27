"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { PanelView } from "./base-view";
import { GenerationForm } from "@/components/studio/generation-form";
import { ImagePanel } from "@/components/studio/image-panel";
import { PersonaManager } from "@/components/studio/persona-manager";
import { TakeCard } from "@/components/studio/take-card";
import { Button } from "@/components/ui/button";
import { useStudioGeneration } from "@/hooks/use-studio-generation";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";
import { useEditor } from "@/hooks/use-editor";
import { addClipsToEditor } from "@/lib/studio/add-to-editor";

/**
 * The single, consolidated AI generation surface — lives inside the editor so
 * generation and the timeline share one screen (no `/studio` route, no alt-tab).
 * Reuses the feature-rich studio pipeline (personas, seed-lock, GPT Image,
 * camera presets, live cost estimate) and drops finished takes straight onto the
 * current project's timeline.
 */
export function GenerateView() {
	const {
		status,
		activeTakes,
		error,
		generate,
		promoteTo1080p,
		starTake,
		pinToBoard,
		loadHistory,
		clearError,
	} = useStudioGeneration();

	const editor = useEditor();
	const settings = useStudioSettingsStore();
	const [section, setSection] = useState("generate");
	const [referenceImageUrl, setReferenceImageUrl] = useState("");

	const busy = status === "submitting" || status === "polling";

	// Reserve an empty generative slot on the timeline — the storyboard primitive.
	// You lay out the reel's shape first; prompts and takes fill the slots later.
	const reserveSlot = useCallback(() => {
		try {
			editor.timeline.addGenerativeSlot({
				spec: {
					prompt: "",
					mode: settings.mode,
					resolution: settings.resolution,
					orientation: settings.orientation,
					duration: settings.duration,
					cameraPreset: settings.cameraPreset ?? undefined,
					seedLocked: settings.seedLocked,
					consistencyMode: settings.consistencyMode,
				},
				duration: settings.duration,
			});
			toast.success("Reserved an empty slot on the timeline.");
		} catch {
			toast.error("No active project to add a slot to.");
		}
	}, [editor, settings]);

	// Hydrate the takes list from persisted history on first mount.
	useEffect(() => {
		void loadHistory();
	}, [loadHistory]);

	// Drop a finished take onto the current project's timeline. We're already
	// inside the editor, so the target project is simply the active one.
	const handleAddToTimeline = useCallback(
		async (videoUrl: string, name = "Generated clip") => {
			let projectId: string | null = null;
			try {
				projectId = editor.project.getActive().metadata.id;
			} catch {
				projectId = null;
			}
			if (!projectId) {
				toast.error("No active project to add to.");
				return;
			}
			const { added } = await addClipsToEditor({
				editor,
				projectId,
				clips: [{ id: crypto.randomUUID(), videoUrl, name }],
			});
			if (added > 0) toast.success("Added to the timeline.");
			else toast.error("Could not add to the timeline.");
		},
		[editor],
	);

	// GPT Image reference-still generation (kept from the studio flow).
	async function handleImageGenerate(prompt: string) {
		const res = await fetch("/api/studio/image", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt, n: 1 }),
		});
		if (res.ok) {
			const data = (await res.json()) as { images: Array<{ imageUrl: string }> };
			if (data.images[0]) setReferenceImageUrl(data.images[0].imageUrl);
		}
	}

	return (
		<PanelView title="Generate" hideHeader>
			<Tabs value={section} onValueChange={setSection} className="space-y-3">
				<TabsList className="w-full grid grid-cols-4 h-8">
					<TabsTrigger value="generate" className="text-xs">
						Shot
					</TabsTrigger>
					<TabsTrigger value="image" className="text-xs">
						Image
					</TabsTrigger>
					<TabsTrigger value="personas" className="text-xs">
						Personas
					</TabsTrigger>
					<TabsTrigger value="takes" className="text-xs">
						Takes
						{activeTakes.length > 0 && (
							<Badge
								variant="secondary"
								className="ml-1 text-[10px] px-1 py-0 h-4"
							>
								{activeTakes.length}
							</Badge>
						)}
					</TabsTrigger>
				</TabsList>

				<TabsContent value="generate" className="mt-0 space-y-3">
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="w-full text-xs"
						onClick={reserveSlot}
					>
						+ Reserve empty slot on timeline
					</Button>
					<p className="text-[10px] text-muted-foreground -mt-1.5">
						Lay out your reel first — drop empty slots, then fill each with a
						prompt and takes.
					</p>
					<GenerationForm
						onGenerate={generate}
						onImageGenerate={handleImageGenerate}
						busy={busy}
					/>
				</TabsContent>

				<TabsContent value="image" className="mt-0">
					<ImagePanel onSelectImage={setReferenceImageUrl} />
				</TabsContent>

				<TabsContent value="personas" className="mt-0">
					<PersonaManager />
				</TabsContent>

				<TabsContent value="takes" className="mt-0">
					{activeTakes.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
							<p className="text-sm font-medium">No takes yet</p>
							<p className="text-xs text-muted-foreground">
								Generate a shot to see takes here, then add the winner to your
								timeline.
							</p>
						</div>
					) : (
						<div className="grid grid-cols-1 gap-3 pb-4">
							{activeTakes.map((take) => (
								<TakeCard
									key={take.takeId}
									take={take}
									onStar={starTake}
									onPromote={promoteTo1080p}
									onPin={pinToBoard}
									onAddToTimeline={(url) =>
										handleAddToTimeline(url, take.prompt || "Generated clip")
									}
								/>
							))}
						</div>
					)}
				</TabsContent>
			</Tabs>

			{error && (
				<div className="mt-3 rounded-md bg-destructive/10 px-3 py-2">
					<p className="text-xs text-destructive">{error}</p>
					<button
						onClick={clearError}
						className="text-xs text-muted-foreground underline mt-1"
					>
						Dismiss
					</button>
				</div>
			)}
		</PanelView>
	);
}
