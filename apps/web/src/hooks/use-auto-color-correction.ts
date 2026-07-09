import { useCallback, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";
import {
	AUTO_CORRECT_PROFILES,
	type ColorCorrectionProfile,
} from "@/lib/color/auto-color-profiles";
import {
	deriveAutoColorAdjustments,
	measureColorFromImageData,
	sampleFrameToImageData,
	type ColorMeasurement,
} from "@/lib/effects/color-scopes";
import type { Effect } from "@/types/effects";
import type {
	ImageElement,
	TimelineElement,
	VideoElement,
} from "@/types/timeline";
import { toast } from "sonner";

type CorrectableElement = VideoElement | ImageElement;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Legal ranges for the `color-adjust` params we write (mirrors auto-correct.ts). */
const RANGE = {
	brightness: [-0.5, 0.5],
	contrast: [0.2, 3],
	saturation: [0, 3],
	temperature: [-1, 1],
	exposure: [-2, 2],
	tint: [-1, 1],
	highlights: [-1, 1],
	shadows: [-1, 1],
} as const;

/** The measured, per-clip base grade the scopes engine derives from pixels. */
interface MeasuredParams {
	brightness: number;
	contrast: number;
	saturation: number;
	temperature: number;
}

/**
 * Layer an optional "look" profile on top of a measured per-clip base grade.
 * Additive params (brightness/temperature) add; multiplicative-neutral params
 * (contrast/saturation) multiply; the profile's absolute-only params
 * (exposure/tint/highlights/shadows) — which the measured base doesn't set —
 * pass straight through. Everything is re-clamped to the effect's legal range.
 */
function applyLookProfile(
	base: MeasuredParams,
	profile: ColorCorrectionProfile,
): Record<string, number> {
	const a = profile.adjustments;
	return {
		brightness: clamp(base.brightness + a.brightness, ...RANGE.brightness),
		contrast: clamp(base.contrast * a.contrast, ...RANGE.contrast),
		saturation: clamp(base.saturation * a.saturation, ...RANGE.saturation),
		temperature: clamp(base.temperature + a.temperature, ...RANGE.temperature),
		exposure: clamp(a.exposure, ...RANGE.exposure),
		tint: clamp(a.tint, ...RANGE.tint),
		highlights: clamp(a.highlights, ...RANGE.highlights),
		shadows: clamp(a.shadows, ...RANGE.shadows),
	};
}

/** Seeks a video file to `seekTime` (seconds) and returns the decoded frame. */
async function loadVideoFrame({
	file,
	seekTime,
}: {
	file: File;
	seekTime: number;
}): Promise<{
	source: HTMLVideoElement;
	width: number;
	height: number;
	objectUrl: string;
}> {
	const video = document.createElement("video");
	const objectUrl = URL.createObjectURL(file);
	video.src = objectUrl;
	video.muted = true;
	video.playsInline = true;

	await new Promise<void>((resolve, reject) => {
		video.onloadedmetadata = () => resolve();
		video.onerror = () => reject(new Error("Failed to load video"));
	});

	const clampedTime = Math.min(
		Math.max(seekTime, 0),
		Math.max(video.duration - 0.05, 0),
	);
	video.currentTime = clampedTime;
	await new Promise<void>((resolve) => {
		video.onseeked = () => resolve();
	});

	return {
		source: video,
		width: video.videoWidth,
		height: video.videoHeight,
		objectUrl,
	};
}

/** Decodes an image file and returns it ready for sampling. */
async function loadImageFrame({ file }: { file: File }): Promise<{
	source: HTMLImageElement;
	width: number;
	height: number;
	objectUrl: string;
}> {
	const image = new Image();
	const objectUrl = URL.createObjectURL(file);
	image.src = objectUrl;

	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error("Failed to load image"));
	});

	return {
		source: image,
		width: image.naturalWidth,
		height: image.naturalHeight,
		objectUrl,
	};
}

export interface UseAutoColorCorrectionReturn {
	analyzeAndCorrect: (profileName?: string) => Promise<void>;
	/** Measurement for the last clip processed — surfaced for debugging/scopes UI. */
	lastMeasurement: ColorMeasurement | null;
	/** Label of the last look applied (e.g. "Auto Balance" or "Auto + Film Look"). */
	appliedProfile: string | null;
	/** Selectable look profiles layered on top of the measured base grade. */
	profiles: ColorCorrectionProfile[];
}

/**
 * Real auto color-correction: for every video/image clip on the timeline,
 * samples an actual frame, measures it with the Canvas2D color-scopes engine
 * (`@/lib/effects/color-scopes`), and derives a `color-adjust` effect from
 * those measurements — no static "one size fits all" preset. An optional named
 * "look" profile is layered on top of the measured base grade.
 */
export function useAutoColorCorrection(): UseAutoColorCorrectionReturn {
	const editor = useEditor();
	const bgTasks = useBackgroundTasksStore();
	const [lastMeasurement, setLastMeasurement] =
		useState<ColorMeasurement | null>(null);
	const [appliedProfile, setAppliedProfile] = useState<string | null>(null);

	const analyzeAndCorrect = useCallback(
		async (profileName?: string) => {
			const taskId = `color-${Date.now()}`;
			const profile = profileName
				? AUTO_CORRECT_PROFILES.find((p) => p.name === profileName)
				: undefined;
			const label = profile ? `Auto + ${profile.name}` : "Auto Balance";

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
				const updates: Array<{
					trackId: string;
					elementId: string;
					updates: Partial<TimelineElement>;
				}> = [];
				let clipsMeasured = 0;
				let latestMeasurement: ColorMeasurement | null = null;

				for (const track of tracks) {
					if (track.type !== "video") continue;

					for (const el of track.elements) {
						if (el.type !== "video" && el.type !== "image") continue;
						if (!("effects" in el)) continue;

						const element = el as CorrectableElement;
						const media = element.mediaId
							? editor.media.getAssetById(element.mediaId)
							: undefined;
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
							const measured = deriveAutoColorAdjustments(measurement);
							latestMeasurement = measurement;
							clipsMeasured++;

							// Measured per-clip base, optionally with a look layered on top.
							const measuredBase: MeasuredParams = {
								brightness: measured.brightness,
								contrast: measured.contrast,
								saturation: measured.saturation,
								temperature: measured.temperature,
							};
							const measuredParams = profile
								? applyLookProfile(measuredBase, profile)
								: measuredBase;

							const existingEffects: Effect[] = [...(element.effects ?? [])];
							const colorEffectIdx = existingEffects.findIndex(
								(effect) => effect.type === "color-adjust",
							);

							if (colorEffectIdx >= 0) {
								existingEffects[colorEffectIdx] = {
									...existingEffects[colorEffectIdx],
									params: {
										...existingEffects[colorEffectIdx].params,
										...measuredParams,
									},
								};
							} else {
								existingEffects.push({
									id: `${element.id}-auto-color`,
									type: "color-adjust",
									enabled: true,
									params: { vignette: 0, ...measuredParams },
								});
							}

							updates.push({
								trackId: track.id,
								elementId: element.id,
								// `effects` isn't in the common-key intersection Partial<TimelineElement>
								// exposes (AudioElement/TextElement don't carry it), so a narrow cast is
								// needed here — same escape hatch the previous implementation used.
								updates: {
									effects: existingEffects,
								} as Partial<TimelineElement>,
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
				setAppliedProfile(clipsMeasured > 0 ? label : null);

				bgTasks.updateTask(taskId, {
					status: "completed",
					progress:
						clipsMeasured > 0
							? `Applied "${label}" to ${clipsMeasured} clip${
									clipsMeasured === 1 ? "" : "s"
								}`
							: "No video/image clips found to correct",
					completedAt: Date.now(),
				});

				if (clipsMeasured > 0) {
					toast.success(
						`Applied "${label}" color correction to ${clipsMeasured} clip${
							clipsMeasured === 1 ? "" : "s"
						}`,
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
		},
		[editor, bgTasks],
	);

	return {
		analyzeAndCorrect,
		lastMeasurement,
		appliedProfile,
		profiles: AUTO_CORRECT_PROFILES,
	};
}
