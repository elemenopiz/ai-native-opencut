import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Campaign C26, W-PROXY2 worker — ADDENDUM to the W-PROXY hunt
 * (task/c26-hunt-proxy @bc3fc723 already answered M9/M11/M12/M13/M16 as
 * PASS and M10 as PARTIAL). This file re-runs ONLY the two honest gaps
 * flagged by the L1 course-correction:
 *
 *   1. M10 FULL RUN — induce a proxy failure via a corrupt-but-probeable
 *      big-res file and observe the tile/retry/usability lifecycle to
 *      completion (predecessor only got a partial look, env-blocked).
 *   2. EXTRA — thumbnail persistence after reload.
 *
 * READ-ONLY on product source. See
 * docs/campaigns/assets/dogfood-assets/w-proxy2/FINDINGS-ADDENDUM.md.
 */

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "w2");
const SCRATCH_DIR = path.join(__dirname, "..", "fixtures", "w2-scratch");
const SHOT_DIR = path.join(
	__dirname,
	"..",
	"..",
	"docs",
	"campaigns",
	"assets",
	"dogfood-assets",
	"w-proxy2",
);

const TINY_H264 = path.join(FIXTURE_DIR, "tiny_640x360_h264.mp4");
const CORRUPT_BIGRES = path.join(SCRATCH_DIR, "corrupt_bigres_truncated.mp4");

async function openEditor(page: Page, route: string): Promise<void> {
	// This host is running many concurrent worktree dev servers (observed
	// load average 8-16 during this hunt); first-compile of the dynamic
	// /editor/[project_id] route has been seen to take several minutes.
	// Generous nav timeout so a slow compile doesn't read as a product bug.
	await page.goto(`/editor/${route}`, { timeout: 400_000 });
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 400_000,
	});
	const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click().catch(() => {});
	}
}

function attachCapture(page: Page) {
	const consoleErrors: string[] = [];
	const failedRequests: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error")
			consoleErrors.push(`[console.error] ${msg.text()}`);
	});
	page.on("pageerror", (err) =>
		consoleErrors.push(`[pageerror] ${err.message}`),
	);
	page.on("requestfailed", (req) => {
		failedRequests.push(
			`[requestfailed] ${req.url()} ${req.failure()?.errorText}`,
		);
	});
	page.on("response", (res) => {
		if (res.status() >= 400)
			failedRequests.push(`[${res.status()}] ${res.url()}`);
	});
	return { consoleErrors, failedRequests };
}

async function importViaFileInput(
	page: Page,
	filePath: string,
	{ expectFailure = false }: { expectFailure?: boolean } = {},
) {
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
	await fileChooser.setFiles(filePath);

	if (expectFailure) {
		await page
			.waitForFunction(
				(beforeIds) => {
					const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
					return assets.some((a) => !beforeIds.includes(a.id));
				},
				before,
				{ timeout: 45_000 },
			)
			.catch(() => {});
	} else {
		await page.waitForFunction(
			(beforeIds) => {
				const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
				return assets.some((a) => !beforeIds.includes(a.id));
			},
			before,
			{ timeout: 120_000 },
		);
	}

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
				proxy: (a as { proxy?: unknown }).proxy,
				passthrough: (a as { passthrough?: boolean }).passthrough,
				thumbnailUrl: !!(a as { thumbnailUrl?: string }).thumbnailUrl,
			}));
	}, before);
}

test.describe("W-PROXY2 addendum", () => {
	test("M10-FULL — induced proxy failure, full lifecycle to completion", async ({
		page,
	}) => {
		test.setTimeout(600_000);
		const { consoleErrors, failedRequests } = attachCapture(page);
		await openEditor(page, "w-proxy2-m10-full");

		const assets = await importViaFileInput(page, CORRUPT_BIGRES, {
			expectFailure: true,
		});
		console.log("[M10-FULL] imported (or not):", JSON.stringify(assets));
		await page.screenshot({
			path: path.join(SHOT_DIR, "m10full-01-after-import.png"),
		});

		expect(assets.length).toBeGreaterThan(0);
		const asset = assets[0];

		// Poll isProxyGenerating to completion (or timeout) — full lifecycle.
		let generatingSeen = false;
		let settledFalseAfterTrue = false;
		for (let i = 0; i < 80; i++) {
			const generating = await page.evaluate(
				(id) => window.__BYORN_E2E__!.editor.media.isProxyGenerating(id),
				asset.id,
			);
			if (generating) generatingSeen = true;
			if (generatingSeen && !generating) {
				settledFalseAfterTrue = true;
				break;
			}
			await page.waitForTimeout(250);
		}
		console.log(
			`[M10-FULL] generatingSeen=${generatingSeen} settledFalseAfterTrue=${settledFalseAfterTrue}`,
		);
		await page.screenshot({
			path: path.join(SHOT_DIR, "m10full-02-post-proxy-attempt.png"),
		});

		// Look for any retry affordance in the DOM near the asset tile.
		const retryVisible = await page
			.getByRole("button", { name: /retry|try again|reload/i })
			.first()
			.isVisible()
			.catch(() => false);
		console.log("[M10-FULL] retry affordance visible:", retryVisible);

		// Also check for any error/warning badge text near the tile.
		const errorBadgeVisible = await page
			.getByText(/failed|error|corrupt|unsupported/i)
			.first()
			.isVisible()
			.catch(() => false);
		console.log("[M10-FULL] error/warning badge visible:", errorBadgeVisible);

		const finalAsset = await page.evaluate((id) => {
			const a = window
				.__BYORN_E2E__!.editor.media.getAssets()
				.find((x) => x.id === id);
			return a
				? {
						id: a.id,
						type: a.type,
						decodeUnsupported: (a as { decodeUnsupported?: boolean })
							.decodeUnsupported,
						proxy: (a as { proxy?: unknown }).proxy,
						thumbnailUrl: !!(a as { thumbnailUrl?: string }).thumbnailUrl,
					}
				: null;
		}, asset.id);
		console.log("[M10-FULL] final asset state:", JSON.stringify(finalAsset));

		// Usability: attempt to insert onto the timeline despite the corruption.
		const insertResult = await page
			.evaluate((a) => {
				const bridge = window.__BYORN_E2E__!;
				try {
					const elementId = bridge.editor.timeline.insertElement({
						element: {
							type: "video",
							mediaId: a.id,
							name: a.name,
							duration: a.duration ?? 2,
							startTime: 0,
							trimStart: 0,
							trimEnd: 0,
							sourceDuration: a.duration ?? 2,
							muted: false,
							hidden: false,
							transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
							opacity: 1,
							blendMode: "normal",
						} as never,
						placement: { mode: "auto" },
					} as never);
					return { ok: true, elementId };
				} catch (e) {
					return { ok: false, error: String(e) };
				}
			}, asset)
			.catch((e) => ({ ok: false, error: String(e) }));
		console.log(
			"[M10-FULL] insert-onto-timeline attempt:",
			JSON.stringify(insertResult),
		);
		await page.waitForTimeout(500);
		await page.screenshot({
			path: path.join(SHOT_DIR, "m10full-03-after-insert-attempt.png"),
		});

		// Does the preview render anything (vs solid black / crash) for the
		// corrupted clip once placed on the timeline?
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
		console.log(
			"[M10-FULL] preview center pixel after insert:",
			JSON.stringify(canvasPixel),
		);

		console.log("[M10-FULL] console errors:", JSON.stringify(consoleErrors));
		console.log("[M10-FULL] failed requests:", JSON.stringify(failedRequests));
	});

	test("EXTRA-RELOAD — thumbnail persistence after page reload", async ({
		page,
	}) => {
		test.setTimeout(500_000);
		const { consoleErrors, failedRequests } = attachCapture(page);
		await openEditor(page, "w-proxy2-extra-reload");

		const [asset] = await importViaFileInput(page, TINY_H264);
		console.log("[EXTRA-RELOAD] imported asset:", JSON.stringify(asset));
		expect(asset).toBeTruthy();

		// Wait explicitly for the thumbnail to actually populate before reload.
		await page
			.waitForFunction(
				(id) => {
					const a = window.__BYORN_E2E__?.editor.media
						.getAssets()
						.find((x) => x.id === id);
					return !!(a as { thumbnailUrl?: string } | undefined)?.thumbnailUrl;
				},
				asset.id,
				{ timeout: 30_000 },
			)
			.catch(() => {});

		const beforeReload = await page.evaluate((id) => {
			const a = window
				.__BYORN_E2E__!.editor.media.getAssets()
				.find((x) => x.id === id);
			return {
				hasThumbnail: !!(a as { thumbnailUrl?: string } | undefined)
					?.thumbnailUrl,
				thumbnailUrlPrefix: (
					a as { thumbnailUrl?: string } | undefined
				)?.thumbnailUrl?.slice(0, 24),
			};
		}, asset.id);
		console.log("[EXTRA-RELOAD] before reload:", JSON.stringify(beforeReload));
		await page.waitForTimeout(300);
		await page.screenshot({
			path: path.join(SHOT_DIR, "reload-01-before-reload.png"),
		});

		await page.reload();
		await page.waitForFunction(
			() => window.__BYORN_E2E__?.ready === true,
			null,
			{
				timeout: 60_000,
			},
		);
		await page.waitForTimeout(1500);
		await page.screenshot({
			path: path.join(SHOT_DIR, "reload-02-immediately-after-reload.png"),
		});

		// Give any lazy thumbnail (re)generation a window, then take a settled shot.
		await page.waitForTimeout(3000);
		await page.screenshot({
			path: path.join(SHOT_DIR, "reload-03-settled-after-reload.png"),
		});

		const afterReload = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.media.getAssets().map((a) => ({
				id: a.id,
				name: a.name,
				hasThumbnail: !!(a as { thumbnailUrl?: string }).thumbnailUrl,
				thumbnailUrlPrefix: (
					a as { thumbnailUrl?: string }
				).thumbnailUrl?.slice(0, 24),
			})),
		);
		console.log(
			"[EXTRA-RELOAD] assets after reload:",
			JSON.stringify(afterReload),
		);

		console.log(
			"[EXTRA-RELOAD] console errors:",
			JSON.stringify(consoleErrors),
		);
		console.log(
			"[EXTRA-RELOAD] failed requests:",
			JSON.stringify(failedRequests),
		);
	});
});
