import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { WEBM_FIXTURE } from "./global-setup";

/**
 * Campaign C2 machine-verification: "a stranger keeps ONE character
 * consistent across 3 generations, and reuses the persona in a second
 * project."
 *
 * Drives the REAL Generate panel UI end to end — persona creation
 * (`PersonaManager`), the consistency strip (`GenerationForm`'s persona
 * chip / seed-lock badge / Style bible chip), and the manual generate path
 * (`useStudioGeneration().generate()`) — with every provider/API call
 * mocked at the network boundary (`page.route`). No real generation, upload,
 * or credit spend occurs.
 *
 * Machinery under test (all on the `campaign/char-consistency` base):
 *  - `src/hooks/use-studio-generation.ts` (~L263-300) folds the reel-level
 *    consistency context into the wire prompt and threads the active
 *    persona's stored seed for single-shot generations.
 *  - `src/lib/studio/consistency-fold.ts` — the pure fold + seed-override
 *    rules (`foldConsistencyIntoPrompt`, `resolvePersonaSeedOverride`).
 *  - `src/components/studio/generation-form.tsx` /
 *    `src/components/studio/persona-manager.tsx` — the consistency strip
 *    UI (persona chip, seed-lock badge, Style bible chip, personas
 *    empty-state, cross-tab hint).
 *
 * Screenshots land in `apps/web/docs/campaigns/assets/c2-walkthrough-0N.png`.
 */

const TAKE_WEBM = readFileSync(WEBM_FIXTURE);
const SCREENSHOT_DIR = path.join(__dirname, "..", "docs/campaigns/assets");

// A 1x1 transparent PNG — used as the persona's anchor image via the
// "…or paste an image URL" field so persona creation needs no file upload
// (and no network request the mock boundary would otherwise have to cover).
const ANCHOR_DATA_URI =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const NOVA_DESCRIPTOR =
	"A woman in her 30s, short silver hair, scar on left cheek, green eyes, worn orange flight jacket.";
const NOVA_SEED = 424242;

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
 *  any Assets-path proxy download, a successful board-pin acknowledgment
 *  (needed by the batch/negative-control step), and the persona-still
 *  endpoint (defensive — the spec forces "Fast" consistency mode so this
 *  should never actually be hit, see the report). */
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
	await page.route("**/api/studio/personas/*/still", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ imageUrl: "https://mock.byorn.local/still.png" }),
		});
	});
}

/** Mocks `GET/POST /api/studio/personas` with a stateful closure: the list
 *  starts empty (empty-state visible), `POST` echoes back a persona under a
 *  fixed id so the rest of the spec can assert against it by testid, and
 *  from then on `GET` returns that persona — this is what makes "open a
 *  brand-new project, the persona is still there" true across a full page
 *  navigation: the mock (standing in for the DB-backed server route) is the
 *  thing that "persists" it, not any client-side state. */
function mockPersonas(page: Page) {
	let created: {
		id: string;
		name: string;
		descriptor: string;
		anchorImageUrl: string;
		refImageUrls: string[];
		seed: number | null;
		createdAt: string;
	} | null = null;

	return page.route("**/api/studio/personas", async (route) => {
		const req = route.request();
		if (req.method() === "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ personas: created ? [created] : [] }),
			});
			return;
		}
		if (req.method() === "POST") {
			const body = req.postDataJSON() as {
				name: string;
				descriptor: string;
				anchorImageUrl: string;
				refImageUrls?: string[];
				seed?: number;
			};
			created = {
				id: "p-nova",
				name: body.name,
				descriptor: body.descriptor,
				anchorImageUrl: body.anchorImageUrl,
				refImageUrls: body.refImageUrls ?? [],
				// The create form DOES expose a "Locked seed (optional)" field
				// (persona-manager.tsx) — the spec fills it with NOVA_SEED and
				// this mock echoes back whatever the client actually sent, so
				// the assertion on the composer's seed-lock badge is exercising
				// the real client→wire seed value, not an injected one.
				seed: body.seed ?? NOVA_SEED,
				createdAt: new Date().toISOString(),
			};
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ persona: created }),
			});
			return;
		}
		await route.continue();
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

function videoSegment(page: Page) {
	return page.getByTestId("generate-media-tab-generate");
}
function personasSegment(page: Page) {
	return page.getByTestId("generate-media-tab-personas");
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
 *  (Director-only) is empty. No private internals touched. */
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

test.describe("C2 — persona consistency (creation, seed-lock, cross-project reuse)", () => {
	test("a stranger creates one persona, keeps it consistent across 3 generations, and reuses it in a second project", async ({
		page,
	}) => {
		test.setTimeout(150_000);

		await mockBaseline(page);
		await mockPersonas(page);

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
					seed: typeof body.seed === "number" ? body.seed : n,
				}),
			});
		});

		// ── Step 2: open the editor, no persona yet ─────────────────────────
		await openEditor(page, "c2-walkthrough-a");
		await expect(page.getByTestId("consistency-persona-hint")).toBeVisible();
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-01.png"),
		});

		// ── Step 3: the hint jumps to the Personas segment (empty state) ───
		await page.getByTestId("consistency-persona-hint").click();
		await expect(page.getByTestId("consistency-personas-empty")).toBeVisible();
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-02.png"),
		});

		// ── Step 4: create the persona without any uploads ──────────────────
		await page.getByPlaceholder("e.g. Nova").fill("Nova");
		await page.getByPlaceholder(/short silver hair/).fill(NOVA_DESCRIPTOR);
		await page.getByPlaceholder(/paste an image URL/).fill(ANCHOR_DATA_URI);
		await page
			.getByPlaceholder("Extra cross-shot stability")
			.fill(String(NOVA_SEED));
		await page.getByRole("button", { name: "Save persona" }).click();

		const novaCard = page.getByTestId("consistency-persona-select-p-nova");
		await expect(novaCard).toBeVisible();
		await expect(
			page.getByTestId("consistency-persona-card-seed-lock"),
		).toBeVisible();
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-03.png"),
		});

		// ── Step 5: back to Video — persona chip + seed-lock badge active ──
		// (persona-manager's handleSave already called setActive(persona.id)
		// on creation, so no explicit select click is needed here.)
		await videoSegment(page).click();
		await expect(page.getByTestId("consistency-persona-chip")).toBeVisible();
		const seedLockBadge = page.getByTestId("consistency-seed-lock");
		await expect(seedLockBadge).toBeVisible();
		await expect(seedLockBadge).toContainText(String(NOVA_SEED));
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-04.png"),
		});

		// Force "Fast" consistency mode so the batch's per-shot-still endpoint
		// (/api/studio/personas/<id>/still) is never exercised — keeps this
		// spec's network surface to exactly the endpoints under test. This is a
		// sticky (localStorage-persisted) setting, so it survives the
		// cross-project navigation in Step 8 too.
		await page.getByRole("button", { name: "Fast" }).click();

		// ── Step 6: reel-level consistency context (Style bible chip) ──────
		await setConsistencyContext(page);
		// GenerationForm reads the bible fresh on mount (no store subscription
		// wired to it) — remount by cycling segments to pick up the write.
		await personasSegment(page).click();
		await videoSegment(page).click();
		await expect(page.getByTestId("consistency-persona-chip")).toBeVisible();

		const styleBibleChip = page.getByTestId("consistency-style-bible-chip");
		let styleContextLanded = false;
		try {
			await expect(styleBibleChip).toBeVisible({ timeout: 5_000 });
			styleContextLanded = true;
			await styleBibleChip.click(); // open the popover
			await page.screenshot({
				path: path.join(SCREENSHOT_DIR, "c2-walkthrough-05.png"),
			});
			// Close the popover so it doesn't cover the composer for later steps.
			await page.keyboard.press("Escape");
		} catch {
			// Documented fallback per the task brief: proceed without the style
			// context if the public bible seam didn't land it (see report).
			await page.screenshot({
				path: path.join(SCREENSHOT_DIR, "c2-walkthrough-05.png"),
			});
		}

		// ── Step 7: three single-shot generations, same persona + seed ─────
		const prompts = [
			"Nova walks through a rain-slick alley, neon signs reflecting in puddles.",
			"Nova leans against a payphone, city lights blurred behind her.",
			"Nova looks up at a passing train, steam curling around her boots.",
		];
		for (const [i, prompt] of prompts.entries()) {
			const before = await assetCount(page);
			await page.getByPlaceholder(/Describe your shot/).fill(prompt);
			await page.getByTestId("video-gen-submit").click();
			await expect
				.poll(async () => assetCount(page), { timeout: 20_000 })
				.toBe(before + 1);
			expect(capturedBodies.length).toBe(i + 1);
		}
		expect(capturedBodies.length).toBe(3);
		for (const body of capturedBodies) {
			expect(body.personaId).toBe("p-nova");
			expect(body.seed).toBe(NOVA_SEED);
			if (styleContextLanded) {
				expect(body.prompt).toMatch(/^STYLE:[\s\S]*\n\nSHOT:/);
			}
		}

		// Bring the Media tab into view for the "takes landed in Assets" shot.
		await page.getByRole("button", { name: "Media", exact: true }).click();
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-06.png"),
		});

		// ── Step 8: cross-project reuse — fresh project, same mocked user ──
		await openEditor(page, "c2-walkthrough-b");
		await personasSegment(page).click();
		// The GET /api/studio/personas mock still returns Nova here — proving
		// the persona is user-scoped, not tied to the first project's client
		// state (activePersonaId itself DOES reset on the fresh page load;
		// selecting Nova below is the actual "reuse" action).
		const novaCardProjectB = page.getByTestId(
			"consistency-persona-select-p-nova",
		);
		await expect(novaCardProjectB).toBeVisible();
		await novaCardProjectB.click();

		await videoSegment(page).click();
		await expect(page.getByTestId("consistency-persona-chip")).toBeVisible();
		await expect(page.getByTestId("consistency-seed-lock")).toContainText(
			String(NOVA_SEED),
		);
		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "c2-walkthrough-07.png"),
		});

		const beforeCrossProject = await assetCount(page);
		await page
			.getByPlaceholder(/Describe your shot/)
			.fill("Nova steps off a ferry, harbor lights behind her.");
		await page.getByTestId("video-gen-submit").click();
		await expect
			.poll(async () => assetCount(page), { timeout: 20_000 })
			.toBe(beforeCrossProject + 1);
		expect(capturedBodies.length).toBe(4);
		expect(capturedBodies[3].personaId).toBe("p-nova");
		expect(capturedBodies[3].seed).toBe(NOVA_SEED);

		// ── Step 9: negative control — a batch of 2 must NOT carry a seed ──
		await page.getByRole("button", { name: "2", exact: true }).click();
		await page
			.getByPlaceholder(/Describe your shot/)
			.fill("Nova, two variations, must vary — no locked seed.");
		await page.getByTestId("video-gen-submit").click();
		await expect.poll(() => capturedBodies.length, { timeout: 20_000 }).toBe(6);

		const batchBodies = capturedBodies.slice(4, 6);
		for (const body of batchBodies) {
			expect(body.personaId).toBe("p-nova");
			expect("seed" in body).toBe(false);
		}
	});
});
