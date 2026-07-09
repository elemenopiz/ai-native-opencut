import type { EditorCore } from "@/core";
import type {
	VideoResolution,
	VideoOrientation,
} from "@/lib/studio/provider-adapter";
import { addClipsToEditor } from "@/lib/studio/add-to-editor";

/**
 * Native "Multiframe" generation. Seedance itself caps at two frames per call
 * (first + last), so we reproduce Dreamina's multi-keyframe sequence the way the
 * editor is built to: generate one flf2v segment between each consecutive pair
 * of keyframes, then lay the finished clips end-to-end on the timeline. No extra
 * provider — just the verified flf2v mode, N-1 times.
 */

const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 120; // ~8 min per segment

export interface MultiframeBase {
	prompt: string;
	resolution: VideoResolution;
	orientation: VideoOrientation;
	duration: number;
	seed?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Submit one first→last frame segment and poll it to a video URL. */
async function generateSegment(
	firstFrame: string,
	lastFrame: string,
	base: MultiframeBase,
): Promise<string | null> {
	const res = await fetch("/api/studio/generate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			prompt: base.prompt,
			referenceImageUrl: firstFrame,
			lastFrameUrl: lastFrame,
			mode: "image-to-video",
			resolution: base.resolution,
			orientation: base.orientation,
			duration: base.duration,
			...(base.seed != null ? { seed: base.seed } : {}),
		}),
	});
	if (!res.ok) return null;

	const data = (await res.json()) as {
		jobId: string;
		status: string;
		videoUrl?: string;
	};
	if (data.status === "completed" && data.videoUrl) return data.videoUrl;

	for (let i = 0; i < MAX_POLLS; i++) {
		await sleep(POLL_INTERVAL_MS);
		const poll = await fetch(`/api/studio/generate/${data.jobId}`);
		if (!poll.ok) continue;
		const j = (await poll.json()) as {
			status: string;
			videoUrl?: string;
		};
		if (j.status === "completed") return j.videoUrl ?? null;
		if (j.status === "failed") return null;
	}
	return null;
}

/**
 * Generate N-1 flf2v segments across the keyframes and append each to the
 * timeline in order. Sequential (not parallel) so clips land in keyframe order.
 */
export async function generateMultiframe({
	editor,
	projectId,
	keyframes,
	base,
	onProgress,
}: {
	editor: EditorCore;
	projectId: string;
	keyframes: string[];
	base: MultiframeBase;
	onProgress?: (done: number, total: number) => void;
}): Promise<{ placed: number; segments: number }> {
	const segments = Math.max(0, keyframes.length - 1);
	let placed = 0;

	for (let i = 0; i < segments; i++) {
		onProgress?.(i, segments);
		try {
			const videoUrl = await generateSegment(
				keyframes[i],
				keyframes[i + 1],
				base,
			);
			if (videoUrl) {
				const { added } = await addClipsToEditor({
					editor,
					projectId,
					clips: [
						{
							id: crypto.randomUUID(),
							videoUrl,
							name: `Multiframe ${i + 1}`,
						},
					],
				});
				if (added > 0) placed++;
			}
		} catch (err) {
			console.error(`Multiframe segment ${i + 1} failed:`, err);
		}
	}

	onProgress?.(segments, segments);
	return { placed, segments };
}
