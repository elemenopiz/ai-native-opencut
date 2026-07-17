import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { RootNode } from "./nodes/root-node";
import type { ExportContainerFormat, ExportQuality } from "@/types/export";
import { CanvasRenderer } from "./canvas-renderer";
import { computeContainFit } from "./contain-fit";
import { createOffscreenCanvas, getContext2D } from "./canvas-utils";
import { GifEncoder } from "@/lib/export/gif/encoder";

type ExportParams = {
	/** Render size — the CanvasRenderer/scene is built and painted at this
	 * size, unchanged from today's behavior (this is the project's own
	 * canvasSize; scene elements are positioned in absolute coordinates
	 * relative to it, so it must never differ from what `buildScene` used). */
	width: number;
	height: number;
	fps: number;
	format: ExportContainerFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	watermark?: boolean;
	/**
	 * Optional final output pixel size (e.g. a platform preset's dimensions).
	 * When provided and different from width/height, each rendered frame is
	 * contain-fit blitted onto a separate output canvas (uniform scale,
	 * centered, black-filled gutters) which becomes the encode source. When
	 * omitted or equal to width/height, the render canvas is encoded
	 * directly — byte-path identical to before this option existed.
	 */
	outputSize?: { width: number; height: number };
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportContainerFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;

	/**
	 * Output canvas for the contain-fit blit stage. Only created when
	 * `outputSize` is provided and differs from the render size — otherwise
	 * stays null and the render canvas is encoded directly, preserving the
	 * original byte path.
	 */
	private outputCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
	private outputContext:
		| OffscreenCanvasRenderingContext2D
		| CanvasRenderingContext2D
		| null = null;
	private outputRect: { x: number; y: number; width: number; height: number } =
		{ x: 0, y: 0, width: 0, height: 0 };

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		watermark,
		outputSize,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
			watermark: watermark ?? false,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;

		if (
			outputSize &&
			(outputSize.width !== width || outputSize.height !== height)
		) {
			this.outputCanvas = createOffscreenCanvas({
				width: outputSize.width,
				height: outputSize.height,
			});
			this.outputContext = getContext2D(this.outputCanvas);
			if (!this.outputContext) {
				throw new Error("Failed to get output canvas context");
			}
			this.outputRect = computeContainFit({
				src: { width, height },
				dst: outputSize,
			});
		}
	}

	/** The canvas that should be handed to `CanvasSource` — the dedicated
	 * output canvas when a differently-sized preset is active, otherwise the
	 * render canvas itself (today's default path, unchanged). */
	private get encodeCanvas(): OffscreenCanvas | HTMLCanvasElement {
		return this.outputCanvas ?? this.renderer.canvas;
	}

	/** Blits the freshly rendered frame onto the output canvas, contain-fit
	 * with black gutters, when an output canvas is in play. No-op on the
	 * default (no dimensions override) path. */
	private blitToOutputCanvas(): void {
		if (!this.outputCanvas || !this.outputContext) return;

		const ctx = this.outputContext;
		ctx.fillStyle = "black";
		ctx.fillRect(0, 0, this.outputCanvas.width, this.outputCanvas.height);
		ctx.drawImage(
			this.renderer.canvas,
			this.outputRect.x,
			this.outputRect.y,
			this.outputRect.width,
			this.outputRect.height,
		);
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		// GIF is animated-image output with its own clean-room encoder — no
		// mediabunny container, no audio track. It still reuses the shared
		// render loop + contain-fit output stage below via the same
		// encodeCanvas, so presets (dimensions/letterbox) apply identically.
		if (this.format === "gif") {
			return this.exportGif({ rootNode });
		}

		const { fps } = this.renderer;
		const frameCount = Math.ceil(rootNode.duration * fps);

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const output = new Output({
			format: outputFormat,
			target: new BufferTarget(),
		});

		const videoSource = new CanvasSource(this.encodeCanvas, {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
		});

		output.addVideoTrack(videoSource, { frameRate: fps });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
		}

		await output.start();

		if (audioSource && this.audioBuffer) {
			await audioSource.add(this.audioBuffer);
			audioSource.close();
		}

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				await output.cancel();
				this.emit("cancelled");
				return null;
			}

			const time = i / fps;
			await this.renderer.render({ node: rootNode, time });
			this.blitToOutputCanvas();
			await videoSource.add(time, 1 / fps);

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			await output.cancel();
			this.emit("cancelled");
			return null;
		}

		videoSource.close();
		await output.finalize();
		this.emit("progress", 1);

		const buffer = output.target.buffer;
		if (!buffer) {
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", buffer);
		return buffer;
	}

	/**
	 * GIF export path. Renders the scene frame by frame exactly like the video
	 * path (including the contain-fit output stage, so presets apply), reads
	 * each finished frame off the encode canvas as RGBA, and feeds it to the
	 * clean-room {@link GifEncoder}. No audio, no mediabunny. Returns the
	 * complete GIF89a bytes as an ArrayBuffer so callers (commitExport) treat
	 * it uniformly with the video buffers.
	 */
	private async exportGif({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const { fps } = this.renderer;
		const frameCount = Math.ceil(rootNode.duration * fps);

		const encodeCanvas = this.encodeCanvas;
		const encodeContext = getContext2D(encodeCanvas);
		if (!encodeContext) {
			this.emit("error", new Error("Failed to get GIF encode context"));
			return null;
		}

		const gif = new GifEncoder({
			width: encodeCanvas.width,
			height: encodeCanvas.height,
			fps,
		});

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				this.emit("cancelled");
				return null;
			}

			const time = i / fps;
			await this.renderer.render({ node: rootNode, time });
			this.blitToOutputCanvas();

			const frame = encodeContext.getImageData(
				0,
				0,
				encodeCanvas.width,
				encodeCanvas.height,
			);
			gif.addFrame(frame);

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			this.emit("cancelled");
			return null;
		}

		const bytes = gif.finish();
		this.emit("progress", 1);

		// Copy into a standalone ArrayBuffer (the Uint8Array may be a view over
		// a larger backing buffer) so the returned buffer is exactly the GIF.
		const buffer = bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer;

		this.emit("complete", buffer);
		return buffer;
	}
}
