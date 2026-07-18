/**
 * BUG23 both-path verification probe (C17 compositor-endgame).
 * Adapted from docs/perf/fix-e-worker-compositor/rerun-2026-07-17/overlay-probe.js.
 *
 * Runs TWO passes against the same E2E build (the flag is a localStorage key,
 * so one server serves both states):
 *   1. flag-ON  — per-canvas pixel probe of the two stacked WorkerPreviewCanvas
 *      layers. PASS = overlay canvas is NO LONGER opaque black (transparent
 *      where empty => magenta underlay shows through), worker canvas has real
 *      content, and the on-screen composite screenshot shows video.
 *   2. flag-OFF — single PreviewCanvas. PASS = canvas readback shows real video
 *      content AND opaque black letterbox pixels (NOT magenta), proving the
 *      default black-fill clear() branch is untouched.
 */
const { chromium } = require(
	"/Users/zsha/Documents/ai-native-opencut/.claude/worktrees/agent-a277a3d8f5363f48e/apps/web/node_modules/@playwright/test",
);
const fs = require("fs");
const path = require("path");

const PORT = process.argv[2] || "3211";
const OUT = process.argv[3] || __dirname;
const FIXTURE =
	"/private/tmp/claude-501/-Users-zsha-Documents-ai-native-opencut/f49934a2-4d4c-4617-9e17-27eea320d6f1/scratchpad/fixtures/fixture.mp4";

async function drive(page, { workerFlag }) {
	await page.addInitScript((flag) => {
		window.localStorage.setItem("hasSeenOnboarding-v3", "true");
		if (flag) window.localStorage.setItem("byorn-worker-compositor", "1");
		else window.localStorage.removeItem("byorn-worker-compositor");
	}, workerFlag);
	await page.goto(`http://localhost:${PORT}/editor/probe-${workerFlag ? "on" : "off"}-${Date.now()}`);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 60_000,
	});
	await page.waitForTimeout(1500);
	await page.locator('input[type="file"]').first().setInputFiles(FIXTURE);
	await page.waitForFunction(
		() =>
			window.__BYORN_E2E__.editor.media
				.getAssets()
				.some((a) => a.type === "video"),
		null,
		{ timeout: 90_000 },
	);
	await page.evaluate(() => {
		const editor = window.__BYORN_E2E__.editor;
		const a = editor.media.getAssets().find((x) => x.type === "video");
		editor.timeline.insertElement({
			element: {
				type: "video",
				name: "probe",
				mediaId: a.id,
				duration: 8,
				startTime: 0,
				trimStart: 0,
				trimEnd: 8,
			},
			placement: { mode: "auto" },
		});
	});
	await page.waitForTimeout(2000);
	await page.evaluate(() =>
		window.__BYORN_E2E__.editor.playback.seek({ time: 2 }),
	);
	await page.waitForTimeout(2500);

	return page.evaluate(() => {
		function readCanvas(c) {
			try {
				const t = document.createElement("canvas");
				t.width = 32;
				t.height = 18;
				const ctx = t.getContext("2d", { willReadFrequently: true });
				// Magenta underlay: fully-transparent source pixels stay magenta,
				// opaque black source pixels come out black.
				ctx.fillStyle = "#ff00ff";
				ctx.fillRect(0, 0, 32, 18);
				ctx.drawImage(c, 0, 0, 32, 18);
				const d = ctx.getImageData(0, 0, 32, 18).data;
				let black = 0;
				let magenta = 0;
				let other = 0;
				for (let i = 0; i < d.length; i += 4) {
					const r = d[i];
					const g = d[i + 1];
					const b = d[i + 2];
					if (r < 10 && g < 10 && b < 10) black++;
					else if (r > 245 && g < 10 && b > 245) magenta++;
					else other++;
				}
				return {
					black,
					magenta,
					other,
					total: 32 * 18,
					width: c.width,
					height: c.height,
					cls: c.className,
				};
			} catch (e) {
				return { error: e.message, cls: c.className };
			}
		}
		const canvases = Array.from(document.querySelectorAll("canvas"));
		return canvases.slice(0, 4).map(readCanvas);
	});
}

async function main() {
	const browser = await chromium.launch({
		channel: "chrome",
		headless: false,
		args: [
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
			"--disable-features=CalculateNativeWinOcclusion",
			"--window-position=0,0",
		],
	});
	const results = {};

	// Pass 1: flag ON
	{
		const ctx = await browser.newContext({
			viewport: { width: 1600, height: 1000 },
		});
		const page = await ctx.newPage();
		results.flagOn = await drive(page, { workerFlag: true });
		await page.screenshot({ path: path.join(OUT, "bug23-flag-on.png") });
		await ctx.close();
	}

	// Pass 2: flag OFF
	{
		const ctx = await browser.newContext({
			viewport: { width: 1600, height: 1000 },
		});
		const page = await ctx.newPage();
		results.flagOff = await drive(page, { workerFlag: false });
		await page.screenshot({ path: path.join(OUT, "bug23-flag-off.png") });
		await ctx.close();
	}

	await browser.close();

	// Verdicts
	const on = results.flagOn || [];
	// worker canvas: "block border"; overlay: contains "pointer-events-none absolute"
	const workerCanvas = on.find((c) => c.cls && c.cls.includes("border"));
	const overlayCanvas = on.find(
		(c) => c.cls && c.cls.includes("pointer-events-none"),
	);
	const off = results.flagOff || [];
	const offPreview = off[0];

	results.verdict = {
		flagOn_workerCanvasHasContent: Boolean(
			workerCanvas && workerCanvas.other > 100,
		),
		flagOn_overlayNoLongerOpaqueBlack: Boolean(
			overlayCanvas && overlayCanvas.magenta > 500 && overlayCanvas.black < 50,
		),
		flagOff_previewShowsVideo: Boolean(offPreview && offPreview.other > 100),
		flagOff_blackFillIntact_notTransparent: Boolean(
			offPreview && offPreview.magenta < 10,
		),
	};
	results.verdict.PASS = Object.values(results.verdict).every(Boolean);

	fs.writeFileSync(
		path.join(OUT, "bug23-both-path-result.json"),
		JSON.stringify(results, null, 2),
	);
	console.log(JSON.stringify(results, null, 2));
	if (!results.verdict.PASS) process.exit(2);
}

main().catch((e) => {
	console.error("PROBE FAILED", e);
	process.exit(1);
});
