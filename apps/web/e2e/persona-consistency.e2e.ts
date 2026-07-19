import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { WEBM_FIXTURE } from "./global-setup";

/**
 * Campaign C2 machine-verification — GATE A CORRECTED (2026-07-20).
 *
 * Director-revamp Part E over-removed: it unmounted the Generate panel's
 * entire Personas tab (`PersonaManager` mount + tab trigger) along with the
 * "Keeping a character? Pick a persona →" hint and the Style Bible chip. The
 * user's actual Gate A intent, clarified 2026-07-20, was narrower — **hint
 * CTA removed; tab retained; chip stays unmounted.** Only the hint (a
 * pushy cross-tab nudge inside the form) was unwanted; the Personas tab
 * itself is a normal, always-available surface and was never meant to go.
 * This spec was corrected to match: the tab is restored and its
 * `PersonaManager` mount is pinned as present and functional, while the
 * hint and Style Bible chip absence pins from the Part E rewrite stay.
 *
 * The picker's machinery (`usePersonaStore`, `persona-manager.tsx`,
 * `seed-lock`, `consistency-prompt.ts`, `reference-intake.ts`,
 * `project-bible.ts`, and Director's own
 * `usePersonaStore.getState().setActive()` call in `director-api.ts`) was
 * never touched by Part E and stays live — re-mounting the tab was the
 * whole fix on the `generate.tsx` side.
 *
 * This spec pins:
 *  1. the Personas tab renders and clicking it mounts `PersonaManager`
 *     (smoke-checked via its empty-state testid) — the Gate-A-correction
 *     regression pin;
 *  2. the hint and Style Bible chip still don't render, even when a
 *     reel-level consistency context is present — the surviving half of
 *     the original Gate A removal;
 *  3. the manual-generate flow still works end-to-end, and a generation run
 *     through this panel *without* picking a persona stays persona/seed-free,
 *     while the *separate*, still-live STYLE/CHARACTERS/SETTING prompt fold
 *     (`lib/studio/consistency-fold.ts`, backend-only, never gated on the
 *     picker) still applies when a reel-level consistency context exists.
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
 *  acknowledgment (needed by the batch step). Persona endpoints are mocked
 *  separately (`mockPersonas`) only by the scenario that actually visits
 *  the Personas tab. */
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

/** Mocks `GET /api/studio/personas` with an empty catalog — enough for
 *  `PersonaManager` (`usePersonaStore`'s `load()`, called on mount) to
 *  settle into its empty state without erroring. Only the tab-navigation
 *  smoke test needs this; full persona creation/seed-lock/cross-project
 *  reuse coverage through this surface is out of scope here (that's the
 *  pre-Gate-A spec's job, not this regression pin's). */
function mockPersonas(page: Page) {
	return page.route("**/api/studio/personas", async (route) => {
		if (route.request().method() !== "GET") {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ personas: [] }),
		});
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
 *  prove the backend fold applies independently of persona selection —
 *  Gate A's "keep the product" half, not to drive any removed UI. */
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
 *  Gate A. Uses Image (not Personas) as "the other tab" to bounce off of so
 *  this helper doesn't trigger a `PersonaManager` mount as a side effect. */
async function remountGenerateSegment(page: Page) {
	await page.getByTestId("generate-media-tab-image").click();
	await page.getByTestId("generate-media-tab-generate").click();
}

test.describe("C2 — persona/Style-Bible UI (Gate A, corrected)", () => {
	test("Generate panel's Personas tab renders and mounts PersonaManager, but the persona hint and Style Bible chip stay gone even with a reel-level consistency context set", async ({
		page,
	}) => {
		await mockBaseline(page);
		await mockPersonas(page);
		await openEditor(page, "c2-gate-a-absence");

		// Gate A correction (2026-07-20): the Personas tab itself was never
		// meant to go — only the in-form hint CTA was. The tab renders as a
		// normal segmented-control option.
		const personasTab = page.getByTestId("generate-media-tab-personas");
		await expect(personasTab).toBeVisible();
		// The old "no persona yet" hint that used to jump here stays gone.
		await expect(page.getByTestId("consistency-persona-hint")).toHaveCount(0);
		// No persona is active yet, so the passive status chip doesn't render.
		await expect(page.getByTestId("consistency-persona-chip")).toHaveCount(0);
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-01.png"),
		});

		// Clicking the tab mounts the real PersonaManager surface — smoke-check
		// via its empty-state testid (no personas mocked).
		await personasTab.click();
		await expect(page.getByTestId("consistency-personas-empty")).toBeVisible();
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-02.png"),
		});
		await page.getByTestId("generate-media-tab-generate").click();

		// Even with a reel-level consistency context present (the same seam
		// Director writes through), the Style Bible chip must still not render
		// — that half of Gate A's removal stands.
		await setConsistencyContext(page);
		await remountGenerateSegment(page);
		await expect(page.getByTestId("consistency-style-bible-chip")).toHaveCount(
			0,
		);
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-03.png"),
		});
	});

	test("manual generation still works end-to-end without picking a persona: wire bodies are persona/seed-free, but the backend STYLE fold still applies", async ({
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
		// (consistency-fold.ts) — it isn't gated on picking a persona.
		expect(capturedBodies[0].prompt).toMatch(/^STYLE:[\s\S]*\n\nSHOT:/);
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-04.png"),
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
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-05.png"),
		});
	});
});
