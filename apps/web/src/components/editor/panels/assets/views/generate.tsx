"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Video02Icon,
	Image02Icon,
	AudioWave01Icon,
} from "@hugeicons/core-free-icons";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PanelView } from "./base-view";
import { GenerationForm } from "@/components/studio/generation-form";
import { ImagePanel } from "@/components/studio/image-panel";
import { AudioPanel } from "@/components/studio/audio-panel";
import { SegmentedControl } from "@/components/studio/generation-bottom-bar";
import { useStudioGeneration } from "@/hooks/use-studio-generation";
import { useEditor } from "@/hooks/use-editor";
import {
	generateMultiframe,
	type MultiframeBase,
} from "@/lib/studio/multiframe";

const MEDIA_SEGMENTS = [
	{
		value: "generate",
		label: (
			<span className="flex items-center gap-1.5">
				<HugeiconsIcon icon={Video02Icon} className="size-[13.5px]" />
				Video
			</span>
		),
	},
	{
		value: "image",
		label: (
			<span className="flex items-center gap-1.5">
				<HugeiconsIcon icon={Image02Icon} className="size-[13.5px]" />
				Image
			</span>
		),
	},
	{
		value: "audio",
		label: (
			<span className="flex items-center gap-1.5">
				<HugeiconsIcon icon={AudioWave01Icon} className="size-[13.5px]" />
				Audio
			</span>
		),
	},
] satisfies { value: string; label: React.ReactNode }[];

/**
 * The single, consolidated AI generation surface — lives inside the editor so
 * generation and the timeline share one screen (no `/studio` route, no alt-tab).
 * Reuses the feature-rich studio pipeline (seed-lock, GPT Image, camera
 * presets, live cost estimate) and drops finished takes straight onto the
 * current project's timeline. Batch/slot generation (storyboard "generate all")
 * lives with the Director now — this panel is single-shot generation only.
 * Video/image/audio only — no Personas tab here. Persona management
 * (`components/studio/persona-manager.tsx`) and the Director's persona verb
 * are unaffected; they're just not surfaced as a tab in this panel.
 */
export function GenerateView() {
	const { status, error, generate, clearError, loadHistory } =
		useStudioGeneration();

	const editor = useEditor();
	const [section, setSection] = useState("generate");

	const busy = status === "submitting" || status === "polling";

	// Resume polling for any generation that was still in-flight when the page
	// was last closed/reloaded — otherwise an orphaned take never completes and
	// never surfaces anywhere (see use-studio-generation.ts's loadHistory for
	// the Board-routing side of this fix).
	useEffect(() => {
		void loadHistory();
	}, [loadHistory]);

	// GenerationForm builds the generate params (including batchSize) but has
	// no reason to know about EditorCore/project id — inject them here so the
	// hook can route a finished take straight to Assets or to Board.
	const handleGenerate = useCallback(
		(params: Omit<Parameters<typeof generate>[0], "editor" | "projectId">) => {
			let projectId: string | null = null;
			try {
				projectId = editor.project.getActive().metadata.id;
			} catch {
				projectId = null;
			}
			if (!projectId) {
				toast.error("No active project to add to.");
				// Reject (not resolve) so the batch caller's Promise.allSettled
				// counts this as a failure — otherwise it reads as "fulfilled" and
				// the success toast fires alongside this error.
				return Promise.reject(new Error("No active project"));
			}
			return generate({ ...params, editor, projectId });
		},
		[editor, generate],
	);

	// Multiframe: generate N-1 flf2v segments across the keyframes and lay them
	// end-to-end on the active project's timeline.
	const handleGenerateMultiframe = useCallback(
		async (keyframes: string[], base: MultiframeBase) => {
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
			const segs = keyframes.length - 1;
			toast.info(`Generating ${segs} segment${segs === 1 ? "" : "s"}…`);
			const { placed, segments } = await generateMultiframe({
				editor,
				projectId,
				keyframes,
				base,
			});
			if (placed > 0) {
				toast.success(
					`Placed ${placed}/${segments} segment${segments === 1 ? "" : "s"} on the timeline.`,
				);
			} else {
				toast.error("Multiframe generation failed.");
			}
		},
		[editor],
	);

	return (
		<PanelView title="Generate" hideHeader>
			<Tabs value={section} onValueChange={setSection} className="space-y-4">
				<SegmentedControl
					value={section}
					onChange={setSection}
					testIdPrefix="generate-media-tab"
					options={MEDIA_SEGMENTS}
				/>

				<TabsContent value="generate" className="mt-0 space-y-4">
					<GenerationForm
						onGenerate={handleGenerate}
						onGenerateMultiframe={handleGenerateMultiframe}
						busy={busy}
					/>
				</TabsContent>

				<TabsContent value="image" className="mt-0">
					<ImagePanel />
				</TabsContent>

				<TabsContent value="audio" className="mt-0">
					<AudioPanel />
				</TabsContent>
			</Tabs>

			{error && (
				<div className="mt-4 flex items-center gap-3">
					<p className="min-w-0 flex-1 text-[11.5px] text-destructive">
						{error}
					</p>
					<button
						type="button"
						onClick={clearError}
						className="shrink-0 text-[11.5px] text-muted-foreground hover:text-foreground"
					>
						Dismiss
					</button>
				</div>
			)}
		</PanelView>
	);
}
