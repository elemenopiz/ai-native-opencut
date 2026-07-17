import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Shared helpers for the export FIDELITY MATRIX (campaign C24) —
 * `fidelity-matrix.e2e.ts`. Everything here is self-contained to this suite:
 * no shared fixture files, no `global-setup.ts` dependency. Fixtures (tone
 * WAVs, a tiny A/V webm) are minted in-process and fed to the app via
 * in-memory `FileChooser` buffer payloads — nothing touches disk except the
 * exported output (written to an OS temp dir for ffprobe/ffmpeg to read).
 */

// ── ffprobe / ffmpeg plumbing ────────────────────────────────────────────────

export interface FfprobeStream {
	index: number;
	codec_type: string;
	codec_name: string;
	width?: number;
	height?: number;
	sample_rate?: string;
	channels?: number;
	[key: string]: unknown;
}
export interface FfprobeResult {
	streams: FfprobeStream[];
	format: { duration?: string; size?: string; [key: string]: unknown };
}

/** Run a binary, trying PATH first (CI) and falling back to the Homebrew
 *  path (this machine) — same fallback recipe as every other real-export
 *  spec in this suite (see `golden-path-export.e2e.ts`). */
function runTool(
	bin: string,
	homebrewPath: string,
	args: string[],
	opts: { encoding: "utf-8" | null; maxBuffer?: number },
): { stdout: string | Buffer; stderr: string | Buffer; status: number | null } {
	let result = spawnSync(bin, args, {
		encoding: opts.encoding as BufferEncoding,
		maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		result = spawnSync(homebrewPath, args, {
			encoding: opts.encoding as BufferEncoding,
			maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
		});
	}
	if (result.error) {
		throw new Error(`${bin} not runnable: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`${bin} exited ${result.status}: ${
				typeof result.stderr === "string"
					? result.stderr
					: result.stderr?.toString("utf-8")
			}`,
		);
	}
	return result;
}

export function runFfprobe(filePath: string): FfprobeResult {
	const result = runTool(
		"ffprobe",
		"/opt/homebrew/bin/ffprobe",
		["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
		{ encoding: "utf-8" },
	);
	return JSON.parse(result.stdout as string) as FfprobeResult;
}

/** Decode the audio stream of `filePath` to mono 32-bit float PCM at
 *  `sampleRate` via the ffmpeg CLI, per the DECODED-SAMPLE RECIPE — robust to
 *  whatever the export produced it as (AAC/Opus), since we always decode back
 *  down to raw samples before measuring anything. */
export function decodePcmF32Mono(
	filePath: string,
	sampleRate = 44100,
): Float32Array {
	const result = runTool(
		"ffmpeg",
		"/opt/homebrew/bin/ffmpeg",
		[
			"-v",
			"error",
			"-i",
			filePath,
			"-f",
			"f32le",
			"-acodec",
			"pcm_f32le",
			"-ac",
			"1",
			"-ar",
			String(sampleRate),
			"-",
		],
		{ encoding: null, maxBuffer: 500 * 1024 * 1024 },
	);
	const buf = result.stdout as Buffer;
	const usableLength = buf.byteLength - (buf.byteLength % 4);
	// `buf.byteOffset` into its backing ArrayBuffer isn't guaranteed to be a
	// multiple of 4 (Node's Buffer pooling can land it anywhere) — constructing
	// a Float32Array view directly over it would throw ("start offset ... must
	// be a multiple of element size") whenever it isn't. `allocUnsafeSlow`
	// always backs onto its own dedicated (offset-0) ArrayBuffer regardless of
	// size, unlike `Buffer.alloc`/`allocUnsafe`, which pool small allocations.
	const aligned = Buffer.allocUnsafeSlow(usableLength);
	buf.copy(aligned, 0, 0, usableLength);
	return new Float32Array(
		aligned.buffer,
		aligned.byteOffset,
		usableLength / Float32Array.BYTES_PER_ELEMENT,
	);
}

/** RMS (root-mean-square) amplitude of `samples` over `[startSec, endSec)`. */
export function rmsWindow(
	samples: Float32Array,
	sampleRate: number,
	startSec: number,
	endSec: number,
): number {
	const startIdx = Math.max(0, Math.floor(startSec * sampleRate));
	const endIdx = Math.min(samples.length, Math.floor(endSec * sampleRate));
	if (endIdx <= startIdx) {
		throw new Error(
			`rmsWindow: empty window [${startSec}, ${endSec}) resolved to indices [${startIdx}, ${endIdx}) over ${samples.length} samples`,
		);
	}
	let sumSquares = 0;
	for (let i = startIdx; i < endIdx; i++) {
		sumSquares += samples[i] * samples[i];
	}
	return Math.sqrt(sumSquares / (endIdx - startIdx));
}

/** Extract a single frame at `atSeconds` as raw RGB24 pixels via ffmpeg,
 *  returning the flat byte buffer (3 bytes/pixel, row-major). */
export function extractRawFrameRgb24(
	filePath: string,
	atSeconds: number,
): Buffer {
	const result = runTool(
		"ffmpeg",
		"/opt/homebrew/bin/ffmpeg",
		[
			"-v",
			"error",
			"-ss",
			String(atSeconds),
			"-i",
			filePath,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgb24",
			"-",
		],
		{ encoding: null, maxBuffer: 200 * 1024 * 1024 },
	);
	return result.stdout as Buffer;
}

/** Population variance of a raw RGB24 frame buffer's luma (perceptual
 *  brightness) — a uniform (blank/solid) frame has variance ~0; text/edges
 *  push it well above a small epsilon. */
export function lumaVariance(rgb24: Buffer): number {
	const pixelCount = Math.floor(rgb24.length / 3);
	if (pixelCount === 0) return 0;
	const luma = new Float64Array(pixelCount);
	for (let i = 0; i < pixelCount; i++) {
		const r = rgb24[i * 3];
		const g = rgb24[i * 3 + 1];
		const b = rgb24[i * 3 + 2];
		luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
	}
	let mean = 0;
	for (let i = 0; i < pixelCount; i++) mean += luma[i];
	mean /= pixelCount;
	let variance = 0;
	for (let i = 0; i < pixelCount; i++) {
		const d = luma[i] - mean;
		variance += d * d;
	}
	return variance / pixelCount;
}

// ── deterministic tone-fixture minting (pure Node, no browser) ─────────────

/** Mint a mono 16-bit PCM WAV containing a pure sine tone — same
 *  hand-built-WAV-header recipe as `auto-duck-playback.e2e.ts`'s `mintWav`
 *  (and `voiceover-single-ui.e2e.ts`'s `mintTinyWav`), parameterized for this
 *  suite's needs (44.1kHz to match the export mixdown's `EXPORT_SAMPLE_RATE`,
 *  cleaner than round-tripping through a lower rate). Amplitude stays well
 *  under full-scale so it doesn't clip either at import or through any
 *  codec's later re-encode. */
export function mintToneWav({
	seconds,
	sampleRate = 44100,
	freq = 440,
	amplitude = 0.6,
}: {
	seconds: number;
	sampleRate?: number;
	freq?: number;
	amplitude?: number;
}): Buffer {
	const numSamples = Math.round(seconds * sampleRate);
	const dataSize = numSamples * 2; // 16-bit mono
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // mono
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataSize, 40);

	const peak = Math.round(amplitude * 32767);
	for (let i = 0; i < numSamples; i++) {
		const t = i / sampleRate;
		const sample = Math.round(peak * Math.sin(2 * Math.PI * freq * t));
		buffer.writeInt16LE(sample, 44 + i * 2);
	}
	return buffer;
}

// ── E2E bridge / editor plumbing ─────────────────────────────────────────────

/** Navigate to a fresh anonymous editor project and wait for the E2E bridge.
 *  Self-skips the calling test if this build still has the export stub on
 *  (same two-layer protection every other real-export spec in this repo
 *  uses — see `golden-path-export.e2e.ts`'s file header). */
export async function openEditor(page: Page, route: string): Promise<void> {
	await page.goto(`/editor/${route}`);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 60_000,
	});
	const stubExport = await page.evaluate(
		() => window.__BYORN_E2E__?.stubExport,
	);
	test.skip(
		stubExport !== false,
		"export-fidelity matrix requires a build with NEXT_PUBLIC_E2E_STUB_EXPORT=0 " +
			"(run via playwright.export-fidelity.config.ts's webServer, which sets it)",
	);
	const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click().catch(() => {});
	}
}

export interface AssetSnapshot {
	id: string;
	name: string;
	type: string;
	width?: number;
	height?: number;
	duration?: number;
}

/** Drive a real import through the actual Media-panel file input (not the
 *  E2E bridge), feeding an in-memory buffer via Playwright's `FileChooser`
 *  payload form — no fixture file ever touches disk. Mirrors
 *  `fixtures-w2-hunt.e2e.ts`'s `importViaFileInput`, generalized to accept
 *  bytes directly. */
export async function importBufferViaFileInput(
	page: Page,
	params: { buffer: Buffer; name: string; mimeType: string },
): Promise<AssetSnapshot> {
	const mediaTab = page.getByRole("button", { name: "Media", exact: true });
	if (await mediaTab.isVisible().catch(() => false)) {
		await mediaTab.click();
	}
	const before = await page.evaluate(() =>
		window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
	);

	const [fileChooser] = await Promise.all([
		page.waitForEvent("filechooser"),
		page.getByRole("button", { name: "Import", exact: true }).click(),
	]);
	await fileChooser.setFiles({
		name: params.name,
		mimeType: params.mimeType,
		buffer: params.buffer,
	});

	await page.waitForFunction(
		(beforeIds) => {
			const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
			return assets.some((a) => !beforeIds.includes(a.id));
		},
		before,
		{ timeout: 60_000 },
	);

	const assets = await page.evaluate((beforeIds) => {
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
			}));
	}, before);

	expect(
		assets.length,
		`expected exactly 1 new asset, got ${assets.length}`,
	).toBe(1);
	return assets[0];
}

export interface InsertedElement {
	elementId: string;
	trackId: string;
}

/** Insert an audio-type element referencing an already-imported asset,
 *  bypassing the drag-drop UI (same `insertElement` command-stack seam
 *  `fixtures-w2-hunt.e2e.ts` uses) with explicit control over `volume`,
 *  `muted`, and `playbackRate` — the exact fields BUG32/case-5 need to pin
 *  down. */
export async function insertAudioElement(
	page: Page,
	params: {
		assetId: string;
		name: string;
		startTime: number;
		duration: number;
		volume?: number;
		muted?: boolean;
		playbackRate?: number;
	},
): Promise<InsertedElement> {
	const result = await page.evaluate((p) => {
		const bridge = window.__BYORN_E2E__!;
		const element = {
			type: "audio",
			sourceType: "upload",
			mediaId: p.assetId,
			name: p.name,
			duration: p.duration,
			startTime: p.startTime,
			trimStart: 0,
			trimEnd: 0,
			sourceDuration: p.duration,
			volume: p.volume ?? 1,
			muted: p.muted ?? false,
			...(p.playbackRate ? { playbackRate: p.playbackRate } : {}),
		};
		const elementId = bridge.editor.timeline.insertElement({
			element: element as never,
			placement: { mode: "auto", trackType: "audio" },
		} as never) as unknown as string;
		const track = bridge.editor.timeline
			.getTracks()
			.find((t) => t.elements.some((e) => e.id === elementId));
		return { elementId, trackId: track?.id ?? "" };
	}, params);
	expect(result.trackId, "expected element to land on a track").not.toBe("");
	return result;
}

/** Insert a video-type element referencing an already-imported A/V asset,
 *  with explicit control over `isSourceAudioEnabled` (the audio-separation
 *  gate under test in the detached-audio case). */
export async function insertVideoElement(
	page: Page,
	params: {
		assetId: string;
		name: string;
		startTime: number;
		duration: number;
		isSourceAudioEnabled?: boolean;
	},
): Promise<InsertedElement> {
	const result = await page.evaluate((p) => {
		const bridge = window.__BYORN_E2E__!;
		const element = {
			type: "video",
			mediaId: p.assetId,
			name: p.name,
			duration: p.duration,
			startTime: p.startTime,
			trimStart: 0,
			trimEnd: 0,
			sourceDuration: p.duration,
			muted: false,
			hidden: false,
			transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
			opacity: 1,
			blendMode: "normal",
			...(p.isSourceAudioEnabled === false
				? { isSourceAudioEnabled: false }
				: {}),
		};
		const elementId = bridge.editor.timeline.insertElement({
			element: element as never,
			placement: { mode: "auto", trackType: "video" },
		} as never) as unknown as string;
		const track = bridge.editor.timeline
			.getTracks()
			.find((t) => t.elements.some((e) => e.id === elementId));
		return { elementId, trackId: track?.id ?? "" };
	}, params);
	expect(result.trackId, "expected element to land on a track").not.toBe("");
	return result;
}

/** Insert a text element over the project's (solid-color) background — no
 *  media import needed. Transform `{x:0,y:0}` centers it on the canvas (see
 *  `text-node.ts`'s `canvasCenter` offset). */
export async function insertTextElement(
	page: Page,
	params: {
		content: string;
		startTime: number;
		duration: number;
		fontSize?: number;
		color?: string;
	},
): Promise<InsertedElement> {
	const result = await page.evaluate((p) => {
		const bridge = window.__BYORN_E2E__!;
		const element = {
			type: "text",
			name: "Fidelity overlay text",
			content: p.content,
			fontSize: p.fontSize ?? 140,
			fontFamily: "Arial",
			color: p.color ?? "#ffffff",
			background: { enabled: false, color: "#000000" },
			textAlign: "center",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			duration: p.duration,
			startTime: p.startTime,
			trimStart: 0,
			trimEnd: 0,
			transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
			opacity: 1,
		};
		const elementId = bridge.editor.timeline.insertElement({
			element: element as never,
			placement: { mode: "auto", trackType: "text" },
		} as never) as unknown as string;
		const track = bridge.editor.timeline
			.getTracks()
			.find((t) => t.elements.some((e) => e.id === elementId));
		return { elementId, trackId: track?.id ?? "" };
	}, params);
	expect(result.trackId, "expected element to land on a track").not.toBe("");
	return result;
}

/** Set the active project's background to a solid color via the real
 *  `project.updateSettings` command-stack seam (default is `#000000` per
 *  `DEFAULT_COLOR` — pick a distinct color so a white text overlay's pixels
 *  are unambiguously different from the background either way). */
export async function setSolidBackground(
	page: Page,
	color: string,
): Promise<void> {
	await page.evaluate((c) => {
		window.__BYORN_E2E__!.editor.project.updateSettings({
			settings: { background: { type: "color", color: c } },
		});
	}, color);
}

/** Land `volume` automation keyframes on an element via the real
 *  `upsertKeyframes` command-stack seam — the exact API
 *  `use-auto-duck.ts`'s `applyAutoDuck` uses (`computeDuckKeyframes` ->
 *  `editor.timeline.upsertKeyframes`). `time` is element-relative, matching
 *  that seam's contract. */
export async function upsertVolumeKeyframes(
	page: Page,
	params: {
		trackId: string;
		elementId: string;
		keyframes: Array<{ time: number; value: number }>;
	},
): Promise<void> {
	await page.evaluate((p) => {
		window.__BYORN_E2E__!.editor.timeline.upsertKeyframes({
			keyframes: p.keyframes.map((k) => ({
				trackId: p.trackId,
				elementId: p.elementId,
				propertyPath: "volume" as const,
				time: k.time,
				value: k.value,
				interpolation: "linear" as const,
			})),
		});
	}, params);
}

/** Mint a tiny A/V webm (canvas video + oscillator audio) directly in the
 *  test's own `page`, before it ever navigates to the app — `about:blank`
 *  fully supports Canvas/AudioContext/MediaRecorder. Standalone re-derivation
 *  of `global-setup.ts`'s `mintAvFixture` recipe (that file is
 *  sibling-shared and intentionally left untouched); kept local so this
 *  suite has zero cross-file coupling. */
export async function mintAvWebmBuffer(
	page: Page,
	{ targetSeconds, freq = 440 }: { targetSeconds: number; freq?: number },
): Promise<Buffer> {
	const base64 = await page.evaluate(
		async ({ targetMs, freq }) => {
			const canvas = document.createElement("canvas");
			canvas.width = 128;
			canvas.height = 128;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("no 2d context");
			const videoStream = canvas.captureStream(30);

			const audioCtx = new AudioContext();
			const oscillator = audioCtx.createOscillator();
			oscillator.frequency.value = freq;
			const destination = audioCtx.createMediaStreamDestination();
			oscillator.connect(destination);
			oscillator.start();

			const combined = new MediaStream([
				...videoStream.getVideoTracks(),
				...destination.stream.getAudioTracks(),
			]);

			const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
				? "video/webm;codecs=vp9,opus"
				: MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
					? "video/webm;codecs=vp8,opus"
					: "video/webm";
			const rec = new MediaRecorder(combined, { mimeType: mime });
			const chunks: Blob[] = [];
			rec.ondataavailable = (e) => {
				if (e.data.size) chunks.push(e.data);
			};
			const stopped = new Promise<void>((resolve) => {
				rec.onstop = () => resolve();
			});
			rec.start();
			const start = performance.now();
			await new Promise<void>((resolve) => {
				const draw = () => {
					const t = performance.now() - start;
					ctx.fillStyle = t % 400 < 200 ? "#38BDF8" : "#111827";
					ctx.fillRect(0, 0, 128, 128);
					if (t < targetMs) requestAnimationFrame(draw);
					else resolve();
				};
				draw();
			});
			rec.stop();
			await stopped;
			oscillator.stop();
			await audioCtx.close();

			const blob = new Blob(chunks, { type: "video/webm" });
			const bytes = new Uint8Array(await blob.arrayBuffer());
			let binary = "";
			const CHUNK = 0x8000;
			for (let i = 0; i < bytes.length; i += CHUNK) {
				binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
			}
			return btoa(binary);
		},
		{ targetMs: targetSeconds * 1000, freq },
	);
	const buffer = Buffer.from(base64, "base64");
	if (buffer.byteLength < 512) {
		throw new Error(
			`Minted A/V webm is implausibly small (${buffer.byteLength} bytes)`,
		);
	}
	return buffer;
}

export interface ExportRunResult {
	probe: FfprobeResult;
	resultMeta: Record<string, unknown>;
	outFile: string;
}

/** Trigger the REAL export via the actual UI buttons (same seam as
 *  `golden-path-export.e2e.ts` / `fixtures-w2-hunt.e2e.ts`), wait for it to
 *  settle, pull the produced bytes out of the bridge, write them to a scratch
 *  file, and ffprobe it. */
export async function runRealExportAndProbe(
	page: Page,
	outName: string,
): Promise<ExportRunResult> {
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
		return { probe: { streams: [], format: {} }, resultMeta, outFile: "" };
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
	const outDir = mkdtempSync(path.join(tmpdir(), "byorn-fidelity-"));
	const outFile = path.join(outDir, outName);
	writeFileSync(outFile, Buffer.from(base64, "base64"));

	const probe = runFfprobe(outFile);
	console.log(
		`[fidelity-matrix] ${outName} ffprobe:\n${JSON.stringify(probe, null, 2)}`,
	);
	return { probe, resultMeta, outFile };
}
