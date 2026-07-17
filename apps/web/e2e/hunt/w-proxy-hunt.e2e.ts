import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Campaign C26, W-PROXY worker — hunt the PREVIEW/PROXY/THUMBNAIL cluster of
 * the Assets panel (matrix rows M9/M10/M11/M12/M13/M16 + opportunistic VFR/
 * reload checks). READ-ONLY on product source: this file only documents
 * observed behavior via screenshots + console/network capture. See
 * `docs/campaigns/assets/dogfood-assets/w-proxy/FINDINGS.md` for write-up.
 *
 * Driven against the manually-started `NEXT_PUBLIC_E2E=1 PORT=3302` dev
 * server via playwright.hunt-w2-proxy.config.ts (channel: "chrome" is
 * mandatory — bundled Chromium can't decode H.264/HEVC via WebCodecs).
 *
 * Fixtures: e2e/fixtures/w2/*.mp4 (shared with the w2 campaign) plus
 * throwaway scratch fixtures minted with ffmpeg into
 * e2e/fixtures/w2-scratch/ for this hunt specifically (corrupt-but-probeable
 * truncated MP4s, a 400MB+ big file, a VFR-ish clip).
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
	"w-proxy",
);

const PORTRAIT_H264 = path.join(FIXTURE_DIR, "portrait_1080x1920_h264.mp4");
const HDR_HEVC = path.join(FIXTURE_DIR, "hdr_hevc_1280x720_10bit.mp4");
const TINY_H264 = path.join(FIXTURE_DIR, "tiny_640x360_h264.mp4");

const CORRUPT_TINY = path.join(SCRATCH_DIR, "corrupt_truncated_h264.mp4");
const CORRUPT_BIGRES = path.join(SCRATCH_DIR, "corrupt_bigres_truncated.mp4");
const BIG_FILE = path.join(SCRATCH_DIR, "big_loop_400mb.mp4");
const VFR_ISH = path.join(SCRATCH_DIR, "vfr_ish_640x360.mp4");

interface AssetSnapshot {
	id: string;
	name: string;
	type: string;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	decodeUnsupported?: boolean;
	proxy?: unknown;
	passthrough?: boolean;
}

async function openEditor(page: Page, route: string): Promise<void> {
	await page.goto(`/editor/${route}`);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		// Bumped from 60s: this hunt ran under severe host contention (multiple
		// concurrent agent worktrees each running their own next dev --turbopack
		// + Chrome, system down to ~130MB free RAM) where page hydration itself
		// intermittently took minutes. Not a product issue — see FINDINGS.md's
		// environment note.
		timeout: 150_000,
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

/** Import through the real file input (Import button -> native chooser),
 *  same seam as fixtures-w2-hunt.e2e.ts, so the genuine ingest pipeline
 *  (processMediaAssets -> probe/thumbnail/proxy-schedule) runs. */
async function importViaFileInput(
	page: Page,
	filePath: string,
	{ expectFailure = false }: { expectFailure?: boolean } = {},
): Promise<AssetSnapshot[]> {
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
		// Give it a generous window, but don't hard-fail the test if nothing
		// ever lands — that IS the observation for the corrupt-file case.
		await page
			.waitForFunction(
				(beforeIds) => {
					const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
					return assets.some((a) => !beforeIds.includes(a.id));
				},
				before,
				{ timeout: 30_000 },
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
			}));
	}, before);
}

test.describe("W-PROXY hunt — Assets panel preview/proxy/thumbnail cluster", () => {
	test("M9 — thumbnails while proxy is generating (portrait H.264, height>1080 triggers proxy)", async ({
		page,
	}) => {
		test.setTimeout(300_000);
		const { consoleErrors, failedRequests } = attachCapture(page);
		await openEditor(page, "w-proxy-m9");

		const [asset] = await importViaFileInput(page, PORTRAIT_H264);
		console.log("[M9] imported asset:", JSON.stringify(asset));
		expect(asset).toBeTruthy();

		await page.screenshot({
			path: path.join(SHOT_DIR, "m9-01-just-imported.png"),
		});

		// Poll isProxyGenerating for up to ~10s to catch the mid-generation tile.
		let sawGenerating = false;
		for (let i = 0; i < 40; i++) {
			const generating = await page.evaluate(
				(id) => window.__BYORN_E2E__!.editor.media.isProxyGenerating(id),
				asset.id,
			);
			if (generating) {
				sawGenerating = true;
				await page.screenshot({
					path: path.join(SHOT_DIR, "m9-02-mid-generation.png"),
				});
				break;
			}
			await page.waitForTimeout(250);
		}
		console.log(
			`[M9] observed isProxyGenerating=true at some point: ${sawGenerating}`,
		);

		// Snapshot the background-tasks store contents while (maybe) generating.
		const tasksSnapshot = await page.evaluate(() => {
			const state =
				window.__BYORN_E2E__!.projectScopedStores.backgroundTasks.getState();
			return state.tasks ?? state;
		});
		console.log("[M9] backgroundTasks state:", JSON.stringify(tasksSnapshot));

		// Wait for proxy to finish (or time out) and take the final screenshot.
		await page
			.waitForFunction(
				(id) => !window.__BYORN_E2E__!.editor.media.isProxyGenerating(id),
				asset.id,
				{ timeout: 60_000 },
			)
			.catch(() => {});
		await page.waitForTimeout(500);
		await page.screenshot({
			path: path.join(SHOT_DIR, "m9-03-after-generation.png"),
		});

		const finalAsset = await page.evaluate((id) => {
			const a = window
				.__BYORN_E2E__!.editor.media.getAssets()
				.find((x) => x.id === id);
			return a
				? {
						id: a.id,
						thumbnailUrl: (a as { thumbnailUrl?: string }).thumbnailUrl?.slice(
							0,
							40,
						),
						proxy: (a as { proxy?: unknown }).proxy,
					}
				: null;
		}, asset.id);
		console.log("[M9] final asset state:", JSON.stringify(finalAsset));
		console.log("[M9] console errors:", JSON.stringify(consoleErrors));
		console.log("[M9] failed requests:", JSON.stringify(failedRequests));
	});

	test("M10 — induced proxy failure via corrupt-but-probeable big-res file", async ({
		page,
	}) => {
		test.setTimeout(300_000);
		const { consoleErrors, failedRequests } = attachCapture(page);
		await openEditor(page, "w-proxy-m10");

		const assets = await importViaFileInput(page, CORRUPT_BIGRES, {
			expectFailure: true,
		});
		console.log("[M10] imported (or not) assets:", JSON.stringify(assets));
		await page.screenshot({
			path: path.join(SHOT_DIR, "m10-01-after-import.png"),
		});

		if (assets.length > 0) {
			const asset = assets[0];
			// Poll for a while to see if proxy generation is attempted / fails.
			let generatingSeen = false;
			for (let i = 0; i < 40; i++) {
				const generating = await page.evaluate(
					(id) => window.__BYORN_E2E__!.editor.media.isProxyGenerating(id),
					asset.id,
				);
				if (generating) generatingSeen = true;
				if (generatingSeen && !generating) break; // started then stopped
				await page.waitForTimeout(250);
			}
			await page.screenshot({
				path: path.join(SHOT_DIR, "m10-02-post-attempt.png"),
			});

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
			console.log("[M10] generatingSeen:", generatingSeen);
			console.log("[M10] final asset state:", JSON.stringify(finalAsset));

			// Usability check: is the asset still draggable/insertable onto the
			// timeline despite the (attempted/failed) proxy?
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
				"[M10] insert-onto-timeline attempt:",
				JSON.stringify(insertResult),
			);
			await page.screenshot({
				path: path.join(SHOT_DIR, "m10-03-after-insert-attempt.png"),
			});
		} else {
			console.log(
				"[M10] NO asset was created from the corrupt file — ingest itself rejected it before reaching the proxy stage.",
			);
		}

		console.log("[M10] console errors:", JSON.stringify(consoleErrors));
		console.log("[M10] failed requests:", JSON.stringify(failedRequests));
	});

	test("M11 — HDR HEVC 10-bit ingest, tile, metadata (assets-side only, not export color)", async ({
		page,
	}) => {
		test.setTimeout(300_000);
		const { consoleErrors, failedRequests } = attachCapture(page);
		await openEditor(page, "w-proxy-m11");

		const [asset] = await importViaFileInput(page, HDR_HEVC);
		console.log("[M11] imported asset:", JSON.stringify(asset));
		expect(asset).toBeTruthy();
		await page.screenshot({
			path: path.join(SHOT_DIR, "m11-01-tile-after-import.png"),
		});

		// HEVC kept as passthrough should schedule an auto proxy regardless of
		// its (sub-1080p) resolution — confirm and capture the generating tile.
		const needsProxy = await page.evaluate((id) => {
			const a = window
				.__BYORN_E2E__!.editor.media.getAssets()
				.find((x) => x.id === id);
			return a
				? { passthrough: (a as { passthrough?: boolean }).passthrough }
				: null;
		}, asset.id);
		console.log("[M11] passthrough flag:", JSON.stringify(needsProxy));

		let sawGenerating = false;
		for (let i = 0; i < 40; i++) {
			const generating = await page.evaluate(
				(id) => window.__BYORN_E2E__!.editor.media.isProxyGenerating(id),
				asset.id,
			);
			if (generating) {
				sawGenerating = true;
				await page.screenshot({
					path: path.join(SHOT_DIR, "m11-02-mid-proxy-gen.png"),
				});
				break;
			}
			await page.waitForTimeout(250);
		}
		console.log("[M11] sawGenerating:", sawGenerating);

		await page
			.waitForFunction(
				(id) => !window.__BYORN_E2E__!.editor.media.isProxyGenerating(id),
				asset.id,
				{ timeout: 60_000 },
			)
			.catch(() => {});
		await page.waitForTimeout(500);
		await page.screenshot({
			path: path.join(SHOT_DIR, "m11-03-after-proxy.png"),
		});

		// Insert onto timeline and check preview/hover behavior + metadata badges.
		const { elementId } = await page.evaluate((a) => {
			const bridge = window.__BYORN_E2E__!;
			const elementId = bridge.editor.timeline.insertElement({
				element: {
					type: "video",
					mediaId: a.id,
					name: a.name,
					duration: a.duration ?? 3,
					startTime: 0,
					trimStart: 0,
					trimEnd: 0,
					sourceDuration: a.duration ?? 3,
					muted: false,
					hidden: false,
					transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
					opacity: 1,
					blendMode: "normal",
				} as never,
				placement: { mode: "auto" },
			} as never) as unknown as string;
			return { elementId };
		}, asset);
		expect(elementId).toBeTruthy();
		await page.waitForTimeout(500);
		await page.screenshot({
			path: path.join(SHOT_DIR, "m11-04-on-timeline-preview.png"),
		});

		// Hover the media tile to check for any hover-preview behavior.
		const tile = page.locator("[draggable='true']").first();
		if (await tile.isVisible().catch(() => false)) {
			await tile.hover();
			await page.waitForTimeout(700);
			await page.screenshot({
				path: path.join(SHOT_DIR, "m11-05-tile-hover.png"),
			});
		}

		console.log("[M11] console errors:", JSON.stringify(consoleErrors));
		console.log("[M11] failed requests:", JSON.stringify(failedRequests));
	});

	test("M12 — portrait 1080x1920: tile aspect, cropping, hover, metadata", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		const { consoleErrors, failedRequests } = attachCapture(page);
		await openEditor(page, "w-proxy-m12");

		const [asset] = await importViaFileInput(page, PORTRAIT_H264);
		console.log("[M12] imported asset:", JSON.stringify(asset));
		expect(asset).toBeTruthy();
		expect(asset.width).toBe(1080);
		expect(asset.height).toBe(1920);

		await page.waitForTimeout(500);
		await page.screenshot({
			path: path.join(SHOT_DIR, "m12-01-grid-tile.png"),
		});

		// Switch to list view if a toggle exists, to see aspect handling there too.
		const listToggle = page.getByRole("button", { name: /list/i }).first();
		if (await listToggle.isVisible().catch(() => false)) {
			await listToggle.click().catch(() => {});
			await page.waitForTimeout(300);
			await page.screenshot({
				path: path.join(SHOT_DIR, "m12-02-list-view-tile.png"),
			});
		}

		const tile = page.locator("[draggable='true']").first();
		if (await tile.isVisible().catch(() => false)) {
			await tile.hover();
			await page.waitForTimeout(700);
			await page.screenshot({
				path: path.join(SHOT_DIR, "m12-03-tile-hover.png"),
			});
		}

		console.log("[M12] console errors:", JSON.stringify(consoleErrors));
		console.log("[M12] failed requests:", JSON.stringify(failedRequests));
	});

	test("M13 — big file (400MB+) import: progress feedback, freeze/crash check, tile after", async ({
		page,
	}) => {
		test.setTimeout(300_000);
		const { consoleErrors, failedRequests } = attachCapture(page);
		await openEditor(page, "w-proxy-m13");

		const fileSizeMb = (readFileSync(BIG_FILE).length / (1024 * 1024)).toFixed(
			1,
		);
		console.log(`[M13] big fixture size: ${fileSizeMb} MB`);

		const startedAt = Date.now();
		await page.screenshot({
			path: path.join(SHOT_DIR, "m13-00-before-import.png"),
		});

		const mediaTab = page.getByRole("button", { name: "Media", exact: true });
		if (await mediaTab.isVisible().catch(() => false)) await mediaTab.click();
		const before = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
		);
		const [fileChooser] = await Promise.all([
			page.waitForEvent("filechooser"),
			page.getByRole("button", { name: "Import", exact: true }).click(),
		]);
		await fileChooser.setFiles(BIG_FILE);

		// Take periodic screenshots during the (known-slow) import to see if the
		// UI stays responsive-looking (spinner/progress) vs going fully static
		// or throwing. Also probe main-thread responsiveness via a rapid
		// evaluate() round-trip timing (a wedged main thread will make this
		// evaluate() itself hang, which shows up as this call taking long).
		let importDone = false;
		let sawAnyProgressUi = false;
		for (let i = 0; i < 60 && !importDone; i++) {
			const tBefore = Date.now();
			const assetsNow = await page
				.evaluate((beforeIds) => {
					const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
					return assets.filter((a) => !beforeIds.includes(a.id)).length;
				}, before)
				.catch(() => -1);
			const evalRoundtripMs = Date.now() - tBefore;
			if (evalRoundtripMs > 2000) {
				console.log(
					`[M13] main-thread evaluate() round-trip took ${evalRoundtripMs}ms at t+${Date.now() - startedAt}ms (possible stall)`,
				);
			}
			if (assetsNow > 0) importDone = true;
			if (i === 4 || i === 12 || i === 24) {
				await page.screenshot({
					path: path.join(
						SHOT_DIR,
						`m13-0${Math.min(9, 1 + i / 4)}-during-import-t${i}.png`,
					),
				});
				const hasProgressText = await page
					.getByText(/importing|processing|uploading|%/i)
					.first()
					.isVisible()
					.catch(() => false);
				if (hasProgressText) sawAnyProgressUi = true;
			}
			await page.waitForTimeout(1000);
		}
		const elapsedMs = Date.now() - startedAt;
		console.log(
			`[M13] import settled=${importDone} after ${elapsedMs}ms; sawAnyProgressUi=${sawAnyProgressUi}`,
		);

		if (!importDone) {
			// Give it a much longer final window before giving up entirely.
			await page
				.waitForFunction(
					(beforeIds) => {
						const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
						return assets.some((a) => !beforeIds.includes(a.id));
					},
					before,
					{ timeout: 180_000 },
				)
				.catch(() => {
					console.log("[M13] import NEVER completed within extended timeout.");
				});
		}

		await page.screenshot({
			path: path.join(SHOT_DIR, "m13-99-final-state.png"),
		});

		const finalAssets = await page.evaluate((beforeIds) => {
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
					decodeUnsupported: (a as { decodeUnsupported?: boolean })
						.decodeUnsupported,
				}));
		}, before);
		console.log("[M13] final asset(s):", JSON.stringify(finalAssets));
		console.log(`[M13] total wall time: ${Date.now() - startedAt}ms`);
		console.log("[M13] console errors:", JSON.stringify(consoleErrors));
		console.log("[M13] failed requests:", JSON.stringify(failedRequests));
	});

	test("M16 — insert onto timeline WHILE proxy is still generating (portrait H.264)", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		const { consoleErrors, failedRequests } = attachCapture(page);
		await openEditor(page, "w-proxy-m16");

		const [asset] = await importViaFileInput(page, PORTRAIT_H264);
		console.log("[M16] imported asset:", JSON.stringify(asset));
		expect(asset).toBeTruthy();

		// Confirm proxy generation actually started before we race it.
		let generating = false;
		for (let i = 0; i < 20; i++) {
			generating = await page.evaluate(
				(id) => window.__BYORN_E2E__!.editor.media.isProxyGenerating(id),
				asset.id,
			);
			if (generating) break;
			await page.waitForTimeout(100);
		}
		console.log("[M16] proxy generating before insert:", generating);
		await page.screenshot({
			path: path.join(SHOT_DIR, "m16-01-before-insert-generating.png"),
		});

		// "Drag onto timeline" equivalent: call the same insertElement seam a
		// real drag-drop uses (see use-timeline-drag-drop.ts / element-utils.ts),
		// while the proxy generator is (hopefully still) in flight.
		const insertResult = await page
			.evaluate((a) => {
				const bridge = window.__BYORN_E2E__!;
				try {
					const elementId = bridge.editor.timeline.insertElement({
						element: {
							type: "video",
							mediaId: a.id,
							name: a.name,
							duration: a.duration ?? 4,
							startTime: 0,
							trimStart: 0,
							trimEnd: 0,
							sourceDuration: a.duration ?? 4,
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
			"[M16] insert result while generating:",
			JSON.stringify(insertResult),
		);
		await page.waitForTimeout(500);
		await page.screenshot({
			path: path.join(SHOT_DIR, "m16-02-after-insert-during-generation.png"),
		});

		// Check the clip is genuinely usable: does the preview render a frame
		// (non-blank canvas) with the clip on the timeline mid-proxy-generation?
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
			"[M16] preview center pixel mid-generation:",
			JSON.stringify(canvasPixel),
		);

		// Let proxy finish, confirm the clip survived / still plays.
		await page
			.waitForFunction(
				(id) => !window.__BYORN_E2E__!.editor.media.isProxyGenerating(id),
				asset.id,
				{ timeout: 60_000 },
			)
			.catch(() => {});
		await page.waitForTimeout(500);
		await page.screenshot({
			path: path.join(SHOT_DIR, "m16-03-after-proxy-completes.png"),
		});

		const tracksAfter = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.timeline.getTracks().map((t) => ({
				id: t.id,
				type: t.type,
				elementCount: t.elements.length,
			})),
		);
		console.log(
			"[M16] tracks after proxy completes:",
			JSON.stringify(tracksAfter),
		);

		console.log("[M16] console errors:", JSON.stringify(consoleErrors));
		console.log("[M16] failed requests:", JSON.stringify(failedRequests));
	});

	test("EXTRA — VFR-ish clip ingest + thumbnail-after-reload persistence check", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		const { consoleErrors, failedRequests } = attachCapture(page);
		await openEditor(page, "w-proxy-extra-vfr-reload");

		const [asset] = await importViaFileInput(page, VFR_ISH);
		console.log("[extra] VFR-ish imported asset:", JSON.stringify(asset));
		expect(asset).toBeTruthy();
		await page.waitForTimeout(500);
		await page.screenshot({
			path: path.join(SHOT_DIR, "extra-01-vfr-tile.png"),
		});

		// Also import the tiny fixture for a reload-persistence comparison.
		const [tinyAsset] = await importViaFileInput(page, TINY_H264);
		await page.waitForTimeout(500);
		await page.screenshot({
			path: path.join(SHOT_DIR, "extra-02-before-reload.png"),
		});

		const beforeReloadThumb = await page.evaluate((id) => {
			const a = window
				.__BYORN_E2E__!.editor.media.getAssets()
				.find((x) => x.id === id);
			return (a as { thumbnailUrl?: string } | undefined)?.thumbnailUrl?.slice(
				0,
				60,
			);
		}, tinyAsset.id);
		console.log(
			"[extra] thumbnailUrl before reload (truncated):",
			beforeReloadThumb,
		);

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
			path: path.join(SHOT_DIR, "extra-03-after-reload.png"),
		});

		const afterReloadAssets = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.media.getAssets().map((a) => ({
				id: a.id,
				name: a.name,
				hasThumbnail: !!(a as { thumbnailUrl?: string }).thumbnailUrl,
			})),
		);
		console.log(
			"[extra] assets after reload:",
			JSON.stringify(afterReloadAssets),
		);

		console.log("[extra] console errors:", JSON.stringify(consoleErrors));
		console.log("[extra] failed requests:", JSON.stringify(failedRequests));
	});
});
