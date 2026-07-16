import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { WEBM_FIXTURE } from "./global-setup";

/**
 * Regression coverage for the takes/board routing invariants from the
 * 2026-07-16 review-fix wave (`use-studio-generation.ts`'s `routeCompletedTake`,
 * `generate`, and `loadHistory`). Unlike happy-path.e2e.ts (which drives
 * generation through the `__BYORN_E2E__.generateIntoSlot` bridge — the
 * slot/takes-filmstrip path via `useSlotGeneration`), this spec drives the
 * REAL Generate panel UI (`GenerationForm` inside `GenerateView`, the default
 * tab of the editor's always-open right panel — see right-panel.tsx) so the
 * actual `useStudioGeneration` hook under test runs for real, end to end,
 * with only the `/api/studio/*` and `/api/credits/*` network boundary mocked.
 *
 * Invariants covered:
 *  I1 — batch of 1 completed take auto-saves to Assets, no board pin.
 *  I2 — batch >= 2: each completed take is pinned to Board, not Assets.
 *  I3 — board pin failure falls back to Assets; only a fallback failure too
 *       makes generate() reject (surfaced as the panel's inline error).
 *  I4 — 402 opens the "Out of credits" modal and does NOT also show the
 *       generic inline error for the same event.
 *  I5 — resume-loop dedup: (a) `resumingTakeIds` across repeated
 *       `loadHistory()` calls, (b) `liveTakeIds` so the resume loop doesn't
 *       re-route a take an in-session `generate()` call already owns.
 */

const TAKE_WEBM = readFileSync(WEBM_FIXTURE);

/** Serves the real WebM fixture bytes so the genuine media pipeline
 *  (mediabunny probe + thumbnail) can run deterministically, matching
 *  happy-path.e2e.ts's proxy mock. */
async function fulfillProxyWithFixture(route: Route) {
	await route.fulfill({
		status: 200,
		contentType: "video/webm",
		body: TAKE_WEBM,
	});
}

async function fulfillProxy404(route: Route) {
	await route.fulfill({ status: 404, body: "not found" });
}

/** Baseline mocks every test needs regardless of what it's asserting:
 *  an empty backend catalog (so GenerationForm falls back to its full,
 *  backend-agnostic option sets — see generation-form.tsx's `selectedBackend`
 *  fallback), a generous credit balance, and no prior generation history. */
async function mockBaseline(page: Page) {
	await page.route("**/api/studio/backends**", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ backends: [] }),
		});
	});
	await page.route("**/api/credits/balance", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				spendable: 10_000,
				balance: 10_000,
				reserved: 0,
				lifetimeGranted: 10_000,
			}),
		});
	});
	await page.route("**/api/studio/sets", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ sets: [] }),
		});
	});
	await page.route("**/api/studio/proxy**", fulfillProxyWithFixture);
}

/** Opens a fresh project in the editor, waits for the real editor core to be
 *  live, and dismisses the first-run "Get started" guide that otherwise
 *  covers the Generate panel (see empty-editor-guide.tsx /
 *  app/editor/[project_id]/page.tsx's `guideDismissed` gate). */
async function openGeneratePanel(page: Page, projectId: string) {
	await page.goto(`/editor/${projectId}`);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 60_000,
	});
	await expect(page.getByTestId("export-open")).toBeVisible();

	const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click();
	}

	await expect(page.getByPlaceholder(/Describe your shot/)).toBeVisible();
}

/** Selects a batch size via the Variations chip row (1/2/3/4 — see
 *  generation-form.tsx's `count` state), then fills the prompt. Leaves
 *  submission to the caller so board/asset-count baselines can be captured
 *  right before the click. */
async function setupPrompt(page: Page, prompt: string, batchSize = 1) {
	if (batchSize !== 1) {
		await page
			.getByRole("button", { name: String(batchSize), exact: true })
			.click();
	}
	await page.getByPlaceholder(/Describe your shot/).fill(prompt);
}

async function submit(page: Page) {
	await page.getByTestId("video-gen-submit").click();
}

async function assetCount(page: Page): Promise<number> {
	return page.evaluate(
		() => window.__BYORN_E2E__?.editor.media.getAssets().length ?? -1,
	);
}

/** The panel's inline error block (`{error && <p>…<button>Dismiss</button>}`
 *  in generate.tsx) has no test id, but "Dismiss" is a unique, stable label
 *  for it — its presence is exactly "an inline error is showing". */
function inlineErrorDismissButton(page: Page) {
	return page.getByRole("button", { name: "Dismiss" });
}

test.describe("takes/board routing invariants", () => {
	test.beforeEach(async ({ page }) => {
		await mockBaseline(page);
	});

	test("I1 — batch of 1: completed take auto-saves to Assets, no board pin", async ({
		page,
	}) => {
		let boardCalls = 0;
		await page.route("**/api/studio/board", async (route) => {
			boardCalls += 1;
			await route.fulfill({ status: 200, json: { item: {} } });
		});
		await page.route("**/api/studio/generate", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					takeId: "take-i1",
					setId: "set-i1",
					jobId: "job-i1",
					status: "completed",
					videoUrl: "https://mock.byorn.local/i1.webm",
					seed: 1,
				}),
			});
		});

		await openGeneratePanel(page, "e2e-takes-i1");
		const before = await assetCount(page);
		await setupPrompt(page, "a lone lighthouse at dusk", 1);
		await submit(page);

		await expect
			.poll(async () => assetCount(page), { timeout: 20_000 })
			.toBe(before + 1);

		expect(boardCalls).toBe(0);

		const assets = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.media.getAssets(),
		);
		expect(
			(assets as Array<{ source?: string }>).some((a) => a.source === "ai"),
		).toBe(true);
	});

	test("I2 — batch of 2: each completed take is pinned to Board, not auto-added to Assets", async ({
		page,
	}) => {
		let boardCalls = 0;
		const pinnedTakeIds: string[] = [];
		await page.route("**/api/studio/board", async (route) => {
			boardCalls += 1;
			const body = route.request().postDataJSON() as { takeId?: string };
			if (body.takeId) pinnedTakeIds.push(body.takeId);
			await route.fulfill({ status: 200, json: { item: {} } });
		});
		let genCalls = 0;
		await page.route("**/api/studio/generate", async (route) => {
			genCalls += 1;
			const n = genCalls;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					takeId: `take-i2-${n}`,
					setId: `set-i2-${n}`,
					jobId: `job-i2-${n}`,
					status: "completed",
					videoUrl: `https://mock.byorn.local/i2-${n}.webm`,
					seed: n,
				}),
			});
		});

		await openGeneratePanel(page, "e2e-takes-i2");
		const before = await assetCount(page);
		await setupPrompt(page, "two takes of a rooftop sunset", 2);
		await submit(page);

		await expect.poll(() => boardCalls, { timeout: 20_000 }).toBe(2);
		expect(new Set(pinnedTakeIds).size).toBe(2);

		// Give any (incorrect) auto-add-to-Assets path a moment to have fired,
		// then assert the count never moved.
		await page.waitForTimeout(500);
		expect(await assetCount(page)).toBe(before);
	});

	test("I3a — board pin failure falls back to Assets, no inline error surfaced", async ({
		page,
	}) => {
		let boardCalls = 0;
		await page.route("**/api/studio/board", async (route) => {
			boardCalls += 1;
			await route.fulfill({
				status: 500,
				json: { error: "board unavailable" },
			});
		});
		let genCalls = 0;
		await page.route("**/api/studio/generate", async (route) => {
			genCalls += 1;
			const n = genCalls;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					takeId: `take-i3a-${n}`,
					setId: `set-i3a-${n}`,
					jobId: `job-i3a-${n}`,
					status: "completed",
					videoUrl: `https://mock.byorn.local/i3a-${n}.webm`,
					seed: n,
				}),
			});
		});

		await openGeneratePanel(page, "e2e-takes-i3a");
		const before = await assetCount(page);
		await setupPrompt(page, "fallback save when board is down", 2);
		await submit(page);

		// Both takes' board pin failed; both should fall back to Assets.
		await expect
			.poll(async () => assetCount(page), { timeout: 20_000 })
			.toBe(before + 2);
		expect(boardCalls).toBe(2);
		await expect(inlineErrorDismissButton(page)).toHaveCount(0);
	});

	test("I3b — board pin failure AND fallback failure rejects generate() and surfaces the inline error", async ({
		page,
	}) => {
		await page.route("**/api/studio/board", async (route) => {
			await route.fulfill({
				status: 500,
				json: { error: "board unavailable" },
			});
		});
		// The fallback save's proxy download also fails, so saveToAssets can't
		// rescue the take either — routeCompletedTake has no safe landing spot
		// left and must throw.
		await page.route("**/api/studio/proxy**", fulfillProxy404);
		let genCalls = 0;
		await page.route("**/api/studio/generate", async (route) => {
			genCalls += 1;
			const n = genCalls;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					takeId: `take-i3b-${n}`,
					setId: `set-i3b-${n}`,
					jobId: `job-i3b-${n}`,
					status: "completed",
					videoUrl: `https://mock.byorn.local/i3b-${n}.webm`,
					seed: n,
				}),
			});
		});

		await openGeneratePanel(page, "e2e-takes-i3b");
		const before = await assetCount(page);
		await setupPrompt(page, "double failure has nowhere safe to land", 2);
		await submit(page);

		await expect(inlineErrorDismissButton(page)).toBeVisible({
			timeout: 20_000,
		});
		expect(await assetCount(page)).toBe(before);
	});

	test("I4 — 402 opens the Out of credits modal, no duplicate inline error", async ({
		page,
	}) => {
		await page.route("**/api/studio/generate", async (route) => {
			await route.fulfill({
				status: 402,
				contentType: "application/json",
				body: JSON.stringify({
					error: "insufficient_credits",
					needed: 5,
					spendable: 0,
				}),
			});
		});

		await openGeneratePanel(page, "e2e-takes-i4");
		await setupPrompt(page, "a shot I cannot afford", 1);
		await submit(page);

		await expect(page.getByText("Out of credits", { exact: true })).toBeVisible(
			{ timeout: 20_000 },
		);
		await expect(inlineErrorDismissButton(page)).toHaveCount(0);
	});

	test("I5a — resumingTakeIds dedupes across repeated loadHistory calls (one board pin, not two)", async ({
		page,
	}) => {
		test.setTimeout(45_000);
		let boardCalls = 0;
		const pinnedTakeIds: string[] = [];
		await page.route("**/api/studio/board", async (route) => {
			boardCalls += 1;
			const body = route.request().postDataJSON() as { takeId?: string };
			if (body.takeId) pinnedTakeIds.push(body.takeId);
			await route.fulfill({ status: 200, json: { item: {} } });
		});

		// The set has one take still "polling" (videoUrl null, a providerJobId
		// set) — loadHistory's resume loop should pick this up and start
		// polling it on mount.
		await page.route("**/api/studio/sets", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					sets: [
						{
							id: "set-resume",
							prompt: "a take that was still rendering on reload",
							orientation: "landscape",
							takes: [
								{
									id: "take-resume",
									setId: "set-resume",
									seed: 7,
									resolution: "720p",
									videoUrl: null,
									status: "polling",
									starred: false,
									providerJobId: "job-resume",
									errorMessage: null,
								},
							],
						},
					],
				}),
			});
		});

		// Poll endpoint: "processing" on the first hit (the resume loop's
		// immediate poll), "completed" from the second call onward — the
		// interval's next natural tick, ~4s later (POLL_INTERVAL_MS is fixed
		// in generation-status-store.ts and not configurable from a test).
		let pollCalls = 0;
		await page.route("**/api/studio/generate/job-resume", async (route) => {
			pollCalls += 1;
			if (pollCalls === 1) {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ status: "processing" }),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					status: "completed",
					videoUrl: "https://mock.byorn.local/resume.webm",
					seed: 7,
				}),
			});
		});

		await openGeneratePanel(page, "e2e-takes-i5a");
		// First loadHistory already ran on mount (in openGeneratePanel's wait).
		// The resume poll's first hit landed "processing", so `resumingTakeIds`
		// should still hold "take-resume" here.
		await expect.poll(() => pollCalls, { timeout: 10_000 }).toBeGreaterThan(0);

		// Remount the Generate panel (Properties -> Generate) to trigger a
		// second loadHistory() call while the first resume is still pending —
		// this is the dedup this test is pinning.
		await page.getByRole("button", { name: "Properties" }).click();
		await page.getByRole("button", { name: "Generate", exact: true }).click();
		await expect(page.getByPlaceholder(/Describe your shot/)).toBeVisible();

		// Let the interval's next tick land "completed" and the board pin fire.
		await expect.poll(() => boardCalls, { timeout: 20_000 }).toBeGreaterThan(0);
		// Give a second dedup violation a moment to show up if the fix regressed.
		await page.waitForTimeout(1000);

		expect(boardCalls).toBe(1);
		expect(pinnedTakeIds).toEqual(["take-resume"]);
	});

	test("I5b — liveTakeIds stops the resume loop from re-routing a take an in-session generate() call already owns", async ({
		page,
	}) => {
		test.setTimeout(45_000);
		let boardCalls = 0;
		await page.route("**/api/studio/board", async (route) => {
			boardCalls += 1;
			await route.fulfill({ status: 200, json: { item: {} } });
		});
		await page.route("**/api/studio/generate", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					takeId: "take-live",
					setId: "set-live",
					jobId: "job-live",
					status: "processing",
				}),
			});
		});

		let pollCalls = 0;
		await page.route("**/api/studio/generate/job-live", async (route) => {
			pollCalls += 1;
			if (pollCalls === 1) {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ status: "processing" }),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					status: "completed",
					videoUrl: "https://mock.byorn.local/live.webm",
					seed: 3,
				}),
			});
		});

		// A sets response naming the SAME takeId, still "polling" — models the
		// DB row not having caught up yet while our in-session call owns it.
		// Gated on `liveCallStarted`: the panel's FIRST mount (before submit)
		// must see empty history, or that mount's own loadHistory() would
		// discover "take-live" before liveTakeIds is even populated and start
		// its own independent resume — a false positive unrelated to the
		// liveTakeIds guard this test is pinning. Only the SECOND loadHistory
		// (after submit, via the tab remount below) should see this take.
		let liveCallStarted = false;
		await page.route("**/api/studio/sets", async (route) => {
			if (!liveCallStarted) {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ sets: [] }),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					sets: [
						{
							id: "set-live",
							prompt: "a take the live call already owns",
							orientation: "landscape",
							takes: [
								{
									id: "take-live",
									setId: "set-live",
									seed: 3,
									resolution: "720p",
									videoUrl: null,
									status: "polling",
									starred: false,
									providerJobId: "job-live",
									errorMessage: null,
								},
							],
						},
					],
				}),
			});
		});

		await openGeneratePanel(page, "e2e-takes-i5b");
		const before = await assetCount(page);

		// batchSize 1: submit fires generate(), which adds "take-live" to
		// liveTakeIds immediately after the submit response, then starts
		// polling job-live (first poll lands "processing").
		await setupPrompt(page, "in-session live take", 1);
		await submit(page);
		await expect.poll(() => pollCalls, { timeout: 10_000 }).toBeGreaterThan(0);
		liveCallStarted = true;

		// Remount the panel while the live call's poll is still pending — its
		// loadHistory() sees "take-live" as "polling" in /api/studio/sets and
		// must skip it (liveTakeIds already owns it), not start a second
		// resume-poll+route lifecycle for the same take.
		await page.getByRole("button", { name: "Properties" }).click();
		await page.getByRole("button", { name: "Generate", exact: true }).click();
		await expect(page.getByPlaceholder(/Describe your shot/)).toBeVisible();

		// Let the live call's poll complete (batchSize 1 -> Assets, not Board).
		await expect
			.poll(async () => assetCount(page), { timeout: 20_000 })
			.toBe(before + 1);
		await page.waitForTimeout(1000);

		// If the resume loop had incorrectly picked up "take-live" too, it
		// would have pinned it to Board once its own poll observed completion
		// (the resume path always routes to Board — see loadHistory's comment
		// on not knowing the original batchSize). Zero board calls proves the
		// resume loop skipped it.
		expect(boardCalls).toBe(0);
	});
});
