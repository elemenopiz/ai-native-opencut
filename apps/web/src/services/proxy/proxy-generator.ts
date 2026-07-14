import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	Output,
	Mp4OutputFormat,
	BufferTarget,
	CanvasSource,
	QUALITY_LOW,
} from "mediabunny";
import type { ProxyResolution } from "@/services/storage/types";
import { PROXY_PRESETS } from "@/services/storage/types";

export interface ProxyGenerateOptions {
	file: File;
	resolution: ProxyResolution;
	onProgress?: (progress: number) => void;
	signal?: AbortSignal;
}

export interface ProxyGenerateResult {
	file: File;
	width: number;
	height: number;
}

/**
 * Fit a source into a preset's box and snap each axis to an even number.
 *
 * The AVC (H.264) WebCodecs encoder rejects odd dimensions ("both width and
 * height must be even numbers"), so plain rounding is unsafe: e.g. a 3840x2160
 * source at the "480p" preset scales to 853.3x480 and `Math.round` yields an
 * odd 853 width, which throws when the CanvasSource is constructed. We floor
 * each axis to the nearest even number — this also guarantees we stay within
 * the preset box (never exceeds the max) and never upscales — with a floor of 2
 * so a tiny source can't collapse to a zero dimension.
 */
export function computeProxyDimensions(
	origWidth: number,
	origHeight: number,
	preset: { maxWidth: number; maxHeight: number },
): { width: number; height: number } {
	const scale = Math.min(
		preset.maxWidth / origWidth,
		preset.maxHeight / origHeight,
		1,
	);
	const toEven = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
	return {
		width: toEven(origWidth * scale),
		height: toEven(origHeight * scale),
	};
}

export async function generateProxy(
	options: ProxyGenerateOptions,
): Promise<ProxyGenerateResult> {
	const { file, resolution, onProgress, signal } = options;
	const preset = PROXY_PRESETS[resolution];

	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error("No video track found");

		const canDecode = await videoTrack.canDecode();
		if (!canDecode) throw new Error("Video codec not supported for decoding");

		const origWidth = videoTrack.displayWidth;
		const origHeight = videoTrack.displayHeight;
		const duration = await videoTrack.computeDuration();

		if (duration <= 0) throw new Error("Video has no duration");

		const { width: proxyWidth, height: proxyHeight } = computeProxyDimensions(
			origWidth,
			origHeight,
			preset,
		);

		const stats = await videoTrack.computePacketStats();
		const fps = Math.min(stats.averagePacketRate ?? 30, 30);
		const frameCount = Math.ceil(duration * fps);

		const canvas = document.createElement("canvas");
		canvas.width = proxyWidth;
		canvas.height = proxyHeight;

		const sink = new CanvasSink(videoTrack, {
			poolSize: 2,
			fit: "contain",
		});

		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const videoSource = new CanvasSource(canvas, {
			codec: "avc",
			bitrate: QUALITY_LOW,
		});

		output.addVideoTrack(videoSource, { frameRate: fps });
		await output.start();

		const iterator = sink.canvases(0);
		let framesProcessed = 0;

		try {
			for await (const frame of iterator) {
				if (signal?.aborted) {
					await output.cancel();
					throw new Error("Proxy generation cancelled");
				}

				const ctx = canvas.getContext("2d");
				if (ctx) {
					ctx.clearRect(0, 0, proxyWidth, proxyHeight);
					ctx.drawImage(frame.canvas, 0, 0, proxyWidth, proxyHeight);
				}

				await videoSource.add(frame.timestamp, frame.duration);

				framesProcessed++;
				if (onProgress && framesProcessed % 5 === 0) {
					onProgress(Math.min(framesProcessed / frameCount, 0.99));
				}

				if (frame.timestamp >= duration - frame.duration) break;
			}
		} finally {
			try {
				await iterator.return();
			} catch {}
		}

		videoSource.close();
		await output.finalize();

		const buffer = output.target.buffer;
		if (!buffer) throw new Error("Failed to generate proxy");

		const proxyFile = new File([buffer], `proxy_${file.name}`, {
			type: "video/mp4",
		});

		onProgress?.(1);

		return { file: proxyFile, width: proxyWidth, height: proxyHeight };
	} finally {
		input.dispose();
	}
}
