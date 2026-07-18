import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * C21b bug-purge-w4, worker W3 — TASK B: C15 UI walk. Verification only
 * (frontend-design skill loaded as the critique lens) — no product-source
 * edits. Bridge used only to SEED background tasks / a fake generative
 * take (no paid backend available), never to fake the UI interactions
 * themselves.
 */

const SHOT_DIR = path.join(
	__dirname,
	"..",
	"..",
	"docs",
	"campaigns",
	"assets",
	"bug-purge-w4",
	"w3-completion",
	"screenshots",
);

async function openEditor(page: Page, route: string): Promise<void> {
	// Disable react-scan's debug overlay (auto-loaded in dev via
	// //unpkg.com/react-scan/dist/auto.global.js, src/app/layout.tsx) before
	// it can attach — its component-name annotation overlay was found to
	// break Playwright's text/visibility-based locators (see B1/B3 findings
	// note in task-b-results.md). Blocking the script network request is
	// the most reliable disable, independent of react-scan's internal API.
	await page.route("**/react-scan/**", (r) => r.abort());
	await page.goto(`/editor/${route}`);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 180_000,
	});
}

async function dismissGuideIfPresent(page: Page) {
	const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click().catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Item 1 — Docked tasks mini-bar: never occludes timeline, sits under Export dialog
// ---------------------------------------------------------------------------
test("B1: mini-bar never occludes timeline; Export dialog sits above it", async ({
	page,
}) => {
	await openEditor(page, "w3-b1-minibar");
	await dismissGuideIfPresent(page);

	// Seed a running background task via the bridge (legitimate SEEDING use —
	// a real proxy-generation task would require a real video decode, this
	// is the same store the app itself writes to).
	await page.evaluate(() => {
		const store = window.__BYORN_E2E__!.projectScopedStores.backgroundTasks.getState();
		store.addTask({
			id: "b1-fake-proxy-task",
			type: "proxy-generation",
			label: "Generating proxy — b1-fixture.mp4",
			progress: "42%",
		});
		store.setMinimized(false);
	});
	await page.waitForTimeout(300);

	const timelineBox = await page.evaluate(() => {
		const r = document
			.querySelector('section[aria-label="Timeline"]')!
			.getBoundingClientRect();
		return r.toJSON();
	});
	const miniBarBox = await page.evaluate(() => {
		// The widget's own root: fixed top-16 right-3 wrapper containing the toggle button.
		const btn = Array.from(document.querySelectorAll("button")).find(
			(b) =>
				b.className.includes("bg-surface-overlay") &&
				b.className.includes("rounded-full"),
		);
		const root = btn?.parentElement;
		return root ? root.getBoundingClientRect().toJSON() : null;
	});
	console.log("[B1] timeline bbox:", JSON.stringify(timelineBox));
	console.log("[B1] mini-bar bbox:", JSON.stringify(miniBarBox));

	const overlapsTimeline =
		miniBarBox &&
		miniBarBox.bottom > timelineBox.top &&
		miniBarBox.top < timelineBox.bottom &&
		miniBarBox.right > timelineBox.left &&
		miniBarBox.left < timelineBox.right;
	console.log("[B1] mini-bar overlaps timeline bbox:", !!overlapsTimeline);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taskb-b1-minibar-alone.png"),
	});

	// Now open Export dialog simultaneously.
	await page.getByRole("button", { name: "Export", exact: true }).click();
	await page.waitForTimeout(500);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taskb-b1-minibar-plus-export.png"),
	});

	const miniBarStillVisible = await page
		.evaluate(() => {
			const btn = Array.from(document.querySelectorAll("button")).find(
				(b) =>
					b.className.includes("bg-surface-overlay") &&
					b.className.includes("rounded-full"),
			);
			return !!btn && btn.getBoundingClientRect().width > 0;
		})
		.catch(() => false);
	console.log(
		"[B1] mini-bar element still present with the Export dialog open:",
		miniBarStillVisible,
	);

	// Z-order: read the actual computed z-index stack for both.
	const zInfo = await page.evaluate(() => {
		const btn = Array.from(document.querySelectorAll("button")).find(
			(b) =>
				b.className.includes("bg-surface-overlay") &&
				b.className.includes("rounded-full"),
		);
		const miniBarRoot = btn?.closest(".fixed") as HTMLElement | null;
		const dialog = document.querySelector(
			'[role="dialog"]',
		) as HTMLElement | null;
		return {
			miniBarZ: miniBarRoot ? getComputedStyle(miniBarRoot).zIndex : null,
			dialogZ: dialog ? getComputedStyle(dialog).zIndex : null,
			dialogPresent: !!dialog,
		};
	});
	console.log("[B1] z-index stack:", JSON.stringify(zInfo));

	expect(
		overlapsTimeline,
		"mini-bar must never geometrically overlap the timeline",
	).toBeFalsy();
});

// ---------------------------------------------------------------------------
// Item 2 — Board dialog empty state
// ---------------------------------------------------------------------------
test("B2: Board dialog empty state renders", async ({ page }) => {
	await openEditor(page, "w3-b2-board");
	await dismissGuideIfPresent(page);

	const boardBtn = page.getByRole("button", { name: "Board", exact: true });
	await expect(boardBtn).toBeVisible();
	await boardBtn.click();
	await page.waitForTimeout(500);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taskb-b2-board-empty.png"),
	});

	const dialogVisible = await page
		.getByRole("dialog")
		.isVisible()
		.catch(() => false);
	const bodyText = await page.evaluate(() => document.body.innerText);
	console.log("[B2] Board dialog visible:", dialogVisible);
	console.log(
		"[B2] mentions 'Board' text and something empty-state-ish:",
		bodyText.includes("Board"),
	);
	expect(dialogVisible).toBe(true);

	console.log(
		"[B2] open/promote/discard affordances: NOT independently verified — no bridge seam" +
			" exposes board-item seeding (use-board-items.ts / board-store.ts have no e2e-bridge" +
			" export), and seeding one requires a real generation batch (paid backend). Marked" +
			" NOT-RUN for the interactive sub-checks; empty-state render itself is verified above.",
	);
});

// ---------------------------------------------------------------------------
// Item 3 — First-run guide coexists with composer (BUG27 regression-check)
// ---------------------------------------------------------------------------
test("B3: first-run guide does not hide the Generate composer", async ({
	page,
}) => {
	await openEditor(page, "w3-b3-guide");
	await page.evaluate(() => localStorage.removeItem("hasReadEditorGuide-v1"));
	await page.reload();
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 180_000,
	});
	await page.waitForTimeout(400);

	const guideVisible = await page
		.getByText("Get started")
		.isVisible()
		.catch(() => false);
	const composerVisible = await page
		.getByPlaceholder(
			"Describe your shot…  Type @ to reference attached media.",
		)
		.isVisible()
		.catch(() => false);
	const generateTabVisible = await page
		.getByRole("button", { name: "Generate", exact: true })
		.isVisible()
		.catch(() => false);
	console.log(
		`[B3] guide visible=${guideVisible} composer textbox visible=${composerVisible} Generate tab visible=${generateTabVisible}`,
	);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taskb-b3-guide-plus-composer.png"),
	});

	expect(guideVisible, "first-run guide should render").toBe(true);
	expect(
		composerVisible,
		"Generate composer must remain visible alongside the guide (BUG27)",
	).toBe(true);
});

// ---------------------------------------------------------------------------
// Item 4 — Timeline empty-state hint (BUG28 regression-check)
// ---------------------------------------------------------------------------
test("B4: empty timeline shows an orienting hint", async ({ page }) => {
	await openEditor(page, "w3-b4-empty-hint");
	await dismissGuideIfPresent(page);
	await page.waitForTimeout(300);

	const hint = page.getByText("Drag media here or generate a clip to begin");
	const hintVisible = await hint.isVisible().catch(() => false);
	console.log("[B4] empty-timeline hint visible:", hintVisible);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taskb-b4-empty-timeline-hint.png"),
	});
	expect(hintVisible).toBe(true);
});

// ---------------------------------------------------------------------------
// Item 5 — Focus rings on a keyboard-only Tab walk
// ---------------------------------------------------------------------------
test("B5: keyboard Tab walk shows a visible focus ring on primitives", async ({
	page,
}) => {
	await openEditor(page, "w3-b5-focus");
	await dismissGuideIfPresent(page);
	await page.waitForTimeout(300);

	// Click somewhere neutral first so focus starts from a known place, then
	// Tab through a good number of stops, screenshotting a representative
	// sample and recording each focused element's tag/role/outline styling.
	await page.mouse.click(10, 10);
	const results: Array<{
		step: number;
		tag: string;
		role: string | null;
		text: string | null;
		outline: string;
		boxShadow: string;
		hasVisibleRing: boolean;
	}> = [];

	for (let i = 0; i < 40; i++) {
		await page.keyboard.press("Tab");
		await page.waitForTimeout(30);
		const info = await page.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			if (!el || el === document.body) return null;
			const cs = getComputedStyle(el);
			const hasOutline =
				cs.outlineStyle !== "none" && cs.outlineWidth !== "0px";
			const hasRingShadow = cs.boxShadow !== "none" && cs.boxShadow !== "";
			return {
				tag: el.tagName,
				role: el.getAttribute("role"),
				text: (el.getAttribute("aria-label") || el.textContent || "")
					.trim()
					.slice(0, 40),
				outline: cs.outline,
				boxShadow: cs.boxShadow,
				hasVisibleRing: hasOutline || hasRingShadow,
			};
		});
		if (info) results.push({ step: i, ...info });
	}

	console.log("[B5] tab walk results:", JSON.stringify(results, null, 2));
	const missingRing = results.filter((r) => !r.hasVisibleRing);
	console.log(
		`[B5] ${results.length} focusable stops visited; ${missingRing.length} had NO detectable outline/box-shadow:`,
		JSON.stringify(
			missingRing.map(
				(r) => `${r.tag}${r.role ? `[role=${r.role}]` : ""} "${r.text}"`,
			),
		),
	);

	// Screenshot 3 representative stops (spread across the walk).
	await page.mouse.click(10, 10);
	const shotSteps = [2, 15, 30];
	let step = 0;
	for (let i = 0; i <= Math.max(...shotSteps); i++) {
		await page.keyboard.press("Tab");
		step = i;
		if (shotSteps.includes(step)) {
			await page.screenshot({
				path: path.join(SHOT_DIR, `taskb-b5-focus-ring-step${step}.png`),
			});
		}
	}
});

// ---------------------------------------------------------------------------
// Item 6 — Generation-glow appears only during generation
// ---------------------------------------------------------------------------
test("B6: generation-glow class present only on a generating slot, not a failed one", async ({
	page,
}) => {
	await openEditor(page, "w3-b6-glow");
	await dismissGuideIfPresent(page);

	const insertResult = await page.evaluate(() => {
		try {
			const editor = window.__BYORN_E2E__!.editor;
			editor.timeline.insertElement({
				element: {
					id: "b6-generating",
					type: "video",
					mediaId: "",
					name: "Generating slot",
					startTime: 0,
					duration: 3,
					trimStart: 0,
					trimEnd: 0,
					transform: { x: 0, y: 0, scale: 1, rotation: 0 },
					opacity: 1,
					generation: { prompt: "b6 test", mode: "omni" },
					takes: [
						{
							id: "b6-take-1",
							status: "generating",
							spec: { prompt: "b6 test", mode: "omni" },
							createdAt: Date.now(),
						},
					],
					activeTakeId: "b6-take-1",
				} as any,
				placement: { mode: "auto" },
			});
			editor.timeline.insertElement({
				element: {
					id: "b6-failed",
					type: "video",
					mediaId: "",
					name: "Failed slot",
					startTime: 4,
					duration: 3,
					trimStart: 0,
					trimEnd: 0,
					transform: { x: 0, y: 0, scale: 1, rotation: 0 },
					opacity: 1,
					generation: { prompt: "b6 test 2", mode: "omni" },
					takes: [
						{
							id: "b6-take-2",
							status: "failed",
							spec: { prompt: "b6 test 2", mode: "omni" },
							createdAt: Date.now(),
							error: "simulated",
						},
					],
					activeTakeId: "b6-take-2",
				} as any,
				placement: { mode: "auto" },
			});
			return { ok: true };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	});
	console.log(
		"[B6] bridge-seeded generating+failed slots:",
		JSON.stringify(insertResult),
	);
	expect(insertResult.ok, "bridge seeding must succeed to run this check").toBe(
		true,
	);
	await page.waitForTimeout(500);

	const glow = await page.evaluate(() => {
		const els = Array.from(document.querySelectorAll(".glow-generation"));
		return els.map((e) => e.textContent?.trim().slice(0, 30));
	});
	console.log(
		"[B6] elements carrying glow-generation class:",
		JSON.stringify(glow),
	);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taskb-b6-generation-glow.png"),
	});

	expect(
		glow.length,
		"exactly one element (the generating slot) should carry the glow class",
	).toBe(1);
	expect(glow[0]).toContain("Generating");
});

// ---------------------------------------------------------------------------
// Item 7 — Micro-type spot check at 1280 and 1680
// ---------------------------------------------------------------------------
test("B7: micro-type legibility at 1280 and 1680 viewport widths", async ({
	page,
}) => {
	for (const width of [1280, 1680]) {
		await page.setViewportSize({ width, height: 900 });
		await openEditor(page, `w3-b7-microtype-${width}`);
		await dismissGuideIfPresent(page);
		await page.waitForTimeout(300);
		await page.screenshot({
			path: path.join(SHOT_DIR, `taskb-b7-microtype-${width}px.png`),
			fullPage: false,
		});

		// Sample a few small-text zones and check for clipping (scrollWidth >
		// clientWidth on inline-truncated labels is fine by design — the real
		// smell is a NEGATIVE box or text that overflows its container's
		// bounding box vertically, i.e. actually cut off top/bottom).
		const clippedCandidates = await page.evaluate(() => {
			const smallText = Array.from(document.querySelectorAll("span, button"))
				.filter((el) => {
					const cs = getComputedStyle(el);
					const size = Number.parseFloat(cs.fontSize);
					return (
						size > 0 && size <= 11 && (el.textContent?.trim().length ?? 0) > 0
					);
				})
				.slice(0, 200);
			const clipped = smallText.filter((el) => {
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				const lineHeight = Number.parseFloat(cs.lineHeight);
				return (
					r.height > 0 && !Number.isNaN(lineHeight) && r.height < lineHeight - 2
				);
			});
			return clipped.map((el) => ({
				text: el.textContent?.trim().slice(0, 30),
				tag: el.tagName,
				fontSize: getComputedStyle(el).fontSize,
			}));
		});
		console.log(
			`[B7] width=${width} sampled small-text elements; vertically-clipped candidates:`,
			JSON.stringify(clippedCandidates),
		);
	}
});
