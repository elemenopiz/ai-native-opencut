import { EXPORT_MIME_TYPES } from "@/constants/export-constants";
import type {
	ExportContainerFormat,
	ExportJobStatus,
	ExportResult,
} from "@/types/export";

export function getExportMimeType({
	format,
}: {
	format: ExportContainerFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportContainerFormat;
}): string {
	return `.${format}`;
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}

/**
 * Mints a stable id for one export attempt. Minted once per verb/button
 * invocation and threaded through the response envelope (not yet through
 * the renderer itself — see {@link commitExport} doc for why) so a future
 * FIFO queue and `manage_exports {list|cancel}` verb can key progress/cancel
 * state on it without changing what callers already receive.
 */
export function createExportJobId(): string {
	return crypto.randomUUID();
}

/**
 * Outcome of routing a finished (or cancelled/failed) {@link ExportResult}
 * through {@link commitExport}. `status` intentionally reuses
 * {@link ExportJobStatus} — see that type for why the enum is bigger than
 * what we emit today.
 */
export type ExportCommitOutcome =
	| {
			status: Extract<ExportJobStatus, "completed">;
			jobId: string;
			bytes: number;
			downloaded: boolean;
	  }
	| {
			status: Extract<ExportJobStatus, "failed">;
			jobId: string;
			reason: "cancelled" | "render-failed" | "empty-buffer";
			/**
			 * Always a human-safe sentence — no raw `DOMException` text, codec
			 * string, provider name, or file path. This is the only field any
			 * customer-facing surface (Director chat, export UI) should render.
			 * See the standing "no errors to customers" directive: silent
			 * retry → friendly line → details collapsed.
			 */
			message: string;
			/**
			 * The underlying failure exactly as the renderer reported it (e.g.
			 * a raw `DOMException` message or codec string from
			 * `result.error`). Populated only for `reason === "render-failed"`
			 * — `cancelled` and `empty-buffer` never had a raw error to begin
			 * with. For dev-side logging/telemetry ONLY; never render this to
			 * an end user.
			 */
			detail?: string;
	  };

/**
 * WRITE-PATH AUDIT (2026-07-14, docs/poach/palmier-delta-refresh-2026-07-14.md
 * §4.4 — idea only; clean-room, no palmier-pro source consulted): our export
 * pipeline (`SceneExporter` → mediabunny `Output` with a `BufferTarget`,
 * see services/renderer/scene-exporter.ts) renders entirely into an
 * in-memory `ArrayBuffer`. Nothing is written incrementally to OPFS, disk,
 * or R2 during encode — there is no durable partial file that a crash could
 * leave behind, because there is no file at all until the whole thing is
 * done. The one durable-ish "destination" in this pipeline is the browser's
 * own download manager, reached via a single anchor-click handoff of the
 * COMPLETE blob (`downloadBuffer`) — never a stream the OS writes to
 * incrementally, and never something we can partially overwrite. A prior
 * successful download is therefore never at risk: by the time this module
 * could touch it, that file has already left our runtime for good.
 *
 * What *wasn't* previously guaranteed in one place is that every call site
 * agreed on "only hand off a buffer that finished a full, non-cancelled
 * encode." Two call sites (the Export button and the Director/MCP `export`
 * verb) each inlined that check separately, which is exactly the kind of
 * duplication that drifts. `commitExport` is the single gate both route
 * through now — the staged-output analog for a pipeline with no durable
 * temp file to stage: the "temp" is the `ArrayBuffer` living only in this
 * function's stack until every guard passes, and "promote" is the one
 * `downloadBuffer` call at the bottom. Cancelled/failed results never reach
 * it; there is nothing left to "clean up" for those cases beyond letting the
 * (never-returned) buffer be garbage collected — `SceneExporter.export`
 * already returns `null` before `output.finalize()` on cancellation, so a
 * cancelled run never even produces a buffer to guard against.
 *
 * If/when export gains a durable intermediate (OPFS scratch file, staged R2
 * key) for a queued/background render, THIS is the function that grows a
 * real `.{stem}-{uuid}.partial` write + atomic promote — the call sites
 * below don't need to change.
 */
export function commitExport({
	result,
	jobId,
	filename,
	mimeType,
	download = true,
}: {
	result: ExportResult;
	jobId: string;
	filename: string;
	mimeType: string;
	/** Skip the actual browser handoff (Director `download: false`) while
	 * still reporting completion — the render still ran, we just don't
	 * trigger a download for it. */
	download?: boolean;
}): ExportCommitOutcome {
	if (result.cancelled) {
		return {
			status: "failed",
			jobId,
			reason: "cancelled",
			message: "Export was cancelled.",
		};
	}
	if (!result.success) {
		// NEVER forward `result.error` verbatim as `message` — it's whatever
		// the renderer/browser encoder produced (raw `DOMException` text, a
		// codec string, etc.) and this is the last beat of the export flow,
		// surfaced straight to chat by the Director's exportReel wrapper with
		// no sanitisation of its own. The raw text survives on `detail` for
		// dev-side logging; the customer only ever sees the sentence below.
		return {
			status: "failed",
			jobId,
			reason: "render-failed",
			message: "We couldn't finish this export. Please try again.",
			detail: result.error ?? "unknown error",
		};
	}
	if (!result.buffer) {
		return {
			status: "failed",
			jobId,
			reason: "empty-buffer",
			message: "Export finished with no output buffer.",
		};
	}

	// Sole handoff point: only reachable once the encode fully succeeded,
	// wasn't cancelled, and actually produced bytes.
	if (download) {
		downloadBuffer({ buffer: result.buffer, filename, mimeType });
	}

	return {
		status: "completed",
		jobId,
		bytes: result.buffer.byteLength,
		downloaded: download,
	};
}
