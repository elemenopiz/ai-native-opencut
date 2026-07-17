export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: number;
	includeAudio?: boolean;
	includeWatermark?: boolean;
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
