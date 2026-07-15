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
 * The canvas kinds the encode core can draw into — exactly what mediabunny's
 * `CanvasSource` constructor accepts. Lets the same encode loop run against a
 * DOM `<canvas>` on the main thread or an `OffscreenCanvas` in a worker.
 */
export type ProxyCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface ProxyEncodeOptions extends ProxyGenerateOptions {
	/**
	 * Creates the scratch canvas the encode loop draws each decoded frame
	 * into. Called once with the computed proxy dimensions. On the main
	 * thread this is `document.createElement("canvas")`; in a worker it is
	 * `new OffscreenCanvas(width, height)`.
	 */
	createCanvas: (width: number, height: number) => ProxyCanvas;
}

/**
 * Minimal structural view of a 2D context shared by
 * `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D`.
 * TypeScript cannot call overloaded methods (`getContext`, `drawImage`)
 * through a union of the two canvas/context types, so the encode loop goes
 * through this common surface instead — runtime behavior is identical.
 */
interface ProxyDrawContext {
	clearRect(x: number, y: number, w: number, h: number): void;
	drawImage(
		image: CanvasImageSource,
		dx: number,
		dy: number,
		dw: number,
		dh: number,
	): void;
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

/**
 * Canvas-agnostic encode core: probes the source's video track, decodes every
 * frame via mediabunny's `CanvasSink`, draws each frame into the injected
 * canvas, and re-encodes to an H.264 MP4 via WebCodecs (`CanvasSource`).
 *
 * The canvas is injected (rather than created here) so the identical encode
 * logic can run on the main thread against a DOM `<canvas>` or inside a Web
 * Worker against an `OffscreenCanvas`. Main-thread callers should use
 * {@link generateProxy}; a worker calls this directly with an
 * `OffscreenCanvas` factory.
 */
export async function runProxyEncode(
	options: ProxyEncodeOptions,
): Promise<ProxyGenerateResult> {
	const { file, resolution, onProgress, signal, createCanvas } = options;
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

		const canvas = createCanvas(proxyWidth, proxyHeight);
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

				const ctx = canvas.getContext("2d") as ProxyDrawContext | null;
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

export async function generateProxy(
	options: ProxyGenerateOptions,
): Promise<ProxyGenerateResult> {
	return runProxyEncode({
		...options,
		createCanvas: () => document.createElement("canvas"),
	});
}
