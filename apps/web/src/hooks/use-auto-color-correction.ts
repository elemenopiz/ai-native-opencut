import { useCallback, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";
import {
	deriveAutoColorAdjustments,
	measureColorFromImageData,
	sampleFrameToImageData,
	type ColorMeasurement,
} from "@/lib/effects/color-scopes";
import type { Effect } from "@/types/effects";
import type { ImageElement, TimelineElement, VideoElement } from "@/types/timeline";
import { toast } from "sonner";

type CorrectableElement = VideoElement | ImageElement;

/** Seeks a video file to `seekTime` (seconds) and returns the decoded frame. */
async function loadVideoFrame({
	file,
	seekTime,
}: {
	file: File;
	seekTime: number;
}): Promise<{ source: HTMLVideoElement; width: number; height: number; objectUrl: string }> {
	const video = document.createElement("video");
	const objectUrl = URL.createObjectURL(file);
	video.src = objectUrl;
	video.muted = true;
	video.playsInline = true;

	await new Promise<void>((resolve, reject) => {
		video.onloadedmetadata = () => resolve();
		video.onerror = () => reject(new Error("Failed to load video"));
	});

	const clampedTime = Math.min(Math.max(seekTime, 0), Math.max(video.duration - 0.05, 0));
	video.currentTime = clampedTime;
	await new Promise<void>((resolve) => {
		video.onseeked = () => resolve();
	});

	return { source: video, width: video.videoWidth, height: video.videoHeight, objectUrl };
}

/** Decodes an image file and returns it ready for sampling. */
async function loadImageFrame({
	file,
}: {
	file: File;
}): Promise<{ source: HTMLImageElement; width: number; height: number; objectUrl: string }> {
	const image = new Image();
	const objectUrl = URL.createObjectURL(file);
	image.src = objectUrl;

	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error("Failed to load image"));
	});

	return { source: image, width: image.naturalWidth, height: image.naturalHeight, objectUrl };
}

export interface UseAutoColorCorrectionReturn {
	analyzeAndCorrect: () => Promise<void>;
	/** Measurement for the last clip processed — surfaced for debugging/scopes UI. */
	lastMeasurement: ColorMeasurement | null;
}

/**
 * Real auto color-correction: for every video/image clip on the timeline,
 * samples an actual frame, measures it with the Canvas2D color-scopes engine
 * (`@/lib/effects/color-scopes`), and derives a `color-adjust` effect from
 * those measurements — no static "one size fits all" preset.
 */
export function useAutoColorCorrection(): UseAutoColorCorrectionReturn {
	const editor = useEditor();
	const bgTasks = useBackgroundTasksStore();
	const [lastMeasurement, setLastMeasurement] = useState<ColorMeasurement | null>(null);

	const analyzeAndCorrect = useCallback(async () => {
		const taskId = `color-${Date.now()}`;
		bgTasks.addTask({
			id: taskId,
			// No dedicated background-task type exists for color correction yet;
			// reusing "broll-suggestions" (progress/label are what's actually shown).
			type: "broll-suggestions",
			label: "Auto Color Correction",
			progress: "Measuring video frames...",
		});

		try {
			const tracks = editor.timeline.getTracks();
			const updates: Array<{ trackId: string; elementId: string; updates: Partial<TimelineElement> }> = [];
			let clipsMeasured = 0;
			let latestMeasurement: ColorMeasurement | null = null;

			for (const track of tracks) {
				if (track.type !== "video") continue;

				for (const el of track.elements) {
					if (el.type !== "video" && el.type !== "image") continue;
					if (!("effects" in el)) continue;

					const element = el as CorrectableElement;
					const media = element.mediaId ? editor.media.getAssetById(element.mediaId) : undefined;
					if (!media?.file) continue;

					let objectUrl: string | null = null;
					try {
						const frame =
							element.type === "video"
								? await loadVideoFrame({
										file: media.file,
										seekTime: element.trimStart + element.duration / 2,
									})
								: await loadImageFrame({ file: media.file });
						objectUrl = frame.objectUrl;

						if (frame.width <= 0 || frame.height <= 0) continue;

						const imageData = sampleFrameToImageData({
							source: frame.source,
							sourceWidth: frame.width,
							sourceHeight: frame.height,
						});
						const measurement = measureColorFromImageData(imageData);
						const adjustments = deriveAutoColorAdjustments(measurement);
						latestMeasurement = measurement;
						clipsMeasured++;

						const existingEffects: Effect[] = [...(element.effects ?? [])];
						const colorEffectIdx = existingEffects.findIndex((effect) => effect.type === "color-adjust");
						const measuredParams = {
							brightness: adjustments.brightness,
							contrast: adjustments.contrast,
							saturation: adjustments.saturation,
							temperature: adjustments.temperature,
						};

						if (colorEffectIdx >= 0) {
							existingEffects[colorEffectIdx] = {
								...existingEffects[colorEffectIdx],
								params: { ...existingEffects[colorEffectIdx].params, ...measuredParams },
							};
						} else {
							existingEffects.push({
								id: `${element.id}-auto-color`,
								type: "color-adjust",
								enabled: true,
								params: { ...measuredParams, vignette: 0 },
							});
						}

						updates.push({
							trackId: track.id,
							elementId: element.id,
							// `effects` isn't in the common-key intersection Partial<TimelineElement>
							// exposes (AudioElement/TextElement don't carry it), so a narrow cast is
							// needed here — same escape hatch the previous implementation used.
							updates: { effects: existingEffects } as Partial<TimelineElement>,
						});
					} finally {
						if (objectUrl) URL.revokeObjectURL(objectUrl);
					}
				}
			}

			if (updates.length > 0) {
				editor.timeline.updateElements({ updates });
			}

			setLastMeasurement(latestMeasurement);

			bgTasks.updateTask(taskId, {
				status: "completed",
				progress:
					clipsMeasured > 0
						? `Measured and corrected ${clipsMeasured} clip${clipsMeasured === 1 ? "" : "s"}`
						: "No video/image clips found to correct",
				completedAt: Date.now(),
			});

			if (clipsMeasured > 0) {
				toast.success(
					`Auto color-corrected ${clipsMeasured} clip${clipsMeasured === 1 ? "" : "s"} from measured frames`,
				);
			} else {
				toast.info("No video/image clips found to color-correct");
			}
		} catch (err) {
			bgTasks.updateTask(taskId, {
				status: "error",
				error: err instanceof Error ? err.message : "Color correction failed",
				completedAt: Date.now(),
			});
		}
	}, [editor, bgTasks]);

	return { analyzeAndCorrect, lastMeasurement };
}
