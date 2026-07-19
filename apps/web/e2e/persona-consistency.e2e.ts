import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { WEBM_FIXTURE } from "./global-setup";

/**
 * Campaign C2 machine-verification — GATE A UPDATE (2026-07-19).
 *
 * Director-revamp Part E unmounted the Generate panel's Personas tab
 * (`PersonaManager` mount + tab trigger + the "Keeping a character? Pick a
 * persona →" hint) and the Style Bible chip. See
 * `apps/web/docs/plans/2026-07-19-director-revamp-design.md`, section
 * "GATE A" — the user's call was **"remove the UI but keep the product —
 * don't like it for now, will revisit."** The picker's machinery
 * (`usePersonaStore`, `persona-manager.tsx`, `seed-lock`,
 * `consistency-prompt.ts`, `reference-intake.ts`, `project-bible.ts`, and
 * Director's own `usePersonaStore.getState().setActive()` call in
 * `director-api.ts`) is untouched and still live — re-mounting the picker is
 * the whole revert, and Director remains an activation path for a persona,
 * just not through this manual panel. Driving Director chat to exercise that
 * path is out of this UI-driven spec's scope.
 *
 * This spec used to drive persona creation → selection → cross-project reuse
 * entirely through `PersonaManager`'s UI. That UI surface no longer exists
 * (there is no "Personas" tab to navigate to), so that flow can't be driven
 * from the Generate panel anymore. Rewritten to pin the post-removal truth
 * instead of the pre-removal one:
 *
 *  1. the removed surfaces (Personas tab, persona hint, Style Bible chip)
 *     genuinely don't render — even when a reel-level consistency context
 *     is present — which is the Gate A regression pin;
 *  2. the manual-generate flow the old spec exercised still works
 *     end-to-end, and — because there is no in-UI path left to attach a
 *     persona — every wire body from this panel is persona/seed-free
 *     unconditionally, while the *separate*, still-live
 *     STYLE/CHARACTERS/SETTING prompt fold (`lib/studio/consistency-fold.ts`,
 *     backend-only, never gated on the picker) still applies when a
 *     reel-level consistency context exists — proving the "keep the
 *     product" half of Gate A, not just the "remove the UI" half.
 *
 * Screenshots land in `apps/web/docs/campaigns/assets/c2-walkthrough-0N.png`.
 */

const TAKE_WEBM = readFileSync(WEBM_FIXTURE);
const SCREENSHOT_DIR = path.join(__dirname, "..", "docs/campaigns/assets");

/** Shape of `POST /api/studio/generate`'s wire body, loosely typed — this
 *  spec only reads the fields the C2 fold/seed-thread rules touch. */
interface CapturedGenerateBody {
	prompt: string;
	personaId?: string;
	seed?: number;
	consistencyMode?: string;
	[key: string]: unknown;
}

async function fulfillProxyWithFixture(route: Route) {
	await route.fulfill({
		status: 200,
		contentType: "video/webm",
		body: TAKE_WEBM,
	});
}

/** Baseline mocks every scenario needs: empty backend catalog, a generous
 *  credit balance, no prior generation history, the real WebM fixture for
 *  any Assets-path proxy download, and a successful board-pin
 *  acknowledgment (needed by the batch step). No persona endpoints are
 *  mocked here anymore — there's no UI path left that would call them. */
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
	await page.route("**/api/studio/board", async (route) => {
		await route.fulfill({ status: 200, json: { item: {} } });
	});
}

/** Opens a fresh project in the editor, waits for the real editor core to be
 *  live, and dismisses the first-run guide card — mirrors
 *  takes-board-routing.e2e.ts's `openGeneratePanel`. */
async function openEditor(page: Page, projectId: string) {
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

async function assetCount(page: Page): Promise<number> {
	return page.evaluate(
		() => window.__BYORN_E2E__?.editor.media.getAssets().length ?? -1,
	);
}

/** Sets the active project's persisted consistency context through the
 *  public `editor.project.getProjectBible()`/`setProjectBible()` API exposed
 *  on the E2E bridge — the same seam `resolveConsistencyContext`
 *  (`lib/studio/consistency-fold.ts`) falls back to when the session WeakMap
 *  (Director-only) is empty. No private internals touched. Used here to
 *  prove the backend fold still applies with the picker UI gone (Gate A's
 *  "keep the product" half), not to drive any removed UI. */
async function setConsistencyContext(page: Page) {
	await page.evaluate(() => {
		const bridge = window.__BYORN_E2E__;
		if (!bridge) throw new Error("E2E bridge not ready");
		const editor = bridge.editor;
		const existing = editor.project.getProjectBible() ?? {
			version: 0,
			updatedAt: Date.now(),
		};
		editor.project.setProjectBible({
			bible: {
				...existing,
				consistencyContext: {
					style:
						"Warm 35mm film grain, teal-and-amber grade, soft diffusion, handheld camera.",
					characters: [
						{
							name: "Nova",
							descriptor:
								"A woman in her 30s, short silver hair, scar on left cheek, green eyes, worn orange flight jacket.",
							personaId: "p-nova",
						},
					],
					setting: "A rain-slick, neon-lit downtown street at night.",
				},
			},
		});
	});
}

/** Remounts `GenerationForm` by cycling segments — it reads the project
 *  bible fresh on mount (no store subscription wired to it), same as before
 *  Gate A. Image has replaced Personas as "the other tab" to bounce off of. */
async function remountGenerateSegment(page: Page) {
	await page.getByTestId("generate-media-tab-image").click();
	await page.getByTestId("generate-media-tab-generate").click();
}

test.describe("C2 — persona/Style-Bible UI removal (Gate A)", () => {
	test("Generate panel exposes no persona picker or Style Bible chip, even with a reel-level consistency context set", async ({
		page,
	}) => {
		await mockBaseline(page);
		await openEditor(page, "c2-gate-a-absence");

		// The Personas tab is gone entirely — not just its content, the
		// segmented-control option itself.
		await expect(page.getByTestId("generate-media-tab-personas")).toHaveCount(
			0,
		);
		// The old "no persona yet" hint that jumped to the Personas tab is gone.
		await expect(page.getByTestId("consistency-persona-hint")).toHaveCount(0);
		// No persona can be active from this surface anymore, so the passive
		// status chip never renders either.
		await expect(page.getByTestId("consistency-persona-chip")).toHaveCount(0);
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-01.png"),
		});

		// Even with a reel-level consistency context present (the same seam
		// Director writes through), the Style Bible chip must still not render
		// — Gate A removed the surface, not the underlying data.
		await setConsistencyContext(page);
		await remountGenerateSegment(page);
		await expect(page.getByTestId("consistency-style-bible-chip")).toHaveCount(
			0,
		);
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-02.png"),
		});
	});

	test("manual generation still works end-to-end with the picker gone: wire bodies are always persona/seed-free, but the backend STYLE fold still applies", async ({
		page,
	}) => {
		test.setTimeout(90_000);

		await mockBaseline(page);

		const capturedBodies: CapturedGenerateBody[] = [];
		await page.route("**/api/studio/generate", async (route) => {
			const n = capturedBodies.length + 1;
			const body = route.request().postDataJSON() as CapturedGenerateBody;
			capturedBodies.push(body);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					takeId: `take-c2-${n}`,
					setId: `set-c2-${n}`,
					jobId: `job-c2-${n}`,
					status: "completed",
					videoUrl: "https://mock.byorn.local/take.webm",
					seed: n,
				}),
			});
		});

		await openEditor(page, "c2-gate-a-generate");
		await setConsistencyContext(page);
		await remountGenerateSegment(page);

		// ── single-shot ──────────────────────────────────────────────────
		const before = await assetCount(page);
		await page
			.getByPlaceholder(/Describe your shot/)
			.fill(
				"Nova walks through a rain-slick alley, neon signs reflecting in puddles.",
			);
		await page.getByTestId("video-gen-submit").click();
		await expect
			.poll(async () => assetCount(page), { timeout: 20_000 })
			.toBe(before + 1);
		expect(capturedBodies.length).toBe(1);
		expect(capturedBodies[0].personaId).toBeUndefined();
		expect("seed" in capturedBodies[0]).toBe(false);
		// The reel-level STYLE fold is separate, still-live machinery
		// (consistency-fold.ts) — it isn't gated on the removed picker.
		expect(capturedBodies[0].prompt).toMatch(/^STYLE:[\s\S]*\n\nSHOT:/);
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-03.png"),
		});

		// ── batch of 2 — must also never carry a persona or seed ───────────
		await page.getByRole("button", { name: "2", exact: true }).click();
		await page
			.getByPlaceholder(/Describe your shot/)
			.fill("Nova, two variations, must vary — no locked seed.");
		await page.getByTestId("video-gen-submit").click();
		await expect.poll(() => capturedBodies.length, { timeout: 20_000 }).toBe(3);

		const batchBodies = capturedBodies.slice(1, 3);
		for (const body of batchBodies) {
			expect(body.personaId).toBeUndefined();
			expect("seed" in body).toBe(false);
			expect(body.prompt).toMatch(/^STYLE:[\s\S]*\n\nSHOT:/);
		}
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-04.png"),
		});
	});
});
