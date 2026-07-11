import { useCallback, useState } from "react";

import { useEditor } from "@/hooks/use-editor";
import { aiClient } from "@/lib/ai-client";
import {
	type ReframeOptions,
	type ReframePreset,
	type ReframeResult,
	computeReframeKeyframes,
	getDefaultReframeOptions,
} from "@/lib/reframe/reframe-types";
import {
	hasUsableFaces,
	smartcropFallbackDetection,
} from "@/lib/reframe/smartcrop-fallback";
import type { FaceDetectionResult } from "@/types/ai";
import type { NumberKeyframe } from "@/types/animation";
import type { VideoElement } from "@/types/timeline";

export type ReframeStatus =
	| "idle"
	| "detecting"
	| "computing"
	| "applying"
	| "done"
	| "error";

export interface UseSmartReframeReturn {
	status: ReframeStatus;
	progress: number;
	result: ReframeResult | null;
	error: string | null;
	startReframe: (
		elementId: string,
		trackId: string,
		preset: ReframePreset,
		options?: Partial<ReframeOptions>,
	) => Promise<void>;
	applyKeyframes: () => void;
	reset: () => void;
}

export function useSmartReframe(): UseSmartReframeReturn {
	const editor = useEditor();
	const [status, setStatus] = useState<ReframeStatus>("idle");
	const [progress, setProgress] = useState(0);
	const [result, setResult] = useState<ReframeResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const startReframe = useCallback(
		async (
			elementId: string,
			trackId: string,
			preset: ReframePreset,
			options?: Partial<ReframeOptions>,
		) => {
			setStatus("detecting");
			setProgress(0);
			setError(null);
			setResult(null);

			try {
				const tracks = editor.timeline.getTracks();
				const track = tracks.find((t) => t.id === trackId);
				if (!track) throw new Error("Track not found");

				const element = track.elements.find((e) => e.id === elementId);
				if (!element || element.type !== "video") {
					throw new Error("Element must be a video");
				}

				const videoEl = element as VideoElement;
				if (!videoEl.mediaId) throw new Error("Video has no media source");

				const media = editor.media.getAssetById(videoEl.mediaId);
				if (!media?.file) throw new Error("Media file not available");

				setProgress(10);

				const opts: ReframeOptions = {
					...getDefaultReframeOptions(),
					targetWidth: preset.width,
					targetHeight: preset.height,
					...options,
				};

				let detection: FaceDetectionResult | null = null;
				try {
					detection = await aiClient.detectFaces(media.file, {
						sampleInterval: 0.5,
						maxSamples: 240,
					});
				} catch {
					// Face service unreachable — fall through to the
					// content-aware crop fallback below.
				}

				if (!hasUsableFaces(detection)) {
					// No faces found (or service down): pick a static crop
					// window with smartcrop.js on sampled frames and feed it
					// through the same keyframe path a face result uses.
					setProgress(40);
					detection = await smartcropFallbackDetection(media.file, {
						targetWidth: opts.targetWidth,
						targetHeight: opts.targetHeight,
					});
				}

				setProgress(60);
				setStatus("computing");

				const keyframes = computeReframeKeyframes(detection, opts);

				setProgress(80);

				const reframeResult: ReframeResult = {
					keyframes,
					preset,
					detectionResult: detection,
					framesAnalyzed: detection.frames.length,
				};

				setResult(reframeResult);
				setProgress(100);
				setStatus("done");
			} catch (err) {
				setStatus("error");
				setError(err instanceof Error ? err.message : "Smart Reframe failed");
			}
		},
		[editor],
	);

	const applyKeyframes = useCallback(() => {
		if (!result) return;

		setStatus("applying");

		try {
			const tracks = editor.timeline.getTracks();
			for (const track of tracks) {
				for (const element of track.elements) {
					if (element.type !== "video") continue;
					if (!(element as VideoElement).mediaId) continue;

					const animations = { ...element.animations };
					const channels = { ...animations?.channels };

					if (result.keyframes.positionX.length > 0) {
						channels["transform.position.x"] = {
							valueKind: "number",
							keyframes: result.keyframes.positionX as NumberKeyframe[],
						};
					}

					if (result.keyframes.positionY.length > 0) {
						channels["transform.position.y"] = {
							valueKind: "number",
							keyframes: result.keyframes.positionY as NumberKeyframe[],
						};
					}

					if (result.keyframes.scale.length > 0) {
						channels["transform.scale"] = {
							valueKind: "number",
							keyframes: result.keyframes.scale as NumberKeyframe[],
						};
					}

					element.animations = { channels };
				}
			}

			setStatus("done");
		} catch (err) {
			setStatus("error");
			setError(
				err instanceof Error ? err.message : "Failed to apply keyframes",
			);
		}
	}, [result, editor]);

	const reset = useCallback(() => {
		setStatus("idle");
		setProgress(0);
		setResult(null);
		setError(null);
	}, []);

	return {
		status,
		progress,
		result,
		error,
		startReframe,
		applyKeyframes,
		reset,
	};
}
