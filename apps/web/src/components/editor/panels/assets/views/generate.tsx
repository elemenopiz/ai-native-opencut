"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Video02Icon,
	Image02Icon,
	AudioWave01Icon,
	UserMultiple02Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PanelView } from "./base-view";
import { ComingSoon } from "./coming-soon";
import { GenerationForm } from "@/components/studio/generation-form";
import { ImagePanel } from "@/components/studio/image-panel";
import { PersonaManager } from "@/components/studio/persona-manager";
import { SegmentedControl } from "@/components/studio/generation-bottom-bar";
import { useStudioGeneration } from "@/hooks/use-studio-generation";
import { useEditor } from "@/hooks/use-editor";
import {
	generateMultiframe,
	type MultiframeBase,
} from "@/lib/studio/multiframe";
import { useTakesNotificationStore } from "@/stores/takes-notification-store";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";

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
	{
		value: "personas",
		label: (
			<span className="flex items-center gap-1.5">
				<HugeiconsIcon icon={UserMultiple02Icon} className="size-[13.5px]" />
				Personas
			</span>
		),
	},
] satisfies { value: string; label: React.ReactNode }[];

/**
 * The single, consolidated AI generation surface — lives inside the editor so
 * generation and the timeline share one screen (no `/studio` route, no alt-tab).
 * Reuses the feature-rich studio pipeline (personas, seed-lock, GPT Image,
 * camera presets, live cost estimate) and drops finished takes straight onto the
 * current project's timeline. Batch/slot generation (storyboard "generate all")
 * lives with the Director now — this panel is single-shot generation only.
 */
export function GenerateView() {
	const { status, error, generate, clearError } = useStudioGeneration();

	const editor = useEditor();
	const [section, setSection] = useState("generate");

	const busy = status === "submitting" || status === "polling";

	// Drive the Takes tab icon (left rail): fill it blue while a generation is
	// in flight, keep it blue once done so the user knows takes are waiting.
	const setGenerating = useTakesNotificationStore((s) => s.setGenerating);
	const setReady = useTakesNotificationStore((s) => s.setReady);
	const clearTakesNotification = useTakesNotificationStore((s) => s.clear);
	const setAssetsActiveTab = useAssetsPanelStore((s) => s.setActiveTab);
	const wasBusy = useRef(false);
	useEffect(() => {
		if (busy && !wasBusy.current) setGenerating();
		else if (!busy && wasBusy.current) {
			setReady();
			// The ambient star-glow on the Takes tab (left rail) is easy to miss —
			// surface a toast that points at the SAME star so the two read as one
			// signal, with a one-click jump straight there.
			if (status === "done") {
				toast.success("Take ready", {
					description: "View it in Takes.",
					icon: (
						<HugeiconsIcon
							icon={StarIcon}
							className="size-4 fill-current text-blue-500"
						/>
					),
					action: {
						label: "View in Takes",
						onClick: () => {
							setAssetsActiveTab("starred");
							clearTakesNotification();
						},
					},
				});
			}
		}
		wasBusy.current = busy;
	}, [
		busy,
		status,
		setGenerating,
		setReady,
		clearTakesNotification,
		setAssetsActiveTab,
	]);

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
						onGenerate={generate}
						onGenerateMultiframe={handleGenerateMultiframe}
						busy={busy}
					/>
				</TabsContent>

				<TabsContent value="image" className="mt-0">
					<ImagePanel />
				</TabsContent>

				{/* Text-to-music / video-to-audio generation is gated OFF for this
				    beta — neither ElevenLabs Music nor fal MMAudio has a funded
				    key (see lib/studio/backends/audio/index.ts). Kept as a tab
				    (rather than removed) so it isn't a dead end. */}
				<TabsContent value="audio" className="mt-0">
					<ComingSoon
						title="Audio"
						description="Music and sound generation aren't available in this beta."
					/>
				</TabsContent>

				<TabsContent value="personas" className="mt-0">
					<PersonaManager />
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
