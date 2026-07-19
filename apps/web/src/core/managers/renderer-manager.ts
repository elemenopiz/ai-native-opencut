import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportOptions, ExportResult } from "@/types/export";
import type { TimelineTrack } from "@/types/timeline";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { buildScene } from "@/services/renderer/scene-builder";
import { resolveExportProxyFallback } from "@/services/renderer/export-decodability";
import { createTimelineAudioBuffer } from "@/lib/media/audio";
import { formatTimeCode, getLastFrameTime } from "@/lib/time";
import { downloadBlob } from "@/utils/browser";
import { isVisualElement } from "@/lib/timeline";

/**
 * BUG17 — does this scene have anything to actually paint? Mirrors
 * `scene-builder`'s own visibility filtering (a hidden track or a hidden
 * element contributes no pixels, same as `buildScene`/`getVisibleSortedElements`
 * treat them) so this stays in lockstep with what `buildScene` would actually
 * render — an audio/effect-only timeline (or one where every visual element is
 * hidden) reports `false` here. Effect elements are deliberately excluded:
 * they recolor/blur *other* layers rather than paint content of their own, so
 * an effect-only track without any video/image/text/sticker underneath still
 * has nothing to show. Used by `exportProject` to (a) suppress the video
 * track entirely for an audio-only export (see `SceneExporter`'s
 * `includeVideoTrack`) and (b) fail fast when there's neither visual content
 * nor audio to export at all.
 */
export function hasVisualContent({
	tracks,
}: {
	tracks: TimelineTrack[];
}): boolean {
	return tracks.some((track) => {
		if ("hidden" in track && track.hidden) return false;
		return track.elements.some(
			(element) =>
				isVisualElement(element) && !("hidden" in element && element.hidden),
		);
	});
}

export class RendererManager {
	private renderTree: RootNode | null = null;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		try {
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;

			// The live render tree is the PREVIEW scene (capped video decode tier,
			// downscaled images, proxies). Build a fresh full-quality scene — like
			// exportProject below — so snapshots match export output, not preview.
			const renderTree = buildScene({
				tracks: this.editor.timeline.getTracks(),
				mediaAssets: this.editor.media.getAssets(),
				duration,
				canvasSize,
				background: activeProject.settings.background,
			});

			const currentTime = this.editor.playback.getCurrentTime();
			const lastFrameTime = getLastFrameTime({ duration, fps });
			const renderTime = Math.min(currentTime, lastFrameTime);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimeCode({
				timeInSeconds: renderTime,
				fps,
			}).replace(/:/g, "-");
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			downloadBlob({ blob, filename });
			return { success: true };
		} catch (error) {
			console.error("Save snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async exportProject({
		options,
		onProgress,
		onCancel,
	}: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		const {
			format,
			quality,
			fps,
			includeAudio,
			includeWatermark,
			dimensions,
			audioOnly,
		} = options;

		try {
			const tracks = this.editor.timeline.getTracks();
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			// Cross-browser decode fallback (HEVC/VP9/AV1 "passthrough" assets):
			// re-check decodability against THIS browser via the persisted codec
			// string, independent of whatever the ingesting browser decided. An
			// asset that can't decode here but has a portable H.264 proxy exports
			// from the proxy instead (flagged via `warnings` below); an asset with
			// neither blocks the export outright rather than silently producing a
			// broken file. See `services/renderer/export-decodability.ts`.
			const { fallbackAssetIds, blockingAssets, warnings } =
				await resolveExportProxyFallback({ mediaAssets });

			if (blockingAssets.length > 0) {
				const names = blockingAssets
					.map((asset) => `"${asset.name}"`)
					.join(", ");
				return {
					success: false,
					error: `${names} can't be exported yet — your browser can't decode the original video and its portable proxy is still being prepared. Try exporting again in a moment.`,
				};
			}

			const exportFps = fps || activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;
			// The scene is always BUILT and RENDERED at the project's own
			// canvasSize — scene elements are positioned in absolute canvas
			// coordinates relative to it, so rendering at a different size would
			// recompose (crop/reveal) the shot. A preset's dimensions only
			// control the final output canvas; SceneExporter contain-fit blits
			// each rendered frame onto it. No dimensions (Custom / default) means
			// outputSize === canvasSize, which SceneExporter treats as a no-op.
			const outputSize = dimensions ?? canvasSize;

			// GIF is a silent animated image — it has no audio track, so never
			// spend time building the timeline mixdown for it regardless of the
			// includeAudio flag.
			const withAudio = includeAudio && format !== "gif";

			let audioBuffer: AudioBuffer | null = null;
			if (withAudio) {
				onProgress?.({ progress: 0.05 });
				audioBuffer = await createTimelineAudioBuffer({
					tracks,
					mediaAssets,
					duration,
				});
			}

			// BUG17: an audio-only project (no video/image/text/sticker element on
			// any visible track) has nothing for SceneExporter to paint, so the
			// video track it produces today is ~90 static background frames at a
			// token bitrate — wasted encode time/bytes, confusing in players. When
			// there's visual content we always export video as before. When there
			// isn't, we still export — as an audio-only MP4/WebM (the container and
			// file extension are unchanged; only the video stream is dropped, see
			// `includeVideoTrack` below) — as long as there's real audio to carry
			// it (`audioBuffer` is non-null only when `createTimelineAudioBuffer`
			// found actual audio elements; it's `null` for `includeAudio` off,
			// GIF exports, or an audio track with no elements/all muted). If
			// there's neither, there is nothing whatsoever to export, so fail fast
			// with a clear message instead of producing an empty/blank file.
			//
			// `audioOnly` (the "Podcast" preset, or a direct caller opting in)
			// forces the video track off even when `hasVisualContent` would
			// otherwise say yes — e.g. a podcast project with a static cover image
			// or waveform visual. It's a user choice layered on top of the same
			// `includeVideoTrack` seam, not a separate code path: the "nothing to
			// export" fail-fast still applies, now keyed on audio alone whenever
			// `audioOnly` is set, since the (possibly present) visual content is
			// being deliberately dropped.
			const includeVideo = audioOnly ? false : hasVisualContent({ tracks });
			if (!includeVideo && !audioBuffer) {
				return {
					success: false,
					error: audioOnly
						? "Nothing to export — audio-only export needs an audio track, but this project has none. Add or enable audio before exporting."
						: "Nothing to export — this project has no visual content and no audio. Add a clip, text, or sticker, or enable audio, before exporting.",
				};
			}

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
				forceProxyAssetIds: fallbackAssetIds,
			});

			const exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				watermark: includeWatermark ?? true,
				quality,
				shouldIncludeAudio: withAudio,
				audioBuffer: audioBuffer || undefined,
				outputSize,
				includeVideoTrack: includeVideo,
			});

			exporter.on("progress", (progress) => {
				const adjustedProgress = withAudio ? 0.05 + progress * 0.95 : progress;
				onProgress?.({ progress: adjustedProgress });
			});

			let cancelled = false;
			const checkCancel = () => {
				if (onCancel?.()) {
					cancelled = true;
					exporter.cancel();
				}
			};

			const cancelInterval = setInterval(checkCancel, 100);

			try {
				const buffer = await exporter.export({ rootNode: scene });
				clearInterval(cancelInterval);

				if (cancelled) {
					return { success: false, cancelled: true };
				}

				if (!buffer) {
					return { success: false, error: "Export failed to produce buffer" };
				}

				return {
					success: true,
					buffer,
					warnings: warnings.length > 0 ? warnings : undefined,
				};
			} finally {
				clearInterval(cancelInterval);
			}
		} catch (error) {
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => fn());
	}
}
