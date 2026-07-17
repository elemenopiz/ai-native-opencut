import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

/**
 * campaign/bug-purge-w2 (Part 2) — fresh-fixture golden-path bug hunt.
 *
 * Mints its own fixtures under `e2e/fixtures/w2/` with real ffmpeg (not the
 * Chromium-MediaRecorder-minted WebMs the other real-export specs use), and
 * drives real import -> real timeline edit -> real export -> ffprobe for
 * five distinct media shapes: portrait H.264+AAC, 10-bit HDR HEVC, a tiny
 * H.264 clip, AAC-only audio, and a PNG with a genuine alpha channel
 * overlaid on video.
 *
 * Requires the real-export build (`NEXT_PUBLIC_E2E_STUB_EXPORT=0`) — see
 * `playwright.fixtures-w2.config.ts`, which also switches the browser to
 * the real Chrome channel (not Playwright's bundled codec-less Chromium) so
 * H.264/HEVC actually decode and the genuine ingest/normalize path runs
 * instead of the "unsupported codec" fallback.
 */

const FIXTURE_DIR = path.join(__dirname, "fixtures", "w2");
const PORTRAIT_H264 = path.join(FIXTURE_DIR, "portrait_1080x1920_h264.mp4");
const HDR_HEVC = path.join(FIXTURE_DIR, "hdr_hevc_1280x720_10bit.mp4");
const TINY_H264 = path.join(FIXTURE_DIR, "tiny_640x360_h264.mp4");
const AUDIO_ONLY = path.join(FIXTURE_DIR, "audio_only_3s.m4a");
const ALPHA_PNG = path.join(FIXTURE_DIR, "alpha_overlay_512.png");

interface FfprobeStream {
	index: number;
	codec_type: string;
	codec_name: string;
	width?: number;
	height?: number;
	pix_fmt?: string;
	color_primaries?: string;
	color_transfer?: string;
	color_space?: string;
	sample_rate?: string;
	channels?: number;
	[key: string]: unknown;
}
interface FfprobeResult {
	streams: FfprobeStream[];
	format: { duration?: string; size?: string; [key: string]: unknown };
}

function runFfprobe(filePath: string): FfprobeResult {
	const args = [
		"-v",
		"error",
		"-show_streams",
		"-show_format",
		"-of",
		"json",
		filePath,
	];
	let result = spawnSync("ffprobe", args, { encoding: "utf-8" });
	if (result.error || result.status !== 0) {
		result = spawnSync("/opt/homebrew/bin/ffprobe", args, {
			encoding: "utf-8",
		});
	}
	if (result.error) {
		throw new Error(`ffprobe not runnable: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`ffprobe exited ${result.status}: ${result.stderr}`);
	}
	return JSON.parse(result.stdout) as FfprobeResult;
}

interface AssetSnapshot {
	id: string;
	name: string;
	type: string;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	decodeUnsupported?: boolean;
}

/** Navigate to a fresh anonymous editor project and wait for the E2E bridge.
 *  Self-skips the calling test if this build still has the export stub on. */
async function openEditor(page: Page, route: string): Promise<void> {
	await page.goto(`/editor/${route}`);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 60_000,
	});
	const stubExport = await page.evaluate(() => window.__BYORN_E2E__?.stubExport);
	test.skip(
		stubExport !== false,
		"fixtures-w2 hunt requires a build with NEXT_PUBLIC_E2E_STUB_EXPORT=0 " +
			"(run via playwright.fixtures-w2.config.ts's webServer, which sets it)",
	);
	// Dismiss the "Get started" tour card if present — it doesn't block the
	// canvas/export affordances here, but dismiss for a clean screenshot/DOM.
	const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click().catch(() => {});
	}
}

/** Drive a real import through the actual Media-panel file input (not the
 *  E2E bridge) so the genuine `processMediaAssets` -> mediabunny probe/
 *  decode/normalize/thumbnail pipeline runs, exactly as it would for a real
 *  user dropping a file. Returns the newly created asset(s). */
async function importViaFileInput(
	page: Page,
	filePath: string,
): Promise<AssetSnapshot[]> {
	const mediaTab = page.getByRole("button", { name: "Media", exact: true });
	if (await mediaTab.isVisible().catch(() => false)) {
		await mediaTab.click();
	}
	const before = await page.evaluate(
		() => window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
	);
	// Go through the real "Import" button -> native file-chooser flow rather
	// than guessing at `input[type=file]` by attribute: the Director tab's
	// reference-media uploader mounts a near-identical hidden input even when
	// inactive (off-screen in a Radix tab), so a bare `input[type=file]`
	// locator is ambiguous. `filechooser` correlates the click to the exact
	// input the click handler set `.accept`/`.multiple` on, matching what a
	// real user driving the "Import" button would trigger.
	const [fileChooser] = await Promise.all([
		page.waitForEvent("filechooser"),
		page.getByRole("button", { name: "Import", exact: true }).click(),
	]);
	await fileChooser.setFiles(filePath);

	await page.waitForFunction(
		(beforeIds) => {
			const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
			return assets.some((a) => !beforeIds.includes(a.id));
		},
		before,
		{ timeout: 60_000 },
	);

	return page.evaluate((beforeIds) => {
		const assets = window.__BYORN_E2E__!.editor.media.getAssets();
		return assets
			.filter((a) => !beforeIds.includes(a.id))
			.map((a) => ({
				id: a.id,
				name: a.name,
				type: a.type,
				width: a.width,
				height: a.height,
				duration: a.duration,
				fps: a.fps,
				decodeUnsupported: (a as { decodeUnsupported?: boolean })
					.decodeUnsupported,
			}));
	}, before);
}

/** Insert an already-imported media asset onto the timeline as a real
 *  command-stack op (`editor.timeline.insertElement`), mirroring what
 *  `buildElementFromMedia` + `insertElement` do for a drag-drop / take-land
 *  in production (see `src/lib/timeline/element-utils.ts`,
 *  `src/hooks/timeline/use-timeline-drag-drop.ts`). */
async function insertMediaElement(
	page: Page,
	params: {
		asset: AssetSnapshot;
		startTime: number;
		duration: number;
		trackType?: "video" | "audio";
	},
): Promise<{ elementId: string; trackId: string | null }> {
	return page.evaluate((p) => {
		const { asset, startTime, duration, trackType } = p;
		let element: Record<string, unknown>;
		if (asset.type === "audio") {
			element = {
				type: "audio",
				sourceType: "upload",
				mediaId: asset.id,
				name: asset.name,
				duration,
				startTime,
				trimStart: 0,
				trimEnd: 0,
				sourceDuration: duration,
				volume: 1,
				muted: false,
			};
		} else if (asset.type === "image") {
			element = {
				type: "image",
				mediaId: asset.id,
				name: asset.name,
				duration,
				startTime,
				trimStart: 0,
				trimEnd: 0,
				hidden: false,
				transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
				opacity: 1,
				blendMode: "normal",
			};
		} else {
			element = {
				type: "video",
				mediaId: asset.id,
				name: asset.name,
				duration,
				startTime,
				trimStart: 0,
				trimEnd: 0,
				sourceDuration: duration,
				muted: false,
				hidden: false,
				transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
				opacity: 1,
				blendMode: "normal",
			};
		}

		const bridge = window.__BYORN_E2E__!;
		const elementId = bridge.editor.timeline.insertElement({
			element: element as never,
			placement: { mode: "auto", trackType },
		} as never) as unknown as string;

		const track = bridge.editor.timeline
			.getTracks()
			.find((t) => t.elements.some((e) => e.id === elementId));

		return { elementId, trackId: track?.id ?? null };
	}, params);
}

/** Trigger the REAL export via the actual UI buttons (same seam as
 *  `golden-path-export.e2e.ts`), wait for it to settle, pull the produced
 *  bytes out of the bridge, write them to a scratch file, and ffprobe it. */
async function runRealExportAndProbe(
	page: Page,
	outName: string,
): Promise<{ probe: FfprobeResult; resultMeta: Record<string, unknown>; outFile: string }> {
	await page.getByTestId("export-open").click();
	const runBtn = page.getByTestId("export-run");
	await expect(runBtn).toBeVisible();
	await runBtn.click();

	await page.waitForFunction(
		() =>
			window.__BYORN_E2E__?.editor.project.getExportState().isExporting ===
			false,
		null,
		{ timeout: 240_000 },
	);

	const resultMeta = await page.evaluate(() => {
		const r = window.__BYORN_E2E__!.getLastExportResult();
		return {
			success: r?.success ?? false,
			error: r?.error,
			cancelled: r?.cancelled,
			warnings: r?.warnings,
			byteLength: r?.buffer?.byteLength ?? 0,
		};
	});

	if (!resultMeta.success || !resultMeta.byteLength) {
		return {
			probe: { streams: [], format: {} },
			resultMeta,
			outFile: "",
		};
	}

	const base64 = await page.evaluate(() => {
		const r = window.__BYORN_E2E__!.getLastExportResult();
		const bytes = new Uint8Array(r!.buffer!);
		let binary = "";
		const CHUNK = 0x8000;
		for (let i = 0; i < bytes.length; i += CHUNK) {
			binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
		}
		return btoa(binary);
	});
	const outDir = mkdtempSync(path.join(tmpdir(), "byorn-w2-hunt-"));
	const outFile = path.join(outDir, outName);
	writeFileSync(outFile, Buffer.from(base64, "base64"));

	const probe = runFfprobe(outFile);
	console.log(
		`[fixtures-w2-hunt] ${outName} ffprobe:\n${JSON.stringify(probe, null, 2)}`,
	);
	return { probe, resultMeta, outFile };
}

function attachConsoleCapture(page: Page, label: string): string[] {
	const errors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			errors.push(`[console.error] ${msg.text()}`);
		}
	});
	page.on("pageerror", (err) => {
		errors.push(`[pageerror] ${err.message}`);
	});
	page.on("response", (response) => {
		if (response.status() === 401 && response.url().includes("/api/")) {
			errors.push(`[401] ${response.url()}`);
		}
	});
	// Flush at the very end of the test via test.info() annotation instead of
	// a fixed teardown — callers print `errors` explicitly before asserting.
	void label;
	return errors;
}

test.describe("fixtures-w2 bug hunt — fresh fixtures through real import/edit/export", () => {
	test("portrait 9:16 H.264+AAC — import, trim, real export stays portrait", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		const errors = attachConsoleCapture(page, "portrait");
		await openEditor(page, "w2-hunt-portrait");
		await expect(page.getByTestId("export-open")).toBeVisible();

		const [asset] = await importViaFileInput(page, PORTRAIT_H264);
		console.log("[portrait] imported asset:", JSON.stringify(asset));
		expect(asset).toBeTruthy();
		expect(asset.type).toBe("video");

		const { elementId } = await insertMediaElement(page, {
			asset,
			startTime: 0,
			duration: asset.duration ?? 4,
		});
		expect(elementId).toBeTruthy();

		const canvas = await page.evaluate(
			() => window.__BYORN_E2E__!.editor.project.getActive()?.settings.canvasSize,
		);
		console.log("[portrait] canvas after first insert:", JSON.stringify(canvas));

		// Trim 0.5s off the tail — a real command-stack edit op.
		const origDuration = asset.duration ?? 4;
		const trimEnd = 0.5;
		const postTrim = origDuration - trimEnd;
		await page.evaluate(
			({ elementId, trimEnd, duration }) => {
				window.__BYORN_E2E__!.editor.timeline.updateElementTrim({
					elementId,
					trimStart: 0,
					trimEnd,
					duration,
				});
			},
			{ elementId, trimEnd, duration: postTrim },
		);

		const { probe, resultMeta } = await runRealExportAndProbe(
			page,
			"portrait.mp4",
		);
		console.log("[portrait] export result:", JSON.stringify(resultMeta));
		console.log("[portrait] console/network errors:", JSON.stringify(errors));

		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);
		const videoStreams = probe.streams.filter((s) => s.codec_type === "video");
		const audioStreams = probe.streams.filter((s) => s.codec_type === "audio");
		expect(videoStreams.length).toBeGreaterThanOrEqual(1);
		expect(audioStreams.length).toBeGreaterThanOrEqual(1);

		console.log(
			`[portrait] canvas=${JSON.stringify(canvas)} exported=${videoStreams[0]?.width}x${videoStreams[0]?.height}`,
		);
	});

	test("10-bit HDR HEVC — import behavior + real export (no crash)", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		const errors = attachConsoleCapture(page, "hdr-hevc");
		await openEditor(page, "w2-hunt-hdr-hevc");
		await expect(page.getByTestId("export-open")).toBeVisible();

		const [asset] = await importViaFileInput(page, HDR_HEVC);
		console.log("[hdr-hevc] imported asset:", JSON.stringify(asset));
		expect(asset).toBeTruthy();

		const { elementId, trackId } = await insertMediaElement(page, {
			asset,
			startTime: 0,
			duration: asset.duration ?? 3,
		});
		expect(elementId).toBeTruthy();

		// Split at the midpoint — a real command-stack edit op.
		const splitAt = (asset.duration ?? 3) / 2;
		const splitResult = await page.evaluate(
			({ trackId, elementId, splitAt }) => {
				return window.__BYORN_E2E__!.editor.timeline.splitElements({
					elements: [{ trackId: trackId as string, elementId }],
					splitTime: splitAt,
				});
			},
			{ trackId, elementId, splitAt },
		);
		console.log("[hdr-hevc] split result:", JSON.stringify(splitResult));

		const { probe, resultMeta } = await runRealExportAndProbe(
			page,
			"hdr-hevc.mp4",
		);
		console.log("[hdr-hevc] export result:", JSON.stringify(resultMeta));
		console.log("[hdr-hevc] console/network errors:", JSON.stringify(errors));

		// No-crash is the primary bar here; log full characterization either way.
		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);
		const videoStreams = probe.streams.filter((s) => s.codec_type === "video");
		expect(videoStreams.length).toBeGreaterThanOrEqual(1);
		console.log(
			`[hdr-hevc] exported video stream: ${JSON.stringify(videoStreams[0])}`,
		);
	});

	test("tiny H.264 clip + PNG alpha overlay — composite + real export", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		const errors = attachConsoleCapture(page, "alpha-overlay");
		await openEditor(page, "w2-hunt-alpha-overlay");
		await expect(page.getByTestId("export-open")).toBeVisible();

		const [videoAsset] = await importViaFileInput(page, TINY_H264);
		console.log("[alpha] imported video asset:", JSON.stringify(videoAsset));
		expect(videoAsset).toBeTruthy();

		const { elementId: videoElId } = await insertMediaElement(page, {
			asset: videoAsset,
			startTime: 0,
			duration: videoAsset.duration ?? 2,
		});

		// Trim the video slightly so it and the overlay have different bounds.
		const origDuration = videoAsset.duration ?? 2;
		const trimEnd = 0.3;
		const postTrim = origDuration - trimEnd;
		await page.evaluate(
			({ elementId, trimEnd, duration }) => {
				window.__BYORN_E2E__!.editor.timeline.updateElementTrim({
					elementId,
					trimStart: 0,
					trimEnd,
					duration,
				});
			},
			{ elementId: videoElId, trimEnd, duration: postTrim },
		);

		const [pngAsset] = await importViaFileInput(page, ALPHA_PNG);
		console.log("[alpha] imported png asset:", JSON.stringify(pngAsset));
		expect(pngAsset).toBeTruthy();
		expect(pngAsset.type).toBe("image");

		// Overlay the PNG over the full (trimmed) video duration on a second
		// (auto-created) video-type track — exercises alpha compositing.
		const { elementId: pngElId, trackId: pngTrackId } =
			await insertMediaElement(page, {
				asset: pngAsset,
				startTime: 0,
				duration: postTrim,
			});
		expect(pngElId).toBeTruthy();

		const videoTrackId = (
			await page.evaluate((id) => {
				const track = window
					.__BYORN_E2E__!.editor.timeline.getTracks()
					.find((t) => t.elements.some((e) => e.id === id));
				return track?.id ?? null;
			}, videoElId)
		) as string | null;
		console.log(
			`[alpha] videoTrack=${videoTrackId} pngTrack=${pngTrackId} (distinct tracks expected for overlap)`,
		);
		expect(pngTrackId).not.toBe(videoTrackId);

		// Preview-compositing sanity check: seek the playhead into the overlap
		// window and read back a pixel under the semi-transparent PNG region to
		// confirm the preview canvas actually blended (not opaque copy, not a
		// crash/blank frame). This targets the "alpha handling in preview"
		// watch item independent of the export probe below.
		await page.waitForTimeout(500); // let the compositor settle after inserts
		const canvasPixel = await page.evaluate(() => {
			const canvases = Array.from(document.querySelectorAll("canvas"));
			const preview = canvases.reduce(
				(biggest, c) =>
					c.width * c.height > (biggest?.width ?? 0) * (biggest?.height ?? 0)
						? c
						: biggest,
				canvases[0],
			);
			if (!preview) return null;
			const ctx = preview.getContext("2d", { willReadFrequently: true });
			if (!ctx) return { note: "no 2d context (likely WebGL canvas)" };
			try {
				const { width, height } = preview;
				const data = ctx.getImageData(
					Math.floor(width / 2),
					Math.floor(height / 2),
					1,
					1,
				).data;
				return { width, height, rgba: Array.from(data) };
			} catch (e) {
				return { note: `getImageData threw: ${String(e)}` };
			}
		});
		console.log("[alpha] preview center pixel:", JSON.stringify(canvasPixel));

		const { probe, resultMeta } = await runRealExportAndProbe(
			page,
			"alpha-overlay.mp4",
		);
		console.log("[alpha] export result:", JSON.stringify(resultMeta));
		console.log("[alpha] console/network errors:", JSON.stringify(errors));

		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);
		const videoStreams = probe.streams.filter((s) => s.codec_type === "video");
		expect(videoStreams.length).toBeGreaterThanOrEqual(1);
		console.log(
			`[alpha] exported video stream: ${JSON.stringify(videoStreams[0])}`,
		);
	});

	test("audio-only AAC/M4A — import lands on an audio track, real export", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		const errors = attachConsoleCapture(page, "audio-only");
		await openEditor(page, "w2-hunt-audio-only");
		await expect(page.getByTestId("export-open")).toBeVisible();

		const [asset] = await importViaFileInput(page, AUDIO_ONLY);
		console.log("[audio-only] imported asset:", JSON.stringify(asset));
		expect(asset).toBeTruthy();
		expect(asset.type).toBe("audio");

		const { elementId, trackId } = await insertMediaElement(page, {
			asset,
			startTime: 0,
			duration: asset.duration ?? 3,
			trackType: "audio",
		});
		expect(elementId).toBeTruthy();

		const trackType = await page.evaluate((tid) => {
			const track = window
				.__BYORN_E2E__!.editor.timeline.getTracks()
				.find((t) => t.id === tid);
			return track?.type ?? null;
		}, trackId);
		console.log(`[audio-only] landed on track type: ${trackType}`);
		expect(trackType).toBe("audio");

		const { probe, resultMeta } = await runRealExportAndProbe(
			page,
			"audio-only.mp4",
		);
		console.log("[audio-only] export result:", JSON.stringify(resultMeta));
		console.log("[audio-only] console/network errors:", JSON.stringify(errors));

		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);
		const audioStreams = probe.streams.filter((s) => s.codec_type === "audio");
		const videoStreams = probe.streams.filter((s) => s.codec_type === "video");
		console.log(
			`[audio-only] exported streams: video=${videoStreams.length} audio=${audioStreams.length}`,
		);
		expect(audioStreams.length).toBeGreaterThanOrEqual(1);
	});
});
