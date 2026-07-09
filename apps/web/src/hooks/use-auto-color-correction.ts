import { useCallback, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";
import { usePreviewCanvasStore } from "@/stores/preview-canvas-store";
import { AUTO_CORRECT_PROFILES } from "@/lib/color/auto-color-profiles";
import { sampleCanvasImageData } from "@/lib/color/sample-canvas";
import { computeScopeSummary } from "@/lib/color/scopes";
import {
	computeAutoCorrection,
	layerLookProfile,
	type AutoCorrectAdjustments,
} from "@/lib/color/auto-correct";
import { toast } from "sonner";

/**
 * Real auto color-correction. Samples the composited preview frame, measures it
 * with the scopes engine, and derives `color-adjust` params from the actual
 * pixels (auto white balance, exposure, contrast, black/white points). An
 * optional look profile is layered on top of the measured base grade.
 */
export function useAutoColorCorrection() {
	const editor = useEditor();
	const bgTasks = useBackgroundTasksStore();
	const [appliedProfile, setAppliedProfile] = useState<string | null>(null);

	const analyzeAndCorrect = useCallback(
		async (profileName?: string) => {
			const taskId = `color-${Date.now()}`;
			bgTasks.addTask({
				id: taskId,
				type: "broll-suggestions",
				label: "Auto Color Correction",
				progress: "Measuring the current frame…",
			});

			try {
				// 1. Sample the live composited frame from the preview canvas.
				const canvas = usePreviewCanvasStore.getState().canvasEl;
				if (!canvas) {
					throw new Error(
						"Preview isn't ready yet — open a project with footage and try again.",
					);
				}
				const imageData = sampleCanvasImageData({ source: canvas });
				if (!imageData || imageData.width === 0) {
					throw new Error("Couldn't read pixels from the preview frame.");
				}

				// 2. Measure it and derive a base correction from the statistics.
				const summary = computeScopeSummary({
					data: imageData.data,
					width: imageData.width,
					height: imageData.height,
				});
				if (summary.sampleCount === 0) {
					throw new Error("The current frame is empty — nothing to correct.");
				}

				let adjustments: AutoCorrectAdjustments = computeAutoCorrection({
					summary,
				});

				// 3. Optionally layer a named "look" on top of the measured base.
				const profile = profileName
					? AUTO_CORRECT_PROFILES.find((p) => p.name === profileName)
					: undefined;
				if (profile) {
					adjustments = layerLookProfile({ base: adjustments, profile });
				}

				const label = profile ? `Auto + ${profile.name}` : "Auto Balance";

				// 4. Apply the computed params to every video/image clip.
				const tracks = editor.timeline.getTracks();
				const updates: Array<{
					trackId: string;
					elementId: string;
					updates: Record<string, unknown>;
				}> = [];
				for (const track of tracks) {
					if (track.type !== "video") continue;
					for (const el of track.elements) {
						if (el.type !== "video" && el.type !== "image") continue;
						if (!("effects" in el)) continue;

						const existingEffects = [
							...((el as { effects?: unknown[] }).effects ?? []),
						];
						const colorEffectIdx = existingEffects.findIndex(
							(e) => (e as { type?: string }).type === "color-adjust",
						);

						if (colorEffectIdx >= 0) {
							const existing = existingEffects[colorEffectIdx] as {
								params?: Record<string, unknown>;
							};
							existingEffects[colorEffectIdx] = {
								...existing,
								params: { ...existing.params, ...adjustments },
							};
						} else {
							existingEffects.push({
								id: `color-adjust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
								type: "color-adjust",
								enabled: true,
								params: { ...adjustments },
							});
						}

						updates.push({
							trackId: track.id,
							elementId: el.id,
							updates: { effects: existingEffects },
						});
					}
				}

				if (updates.length === 0) {
					throw new Error("No video or image clips to color-correct.");
				}

				editor.timeline.updateElements({ updates: updates as never });
				setAppliedProfile(label);

				bgTasks.updateTask(taskId, {
					status: "completed",
					progress: `Applied "${label}" to ${updates.length} clip${
						updates.length === 1 ? "" : "s"
					}`,
					completedAt: Date.now(),
				});

				toast.success(
					`Applied "${label}" color correction to ${updates.length} clip${
						updates.length === 1 ? "" : "s"
					}`,
				);
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

	return { analyzeAndCorrect, appliedProfile, profiles: AUTO_CORRECT_PROFILES };
}
