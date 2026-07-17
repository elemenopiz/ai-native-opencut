import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * BUG14 profiling harness (queue §2, campaign perf-wave).
 *
 * Repro: import a heavy 4K HEVC file, then WHILE proxy/thumbnail background
 * work is still running, perform a timeline mutation (asset drag-insert).
 * The mutation lands in store state but the UI/automation stalls 10-30s
 * (bug-purge-w1 hunt, filed as BUG14 in apps/web/docs/SPEEDRUN-QUEUE.md).
 *
 * This spec drives the REAL import (`processMediaAssets`) through the actual
 * media-panel file input, waits for the auto-proxy background task to be
 * confirmed in flight, then performs a real `editor.timeline.insertElement`
 * command while capturing:
 *  - a CDP `Profiler` CPU profile across the mutation window
 *  - `PerformanceObserver` longtask entries
 *  - wall-clock time from the mutation call to the next requestAnimationFrame
 *    (the standard main-thread-blocked proxy: if the thread is genuinely
 *    wedged, rAF cannot fire until it's freed, so this number IS the stall)
 *
 * Three varied attempts (mutation fired at different offsets after import)
 * per the task brief's non-repro protocol. The worst-case run's full
 * .cpuprofile is written next to the report doc for offline analysis.
 */

const FIXTURE = path.join(
	__dirname,
	"fixtures",
	"bug14",
	"heavy_4k_hevc_45s.mp4",
);
const EVIDENCE_DIR = path.join(
	__dirname,
	"..",
	"docs",
	"perf",
	"bug14-evidence",
);

interface RunResult {
	label: string;
	mutationOffsetMs: number;
	importMs: number;
	stallMs: number;
	longtasks: Array<{ name: string; start: number; duration: number }>;
	cpuprofilePath: string | null;
}

async function openEditor(page: Page, route: string): Promise<void> {
	await page.goto(`/editor/${route}`);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 60_000,
	});
	const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click().catch(() => {});
	}
}

async function importHeavyFixture(
	page: Page,
): Promise<{ assetId: string; importMs: number }> {
	const mediaTab = page.getByRole("button", { name: "Media", exact: true });
	if (await mediaTab.isVisible().catch(() => false)) {
		await mediaTab.click();
	}
	const before = await page.evaluate(() =>
		window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
	);
	const t0 = Date.now();
	const [fileChooser] = await Promise.all([
		page.waitForEvent("filechooser"),
		page.getByRole("button", { name: "Import", exact: true }).click(),
	]);
	await fileChooser.setFiles(FIXTURE);

	await page.waitForFunction(
		(beforeIds) => {
			const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
			return assets.some((a) => !beforeIds.includes(a.id));
		},
		before,
		{ timeout: 60_000 },
	);
	const importMs = Date.now() - t0;

	const assetId = await page.evaluate((beforeIds) => {
		const assets = window.__BYORN_E2E__!.editor.media.getAssets();
		return assets.find((a) => !beforeIds.includes(a.id))!.id;
	}, before);

	return { assetId, importMs };
}

/** Poll until the auto-proxy background task is confirmed running (or has
 *  already finished — a fast machine may beat a generous offset). Returns
 *  which state was observed so the caller can log it. */
async function waitForProxyInFlightOrSettled(
	page: Page,
	assetId: string,
	timeoutMs: number,
): Promise<"generating" | "settled-fast" | "timeout"> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = await page.evaluate((id) => {
			const bridge = window.__BYORN_E2E__!;
			return {
				generating: bridge.editor.media.isProxyGenerating(id),
				hasProxy: !!bridge.editor.media.getAssetById(id)?.proxy,
			};
		}, assetId);
		if (state.generating) return "generating";
		if (state.hasProxy) return "settled-fast";
		await page.waitForTimeout(50);
	}
	return "timeout";
}

async function installLongtaskObserver(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as {
			__bug14Longtasks: Array<{
				name: string;
				start: number;
				duration: number;
			}>;
		};
		w.__bug14Longtasks = [];
		const po = new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				w.__bug14Longtasks.push({
					name: e.name,
					start: e.startTime,
					duration: e.duration,
				});
			}
		});
		po.observe({ entryTypes: ["longtask"] });
	});
}

async function readLongtasks(
	page: Page,
): Promise<Array<{ name: string; start: number; duration: number }>> {
	return page.evaluate(() => {
		const w = window as unknown as {
			__bug14Longtasks?: Array<{
				name: string;
				start: number;
				duration: number;
			}>;
		};
		return w.__bug14Longtasks ?? [];
	});
}

/** Perform the timeline mutation (asset drag-insert onto the timeline) and
 *  measure ms from the mutation call to the next requestAnimationFrame —
 *  the main-thread-blocked proxy metric. */
async function mutateAndMeasureStall(
	page: Page,
	assetId: string,
): Promise<number> {
	return page.evaluate((id) => {
		return new Promise<number>((resolve) => {
			const bridge = window.__BYORN_E2E__!;
			const asset = bridge.editor.media.getAssetById(id)!;
			const t0 = performance.now();
			bridge.editor.timeline.insertElement({
				element: {
					type: "video",
					mediaId: asset.id,
					name: asset.name,
					duration: Math.min(asset.duration ?? 5, 5),
					startTime: 0,
					trimStart: 0,
					trimEnd: 0,
					sourceDuration: asset.duration ?? 5,
					muted: false,
					hidden: false,
					transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
					opacity: 1,
					blendMode: "normal",
				} as never,
				placement: { mode: "auto" },
			} as never);
			requestAnimationFrame(() => {
				resolve(performance.now() - t0);
			});
		});
	}, assetId);
}

async function runOnce(
	page: Page,
	cdp: CDPSession,
	label: string,
	mutationOffsetMs: number,
	captureProfile: boolean,
): Promise<RunResult> {
	await openEditor(page, `bug14-${label}`);
	await installLongtaskObserver(page);

	const { assetId, importMs } = await importHeavyFixture(page);
	console.log(`[${label}] import done in ${importMs}ms, asset=${assetId}`);

	const proxyState = await waitForProxyInFlightOrSettled(page, assetId, 15_000);
	console.log(`[${label}] proxy state after import: ${proxyState}`);

	if (mutationOffsetMs > 0) {
		await page.waitForTimeout(mutationOffsetMs);
	}

	const proxyStateAtMutation = await page.evaluate(
		(id) => window.__BYORN_E2E__!.editor.media.isProxyGenerating(id),
		assetId,
	);
	console.log(
		`[${label}] proxy generating at mutation time (t+${mutationOffsetMs}ms): ${proxyStateAtMutation}`,
	);

	if (captureProfile) {
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
		await cdp.send("Profiler.start");
	}

	const stallMs = await mutateAndMeasureStall(page, assetId);
	console.log(`[${label}] mutation -> next rAF: ${stallMs.toFixed(1)}ms`);

	// Give the tail of any async work a moment to land in the profile/longtask
	// stream before stopping capture.
	await page.waitForTimeout(1000);

	let cpuprofilePath: string | null = null;
	if (captureProfile) {
		const { profile } = await cdp.send("Profiler.stop");
		mkdirSync(EVIDENCE_DIR, { recursive: true });
		cpuprofilePath = path.join(EVIDENCE_DIR, `${label}.cpuprofile`);
		writeFileSync(cpuprofilePath, JSON.stringify(profile));
		console.log(`[${label}] cpuprofile written: ${cpuprofilePath}`);
	}

	const longtasks = await readLongtasks(page);
	console.log(
		`[${label}] longtasks captured: ${longtasks.length} — ${JSON.stringify(
			longtasks.slice(0, 10),
		)}`,
	);

	return {
		label,
		mutationOffsetMs,
		importMs,
		stallMs,
		longtasks,
		cpuprofilePath,
	};
}

/** Label prefix + which offsets to run — set via env so a before/after
 *  comparison pass doesn't have to edit this file. Defaults match the
 *  original 3-attempt pre-fix protocol. */
const RUN_PREFIX = process.env.BUG14_RUN_PREFIX ?? "run";
const RUN_OFFSETS = process.env.BUG14_RUN_OFFSETS
	? process.env.BUG14_RUN_OFFSETS.split(",").map(Number)
	: [0, 1000, 3000];

test.describe("BUG14 — import-stall profiling", () => {
	test(`${RUN_OFFSETS.length} varied attempts: mutation during heavy 4K HEVC import background work`, async ({
		page,
	}) => {
		test.setTimeout(480_000);
		const cdp = await page.context().newCDPSession(page);

		const results: RunResult[] = [];
		mkdirSync(EVIDENCE_DIR, { recursive: true });

		for (const offset of RUN_OFFSETS) {
			const label = `${RUN_PREFIX}-t${offset}`;
			const result = await runOnce(page, cdp, label, offset, true);
			results.push(result);
			// Write after each run so a later failure doesn't lose earlier data.
			writeFileSync(
				path.join(EVIDENCE_DIR, `summary-${RUN_PREFIX}.json`),
				JSON.stringify(results, null, 2),
			);
		}

		console.log("[bug14] SUMMARY:", JSON.stringify(results, null, 2));

		// Not a pass/fail gate — this spec's job is measurement. Sanity-check the
		// harness actually captured something in each run.
		for (const r of results) {
			expect(r.stallMs).toBeGreaterThan(0);
		}
	});
});
