"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { aiClient } from "@/lib/ai-client";
import { useAIStatus } from "@/hooks/use-ai-status";
import { isFeatureAvailable } from "@/lib/local-ai/retired-features";
import { useAIStore } from "@/stores/ai-store";
import { useEditor } from "@/hooks/use-editor";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";
import {
	removeImageBackground,
	type BackgroundRemovalResult,
} from "@/lib/studio/background-removal";
import { Separator } from "@/components/ui/separator";
import { AIToolbarButtons } from "./ai-toolbar-buttons";
import { BackgroundRemovalDialog } from "./background-removal-dialog";

/**
 * Mounts the built-but-unmounted `AIToolbarButtons` in the preview toolbar and
 * wires its handlers to the AI client. In particular this is the sole caller of
 * `aiClient.generateInfographic` and `aiClient.removeBackground` (via the
 * BackgroundRemovalDialog). The secondary actions route to the relevant Assets
 * tab, which already hosts the full flow (Director for image gen, Audio for
 * voiceover/clean, Captions for transcribe/subtitles).
 */
export function AIToolbar({ className }: { className?: string }) {
	const { isConnected } = useAIStatus();
	const toggleSetupGuide = useAIStore((s) => s.toggleSetupGuide);
	const editor = useEditor();
	const setActiveTab = useAssetsPanelStore((s) => s.setActiveTab);

	const [isBgOpen, setIsBgOpen] = useState(false);
	const [isGenerating, setIsGenerating] = useState(false);

	const getActiveProjectId = useCallback((): string | null => {
		try {
			return editor.project.getActive().metadata.id;
		} catch {
			return null;
		}
	}, [editor]);

	const handleGenerateInfographic = useCallback(async () => {
		const topic = window.prompt("Infographic topic?");
		if (!topic?.trim()) return;
		setIsGenerating(true);
		try {
			const data = await aiClient.generateInfographic(topic.trim());
			toast.success("Infographic generated", {
				description: `Template: ${data.template}`,
			});
		} catch (error) {
			toast.error("Infographic generation failed", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setIsGenerating(false);
		}
	}, []);

	const handleRemoveBackground = useCallback(
		async (source: File | string): Promise<BackgroundRemovalResult | null> =>
			removeImageBackground(source, aiClient),
		[],
	);

	const handleAddBgResultToTimeline = useCallback(
		async (result: BackgroundRemovalResult) => {
			const projectId = getActiveProjectId();
			if (!projectId) {
				toast.error("No active project to save to.");
				return;
			}
			const { added } = await addItemsToProjectMedia({
				editor,
				projectId,
				items: [
					{
						url: result.processedUrl,
						name: "background-removed",
						kind: "image",
					},
				],
				source: "ai",
			});
			if (added > 0) toast.success("Added to assets.");
			else toast.error("Could not add to assets.");
		},
		[editor, getActiveProjectId],
	);

	// Every button here is keyed off the retired local backend's health: with
	// the stack gone they all render "disabled" and funnel into its docker
	// setup guide (also gated). Hide the strip rather than ship dead buttons;
	// the live flows stay reachable via their Assets tabs.
	if (!isFeatureAvailable("localBackendSetup")) return null;

	return (
		<>
			<AIToolbarButtons
				className={className}
				isConnected={isConnected}
				isGenerating={isGenerating}
				onSetupClick={toggleSetupGuide}
				onGenerateInfographic={handleGenerateInfographic}
				onRemoveBackground={() => setIsBgOpen(true)}
				onGenerateImage={() => setActiveTab("director")}
				onGenerateVoiceover={() => setActiveTab("audio")}
				onCleanAudio={() => setActiveTab("audio")}
				onTranscribe={() => setActiveTab("captions")}
				onAddSubtitles={() => setActiveTab("captions")}
			/>
			<Separator orientation="vertical" className="h-4" />
			<BackgroundRemovalDialog
				isOpen={isBgOpen}
				onOpenChange={setIsBgOpen}
				onRemoveBackground={handleRemoveBackground}
				onAddToTimeline={handleAddBgResultToTimeline}
			/>
		</>
	);
}
