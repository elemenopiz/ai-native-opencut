import { toast } from "sonner";
import type { MediaAsset } from "@/types/assets";
import type { NormalizedFrom } from "@/services/storage/types";
import { getMediaTypeFromFile } from "@/lib/media/media-utils";
import { getVideoInfo } from "./mediabunny";
import {
	probeVideoFile,
	decideNormalization,
	normalizeVideoFile,
} from "./normalize-media";
import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from "mediabunny";

export interface ProcessedMediaAsset extends Omit<MediaAsset, "id"> {}

const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_MAX_HEIGHT = 720;

const getThumbnailSize = ({
	width,
	height,
}: {
	width: number;
	height: number;
}): { width: number; height: number } => {
	const aspectRatio = width / height;
	let targetWidth = width;
	let targetHeight = height;

	if (targetWidth > THUMBNAIL_MAX_WIDTH) {
		targetWidth = THUMBNAIL_MAX_WIDTH;
		targetHeight = Math.round(targetWidth / aspectRatio);
	}
	if (targetHeight > THUMBNAIL_MAX_HEIGHT) {
		targetHeight = THUMBNAIL_MAX_HEIGHT;
		targetWidth = Math.round(targetHeight * aspectRatio);
	}

	return { width: targetWidth, height: targetHeight };
};

const renderToThumbnailDataUrl = ({
	width,
	height,
	draw,
	fullResolution = false,
}: {
	width: number;
	height: number;
	draw: ({
		context,
		width,
		height,
	}: {
		context: CanvasRenderingContext2D;
		width: number;
		height: number;
	}) => void;
	/**
	 * When true, render at the source's NATIVE resolution (no 1280×720 clamp) and
	 * emit lossless PNG instead of JPEG. Used for extracted frames that seed a new
	 * generation, where the 720p thumbnail clamp would degrade the seed. Default
	 * (false) keeps the cheap clamped JPEG every thumbnail caller relies on.
	 */
	fullResolution?: boolean;
}): string => {
	const size = fullResolution
		? { width, height }
		: getThumbnailSize({ width, height });
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	const context = canvas.getContext("2d");

	if (!context) {
		throw new Error("Could not get canvas context");
	}

	draw({ context, width: size.width, height: size.height });
	return fullResolution
		? canvas.toDataURL("image/png")
		: canvas.toDataURL("image/jpeg", 0.8);
};

/**
 * Decode one or more frames from a video in a SINGLE decode pass: the file is
 * opened (demuxed) and the decoder is set up ONCE, then every requested
 * timestamp is sampled from that same pipeline via mediabunny's
 * `samplesAtTimestamps` (which avoids the redundant re-decode of calling
 * `getSample` per timestamp). Returns one JPEG data URL per timestamp that
 * successfully decoded, in the order the sink yields them; timestamps that
 * fall outside the track (yielded as `null`) are skipped. Throws only on a
 * setup failure (no/undecodable video track).
 */
export async function generateThumbnails({
	videoFile,
	timesInSeconds,
	fullResolution = false,
}: {
	videoFile: File;
	timesInSeconds: number[];
	/** Decode at native resolution as PNG (see {@link renderToThumbnailDataUrl}). */
	fullResolution?: boolean;
}): Promise<string[]> {
	if (timesInSeconds.length === 0) return [];

	const input = new Input({
		source: new BlobSource(videoFile),
		formats: ALL_FORMATS,
	});

	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new Error("No video track found in the file");
		}

		const canDecode = await videoTrack.canDecode();
		if (!canDecode) {
			throw new Error("Video codec not supported for decoding");
		}

		// Explicit hardware-decode hint (perf audit #5): measured 2-3x decode
		// throughput + much tighter run-to-run variance vs the WebCodecs default
		// "no-preference". `canDecode()` above already confirmed this
		// codec/config decodes here at all, but not that the hardware path
		// specifically works on this device — a rare failure there falls back
		// to the default and re-runs the decode once rather than losing the
		// thumbnail entirely.
		const decodeAllFrames = async (
			hardwareAcceleration: "prefer-hardware" | "no-preference",
		): Promise<string[]> => {
			const sink = new VideoSampleSink(videoTrack, { hardwareAcceleration });
			const frames: string[] = [];

			for await (const frame of sink.samplesAtTimestamps(timesInSeconds)) {
				if (!frame) continue;
				try {
					frames.push(
						renderToThumbnailDataUrl({
							width: videoTrack.displayWidth,
							height: videoTrack.displayHeight,
							draw: ({ context, width, height }) => {
								frame.draw(context, 0, 0, width, height);
							},
							fullResolution,
						}),
					);
				} finally {
					frame.close();
				}
			}

			return frames;
		};

		try {
			return await decodeAllFrames("prefer-hardware");
		} catch (error) {
			console.warn(
				"prefer-hardware thumbnail decode failed; retrying with no-preference",
				error,
			);
			return await decodeAllFrames("no-preference");
		}
	} finally {
		input.dispose();
	}
}

export async function generateThumbnail({
	videoFile,
	timeInSeconds,
	fullResolution = false,
}: {
	videoFile: File;
	timeInSeconds: number;
	/** Decode at native resolution as PNG (see {@link renderToThumbnailDataUrl}). */
	fullResolution?: boolean;
}): Promise<string> {
	const [thumbnail] = await generateThumbnails({
		videoFile,
		timesInSeconds: [timeInSeconds],
		fullResolution,
	});

	if (!thumbnail) {
		throw new Error("Could not get frame at specified time");
	}

	return thumbnail;
}

export async function generateImageThumbnail({
	imageFile,
}: {
	imageFile: File;
}): Promise<string> {
	return new Promise((resolve, reject) => {
		const image = new window.Image();
		const objectUrl = URL.createObjectURL(imageFile);

		image.addEventListener("load", () => {
			try {
				const dataUrl = renderToThumbnailDataUrl({
					width: image.naturalWidth,
					height: image.naturalHeight,
					draw: ({ context, width, height }) => {
						context.drawImage(image, 0, 0, width, height);
					},
				});
				resolve(dataUrl);
			} catch (error) {
				reject(
					error instanceof Error ? error : new Error("Could not render image"),
				);
			} finally {
				URL.revokeObjectURL(objectUrl);
				image.remove();
			}
		});

		image.addEventListener("error", () => {
			URL.revokeObjectURL(objectUrl);
			image.remove();
			reject(new Error("Could not load image"));
		});

		image.src = objectUrl;
	});
}

export async function processMediaAssets({
	files,
	onProgress,
}: {
	files: FileList | File[];
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<ProcessedMediaAsset[]> {
	const fileArray = Array.from(files);
	const processedAssets: ProcessedMediaAsset[] = [];

	const total = fileArray.length;
	let completed = 0;

	for (const file of fileArray) {
		const fileType = getMediaTypeFromFile({ file });

		if (!fileType) {
			toast.error(`Unsupported file type: ${file.name}`);
			continue;
		}

		// The asset's backing file/url can be SUBSTITUTED below (HEVC → H.264
		// transcode on ingest). Everything downstream — getVideoInfo, thumbnail,
		// the pushed asset — must run against these, not the raw `file`.
		let assetFile = file;
		let assetUrl = URL.createObjectURL(file);
		let normalized: NormalizedFrom | undefined;
		let thumbnailUrl: string | undefined;
		let duration: number | undefined;
		let width: number | undefined;
		let height: number | undefined;
		let fps: number | undefined;

		try {
			if (fileType === "image") {
				const dimensions = await getImageDimensions({ file });
				width = dimensions.width;
				height = dimensions.height;
				thumbnailUrl = await generateImageThumbnail({ imageFile: file });
			} else if (fileType === "video") {
				// Probe BEFORE decoding: a non-portable/undecodable codec (GoPro/
				// iPhone HEVC, etc.) would otherwise slip through as a silent black
				// clip. Transcode when we can; warn when we can't; passthrough is a
				// couple of lazy byte reads and adds no meaningful latency.
				try {
					const probe = await probeVideoFile(file);
					const decision = decideNormalization(probe);

					if (decision === "transcode") {
						const toastId = toast.loading(
							`Converting ${file.name} to a compatible format…`,
						);
						try {
							const normalizedFile = await normalizeVideoFile(file, (p) => {
								toast.loading(
									`Converting ${file.name}… ${Math.round(p * 100)}%`,
									{ id: toastId },
								);
							});
							URL.revokeObjectURL(assetUrl);
							assetFile = normalizedFile;
							assetUrl = URL.createObjectURL(normalizedFile);
							normalized = {
								originalName: file.name,
								originalCodec: probe.videoCodec ?? "unknown",
							};
							toast.success(`Converted ${file.name} to H.264`, { id: toastId });
						} catch (normalizeError) {
							// Never make ingest worse than before: keep the original file
							// and fall through to the existing best-effort decode path.
							console.warn(
								"Video normalization failed; using original file",
								normalizeError,
							);
							toast.dismiss(toastId);
						}
					} else if (decision === "unsupported") {
						// Distinguish "codec we know but this browser can't decode" from
						// "no readable video track at all" (audio-only-in-video-container,
						// unparseable) — the latter shouldn't be blamed on the decoder.
						toast.error(
							probe.parseable && probe.videoCodec
								? `This clip is ${probe.videoCodec.toUpperCase()} and your browser can't decode it. Try Safari, or convert it to H.264 first.`
								: `Couldn't read a video track from ${file.name}. The file may be audio-only or in an unsupported format.`,
						);
					}
				} catch (probeError) {
					// Probe is best-effort; on failure fall through to the legacy path.
					console.warn("Video probe failed", probeError);
				}

				try {
					const videoInfo = await getVideoInfo({ videoFile: assetFile });
					// Decoders can report NaN/Infinity/0 for some containers; leave
					// duration undefined so consumers fall back to a sane default
					// instead of building an element with an invalid duration.
					duration =
						Number.isFinite(videoInfo.duration) && videoInfo.duration > 0
							? videoInfo.duration
							: undefined;
					width = videoInfo.width;
					height = videoInfo.height;
					fps = Number.isFinite(videoInfo.fps)
						? Math.round(videoInfo.fps)
						: undefined;

					// Clamp the grab time to the clip: a fixed 1s offset yields no
					// frame (and a silent failure) for sub-second videos.
					const thumbTime =
						duration && duration > 0 ? Math.min(1, duration / 2) : 0;
					thumbnailUrl = await generateThumbnail({
						videoFile: assetFile,
						timeInSeconds: thumbTime,
					});
				} catch (error) {
					console.warn("Video processing failed", error);
				}
			} else if (fileType === "audio") {
				// For audio, we don't set width/height/fps (they'll be undefined)
				try {
					const d = await getMediaDuration({ file });
					duration = Number.isFinite(d) && d > 0 ? d : undefined;
				} catch (error) {
					console.warn("Audio processing failed", error);
				}
			}

			processedAssets.push({
				name: file.name,
				type: fileType,
				file: assetFile,
				url: assetUrl,
				thumbnailUrl,
				duration,
				width,
				height,
				fps,
				normalized,
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			completed += 1;
			if (onProgress) {
				const percent = Math.round((completed / total) * 100);
				onProgress({ progress: percent });
			}
		} catch (error) {
			console.error("Error processing file:", file.name, error);
			toast.error(`Failed to process ${file.name}`);
			URL.revokeObjectURL(assetUrl); // Clean up on error
		}
	}

	return processedAssets;
}

const getImageDimensions = ({
	file,
}: {
	file: File;
}): Promise<{ width: number; height: number }> => {
	return new Promise((resolve, reject) => {
		const img = new window.Image();
		const objectUrl = URL.createObjectURL(file);

		img.addEventListener("load", () => {
			const width = img.naturalWidth;
			const height = img.naturalHeight;
			resolve({ width, height });
			URL.revokeObjectURL(objectUrl);
			img.remove();
		});

		img.addEventListener("error", () => {
			reject(new Error("Could not load image"));
			URL.revokeObjectURL(objectUrl);
			img.remove();
		});

		img.src = objectUrl;
	});
};

const getMediaDuration = ({ file }: { file: File }): Promise<number> => {
	return new Promise((resolve, reject) => {
		const element = document.createElement(
			file.type.startsWith("video/") ? "video" : "audio",
		) as HTMLVideoElement;
		const objectUrl = URL.createObjectURL(file);

		element.addEventListener("loadedmetadata", () => {
			resolve(element.duration);
			URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.addEventListener("error", () => {
			reject(new Error("Could not load media"));
			URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.src = objectUrl;
		element.load();
	});
};
