/**
 * VERIFY script — campaign/task-c26-fixes (W-FIX), fixing BUG55 + BUG56 from
 * the W-UP upload-cluster hunt (see
 * apps/web/docs/campaigns/assets/dogfood-assets/w-up/FINDINGS.md).
 *
 * NOT a CI spec. Plain node/playwright script (not @playwright/test) driving
 * a manually-started dev server (NEXT_PUBLIC_E2E=1 PORT=3304) with the real
 * installed Chrome (channel: "chrome") so H.264/AAC actually decode — the
 * bundled Chromium lacks H.264 and would silently fall through the "no
 * readable video track" path for a HEALTHY file too, invalidating results.
 *
 * Scenarios:
 *  1. Corrupt .mp4 (truncated ~20KB, kept .mp4 ext) -> toast shown, NO asset
 *     added, library count unchanged (BUG55 fix).
 *  2. Healthy H.264 upload -> imports exactly as before (control, proves the
 *     "unsupported: known codec, can't decode" arm is untouched).
 *  3a. Same file uploaded via two SEPARATE uploads -> duplicate toast on the
 *      2nd upload, BOTH copies present (BUG56 fix, cross-batch).
 *  3b. Same file appearing TWICE in one picker selection (one setInputFiles
 *      call, two FilePayloads with identical name+size) -> duplicate toast,
 *      BOTH copies present (BUG56 fix, within-batch).
 *  4. Single clean upload of a file with no name+size match anywhere ->
 *     NO duplicate toast (no false positives on a clean batch).
 *
 * Run: bun run e2e/hunt/c26-fix.verify.ts
 *
 * Fixtures used (regenerate under e2e/hunt/scratch-fixtures-fix/ from the
 * shared e2e/fixtures/w2/tiny_640x360_h264.mp4 original if missing):
 *   SCRATCH=apps/web/e2e/hunt/scratch-fixtures-fix
 *   FIX=apps/web/e2e/fixtures/w2
 *   mkdir -p "$SCRATCH"
 *   head -c 20000 "$FIX/tiny_640x360_h264.mp4" > "$SCRATCH/w-fix-corrupt.mp4"
 *   cp "$FIX/tiny_640x360_h264.mp4" "$SCRATCH/w-fix-healthy.mp4"
 *   cp "$FIX/tiny_640x360_h264.mp4" "$SCRATCH/w-fix-dup-a.mp4"
 *   cp "$FIX/tiny_640x360_h264.mp4" "$SCRATCH/w-fix-clean.mp4"
 */
import { chromium, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const BASE_URL = "http://localhost:3304";
const SCRATCH = path.join(__dirname, "scratch-fixtures-fix");
const SHOT_DIR = path.join(
	__dirname,
	"..",
	"..",
	"docs",
	"campaigns",
	"assets",
	"dogfood-assets",
	"w-fix",
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
	console.log(`[c26-fix] ${label}`, ...args.map((a) => JSON.stringify(a)));
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
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => pageErrors.push(err.message));
	return { consoleErrors, pageErrors };
}

async function openEditor(page: Page, route: string) {
	await page.goto(`${BASE_URL}/editor/${route}`, { timeout: 140_000 });
	await page.waitForFunction(
		() => (window as any).__BYORN_E2E__?.ready === true,
		null,
		{ timeout: 140_000 },
	);
	// Dismiss EmptyEditorGuide tour card (known bug: replaces the whole right
	// panel if left up — do NOT re-file, just dismiss before verifying).
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
	return page.evaluate(() => {
		return Array.from(document.querySelectorAll("[data-sonner-toast]")).map(
			(el) => el.textContent || "",
		);
	});
}

async function setFilesOnHiddenInput(page: Page, files: string[]) {
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
	// Scenario 1 — BUG55: corrupt/unreadable .mp4 must NOT be added
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-fix-s1-corrupt");
		const before = await getAssets(page);
		await setFilesOnHiddenInput(page, [
			path.join(SCRATCH, "w-fix-corrupt.mp4"),
		]);
		await page.waitForTimeout(3000);
		const toastTexts = await getToasts(page);
		const after = await getAssets(page);
		await shot(page, "s1-corrupt-after");
		const added = after.length - before.length;
		log("S1 assets added (expect 0)", added, after.slice(before.length));
		log("S1 toasts", toastTexts);
		log("S1 page errors", cap.pageErrors);
		const warned = toastTexts.some((t) =>
			/couldn't read a video track/i.test(t),
		);
		results.S1_corrupt_not_added = {
			verdict: added === 0 && warned ? "PASS" : "FAIL",
			evidence: `added=${added} (want 0); toast seen=${warned}; toasts=${JSON.stringify(
				toastTexts,
			)}; pageErrors=${JSON.stringify(cap.pageErrors)}`,
		};
		await page.close();
	}

	// ---------------------------------------------------------------
	// Scenario 2 — control: healthy H.264 upload imports exactly as before
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-fix-s2-healthy");
		const before = await getAssets(page);
		await setFilesOnHiddenInput(page, [
			path.join(SCRATCH, "w-fix-healthy.mp4"),
		]);
		try {
			await waitForAssetCount(page, before.length + 1, 40_000);
		} catch (e) {
			log("S2 timeout", String(e));
		}
		await page.waitForTimeout(1000);
		const after = await getAssets(page);
		await shot(page, "s2-healthy-after");
		const added = after.slice(before.length);
		log("S2 assets added (expect 1, with duration/width/height)", added);
		log("S2 console errors", cap.consoleErrors);
		const asset = added[0];
		const healthy =
			added.length === 1 &&
			typeof asset?.duration === "number" &&
			typeof asset?.width === "number" &&
			typeof asset?.height === "number";
		results.S2_healthy_unaffected = {
			verdict: healthy ? "PASS" : "FAIL",
			evidence: `added=${JSON.stringify(added)}`,
		};
		await page.close();
	}

	// ---------------------------------------------------------------
	// Scenario 3a — BUG56: same file, two SEPARATE uploads -> duplicate toast
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-fix-s3a-dup-cross-batch");
		const before = await getAssets(page);
		const dupFile = path.join(SCRATCH, "w-fix-dup-a.mp4");
		await setFilesOnHiddenInput(page, [dupFile]);
		await waitForAssetCount(page, before.length + 1, 40_000);
		await page.waitForTimeout(800);
		await shot(page, "s3a-after-first-upload");

		await setFilesOnHiddenInput(page, [dupFile]);
		try {
			await waitForAssetCount(page, before.length + 2, 40_000);
		} catch (e) {
			log("S3a timeout on second identical upload", String(e));
		}
		await page.waitForTimeout(1000);
		const toastTexts = await getToasts(page);
		const after = await getAssets(page);
		await shot(page, "s3a-dup-cross-batch-after");
		const added = after.length - before.length;
		log("S3a assets added for 2x cross-batch identical upload", added);
		log("S3a toasts", toastTexts);
		log("S3a console errors", cap.consoleErrors);
		const warned = toastTexts.some((t) => /duplicate/i.test(t));
		results.S3a_dup_cross_batch = {
			verdict: added === 2 && warned ? "PASS" : "FAIL",
			evidence: `added=${added} (want 2, both copies present); duplicate toast seen=${warned}; toasts=${JSON.stringify(
				toastTexts,
			)}`,
		};
		await page.close();
	}

	// ---------------------------------------------------------------
	// Scenario 3b — BUG56: same file TWICE in one picker selection
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-fix-s3b-dup-within-batch");
		const before = await getAssets(page);
		const buf = fs.readFileSync(path.join(SCRATCH, "w-fix-batch-dup.mp4"));
		const input = page.locator('input[type="file"]').first();
		await input.evaluate((el: HTMLInputElement) => {
			el.multiple = true;
		});
		// Two FilePayloads with the IDENTICAL name+size in a single
		// setInputFiles call — simulates a user picking the same file twice
		// in one native file-picker multi-select (can't be done via real
		// filesystem paths since a directory can't hold two same-named
		// files, but this is what setInputFiles's payload form is for).
		await input.setInputFiles([
			{ name: "w-fix-batch-dup.mp4", mimeType: "video/mp4", buffer: buf },
			{ name: "w-fix-batch-dup.mp4", mimeType: "video/mp4", buffer: buf },
		]);
		try {
			await waitForAssetCount(page, before.length + 2, 40_000);
		} catch (e) {
			log("S3b timeout", String(e));
		}
		await page.waitForTimeout(1000);
		const toastTexts = await getToasts(page);
		const after = await getAssets(page);
		await shot(page, "s3b-dup-within-batch-after");
		const added = after.length - before.length;
		log("S3b assets added for 2x-in-one-batch identical upload", added);
		log("S3b toasts", toastTexts);
		log("S3b console errors", cap.consoleErrors);
		const warned = toastTexts.some((t) => /duplicate/i.test(t));
		results.S3b_dup_within_batch = {
			verdict: added === 2 && warned ? "PASS" : "FAIL",
			evidence: `added=${added} (want 2, both copies present); duplicate toast seen=${warned}; toasts=${JSON.stringify(
				toastTexts,
			)}`,
		};
		await page.close();
	}

	// ---------------------------------------------------------------
	// Scenario 4 — control: single clean upload -> NO duplicate toast
	// ---------------------------------------------------------------
	{
		const page = await context.newPage();
		const cap = attachCapture(page);
		await openEditor(page, "c26-fix-s4-clean");
		const before = await getAssets(page);
		await setFilesOnHiddenInput(page, [path.join(SCRATCH, "w-fix-clean.mp4")]);
		try {
			await waitForAssetCount(page, before.length + 1, 40_000);
		} catch (e) {
			log("S4 timeout", String(e));
		}
		await page.waitForTimeout(1000);
		const toastTexts = await getToasts(page);
		const after = await getAssets(page);
		await shot(page, "s4-clean-after");
		const added = after.length - before.length;
		log("S4 assets added (expect 1)", added);
		log("S4 toasts (expect none matching /duplicate/)", toastTexts);
		log("S4 console errors", cap.consoleErrors);
		const falsePositive = toastTexts.some((t) => /duplicate/i.test(t));
		results.S4_no_false_positive = {
			verdict: added === 1 && !falsePositive ? "PASS" : "FAIL",
			evidence: `added=${added} (want 1); spurious duplicate toast=${falsePositive}; toasts=${JSON.stringify(
				toastTexts,
			)}`,
		};
		await page.close();
	}

	await browser.close();

	console.log("\n\n===== VERIFY SUMMARY =====");
	for (const [k, v] of Object.entries(results)) {
		console.log(`${k}: ${v.verdict} — ${v.evidence}`);
	}
	fs.writeFileSync(
		path.join(SHOT_DIR, "verify-raw-results.json"),
		JSON.stringify(results, null, 2),
	);
	const anyFail = Object.values(results).some((r) => r.verdict !== "PASS");
	if (anyFail) process.exit(1);
}

main().catch((err) => {
	console.error("VERIFY SCRIPT FATAL ERROR:", err);
	process.exit(1);
});
