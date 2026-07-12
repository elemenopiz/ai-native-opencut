import { useCallback, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";
import { aiClient } from "@/lib/ai-client";
import {
	isFeatureAvailable,
	retiredFeatureMessage,
} from "@/lib/local-ai/retired-features";
import type { AudioElement, CreateUploadAudioElement } from "@/types/timeline";
import { toast } from "sonner";

/**
 * Wires the backend's spectral-gating denoise endpoint (`/api/audio/denoise`,
 * `noisereduce`-backed) into a real timeline operation: pulls the clip's
 * source audio, runs it through the AI backend, and swaps the clip onto the
 * cleaned result — same position/trim/volume/keyframes, new media.
 */
export function useNoiseReduction() {
	const editor = useEditor();
	const bgTasks = useBackgroundTasksStore();
	const [isProcessing, setIsProcessing] = useState(false);

	const applyNoiseReduction = useCallback(
		async ({
			trackId,
			element,
			strength = 0.7,
		}: {
			trackId: string;
			element: AudioElement;
			strength?: number;
		}) => {
			// The denoise endpoint only ever existed on the retired Python
			// stack — gate until a browser/cloud implementation lands.
			if (!isFeatureAvailable("denoise")) {
				toast.error(retiredFeatureMessage("denoise"));
				return;
			}

			const taskId = `denoise-${Date.now()}`;
			setIsProcessing(true);
			bgTasks.addTask({
				id: taskId,
				type: "denoise",
				label: "Reducing Noise",
				progress: "Reading source audio...",
			});

			try {
				let sourceFile: File | null = null;

				if (element.sourceType === "upload") {
					const asset = editor.media.getAssetById(element.mediaId);
					if (asset?.file) {
						sourceFile = asset.file;
					}
				} else {
					const response = await fetch(element.sourceUrl);
					if (!response.ok) {
						throw new Error("Could not fetch library audio source");
					}
					const blob = await response.blob();
					sourceFile = new File([blob], `${element.name || "audio"}.wav`, {
						type: blob.type || "audio/wav",
					});
				}

				if (!sourceFile) {
					throw new Error("Could not read audio source for this clip.");
				}

				bgTasks.updateTask(taskId, {
					progress: "Applying spectral-gating noise reduction...",
				});

				const result = await aiClient.denoiseAudio(sourceFile, strength);

				const denoisedResponse = await fetch(result.audioUrl);
				const denoisedBlob = await denoisedResponse.blob();
				const denoisedFile = new File(
					[denoisedBlob],
					`${element.name || "audio"}-denoised.wav`,
					{ type: "audio/wav" },
				);

				const projectId = editor.project.getActive().metadata.id;
				const mediaId = await editor.media.addMediaAsset({
					projectId,
					asset: {
						name: denoisedFile.name,
						type: "audio",
						file: denoisedFile,
						url: URL.createObjectURL(denoisedFile),
						duration: element.sourceDuration ?? element.duration,
					},
				});

				const newElement: CreateUploadAudioElement = {
					type: "audio",
					sourceType: "upload",
					mediaId,
					name: `${element.name} (denoised)`,
					startTime: element.startTime,
					duration: element.duration,
					trimStart: element.trimStart,
					trimEnd: element.trimEnd,
					sourceDuration: element.sourceDuration,
					volume: element.volume,
					muted: element.muted,
					playbackRate: element.playbackRate,
					animations: element.animations,
				};

				const supportsTransaction =
					typeof editor.command.beginTransaction === "function";
				if (supportsTransaction) editor.command.beginTransaction();

				editor.timeline.deleteElements({
					elements: [{ trackId, elementId: element.id }],
				});

				editor.timeline.insertElement({
					element: newElement,
					placement: { mode: "explicit", trackId },
				});

				if (supportsTransaction) editor.command.commitTransaction();

				bgTasks.updateTask(taskId, {
					status: "completed",
					progress: "Noise reduction applied",
					completedAt: Date.now(),
				});
				toast.success("Noise reduction applied to clip");
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Noise reduction failed";
				bgTasks.updateTask(taskId, {
					status: "error",
					error: message,
					completedAt: Date.now(),
				});
				toast.error("Noise reduction failed", { description: message });
			} finally {
				setIsProcessing(false);
			}
		},
		[editor, bgTasks],
	);

	return { applyNoiseReduction, isProcessing };
}
