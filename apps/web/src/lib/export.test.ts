import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExportResult } from "@/types/export";
import { commitExport, createExportJobId } from "@/lib/export";

/**
 * Staged-output write invariant tests (poach: palmier-delta-refresh
 * 2026-07-14 §4.4 — idea only, clean-room, no palmier-pro source consulted).
 *
 * Our export pipeline renders entirely into an in-memory `ArrayBuffer` (see
 * the write-path audit in lib/export.ts on `commitExport`) — there is no
 * OPFS/disk/R2 temp file to inspect after the fact, so "destination
 * untouched on cancel" and "promoted exactly once on success" are verified
 * here as "the browser download handoff (`downloadBuffer`'s DOM writes) is
 * NEVER reached on cancel/failure, and reached EXACTLY ONCE on a genuine
 * success."
 *
 * `document` isn't defined in the bun test runtime, so we install the
 * minimal fake `downloadBuffer` needs (`createElement`, `body.appendChild`,
 * `body.removeChild`) and assert on calls to it — the same role a real
 * browser's download-manager write would play.
 */

type FakeAnchor = {
	href: string;
	download: string;
	click: () => void;
};

let appendedNodes: FakeAnchor[] = [];
let removedNodes: FakeAnchor[] = [];
let clicked: FakeAnchor[] = [];

beforeEach(() => {
	appendedNodes = [];
	removedNodes = [];
	clicked = [];

	(globalThis as { document?: unknown }).document = {
		createElement: () => {
			const anchor: FakeAnchor = {
				href: "",
				download: "",
				click: () => clicked.push(anchor),
			};
			return anchor;
		},
		body: {
			appendChild: (node: FakeAnchor) => appendedNodes.push(node),
			removeChild: (node: FakeAnchor) => removedNodes.push(node),
		},
	};
});

afterEach(() => {
	(globalThis as { document?: unknown }).document = undefined;
});

const jobId = () => createExportJobId();

describe("commitExport — staged-output handoff gate", () => {
	it("never touches the download handoff on a cancelled result (destination untouched)", () => {
		const result: ExportResult = { success: false, cancelled: true };

		const outcome = commitExport({
			result,
			jobId: jobId(),
			filename: "reel.mp4",
			mimeType: "video/mp4",
		});

		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" && outcome.reason).toBe("cancelled");
		expect(appendedNodes).toHaveLength(0);
		expect(clicked).toHaveLength(0);
	});

	it("never touches the download handoff on a failed render", () => {
		const result: ExportResult = { success: false, error: "codec unavailable" };

		const outcome = commitExport({
			result,
			jobId: jobId(),
			filename: "reel.mp4",
			mimeType: "video/mp4",
		});

		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" && outcome.reason).toBe("render-failed");
		expect(appendedNodes).toHaveLength(0);
		expect(clicked).toHaveLength(0);
	});

	it("sanitises a raw renderer failure into a human message, keeping the raw text on `detail`", () => {
		// This is the demo-day defect: a real browser encode failure surfaces
		// as a raw DOMException/codec string. `message` must never carry that
		// verbatim — it's what the Director's exportReel wrapper puts
		// straight into chat with no sanitisation of its own. The raw text
		// must still survive, but only on `detail`, for dev-side logging.
		const result: ExportResult = {
			success: false,
			error:
				"DOMException: codec 'avc1.640028' unavailable at /tmp/scratch.mp4",
		};

		const outcome = commitExport({
			result,
			jobId: jobId(),
			filename: "reel.mp4",
			mimeType: "video/mp4",
		});

		if (outcome.status !== "failed") throw new Error("expected failure");
		expect(outcome.reason).toBe("render-failed");
		expect(outcome.message).not.toMatch(/DOMException/);
		expect(outcome.message).not.toMatch(/codec/i);
		expect(outcome.message).not.toMatch(/avc1/);
		expect(outcome.message).not.toMatch(/\/tmp/);
		expect(outcome.message.length).toBeGreaterThan(0);
		expect(outcome.detail).toBe(
			"DOMException: codec 'avc1.640028' unavailable at /tmp/scratch.mp4",
		);
	});

	it("falls back to a generic detail when the renderer reports failure with no error text", () => {
		const result: ExportResult = { success: false };

		const outcome = commitExport({
			result,
			jobId: jobId(),
			filename: "reel.mp4",
			mimeType: "video/mp4",
		});

		if (outcome.status !== "failed") throw new Error("expected failure");
		expect(outcome.reason).toBe("render-failed");
		expect(outcome.detail).toBe("unknown error");
	});

	it("never touches the download handoff when success is reported with no buffer", () => {
		const result: ExportResult = { success: true };

		const outcome = commitExport({
			result,
			jobId: jobId(),
			filename: "reel.mp4",
			mimeType: "video/mp4",
		});

		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" && outcome.reason).toBe("empty-buffer");
		expect(appendedNodes).toHaveLength(0);
		expect(clicked).toHaveLength(0);
	});

	it("promotes exactly once on a genuine success", () => {
		const buffer = new ArrayBuffer(1024);
		const result: ExportResult = { success: true, buffer };
		const id = jobId();

		const outcome = commitExport({
			result,
			jobId: id,
			filename: "reel.mp4",
			mimeType: "video/mp4",
		});

		expect(outcome).toEqual({
			status: "completed",
			jobId: id,
			bytes: 1024,
			downloaded: true,
		});
		expect(appendedNodes).toHaveLength(1);
		expect(clicked).toHaveLength(1);
		expect(removedNodes).toHaveLength(1);
		expect(appendedNodes[0]?.download).toBe("reel.mp4");
	});

	it("reports completion without touching the handoff when download is opted out (download: false)", () => {
		const buffer = new ArrayBuffer(2048);
		const result: ExportResult = { success: true, buffer };
		const id = jobId();

		const outcome = commitExport({
			result,
			jobId: id,
			filename: "reel.mp4",
			mimeType: "video/mp4",
			download: false,
		});

		expect(outcome).toEqual({
			status: "completed",
			jobId: id,
			bytes: 2048,
			downloaded: false,
		});
		expect(appendedNodes).toHaveLength(0);
		expect(clicked).toHaveLength(0);
	});

	it("a prior successful download is never re-touched by a later commitExport call", () => {
		const first = commitExport({
			result: { success: true, buffer: new ArrayBuffer(10) },
			jobId: jobId(),
			filename: "reel.mp4",
			mimeType: "video/mp4",
		});
		expect(first.status).toBe("completed");
		expect(appendedNodes).toHaveLength(1);

		// A second export attempt that fails/cancels must not touch the DOM
		// again — there is nothing for it to "clobber": the prior download
		// already left our runtime via the browser's own download manager,
		// and this call produces no buffer to hand off.
		const second = commitExport({
			result: { success: false, cancelled: true },
			jobId: jobId(),
			filename: "reel.mp4",
			mimeType: "video/mp4",
		});
		expect(second.status).toBe("failed");
		expect(appendedNodes).toHaveLength(1); // unchanged since the first call
	});
});

describe("createExportJobId", () => {
	it("returns RFC-4122-shaped, unique ids", () => {
		const a = createExportJobId();
		const b = createExportJobId();
		const uuidRe =
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

		expect(a).toMatch(uuidRe);
		expect(b).toMatch(uuidRe);
		expect(a).not.toBe(b);
	});
});
