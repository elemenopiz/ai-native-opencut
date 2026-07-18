/**
 * THROWAWAY hunt script — campaign/c26-hunt-upload (W-UP).
 *
 * NOT a CI spec. Plain node/playwright script (not @playwright/test) driving
 * a manually-started dev server (NEXT_PUBLIC_E2E=1 PORT=3301) with the real
 * installed Chrome (channel: "chrome") so H.264/AAC actually decode.
 *
 * Hunts the UPLOAD cluster of the Assets panel: M1 multi-file, M2 mixed-type
 * batch (junk included), M3 upload-during-upload, M4 duplicate upload, M5
 * unsupported-alone, M6 corrupt media, M7 delete+reupload.
 *
 * Run: bun run e2e/hunt/c26-up.hunt.ts
 *
 * Scratch fixtures (NOT committed — regenerate with the recipe below; they're
 * just renamed/truncated copies of the shared e2e/fixtures/w2/* originals):
 *
 *   SCRATCH=apps/web/e2e/hunt/scratch-fixtures
 *   FIX=apps/web/e2e/fixtures/w2
 *   mkdir -p "$SCRATCH"
 *   for i in 1 2 3 4; do cp "$FIX/tiny_640x360_h264.mp4" "$SCRATCH/m1-clip-$i.mp4"; done
 *   for i in 1 2; do cp "$FIX/alpha_overlay_512.png" "$SCRATCH/m1-img-$i.png"; done
 *   for i in 1 2; do cp "$FIX/audio_only_3s.m4a" "$SCRATCH/m1-audio-$i.m4a"; done
 *   cp "$FIX/tiny_640x360_h264.mp4" "$SCRATCH/m2-video.mp4"
 *   cp "$FIX/alpha_overlay_512.png" "$SCRATCH/m2-image.png"
 *   cp "$FIX/audio_only_3s.m4a" "$SCRATCH/m2-audio.m4a"
 *   echo "this is a junk text file, not media" > "$SCRATCH/m2-junk.txt"
 *   cp "$FIX/tiny_640x360_h264.mp4" "$SCRATCH/m4-dup.mp4"
 *   echo "renamed txt content" > "$SCRATCH/m5-unsupported.xyz"
 *   (cd "$SCRATCH" && zip -q m5-archive.zip m5-unsupported.xyz)
 *   head -c 20000 "$FIX/tiny_640x360_h264.mp4" > "$SCRATCH/m6-corrupt.mp4"
 *   cp "$FIX/tiny_640x360_h264.mp4" "$SCRATCH/m7-reupload.mp4"
 */
import { chromium, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const BASE_URL = "http://localhost:3301";
const FIX = path.join(__dirname, "..", "fixtures", "w2");
const SCRATCH = path.join(__dirname, "scratch-fixtures");
const SHOT_DIR = path.join(
	__dirname,
	"..",
	"..",
	"docs",
	"campaigns",
	"assets",
	"dogfood-assets",
	"w-up",
);
fs.mkdirSync(SHOT_DIR, { recursive: true });

interface AssetSnap {
	id: string;
	name: string;
	type: string;
	duration?: number;
	width?: number;
	height?: number;
}

function log(label: string, ...args: unknown[]) {
	console.log(`[c26-up] ${label}`, ...args.map((a) => JSON.stringify(a)));
}

async function shot(page: Page, name: string) {
	await page.screenshot({
		path: path.join(SHOT_DIR, `${name}.png`),
		fullPage: false,
	});
}

function attachCapture(page: Page) {
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	const toasts: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => pageErrors.push(err.message));
	page.on("requestfailed", (req) => {
		failedRequests.push(
			`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`,
		);
	});
	page.on("response", (res) => {
		if (res.status() >= 400)
			failedRequests.push(`${res.status()} ${res.url()}`);
	});
	return { consoleErrors, pageErrors, failedRequests, toasts };
}

async function openEditor(page: Page, route: string) {
	await page.goto(`${BASE_URL}/editor/${route}`, { timeout: 140_000 });
	await page.waitForFunction(
		() => (window as any).__BYORN_E2E__?.ready === true,
		null,
		{
			timeout: 140_000,
		},
	);
	// Dismiss EmptyEditorGuide tour card (known bug: replaces the whole right
	// panel if left up — do NOT re-file, just dismiss before hunting).
	const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click().catch(() => {});
	}
	const mediaTab = page.getByRole("button", { name: "Media", exact: true });
	if (await mediaTab.isVisible().catch(() => false)) {
		await mediaTab.click();
	}
}

async function getAssets(page: Page): Promise<AssetSnap[]> {
	return page.evaluate(() => {
		const e = (window as any).__BYORN_E2E__;
		return e.editor.media.getAssets().map((a: any) => ({
			id: a.id,
			name: a.name,
			type: a.type,
			duration: a.duration,
			width: a.width,
			height: a.height,
		}));
	});
}

async function getToasts(page: Page): Promise<string[]> {
	// sonner toasts render into a portal with [data-sonner-toast]
	return page.evaluate(() => {
		return Array.from(document.querySelectorAll("[data-sonner-toast]")).map(
			(el) => el.textContent || "",
		);
	});
}

async function setFilesOnHiddenInput(page: Page, files: string[]) {
	// The Assets panel keeps its file input mounted (display:none) at all
	// times (see useFileUpload's fileInputProps) — setInputFiles doesn't
	// require visibility, so we can drive uploads directly without the
	// filechooser dance, which also lets us fire overlapping uploads (M3).
	// The `multiple` attribute is only set imperatively by openFilePicker()
	// on click (see use-file-upload.ts), so force it here for >1 file drops.
	const input = page.locator('input[type="file"]').first();
	await input.evaluate((el: HTMLInputElement, multi: boolean) => {
		el.multiple = multi;
	}, files.length > 1);
	await input.setInputFiles(files);
}

async function waitForAssetCount(page: Page, count: number, timeout = 60_000) {
	await page.waitForFunction(
		(n) => (window as any).__BYORN_E2E__.editor.media.getAssets().length >= n,
		count,
		{ timeout },
	);
}

const results: Record<string, { verdict: string; evidence: string }> = {};

async function main() {
	const browser = await chromium.launch({ channel: "chrome", headless: true });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
	});

	// ---------------------------------------------------------------
	// M1 — Multi-file upload (8 files at once)
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-m1-multi");
		const before = await getAssets(page);
		const files = [
			"m1-clip-1.mp4",
			"m1-clip-2.mp4",
			"m1-clip-3.mp4",
			"m1-clip-4.mp4",
			"m1-img-1.png",
			"m1-img-2.png",
			"m1-audio-1.m4a",
			"m1-audio-2.m4a",
		].map((f) => path.join(SCRATCH, f));
		await setFilesOnHiddenInput(page, files);
		try {
			await waitForAssetCount(page, before.length + 8, 90_000);
		} catch (e) {
			log("M1 timeout waiting for 8 assets", String(e));
		}
		await page.waitForTimeout(1000);
		const after = await getAssets(page);
		const added = after.length - before.length;
		await shot(page, "m1-multi-file-after");
		log(
			"M1 assets added",
			added,
			after.map((a) => a.name),
		);
		log("M1 console errors", cap.consoleErrors);
		log("M1 failed requests", cap.failedRequests);
		results.M1 = {
			verdict: added === 8 ? "PASS" : added > 0 ? "PARTIAL" : "FAIL",
			evidence: `added ${added}/8 assets; names=${after
				.slice(before.length)
				.map((a) => a.name)
				.join(",")}`,
		};
		await page.close();
	}

	// ---------------------------------------------------------------
	// M2 — Mixed-type batch (video+image+audio+junk .txt) in ONE selection
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-m2-mixed");
		const before = await getAssets(page);
		const files = [
			"m2-video.mp4",
			"m2-image.png",
			"m2-audio.m4a",
			"m2-junk.txt",
		].map((f) => path.join(SCRATCH, f));
		await setFilesOnHiddenInput(page, files);
		try {
			await waitForAssetCount(page, before.length + 3, 60_000);
		} catch (e) {
			log("M2 timeout waiting for 3 assets", String(e));
		}
		await page.waitForTimeout(1500);
		const toastTexts = await getToasts(page);
		const after = await getAssets(page);
		const added = after.length - before.length;
		await shot(page, "m2-mixed-batch-after");
		log(
			"M2 assets added",
			added,
			after.slice(before.length).map((a) => a.name),
		);
		log("M2 toasts", toastTexts);
		log("M2 console errors", cap.consoleErrors);
		// Panel should not be wedged: Import button still enabled/clickable after.
		const importBtn = page.getByRole("button", { name: "Import", exact: true });
		const wedged = await importBtn.isDisabled().catch(() => false);
		log("M2 import button disabled after settle (wedged?)", wedged);
		results.M2 = {
			verdict:
				added === 3 && !wedged ? "PASS" : added === 3 ? "PARTIAL" : "FAIL",
			evidence: `added ${added}/3 real assets (junk skipped); toasts=${JSON.stringify(
				toastTexts,
			)}; wedged=${wedged}`,
		};
		await page.close();
	}

	// ---------------------------------------------------------------
	// M3 — Upload during another upload (second batch while first processing)
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-m3-during");
		const before = await getAssets(page);
		const batchA = [
			"m1-clip-1.mp4",
			"m1-clip-2.mp4",
			"m1-clip-3.mp4",
			"m1-clip-4.mp4",
		].map((f) => path.join(SCRATCH, f));
		const batchB = ["m1-img-1.png", "m1-img-2.png"].map((f) =>
			path.join(SCRATCH, f),
		);
		// Fire batch A, then immediately (no await on completion) fire batch B
		// on the same hidden input before A has finished processing.
		const inputLocator = page.locator('input[type="file"]').first();
		await inputLocator.evaluate((el: HTMLInputElement) => {
			el.multiple = true;
		});
		const pA = inputLocator.setInputFiles(batchA);
		await page.waitForTimeout(50); // let A's change event start processing
		const pB = inputLocator.setInputFiles(batchB);
		await Promise.all([pA, pB]);
		try {
			await waitForAssetCount(page, before.length + 4, 90_000);
		} catch (e) {
			log("M3 timeout", String(e));
		}
		await page.waitForTimeout(2000);
		const after = await getAssets(page);
		const added = after.length - before.length;
		await shot(page, "m3-during-upload-after");
		log(
			"M3 assets added (expect 6 if both survive, 2 if B clobbered A)",
			added,
			after.slice(before.length).map((a) => a.name),
		);
		log("M3 console errors", cap.consoleErrors);
		results.M3 = {
			verdict: added === 6 ? "PASS" : added > 0 ? "PARTIAL" : "FAIL",
			evidence: `added ${added}/6 expected (4 from batch A + 2 from batch B); names=${after
				.slice(before.length)
				.map((a) => a.name)
				.join(",")}`,
		};
		await page.close();
	}

	// ---------------------------------------------------------------
	// M4 — Duplicate upload (same exact file twice)
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-m4-dup");
		const before = await getAssets(page);
		const dupFile = path.join(SCRATCH, "m4-dup.mp4");
		await setFilesOnHiddenInput(page, [dupFile]);
		await waitForAssetCount(page, before.length + 1, 40_000);
		await page.waitForTimeout(800);
		await setFilesOnHiddenInput(page, [dupFile]);
		try {
			await waitForAssetCount(page, before.length + 2, 40_000);
		} catch (e) {
			log("M4 timeout on second identical upload", String(e));
		}
		await page.waitForTimeout(1000);
		const toastTexts = await getToasts(page);
		const after = await getAssets(page);
		const added = after.length - before.length;
		await shot(page, "m4-duplicate-after");
		log(
			"M4 assets added for 2x identical upload",
			added,
			after.slice(before.length),
		);
		log("M4 toasts (any duplicate warning?)", toastTexts);
		const warned = toastTexts.some((t) => /duplicate|already|exists/i.test(t));
		results.M4 = {
			verdict:
				added === 2 && !warned
					? "FAIL"
					: added === 2 && warned
						? "PARTIAL"
						: "PASS",
			evidence: `2 identical uploads produced ${added} assets; duplicate-warning toast seen=${warned} (silently dupes if added=2 and no warning)`,
		};
		await page.close();
	}

	// ---------------------------------------------------------------
	// M5 — Unsupported file type alone (.txt renamed .xyz, and a .zip)
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-m5-unsupported");
		const before = await getAssets(page);
		await setFilesOnHiddenInput(page, [
			path.join(SCRATCH, "m5-unsupported.xyz"),
		]);
		await page.waitForTimeout(1500);
		const toast1 = await getToasts(page);
		await shot(page, "m5-unsupported-xyz-toast");
		log("M5 (.xyz) toasts", toast1);

		await setFilesOnHiddenInput(page, [path.join(SCRATCH, "m5-archive.zip")]);
		await page.waitForTimeout(1500);
		const toast2 = await getToasts(page);
		await shot(page, "m5-unsupported-zip-toast");
		log("M5 (.zip) toasts", toast2);

		const after = await getAssets(page);
		const added = after.length - before.length;
		// Recovery check: panel not wedged, Import still clickable, can still
		// upload a real file afterward.
		const realFile = path.join(SCRATCH, "m1-clip-1.mp4");
		await setFilesOnHiddenInput(page, [realFile]);
		let recovered = true;
		try {
			await waitForAssetCount(page, before.length + 1, 40_000);
		} catch {
			recovered = false;
		}
		log("M5 console errors", cap.consoleErrors);
		log("M5 recovered (real upload after 2 rejects)", recovered);
		results.M5 = {
			verdict:
				added === 0 && recovered ? "PASS" : recovered ? "PARTIAL" : "FAIL",
			evidence: `.xyz toasts=${JSON.stringify(toast1)}; .zip toasts=${JSON.stringify(
				toast2,
			)}; spuriously-added=${added}; panel recovered=${recovered}`,
		};
		await page.close();
	}

	// ---------------------------------------------------------------
	// M6 — Corrupt media (truncated ~20KB .mp4)
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-m6-corrupt");
		const before = await getAssets(page);
		await setFilesOnHiddenInput(page, [path.join(SCRATCH, "m6-corrupt.mp4")]);
		await page.waitForTimeout(3000);
		const toastTexts = await getToasts(page);
		const after = await getAssets(page);
		await shot(page, "m6-corrupt-after");
		const added = after.length - before.length;
		log("M6 assets added", added, after.slice(before.length));
		log("M6 toasts", toastTexts);
		log("M6 console errors", cap.consoleErrors);
		log("M6 page errors", cap.pageErrors);
		// Recovery check.
		const realFile = path.join(SCRATCH, "m1-clip-1.mp4");
		await setFilesOnHiddenInput(page, [realFile]);
		let recovered = true;
		try {
			await waitForAssetCount(page, before.length + added + 1, 40_000);
		} catch {
			recovered = false;
		}
		log("M6 recovered after corrupt upload", recovered);
		results.M6 = {
			verdict:
				cap.pageErrors.length > 0
					? "FAIL"
					: recovered
						? added <= 1
							? "PARTIAL"
							: "PASS"
						: "FAIL",
			evidence: `added=${added} asset(s) for corrupt file; toasts=${JSON.stringify(
				toastTexts,
			)}; pageErrors=${JSON.stringify(cap.pageErrors)}; recovered=${recovered}`,
		};
		await page.close();
	}

	// ---------------------------------------------------------------
	// M7 — Delete non-audio asset via context menu, then re-upload same file
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-m7-reupload");
		const before = await getAssets(page);
		const file = path.join(SCRATCH, "m7-reupload.mp4");
		await setFilesOnHiddenInput(page, [file]);
		await waitForAssetCount(page, before.length + 1, 40_000);
		await page.waitForTimeout(500);
		await shot(page, "m7-before-delete");

		// Right-click the card (span[title=name]) to open the Radix context
		// menu, then click "Delete". Radix menu items want a real pointer
		// sequence — plain .click() on the trigger for opening is fine
		// (contextmenu event), but we use page.mouse for the destructive item
		// click to match the documented gotcha.
		const card = page.locator('span[title="m7-reupload.mp4"]').first();
		await card.scrollIntoViewIfNeeded();
		const box = await card.boundingBox();
		if (!box)
			throw new Error("M7: could not locate asset card for context menu");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down({ button: "right" });
		await page.mouse.up({ button: "right" });
		await page.waitForTimeout(300);
		await shot(page, "m7-context-menu-open");

		const deleteItem = page.getByText("Delete", { exact: true });
		const delBox = await deleteItem.boundingBox().catch(() => null);
		if (delBox) {
			await page.mouse.move(
				delBox.x + delBox.width / 2,
				delBox.y + delBox.height / 2,
			);
			await page.mouse.down();
			await page.mouse.up();
		} else {
			log("M7 WARNING: could not find Delete menu item via boundingBox");
		}
		await page.waitForTimeout(800);
		const afterDelete = await getAssets(page);
		const stillThere = afterDelete.some((a) => a.name === "m7-reupload.mp4");
		log("M7 asset still present after delete attempt?", stillThere);
		await shot(page, "m7-after-delete");

		// Re-upload the identical file.
		await setFilesOnHiddenInput(page, [file]);
		let reuploadOk = true;
		try {
			await waitForAssetCount(page, afterDelete.length + 1, 40_000);
		} catch {
			reuploadOk = false;
		}
		await page.waitForTimeout(500);
		const finalAssets = await getAssets(page);
		const reuploaded = finalAssets.filter((a) => a.name === "m7-reupload.mp4");
		await shot(page, "m7-after-reupload");
		log("M7 console errors", cap.consoleErrors);
		log("M7 final matching assets", reuploaded);
		results.M7 = {
			verdict:
				!stillThere && reuploadOk && reuploaded.length === 1
					? "PASS"
					: stillThere
						? "FAIL (delete didn't remove it)"
						: "PARTIAL",
			evidence: `deleted=${!stillThere}; reuploadOk=${reuploadOk}; reuploadedCount=${reuploaded.length}`,
		};
		await page.close();
	}

	await browser.close();

	console.log("\n\n===== MATRIX SUMMARY =====");
	for (const [k, v] of Object.entries(results)) {
		console.log(`${k}: ${v.verdict} — ${v.evidence}`);
	}
	fs.writeFileSync(
		path.join(SHOT_DIR, "matrix-raw-results.json"),
		JSON.stringify(results, null, 2),
	);
}

main().catch((err) => {
	console.error("HUNT SCRIPT FATAL ERROR:", err);
	process.exit(1);
});
