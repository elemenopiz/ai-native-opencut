import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { WEBM_FIXTURE } from "./global-setup";
import type { GenerationSpec } from "@/types/timeline";

/**
 * Critical-path smoke test — the core creative loop, end to end, in a real
 * browser with the provider network mocked:
 *
 *   open editor → create a generative slot → generate a take (provider stubbed)
 *     → take lands on the timeline → export kicks off a render
 *
 * Each stage asserts both the genuine editor/store state (via the `E2EBridge`
 * seam, `window.__BYORN_E2E__`) and the rendered DOM. Everything the app does is
 * real except two seams: the two `/api/studio/*` provider calls (mocked here) and
 * the canvas/ffmpeg encoder (a deterministic stub in `E2EBridge`, so "export
 * kicks off a render" is observable without shipping a 4 GB codec to CI).
 */

// A minimal but complete generation recipe for a video slot.
const SPEC: GenerationSpec = {
	prompt: "a neon city flyover at night",
	mode: "text-to-video",
	resolution: "720p",
	orientation: "landscape",
	duration: 5,
};

// Bytes of a real, Chromium-decodable WebM (minted in global-setup). Served from
// the mocked proxy so the real media pipeline can probe/decode/thumbnail it.
const TAKE_WEBM = readFileSync(WEBM_FIXTURE);

test.describe("editor happy path", () => {
	test.beforeEach(async ({ page }) => {
		// Provider submit: resolve immediately as a completed job (no polling),
		// stamped with provenance + cost like the real route.
		await page.route("**/api/studio/generate", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					jobId: "e2e-job-1",
					status: "completed",
					videoUrl: "https://mock.byorn.local/take.webm",
					seed: 424242,
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

		// Same-origin media proxy: hand back the real WebM fixture bytes.
		await page.route("**/api/studio/proxy**", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "video/webm",
				body: TAKE_WEBM,
			});
		});
	});

	test("open → slot → generate → lands on timeline → export kicks off", async ({
		page,
	}) => {
		// ── Stage 1: open the editor ──────────────────────────────────────────
		// Navigating to an unknown id makes the app create a fresh project and
		// redirect; the E2EBridge signals when the real editor core is live.
		await page.goto("/editor/e2e-happy-path");
		await page.waitForFunction(
			() => window.__BYORN_E2E__?.ready === true,
			null,
			{
				timeout: 60_000,
			},
		);
		await expect(page).toHaveURL(/\/editor\/.+/);
		// The editor chrome is mounted (export affordance present).
		await expect(page.getByTestId("export-open")).toBeVisible();

		// ── Stage 2: create a generative slot ─────────────────────────────────
		const elementId = await page.evaluate((spec) => {
			return window.__BYORN_E2E__!.editor.timeline.addGenerativeSlot({
				spec: spec as unknown as Parameters<
					typeof window.__BYORN_E2E__.editor.timeline.addGenerativeSlot
				>[0]["spec"],
				duration: 5,
			});
		}, SPEC);
		expect(elementId).toBeTruthy();

		// Store: the slot exists, carries the recipe, and holds no takes yet.
		const slot = await page.evaluate((id) => {
			const el = window
				.__BYORN_E2E__!.editor.timeline.getTracks()
				.flatMap((t) => t.elements)
				.find((e) => e.id === id) as
				| { type: string; generation?: { prompt?: string }; takes?: unknown[] }
				| undefined;
			return el
				? {
						type: el.type,
						prompt: el.generation?.prompt,
						takes: el.takes?.length ?? 0,
					}
				: null;
		}, elementId);
		expect(slot).toMatchObject({
			type: "video",
			prompt: SPEC.prompt,
			takes: 0,
		});

		// DOM: the slot renders on the timeline as an empty generative placeholder.
		const slotEl = page.locator(
			`[data-testid="timeline-element"][data-element-id="${elementId}"]`,
		);
		await expect(slotEl).toBeVisible();
		await expect(
			slotEl.locator('[data-testid="generative-slot-content"]'),
		).toHaveAttribute("data-slot-state", "empty");

		// ── Stage 3 + 4: generate a take → it lands on the timeline ────────────
		const result = await page.evaluate(
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
		expect(result).toEqual({ ok: 1, failed: 0 });

		// Store: exactly one ready take, bound to imported media, auto-selected and
		// mirrored onto the clip's mediaId — the full take-landing contract.
		const landed = await page.evaluate((id) => {
			const el = window
				.__BYORN_E2E__!.editor.timeline.getTracks()
				.flatMap((t) => t.elements)
				.find((e) => e.id === id) as
				| {
						mediaId?: string;
						activeTakeId?: string;
						takes?: Array<{ status: string; mediaId?: string; seed?: number }>;
				  }
				| undefined;
			return {
				takeCount: el?.takes?.length ?? 0,
				takeStatus: el?.takes?.[0]?.status,
				takeMediaId: el?.takes?.[0]?.mediaId ?? "",
				takeSeed: el?.takes?.[0]?.seed,
				activeTakeId: el?.activeTakeId ?? "",
				clipMediaId: el?.mediaId ?? "",
			};
		}, elementId);
		expect(landed.takeCount).toBe(1);
		expect(landed.takeStatus).toBe("ready");
		expect(landed.takeMediaId).not.toBe("");
		expect(landed.takeSeed).toBe(424242);
		expect(landed.activeTakeId).not.toBe("");
		// Active take's media is mirrored onto the clip.
		expect(landed.clipMediaId).toBe(landed.takeMediaId);

		// The imported asset is a real registered project media asset.
		const assetKnown = await page.evaluate((mediaId) => {
			return window
				.__BYORN_E2E__!.editor.media.getAssets()
				.some((a) => a.id === mediaId);
		}, landed.clipMediaId);
		expect(assetKnown).toBe(true);

		// DOM: the slot is no longer showing the "generating" placeholder.
		await expect(slotEl).toBeVisible();
		await expect(slotEl.locator('[data-slot-state="generating"]')).toHaveCount(
			0,
		);

		// ── Stage 5: export kicks off a render ─────────────────────────────────
		await page.getByTestId("export-open").click();
		const runBtn = page.getByTestId("export-run");
		await expect(runBtn).toBeVisible();
		await runBtn.click();

		// The render was kicked off: project.export delegated to the renderer.
		await page.waitForFunction(
			() => (window.__BYORN_E2E__?.exportCalls.length ?? 0) > 0,
			null,
			{ timeout: 20_000 },
		);

		// Store: export is in flight with the expected options.
		const exportState = await page.evaluate(() => {
			const b = window.__BYORN_E2E__!;
			return {
				isExporting: b.editor.project.getExportState().isExporting,
				options: b.exportCalls[0]?.options,
			};
		});
		expect(exportState.isExporting).toBe(true);
		expect(exportState.options).toMatchObject({
			format: "mp4",
			quality: "high",
			includeAudio: true,
			includeWatermark: true,
		});

		// DOM: the export panel reflects the in-progress render.
		await expect(page.getByText("Exporting project")).toBeVisible();

		// Let the stubbed render finish and confirm it settles cleanly.
		await page.evaluate(() => window.__BYORN_E2E__!.releaseExport());
		await page.waitForFunction(
			() =>
				window.__BYORN_E2E__?.editor.project.getExportState().isExporting ===
				false,
			null,
			{ timeout: 20_000 },
		);
	});
});
