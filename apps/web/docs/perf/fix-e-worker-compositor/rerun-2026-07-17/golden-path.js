/**
 * Golden-path browser drive with the worker compositor ON (P1 re-verify,
 * 2026-07-17). Drives the real UI where possible:
 *   create project -> import real 1080p30 h264 -> place on timeline ->
 *   play 10s -> trim -> verify preview painted + playhead advanced.
 * Flag: localStorage["byorn-worker-compositor"]="1" (also baked into the
 * build via NEXT_PUBLIC_WORKER_COMPOSITOR=1).
 * Screenshots + a JSON verdict land in OUT_DIR.
 */
const { chromium } = require(
	"/Users/zsha/Documents/ai-native-opencut/.claude/worktrees/agent-acbc2fad46c570048/apps/web/node_modules/@playwright/test",
);
const path = require("path");
const fs = require("fs");

const PORT = process.argv[2] || "3115";
const BASE_URL = `http://localhost:${PORT}`;
const FIXTURE =
	"/private/tmp/claude-501/-Users-zsha-Documents-ai-native-opencut/ada6718e-31b3-48f8-beaf-a62c82a8253e/scratchpad/fixtures/fixture-1080p30-h264.mp4";
const OUT_DIR = __dirname;

const verdict = { steps: [], pass: true };
function step(name, ok, detail) {
	verdict.steps.push({ name, ok, detail });
	if (!ok) verdict.pass = false;
	console.log(`[gp] ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + JSON.stringify(detail).slice(0, 400) : ""}`);
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
	const context = await browser.newContext({
		viewport: { width: 1600, height: 1000 }, // >=1400px: MobileGate hides editor below desktop width
	});
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e.message));
	page.on("crash", () => {
		pageErrors.push("PAGE CRASHED");
	});
	page.on("console", (msg) => {
		if (msg.type() === "error") console.log("[page:error]", msg.text().slice(0, 250));
	});
	await page.addInitScript(() => {
		window.localStorage.setItem("hasSeenOnboarding-v3", "true");
		window.localStorage.setItem("byorn-worker-compositor", "1");
	});

	// 1. Create/open a project.
	const projectId = `gp-flagon-${Date.now()}`;
	await page.goto(`${BASE_URL}/editor/${projectId}`);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, { timeout: 60_000 });
	await page.waitForTimeout(1500);
	step("editor ready (flag ON)", true, { projectId });

	// Confirm the worker compositor path is actually mounted.
	const hasWorkerPerf = await page
		.waitForFunction(() => !!window.__byornPerfWorker, null, { timeout: 15_000 })
		.then(() => true)
		.catch(() => false);
	step("worker compositor mounted (__byornPerfWorker present)", hasWorkerPerf);

	await page.screenshot({ path: path.join(OUT_DIR, "gp-1-editor-empty.png") });

	// 2. Import the real 1080p30 h264 file via the real file-input UI.
	let imported = false;
	try {
		const fileInputs = page.locator('input[type="file"]');
		const n = await fileInputs.count();
		if (n > 0) {
			await fileInputs.first().setInputFiles(FIXTURE);
			imported = true;
		}
	} catch (e) {
		console.log("[gp] file-input import failed:", e.message);
	}
	if (!imported) {
		// Fallback: the media panel may lazy-create the input on a button click.
		try {
			const [chooser] = await Promise.all([
				page.waitForEvent("filechooser", { timeout: 5000 }),
				page
					.getByRole("button", { name: /import|add media|upload/i })
					.first()
					.click(),
			]);
			await chooser.setFiles(FIXTURE);
			imported = true;
		} catch (e) {
			console.log("[gp] filechooser fallback failed:", e.message);
		}
	}
	step("import initiated via real UI", imported);

	// Wait for the asset to finish ingest (poll the media store via the bridge).
	const assetInfo = await page
		.waitForFunction(
			() => {
				const assets = window.__BYORN_E2E__.editor.media.getAssets();
				const a = assets.find((x) => x.type === "video");
				return a ? { id: a.id, name: a.name, duration: a.duration } : null;
			},
			null,
			{ timeout: 90_000 },
		)
		.then((h) => h.jsonValue())
		.catch(() => null);
	step("asset ingested", !!assetInfo, assetInfo);
	if (!assetInfo) throw new Error("ingest failed");

	// 3. Place it on the timeline via the real UI: drag media card -> timeline.
	await page.waitForTimeout(1000);
	let placed = false;
	const clipCountBefore = await page.evaluate(() =>
		window.__BYORN_E2E__.editor.timeline.getTracks().reduce((s, t) => s + t.elements.length, 0),
	);
	try {
		// The media panel card typically carries the asset name.
		const card = page
			.locator(`[draggable="true"]`)
			.filter({ hasText: "fixture-1080p30-h264" })
			.first();
		const timeline = page.locator('[data-testid="timeline"], .timeline, [class*="timeline"]').first();
		if ((await card.count()) > 0 && (await timeline.count()) > 0) {
			await card.dragTo(timeline);
			await page.waitForTimeout(1500);
			const after = await page.evaluate(() =>
				window.__BYORN_E2E__.editor.timeline.getTracks().reduce((s, t) => s + t.elements.length, 0),
			);
			placed = after > clipCountBefore;
		}
	} catch (e) {
		console.log("[gp] dragTo failed:", e.message);
	}
	if (!placed) {
		// Fallback A: double-click the media card (common "add to timeline" affordance).
		try {
			const card = page.locator('text=fixture-1080p30-h264').first();
			await card.dblclick({ timeout: 5000 });
			await page.waitForTimeout(1500);
			const after = await page.evaluate(() =>
				window.__BYORN_E2E__.editor.timeline.getTracks().reduce((s, t) => s + t.elements.length, 0),
			);
			placed = after > clipCountBefore;
			if (placed) step("placed on timeline (dblclick fallback)", true);
		} catch (e) {
			console.log("[gp] dblclick fallback failed:", e.message);
		}
	} else {
		step("placed on timeline (drag)", true);
	}
	if (!placed) {
		// Last resort: bridge insert (note: weakens the 'real UI' claim for this
		// one step; everything else stays real).
		await page.evaluate((mediaId) => {
			const editor = window.__BYORN_E2E__.editor;
			editor.timeline.insertElement({
				element: {
					type: "video",
					name: "gp-clip",
					mediaId,
					duration: 15,
					startTime: 0,
					trimStart: 0,
					trimEnd: 5,
				},
				placement: { mode: "auto" },
			});
		}, assetInfo.id);
		await page.waitForTimeout(1000);
		const after = await page.evaluate(() =>
			window.__BYORN_E2E__.editor.timeline.getTracks().reduce((s, t) => s + t.elements.length, 0),
		);
		placed = after > clipCountBefore;
		step("placed on timeline (BRIDGE fallback — UI drag paths did not take)", placed);
	}
	if (!placed) throw new Error("could not place clip");

	// 4. Play 10s; verify playhead advances and the worker canvas paints.
	const statsBefore = await page.evaluate(() =>
		window.__byornPerfWorker ? window.__byornPerfWorker.getLatestStats() : null,
	);
	const t0 = await page.evaluate(() => window.__BYORN_E2E__.editor.playback.getCurrentTime());
	await page.keyboard.press("Space"); // real UI: spacebar play
	await page.waitForTimeout(3000);
	const playingViaSpace = await page.evaluate(() => window.__BYORN_E2E__.editor.playback.getIsPlaying());
	if (!playingViaSpace) {
		// Fallback to the toolbar play control if the shortcut is focused elsewhere.
		try {
			await page.getByRole("button", { name: /play/i }).first().click({ timeout: 3000 });
		} catch {
			await page.evaluate(() => window.__BYORN_E2E__.editor.playback.play());
		}
	}
	await page.waitForTimeout(10_000);
	const t1 = await page.evaluate(() => window.__BYORN_E2E__.editor.playback.getCurrentTime());
	const statsAfter = await page.evaluate(() =>
		window.__byornPerfWorker ? window.__byornPerfWorker.getLatestStats() : null,
	);
	await page.screenshot({ path: path.join(OUT_DIR, "gp-2-playing.png") });
	step("playback advances", t1 - t0 > 5, { t0, t1, spaceWorked: playingViaSpace });
	const framesDelta =
		statsAfter && statsBefore
			? statsAfter.framesRendered - statsBefore.framesRendered
			: statsAfter
				? statsAfter.framesRendered
				: -1;
	step("worker compositor rendered frames during playback", framesDelta > 0, {
		framesDelta,
		renderErrors: statsAfter?.renderErrors,
		fps: statsAfter?.fps,
	});

	// Pause (real UI).
	await page.keyboard.press("Space");
	await page.waitForTimeout(500);
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.pause());

	// Canvas visual sanity: the preview canvas should not be blank.
	// NOTE: the main canvas is transferred to the worker
	// (transferControlToOffscreen) — read pixels via a screenshot crop of the
	// canvas element's bounding box instead of getImageData.
	const canvasBox = await page.evaluate(() => {
		const c = document.querySelector("canvas");
		if (!c) return null;
		const r = c.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	});
	let canvasPainted = false;
	if (canvasBox && canvasBox.width > 10) {
		const shot = await page.screenshot({
			clip: {
				x: Math.max(0, canvasBox.x),
				y: Math.max(0, canvasBox.y),
				width: Math.min(canvasBox.width, 1590 - canvasBox.x),
				height: Math.min(canvasBox.height, 990 - canvasBox.y),
			},
		});
		// Heuristic: a non-blank PNG of a testsrc2 frame compresses far larger
		// than a solid-color frame. Solid black 1000px-wide PNGs run ~3-8KB.
		canvasPainted = shot.length > 20_000;
		fs.writeFileSync(path.join(OUT_DIR, "gp-canvas-crop.png"), shot);
		step("preview canvas visibly painted", canvasPainted, { pngBytes: shot.length });
	} else {
		step("preview canvas visibly painted", false, { canvasBox });
	}

	// 5. Trim: real UI drag on the clip's right edge in the timeline.
	const durBefore = await page.evaluate(() => {
		const els = window.__BYORN_E2E__.editor.timeline.getTracks().flatMap((t) => t.elements);
		return els.length ? els[0].duration - els[0].trimStart - els[0].trimEnd : null;
	});
	let trimmed = false;
	try {
		// Common pattern: clip element in timeline with resize handles at edges.
		const clip = page.locator('[data-testid*="clip"], [class*="timeline-element"], [class*="timelineElement"]').first();
		if ((await clip.count()) > 0) {
			const box = await clip.boundingBox();
			if (box && box.width > 30) {
				await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
				await page.mouse.down();
				await page.mouse.move(box.x + box.width - 60, box.y + box.height / 2, { steps: 8 });
				await page.mouse.up();
				await page.waitForTimeout(1000);
			}
		}
		const durAfter = await page.evaluate(() => {
			const els = window.__BYORN_E2E__.editor.timeline.getTracks().flatMap((t) => t.elements);
			return els.length ? els[0].duration - els[0].trimStart - els[0].trimEnd : null;
		});
		trimmed = durBefore != null && durAfter != null && durAfter < durBefore - 0.05;
		step("trim via real edge-drag", trimmed, { durBefore, durAfter });
	} catch (e) {
		step("trim via real edge-drag", false, { error: e.message });
	}
	if (!trimmed) {
		// Bridge fallback so the rest of the drive still exercises post-trim preview.
		await page.evaluate(() => {
			const editor = window.__BYORN_E2E__.editor;
			const track = editor.timeline.getTracks().find((t) => t.elements.length);
			const el = track.elements[0];
			editor.timeline.updateElement({
				trackId: track.id,
				elementId: el.id,
				updates: { trimEnd: (el.trimEnd ?? 0) + 2 },
			});
		}).catch((e) => console.log("[gp] bridge trim failed:", e.message));
		await page.waitForTimeout(800);
		const durAfter2 = await page.evaluate(() => {
			const els = window.__BYORN_E2E__.editor.timeline.getTracks().flatMap((t) => t.elements);
			return els.length ? els[0].duration - els[0].trimStart - els[0].trimEnd : null;
		});
		step("trim (BRIDGE fallback)", durBefore != null && durAfter2 != null && durAfter2 < durBefore - 0.05, {
			durBefore,
			durAfter2,
		});
	}

	// 6. Preview updates after trim: seek to 0, play 3s, confirm frames rendered.
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.seek({ time: 0 }));
	await page.waitForTimeout(800);
	const framesBeforeReplay = await page.evaluate(
		() => window.__byornPerfWorker?.getLatestStats()?.framesRendered ?? -1,
	);
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.play());
	await page.waitForTimeout(3000);
	await page.evaluate(() => window.__BYORN_E2E__.editor.playback.pause());
	const framesAfterReplay = await page.evaluate(
		() => window.__byornPerfWorker?.getLatestStats()?.framesRendered ?? -1,
	);
	step("preview still rendering after trim", framesAfterReplay > framesBeforeReplay, {
		framesBeforeReplay,
		framesAfterReplay,
	});
	await page.screenshot({ path: path.join(OUT_DIR, "gp-3-after-trim.png") });

	// 7. Parity gap #9 probe: is the transferred canvas readable as a drawImage
	// source (scopes panel / auto color-correction path)?
	const scopesProbe = await page.evaluate(() => {
		try {
			const source = document.querySelector("canvas");
			if (!source) return { ok: false, reason: "no canvas element" };
			const c = document.createElement("canvas");
			c.width = 64;
			c.height = 36;
			const ctx = c.getContext("2d");
			ctx.drawImage(source, 0, 0, 64, 36);
			const data = ctx.getImageData(0, 0, 64, 36).data;
			let nonZero = 0;
			for (let i = 0; i < data.length; i += 4) {
				if (data[i] || data[i + 1] || data[i + 2]) nonZero++;
			}
			return { ok: true, nonZeroPixels: nonZero, totalPixels: 64 * 36 };
		} catch (e) {
			return { ok: false, reason: e.message };
		}
	});
	step(
		"scopes-panel probe: transferred canvas readable via drawImage (informational)",
		true,
		scopesProbe,
	);
	verdict.scopesProbe = scopesProbe;

	verdict.pageErrors = pageErrors;
	fs.writeFileSync(path.join(OUT_DIR, "gp-verdict.json"), JSON.stringify(verdict, null, 2));
	console.log("[gp] wrote gp-verdict.json — overall:", verdict.pass ? "PASS" : "FAIL");
	await browser.close();
}

main().catch((err) => {
	console.error("[gp] FAILED", err);
	verdict.pass = false;
	verdict.fatal = String(err && err.message);
	try {
		fs.writeFileSync(path.join(OUT_DIR, "gp-verdict.json"), JSON.stringify(verdict, null, 2));
	} catch {}
	process.exit(1);
});
