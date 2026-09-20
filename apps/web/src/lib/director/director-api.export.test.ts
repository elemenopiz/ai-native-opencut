import { describe, expect, it, mock } from "bun:test";
import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import type { ExportOptions, ExportResult } from "@/types/export";
import { createDirectorApi } from "./director-api";

/** RFC-4122-shaped UUID, matching `crypto.randomUUID()`'s output. */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Minimal `EditorCore` stub exposing only what `exportReel` touches:
 * `project.getActiveOrNull` / `project.export` and `timeline.getTotalDuration`.
 * `download: false` is passed by every test so the browser-only `downloadBuffer`
 * (needs `document`) is never reached in this headless run — the point under
 * test is that the verb DELEGATES to the real `editor.project.export` path.
 */
function makeEditor(opts: {
	project?: {
		settings: { fps: number };
		metadata: { name: string };
	} | null;
	totalDuration?: number;
	exportResult?: ExportResult;
}) {
	const exportSpy = mock(
		async (_args: { options: ExportOptions }): Promise<ExportResult> =>
			opts.exportResult ?? { success: true, buffer: new ArrayBuffer(2048) },
	);
	const editor = {
		project: {
			getActiveOrNull: () => opts.project ?? null,
			export: exportSpy,
		},
		timeline: {
			getTotalDuration: () => opts.totalDuration ?? 12,
		},
		command: new CommandManager(),
	} as unknown as EditorCore;
	return { editor, exportSpy };
}

describe("director exportReel", () => {
	it("delegates to editor.project.export with project fps + defaults", async () => {
		const { editor, exportSpy } = makeEditor({
			project: { settings: { fps: 30 }, metadata: { name: "My Reel" } },
			totalDuration: 12,
			exportResult: { success: true, buffer: new ArrayBuffer(3 * 1024 * 1024) },
		});
		const director = createDirectorApi(editor);

		const result = await director.export({ download: false });

		expect(exportSpy).toHaveBeenCalledTimes(1);
		expect(exportSpy.mock.calls[0][0].options).toEqual({
			format: "mp4",
			quality: "high",
			fps: 30,
			includeAudio: true,
			includeWatermark: true,
		});
		expect(result.ok).toBe(true);
		expect(result.data).toEqual({
			jobId: expect.stringMatching(UUID_RE),
			status: "completed",
			format: "mp4",
			bytes: 3 * 1024 * 1024,
			durationSeconds: 12,
			downloaded: false,
		});
	});

	it("forwards caller overrides to the export options", async () => {
		const { editor, exportSpy } = makeEditor({
			project: { settings: { fps: 24 }, metadata: { name: "Reel" } },
		});
		const director = createDirectorApi(editor);

		await director.export({
			format: "webm",
			quality: "low",
			includeAudio: false,
			includeWatermark: false,
			download: false,
		});

		expect(exportSpy.mock.calls[0][0].options).toEqual({
			format: "webm",
			quality: "low",
			fps: 24,
			includeAudio: false,
			includeWatermark: false,
		});
	});

	it("fails cleanly when there is no active project", async () => {
		const { editor, exportSpy } = makeEditor({ project: null });
		const director = createDirectorApi(editor);

		const result = await director.export({ download: false });

		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/no active project/i);
		expect(exportSpy).not.toHaveBeenCalled();
		// Preflight rejection (bad input, not a job outcome) — no jobId was
		// ever minted because no job was ever attempted.
		expect(result.data).toBeUndefined();
	});

	it("refuses to render an empty timeline", async () => {
		const { editor, exportSpy } = makeEditor({
			project: { settings: { fps: 30 }, metadata: { name: "Reel" } },
			totalDuration: 0,
		});
		const director = createDirectorApi(editor);

		const result = await director.export({ download: false });

		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/empty/i);
		expect(exportSpy).not.toHaveBeenCalled();
		expect(result.data).toBeUndefined();
	});

	it("surfaces a failed render as a failed DirectorResult carrying a jobId", async () => {
		const { editor } = makeEditor({
			project: { settings: { fps: 30 }, metadata: { name: "Reel" } },
			exportResult: { success: false, error: "codec unavailable" },
		});
		const director = createDirectorApi(editor);

		const result = await director.export({ download: false });

		expect(result.ok).toBe(false);
		// UPDATED (demo-day fix): this used to pin `result.message` matching
		// the raw renderer error verbatim ("codec unavailable") — that was
		// the actual defect: a raw codec/DOMException string flowing straight
		// into chat on the last beat of the export flow. `commitExport` now
		// sanitises `message` before `exportReel` ever sees it (see
		// lib/export.ts), so the raw detail must NOT reach the user-facing
		// message, only a human sentence should.
		expect(result.message).not.toMatch(/codec unavailable/);
		expect(result.message).toMatch(/export failed/i);
		// A job WAS attempted (editor.project.export was called), so it gets
		// a jobId — a future manage_exports {list} could still find it.
		expect(result.data).toEqual({
			jobId: expect.stringMatching(UUID_RE),
			status: "failed",
		});
	});

	it("reports a cancelled export as a failed job carrying a jobId", async () => {
		const { editor } = makeEditor({
			project: { settings: { fps: 30 }, metadata: { name: "Reel" } },
			exportResult: { success: false, cancelled: true },
		});
		const director = createDirectorApi(editor);

		const result = await director.export({ download: false });

		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/cancel/i);
		expect(result.data).toEqual({
			jobId: expect.stringMatching(UUID_RE),
			status: "failed",
		});
	});

	it("mints a fresh jobId per invocation", async () => {
		const { editor } = makeEditor({
			project: { settings: { fps: 30 }, metadata: { name: "Reel" } },
		});
		const director = createDirectorApi(editor);

		const first = await director.export({ download: false });
		const second = await director.export({ download: false });

		expect(first.data?.jobId).toEqual(expect.stringMatching(UUID_RE));
		expect(second.data?.jobId).toEqual(expect.stringMatching(UUID_RE));
		expect(first.data?.jobId).not.toEqual(second.data?.jobId);
	});
});
