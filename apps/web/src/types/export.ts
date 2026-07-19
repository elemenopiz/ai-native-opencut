export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

/**
 * Container formats the export dialog can produce, a superset of
 * {@link ExportFormat}. GIF is a dialog-only, animated-image output (no audio,
 * encoded by our own clean-room `lib/export/gif` encoder rather than
 * mediabunny). It is intentionally NOT in {@link EXPORT_FORMAT_VALUES}: that
 * narrower enum backs the Director/MCP `export` verb schema and the
 * reference-video encoder in `lib/media/clip-reference.ts`, neither of which
 * should offer GIF. Only the interactive dialog and the render/mime boundary
 * widen to this type.
 */
export const EXPORT_CONTAINER_VALUES = ["mp4", "webm", "gif"] as const;
export type ExportContainerFormat = (typeof EXPORT_CONTAINER_VALUES)[number];

export interface ExportOptions {
	format: ExportContainerFormat;
	quality: ExportQuality;
	fps?: number;
	includeAudio?: boolean;
	includeWatermark?: boolean;
	/**
	 * Force an audio-only export — drop the video track entirely regardless
	 * of what `hasVisualContent` (renderer-manager.ts) would otherwise decide.
	 * Reuses the BUG17 `includeVideoTrack` seam in `SceneExporter`; the only
	 * difference from the automatic path is that this is a user choice (the
	 * "Podcast (audio only)" preset) rather than an inference from the
	 * project's tracks. Still subject to the same "nothing to export"
	 * fail-fast when there's no audio to carry the file.
	 */
	audioOnly?: boolean;
	/**
	 * Output pixel dimensions for a platform preset (e.g. 1080x1920 for
	 * TikTok/Reels). The scene is still built and rendered at the project's
	 * own canvasSize — this only controls the final output canvas, which the
	 * rendered frame is contain-fit (scaled + letterboxed/pillarboxed) into.
	 * Omitted (or Custom preset) means "use the project's canvasSize", which
	 * is a pure passthrough with no extra blit.
	 */
	dimensions?: { width: number; height: number };
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	error?: string;
	cancelled?: boolean;
	/**
	 * Non-blocking, dismissible notices about quality degradation that occurred
	 * during a successful export — e.g. a clip whose original codec this
	 * browser can't decode was exported from its H.264 proxy instead (see
	 * `resolveExportProxyFallback` in `services/renderer/export-decodability.ts`).
	 * Present only when `success` is true; UI shows these as a single
	 * `toast.warning`, matching the CapCut-draft-export precedent.
	 */
	warnings?: string[];
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
}

/**
 * Full intended lifecycle for an export job (poach: palmier-delta-refresh
 * 2026-07-14 §4.4, "Cancellable export queue + staged-output write" — idea
 * only, clean-room: no palmier-pro source consulted, this enum is our own
 * design from the doc's prose). Export is single-shot and synchronous today,
 * so only `"completed"` and `"failed"` are ever actually emitted — the rest
 * of the enum exists so a future FIFO `ExportQueue` can start emitting
 * `queued → preparing → rendering → (canceling) → completed | failed |
 * canceled` without changing the shape callers (Director verb, MCP relay,
 * a future `manage_exports` verb) already depend on.
 */
export const EXPORT_JOB_STATUS_VALUES = [
	"queued",
	"preparing",
	"rendering",
	"canceling",
	"completed",
	"failed",
	"canceled",
] as const;
export type ExportJobStatus = (typeof EXPORT_JOB_STATUS_VALUES)[number];
