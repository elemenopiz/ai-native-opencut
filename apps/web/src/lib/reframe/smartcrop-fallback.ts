import type { FaceDetectionResult } from "@/types/ai";

/**
 * Content-aware crop fallback for auto-reframe.
 *
 * When face detection finds no faces (or the face service is unreachable),
 * we run smartcrop.js on a few sampled keyframes (first / middle / last),
 * average the suggested crop windows, and synthesize a
 * `FaceDetectionResult`-shaped payload whose single "face" bbox is the crop
 * window. That feeds the exact same downstream `computeReframeKeyframes`
 * path the real face result uses.
 *
 * Conservative v1: a single static crop (one keyframe at t=0) — no
 * per-frame tracking.
 */

/** Max dimension (px) frames are downscaled to before running smartcrop. */
const MAX_ANALYSIS_DIMENSION = 640;

/** Relative positions within the clip to sample (first / middle / last). */
const SAMPLE_POSITIONS = [0.05, 0.5, 0.95];

interface CropWindow {
	x: number;
	y: number;
	width: number;
	height: number;
}

function loadVideo(
	file: File,
): Promise<{ video: HTMLVideoElement; url: string }> {
	const url = URL.createObjectURL(file);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";

	return new Promise((resolve, reject) => {
		video.onloadedmetadata = () => resolve({ video, url });
		video.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Could not load video for content-aware crop"));
		};
		video.src = url;
	});
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Timed out seeking video for content-aware crop")),
			10_000,
		);
		video.onseeked = () => {
			clearTimeout(timeout);
			resolve();
		};
		video.onerror = () => {
			clearTimeout(timeout);
			reject(new Error("Video error while seeking for content-aware crop"));
		};
		video.currentTime = time;
	});
}

/**
 * Run smartcrop.js on a few sampled frames and return a static,
 * FaceDetectionResult-compatible detection whose single bbox is the averaged
 * best crop window (in source-video pixel coordinates).
 *
 * Throws if the video cannot be decoded in the browser — callers should
 * treat that as "no reframe signal" and keep the centered default.
 */
export async function smartcropFallbackDetection(
	file: File,
	options: { targetWidth: number; targetHeight: number },
): Promise<FaceDetectionResult> {
	const smartcrop = (await import("smartcrop")).default;

	const { video, url } = await loadVideo(file);

	try {
		const vw = video.videoWidth;
		const vh = video.videoHeight;
		if (!vw || !vh) {
			throw new Error("Video has no decodable dimensions");
		}

		const duration = Number.isFinite(video.duration) ? video.duration : 0;

		// Downscale for analysis speed; smartcrop is content-saliency based
		// and does not need full resolution.
		const scale = Math.min(1, MAX_ANALYSIS_DIMENSION / Math.max(vw, vh));
		const cw = Math.max(1, Math.round(vw * scale));
		const ch = Math.max(1, Math.round(vh * scale));

		// Largest crop window with the target aspect that fits in the source.
		const targetAspect = options.targetWidth / options.targetHeight;
		const cropW = Math.min(cw, Math.round(ch * targetAspect));
		const cropH = Math.min(ch, Math.round(cropW / targetAspect));

		const canvas = document.createElement("canvas");
		canvas.width = cw;
		canvas.height = ch;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Could not create canvas context");

		const sampleTimes =
			duration > 0.5
				? SAMPLE_POSITIONS.map((p) => p * duration)
				: [Math.min(0.01, duration)];

		const crops: CropWindow[] = [];
		for (const time of sampleTimes) {
			try {
				await seekTo(video, time);
				ctx.drawImage(video, 0, 0, cw, ch);
				const { topCrop } = await smartcrop.crop(canvas, {
					width: cropW,
					height: cropH,
					ruleOfThirds: true,
				});
				crops.push(topCrop);
			} catch {
				// Skip frames that fail to seek/decode; any single good frame
				// is enough for a static crop.
			}
		}

		if (crops.length === 0) {
			throw new Error("Content-aware crop could not analyze any frames");
		}

		// Conservative static crop: average the crop windows across samples.
		const avgX = crops.reduce((a, c) => a + c.x, 0) / crops.length;
		const avgY = crops.reduce((a, c) => a + c.y, 0) / crops.length;

		// Map back from analysis scale to source-video pixels.
		const bbox = {
			x: avgX / scale,
			y: avgY / scale,
			width: crops[0].width / scale,
			height: crops[0].height / scale,
			confidence: 1,
		};

		return {
			frames: [{ timestamp: 0, faces: [bbox] }],
			video_width: vw,
			video_height: vh,
			duration,
			// Honest: no faces were detected — the bbox is a content-aware
			// crop window, not a face.
			total_faces_detected: 0,
		};
	} finally {
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(url);
	}
}

/** True when a face-service result contains at least one usable face. */
export function hasUsableFaces(
	detection: FaceDetectionResult | null | undefined,
): detection is FaceDetectionResult {
	return Boolean(
		detection &&
			detection.video_width > 0 &&
			detection.video_height > 0 &&
			detection.frames.some((frame) => frame.faces.length > 0),
	);
}
