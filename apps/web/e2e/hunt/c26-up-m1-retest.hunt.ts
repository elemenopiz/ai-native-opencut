/**
 * THROWAWAY follow-up for M1 — campaign/c26-hunt-upload (W-UP).
 *
 * The main c26-up.hunt.ts run only got 1/8 assets to land within a 90s
 * window on the first scenario of the run (before API routes/mcp-bridge
 * polling were warm). This isolates M1 with a long wait to determine
 * whether the batch eventually completes (known architectural main-thread
 * stall on heavy import — not a new bug) or whether files are genuinely
 * lost/stuck (a new finding).
 *
 * Run: bun run e2e/hunt/c26-up-m1-retest.hunt.ts
 */
import { chromium, type Page } from "@playwright/test";
import path from "node:path";

const BASE_URL = "http://localhost:3301";
const SCRATCH = path.join(__dirname, "scratch-fixtures");

async function main() {
	const browser = await chromium.launch({ channel: "chrome", headless: true });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
	});
	const page = await context.newPage();
	page.on("console", (msg) => {
		if (msg.type() === "error") console.log("[console.error]", msg.text());
	});

	await page.goto(`${BASE_URL}/editor/c26-m1-retest`, { timeout: 140_000 });
	await page.waitForFunction(
		() => (window as any).__BYORN_E2E__?.ready === true,
		null,
		{
			timeout: 140_000,
		},
	);
	const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
	if (await dismiss.isVisible().catch(() => false))
		await dismiss.click().catch(() => {});
	const mediaTab = page.getByRole("button", { name: "Media", exact: true });
	if (await mediaTab.isVisible().catch(() => false)) await mediaTab.click();

	const before: string[] = await page.evaluate(() =>
		(window as any).__BYORN_E2E__.editor.media
			.getAssets()
			.map((a: any) => a.id),
	);

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

	const input = page.locator('input[type="file"]').first();
	await input.evaluate((el: HTMLInputElement) => {
		el.multiple = true;
	});
	const t0 = Date.now();
	await input.setInputFiles(files);

	// Poll every 5s for up to 4 minutes, logging progress over time.
	for (let i = 0; i < 48; i++) {
		await page.waitForTimeout(5000);
		const assets: Array<{ name: string }> = await page.evaluate(() =>
			(window as any).__BYORN_E2E__.editor.media.getAssets(),
		);
		const added = assets.length - before.length;
		const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
		console.log(
			`[m1-retest] t=${elapsed}s added=${added}/8 names=${JSON.stringify(
				assets.slice(before.length).map((a) => a.name),
			)}`,
		);
		if (added >= 8) break;
	}

	await browser.close();
}

main().catch((err) => {
	console.error("M1 RETEST FATAL ERROR:", err);
	process.exit(1);
});
