import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
	AV_WEBM_FIXTURE,
	AV_WEBM_FIXTURE_TARGET_SECONDS,
} from "../global-setup";
import type { GenerationSpec } from "@/types/timeline";

/**
 * Golden-path e2e: the critical creative loop end to end, through a REAL
 * export — the one seam `happy-path.e2e.ts` deliberately stubs out (see that
 * file's header and `docs/beta-b3-verification-runbook.md` section B).
 *
 *   open editor → generate a take (provider mocked, real A/V media) → take
 *     lands as a real project asset → placed on the timeline → trim + split
 *     (real command-stack edit ops) → REAL export (genuine canvas/mediabunny/
 *     WebCodecs path, no stub) → ffprobe the actual produced bytes
 *
 * This spec only runs against a build with the export stub turned OFF
 * (`NEXT_PUBLIC_E2E_STUB_EXPORT=0` — see `build:e2e:real` / `test:e2e:real`
 * in package.json and `playwright.real-export.config.ts`). The stub-build
 * suite's config (`playwright.config.ts`) globs `**\/*.e2e.ts` too and would
 * otherwise pick this file up and hang forever waiting on a real export the
 * stub build can't produce — so every test here self-skips at runtime via
 * `window.__BYORN_E2E__.stubExport` as a second, robust layer of protection
 * that doesn't depend on which config happened to launch it.
 */

// Requested generation duration, kept safely below `AV_WEBM_FIXTURE_TARGET_SECONDS`
// (the real minted source is ~2.6s) so every trim/split below stays within the
// real media's decodable range — no seeking past EOF.
const GEN_DURATION = 2;
// Trim GEN_DURATION down by this much off the tail.
const TRIM_END = 0.4;
const POST_TRIM_DURATION = GEN_DURATION - TRIM_END; // 1.6s

const SPEC: GenerationSpec = {
	prompt: "a lantern-lit alley, slow push in",
	mode: "text-to-video",
	resolution: "720p",
	orientation: "landscape",
	duration: GEN_DURATION,
};

// Bytes of a real, Chromium-decodable A/V WebM (video + opus audio), minted in
// global-setup. Served from the mocked proxy so the real media pipeline
// probes/decodes it, and the real export mixdown has genuine audio to render.
const TAKE_AV_WEBM = readFileSync(AV_WEBM_FIXTURE);

interface FfprobeStream {
	codec_type: string;
	codec_name: string;
	[key: string]: unknown;
}
interface FfprobeResult {
	streams: FfprobeStream[];
	format: { duration?: string; size?: string; [key: string]: unknown };
}

/** Run ffprobe over a file and return its parsed JSON report. Tries a plain
 *  `ffprobe` on PATH first (CI), falling back to the Homebrew path (this
 *  machine, per `docs/beta-b3-verification-runbook.md`). */
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

test.describe("golden path — generate → edit → REAL export", () => {
	test.beforeEach(async ({ page }) => {
		await page.route("**/api/studio/generate", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					jobId: "e2e-real-export-job-1",
					status: "completed",
					videoUrl: "https://mock.byorn.local/take-av.webm",
					seed: 909090,
					provenance: {
						backendId: "e2e-backend",
						vendor: "e2e",
						model: "e2e-mock-1",
						safetyTier: "partner",
						routedBy: "auto",
						seedLocked: false,
						generatedAt: Date.now(),
					},
					cost: { credits: 1, usd: 0.01, estimated: false },
				}),
			});
		});

		await page.route("**/api/studio/proxy**", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "video/webm",
				body: TAKE_AV_WEBM,
			});
		});

		// The Takes-grid history hydration (`useStudioGeneration`'s `loadHistory`)
		// fires an authenticated `GET /api/studio/sets` on editor mount regardless
		// of which panel is open. In this anonymous e2e session it 401s, and
		// `apiFetch` treats ANY 401 as a global "unauthorized" signal — after a
		// short debounce it redirects the whole page to `/signup`, unmounting
		// `E2EBridge` mid-test (`window.__BYORN_E2E__` disappears). The stub-build
		// happy-path smoke gets away with this because it finishes in ~1.5s,
		// often before that fetch/redirect round-trip completes; this spec holds
		// the page open for tens of seconds through a real encode, so it reliably
		// loses the race unless the endpoint is mocked to succeed. Not a bug in
		// the code under test — a real product finding worth a look separately
		// (see report), but out of scope for a test file to fix.
		await page.route("**/api/studio/sets", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ sets: [] }),
			});
		});
	});

	test("generate → land → trim + split → real export produces a playable file", async ({
		page,
	}) => {
		test.setTimeout(240_000);

		// ── Stage 1: open the editor, and self-skip under a stub build ────────
		await page.goto("/editor/e2e-golden-path-export");
		await page.waitForFunction(
			() => window.__BYORN_E2E__?.ready === true,
			null,
			{ timeout: 60_000 },
		);

		const stubExport = await page.evaluate(
			() => window.__BYORN_E2E__?.stubExport,
		);
		test.skip(
			stubExport !== false,
			"real-export spec requires a build with NEXT_PUBLIC_E2E_STUB_EXPORT=0 " +
				"(run via `bun run build:e2e:real && bun run test:e2e:real`)",
		);

		await expect(page.getByTestId("export-open")).toBeVisible();

		// ── Stage 2 + 3: generate a take → it lands on the timeline ───────────
		const elementId = await page.evaluate((spec) => {
			return window.__BYORN_E2E__!.editor.timeline.addGenerativeSlot({
				spec: spec as unknown as Parameters<
					typeof window.__BYORN_E2E__.editor.timeline.addGenerativeSlot
				>[0]["spec"],
				duration: spec.duration,
			});
		}, SPEC);
		expect(elementId).toBeTruthy();

		const genResult = await page.evaluate(
			async ({ id, spec }) => {
				return window.__BYORN_E2E__!.generateIntoSlot({
					elementId: id,
					spec: spec as unknown as Parameters<
						typeof window.__BYORN_E2E__.generateIntoSlot
					>[0]["spec"],
					alternatives: 1,
				});
			},
			{ id: elementId, spec: SPEC },
		);
		expect(genResult).toEqual({ ok: 1, failed: 0 });

		const landed = await page.evaluate((id) => {
			const el = window
				.__BYORN_E2E__!.editor.timeline.getTracks()
				.flatMap((t) => t.elements)
				.find((e) => e.id === id) as
				| {
						mediaId?: string;
						activeTakeId?: string;
						takes?: Array<{ status: string; mediaId?: string }>;
				  }
				| undefined;
			return {
				takeCount: el?.takes?.length ?? 0,
				takeStatus: el?.takes?.[0]?.status,
				takeMediaId: el?.takes?.[0]?.mediaId ?? "",
				activeTakeId: el?.activeTakeId ?? "",
				clipMediaId: el?.mediaId ?? "",
			};
		}, elementId);
		expect(landed.takeCount).toBe(1);
		expect(landed.takeStatus).toBe("ready");
		expect(landed.takeMediaId).not.toBe("");
		expect(landed.activeTakeId).not.toBe("");
		expect(landed.clipMediaId).toBe(landed.takeMediaId);

		// The imported asset is a real registered project media asset.
		const assetKnown = await page.evaluate((mediaId) => {
			return window
				.__BYORN_E2E__!.editor.media.getAssets()
				.some((a) => a.id === mediaId);
		}, landed.clipMediaId);
		expect(assetKnown).toBe(true);

		const trackId = await page.evaluate((id) => {
			const track = window
				.__BYORN_E2E__!.editor.timeline.getTracks()
				.find((t) => t.elements.some((e) => e.id === id));
			return track?.id ?? null;
		}, elementId);
		expect(trackId).toBeTruthy();

		// ── Stage 4: edit ops — trim, then split ───────────────────────────────
		// Trim GEN_DURATION (2s) down to POST_TRIM_DURATION (1.6s) by pulling in
		// the tail. Source range stays [0, 1.6] — well inside the real ~2.6s
		// fixture, so no seek-past-EOF risk.
		await page.evaluate(
			({ elementId, trimEnd, duration }) => {
				window.__BYORN_E2E__!.editor.timeline.updateElementTrim({
					elementId,
					trimStart: 0,
					trimEnd,
					duration,
				});
			},
			{ elementId, trimEnd: TRIM_END, duration: POST_TRIM_DURATION },
		);

		const afterTrim = await page.evaluate((id) => {
			const el = window
				.__BYORN_E2E__!.editor.timeline.getTracks()
				.flatMap((t) => t.elements)
				.find((e) => e.id === id) as
				| { duration: number; trimStart: number; trimEnd: number }
				| undefined;
			return el
				? {
						duration: el.duration,
						trimStart: el.trimStart,
						trimEnd: el.trimEnd,
					}
				: null;
		}, elementId);
		expect(afterTrim).toMatchObject({
			duration: POST_TRIM_DURATION,
			trimStart: 0,
			trimEnd: TRIM_END,
		});

		// Split the trimmed clip at its midpoint. "both" retain mode keeps the
		// left half on `elementId` and mints a new id for the right half —
		// total on-timeline duration is unchanged (contiguous halves).
		const splitTime = POST_TRIM_DURATION / 2;
		const rightSide = await page.evaluate(
			({ trackId, elementId, splitTime }) => {
				return window.__BYORN_E2E__!.editor.timeline.splitElements({
					elements: [{ trackId, elementId }],
					splitTime,
				});
			},
			{ trackId: trackId as string, elementId, splitTime },
		);
		expect(rightSide.length).toBe(1);
		const rightElementId = rightSide[0].elementId;

		const afterSplit = await page.evaluate(
			({ trackId, leftId, rightId }) => {
				const track = window
					.__BYORN_E2E__!.editor.timeline.getTracks()
					.find((t) => t.id === trackId);
				const elements = track?.elements ?? [];
				const left = elements.find((e) => e.id === leftId) as
					| { duration: number }
					| undefined;
				const right = elements.find((e) => e.id === rightId) as
					| { duration: number }
					| undefined;
				return {
					elementCount: elements.length,
					leftDuration: left?.duration ?? -1,
					rightDuration: right?.duration ?? -1,
					totalDuration:
						window.__BYORN_E2E__!.editor.timeline.getTotalDuration(),
				};
			},
			{
				trackId: trackId as string,
				leftId: elementId,
				rightId: rightElementId,
			},
		);
		expect(afterSplit.elementCount).toBe(2);
		expect(afterSplit.leftDuration).toBeCloseTo(splitTime, 5);
		expect(afterSplit.rightDuration).toBeCloseTo(
			POST_TRIM_DURATION - splitTime,
			5,
		);
		// Split doesn't change total playtime — the two halves are contiguous.
		expect(afterSplit.totalDuration).toBeCloseTo(POST_TRIM_DURATION, 5);

		const expectedDuration = afterSplit.totalDuration;

		// ── Stage 5: REAL export ────────────────────────────────────────────────
		await page.getByTestId("export-open").click();
		const runBtn = page.getByTestId("export-run");
		await expect(runBtn).toBeVisible();
		await runBtn.click();

		// Real per-frame render: wait (generously) for isExporting to settle.
		await page.waitForFunction(
			() =>
				window.__BYORN_E2E__?.editor.project.getExportState().isExporting ===
				false,
			null,
			{ timeout: 180_000 },
		);

		// The export button's own success handler clears `getExportState().result`
		// synchronously right after downloading — read the result from the bridge
		// seam instead, which captured it before that happened.
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
		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);
		expect(resultMeta.byteLength).toBeGreaterThan(10 * 1024);

		// Pull the buffer out as base64 (chunked — large buffers overflow
		// String.fromCharCode's argument list otherwise) and write it to a temp
		// file for ffprobe.
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
		const outDir = mkdtempSync(path.join(tmpdir(), "byorn-golden-export-"));
		const outFile = path.join(outDir, "golden-path-export.mp4");
		writeFileSync(outFile, Buffer.from(base64, "base64"));

		// ── Stage 6: probe the ACTUAL produced file — the crux of this spec ────
		const probe = runFfprobe(outFile);
		console.log(
			`[golden-path-export] ffprobe report:\n${JSON.stringify(probe, null, 2)}`,
		);

		const videoStreams = probe.streams.filter((s) => s.codec_type === "video");
		const audioStreams = probe.streams.filter((s) => s.codec_type === "audio");
		expect(
			videoStreams.length,
			`expected >=1 video stream, got ${JSON.stringify(probe.streams)}`,
		).toBeGreaterThanOrEqual(1);
		expect(
			audioStreams.length,
			`expected >=1 audio stream (real audio mixdown), got ${JSON.stringify(probe.streams)}`,
		).toBeGreaterThanOrEqual(1);

		// Default export options are MP4/High — scene-exporter.ts encodes MP4
		// video as h264 (avc) unconditionally (see docs/beta-b3-verification-
		// runbook.md's confirmed h264/aac real-export result).
		expect(videoStreams[0].codec_name).toBe("h264");

		const actualDuration = Number.parseFloat(probe.format.duration ?? "0");
		expect(Number.isFinite(actualDuration)).toBe(true);
		const tolerance = Math.max(0.7, expectedDuration * 0.2);
		expect(
			Math.abs(actualDuration - expectedDuration),
			`expected ~${expectedDuration}s (±${tolerance}s), probed ${actualDuration}s`,
		).toBeLessThanOrEqual(tolerance);

		const fileSize = Number.parseInt(probe.format.size ?? "0", 10);
		expect(fileSize).toBeGreaterThan(10 * 1024);
	});
});
