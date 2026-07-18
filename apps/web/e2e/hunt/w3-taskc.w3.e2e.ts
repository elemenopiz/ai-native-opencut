import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * C21b bug-purge-w4, worker W3 — TASK C disambiguation of the 4 w-drag
 * suite ambiguous failures (REAL BUG vs HARNESS DRIFT), driven like a human
 * through the real UI. Also confirms the duplicate accessible-name "Audio"
 * DOM observation. READ-ONLY on product source.
 */

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");
const W2_DIR = path.join(FIXTURE_DIR, "w2");
const VIDEO_FIXTURE = path.join(W2_DIR, "tiny_640x360_h264.mp4");
const IMAGE_FIXTURE = path.join(W2_DIR, "alpha_overlay_512.png");

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
	await page.goto(`/editor/${route}`);
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 180_000,
	});
	const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click().catch(() => {});
	}
}

async function importViaFileInput(page: Page, filePath: string) {
	const before = await page.evaluate(() =>
		window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
	);
	const [fileChooser] = await Promise.all([
		page.waitForEvent("filechooser"),
		page.getByRole("button", { name: "Import", exact: true }).click(),
	]);
	await fileChooser.setFiles(filePath);
	await page.waitForFunction(
		(beforeIds) => {
			const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
			return assets.some((a) => !beforeIds.includes(a.id));
		},
		before,
		{ timeout: 60_000 },
	);
	return page.evaluate((beforeIds) => {
		const assets = window.__BYORN_E2E__!.editor.media.getAssets();
		return assets
			.filter((a) => !beforeIds.includes(a.id))
			.map((a) => ({ id: a.id, name: a.name, type: a.type }));
	}, before);
}

// ---------------------------------------------------------------------------
// Item 1 — SECOND-IMPORT filechooser timeout (M8/M18 collision leg)
// ---------------------------------------------------------------------------
test("C-item1: second Import click opens a filechooser after panel is populated", async ({
	page,
}) => {
	await openEditor(page, "w3-c1-second-import");
	const [first] = await importViaFileInput(page, VIDEO_FIXTURE);
	console.log("[C1] first import ok:", JSON.stringify(first));
	await page.screenshot({
		path: path.join(SHOT_DIR, "c1-after-first-import.png"),
	});

	const importBtn = page.getByRole("button", { name: "Import", exact: true });
	const stillThere = await importBtn.isVisible().catch(() => false);
	console.log(
		"[C1] Import button still visible after first import:",
		stillThere,
	);

	// Try a human-paced second import: click and see if a filechooser fires,
	// with a realistic (not suite's tight 30s) wait, and log exactly what
	// happens instead of failing hard.
	let fileChooserFired = false;
	let clickError: string | null = null;
	try {
		const [fc] = await Promise.all([
			page.waitForEvent("filechooser", { timeout: 15_000 }),
			importBtn.click(),
		]);
		await fc.setFiles(IMAGE_FIXTURE);
		fileChooserFired = true;
	} catch (e) {
		clickError = (e as Error).message;
	}
	console.log(
		`[C1] second Import click -> filechooser fired: ${fileChooserFired}`,
		clickError ? `error: ${clickError}` : "",
	);
	await page.screenshot({
		path: path.join(SHOT_DIR, "c1-after-second-import-attempt.png"),
	});

	const assetsAfter = await page.evaluate(() =>
		window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.name),
	);
	console.log(
		"[C1] assets after second-import attempt:",
		JSON.stringify(assetsAfter),
	);

	// Also try clicking a SECOND time in a totally fresh evaluate to see if
	// it's a "second native <input> click while first native <input> is still
	// mounted/hidden" browser quirk vs an app bug: check whether a hidden
	// <input type=file> element exists and whether repeated .click() on it
	// via DOM (not Playwright role click) fires natively.
	const inputInfo = await page.evaluate(() => {
		const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
		return inputs.map((i) => ({
			id: i.id,
			hidden: (i as HTMLInputElement).hidden,
			display: getComputedStyle(i).display,
			multiple: (i as HTMLInputElement).multiple,
		}));
	});
	console.log("[C1] file input(s) in DOM:", JSON.stringify(inputInfo));
});

// ---------------------------------------------------------------------------
// Item 2 — LIST-VIEW drag (M15)
// ---------------------------------------------------------------------------
test("C-item2: list/compact view exists and a row is human-draggable to timeline", async ({
	page,
}) => {
	await openEditor(page, "w3-c2-list-view");
	const [asset] = await importViaFileInput(page, VIDEO_FIXTURE);
	console.log("[C2] imported:", JSON.stringify(asset));

	const importBtn = page.getByRole("button", { name: "Import", exact: true });
	const actionsRow = importBtn.locator("xpath=..");
	const viewToggleBtn = actionsRow.locator("button").first();
	const toggleVisible = await viewToggleBtn.isVisible().catch(() => false);
	console.log("[C2] view-toggle button visible:", toggleVisible);
	if (toggleVisible) {
		await viewToggleBtn.click();
		await page.waitForTimeout(300);
	}
	await page.screenshot({
		path: path.join(SHOT_DIR, "c2-after-view-toggle.png"),
	});

	// Inspect what actually rendered: is it a list row, or did the grid stay?
	const rowInfo = await page.evaluate((name) => {
		const spans = Array.from(document.querySelectorAll("span"));
		const titled = document.querySelector(`span[title="${CSS.escape(name)}"]`);
		const exactText = spans.find((s) => s.textContent === name);
		return {
			hasTitledSpan: !!titled,
			hasExactTextSpan: !!exactText,
			draggableAncestorOfTitled: titled
				? !!titled.closest('[draggable="true"]')
				: null,
			draggableAncestorOfExact: exactText
				? !!exactText.closest('[draggable="true"]')
				: null,
		};
	}, asset.name);
	console.log("[C2] row DOM shape after toggle:", JSON.stringify(rowInfo));

	// Attempt the actual native-drag simulation (same technique as the suite)
	// but log every intermediate step instead of throwing on element-not-found.
	const dragResult = await page.evaluate((name) => {
		function findDraggableFor(n: string): { found: boolean; how: string } {
			const span = document.querySelector(
				`span[title="${CSS.escape(n)}"]`,
			) as HTMLElement | null;
			if (span) {
				let container: Element | null = span;
				for (let i = 0; i < 8; i++) {
					container = container?.parentElement ?? null;
					if (!container) break;
					const d = container.querySelector('[draggable="true"]');
					if (d) return { found: true, how: "titled-span-ancestor" };
				}
			}
			const spans = Array.from(document.querySelectorAll("span"));
			const match = spans.find((s) => s.textContent === n);
			const btn = match?.closest('[draggable="true"]');
			if (btn) return { found: true, how: "exact-text-closest-draggable" };
			return { found: false, how: "none" };
		}
		return findDraggableFor(name);
	}, asset.name);
	console.log(
		"[C2] draggable element search result:",
		JSON.stringify(dragResult),
	);

	if (dragResult.found) {
		const timelineRect = await page.evaluate(() => {
			const r = document
				.querySelector('section[aria-label="Timeline"]')!
				.getBoundingClientRect();
			return { left: r.left, top: r.top, width: r.width, height: r.height };
		});
		await page.evaluate(
			({ name, x, y }) => {
				function findDraggableFor(n: string): HTMLElement | null {
					const span = document.querySelector(
						`span[title="${CSS.escape(n)}"]`,
					) as HTMLElement | null;
					if (span) {
						let container: Element | null = span;
						for (let i = 0; i < 8; i++) {
							container = container?.parentElement ?? null;
							if (!container) break;
							const d = container.querySelector('[draggable="true"]');
							if (d) return d as HTMLElement;
						}
					}
					const spans = Array.from(document.querySelectorAll("span"));
					const match = spans.find((s) => s.textContent === n);
					return (match?.closest('[draggable="true"]') as HTMLElement) ?? null;
				}
				const src = findDraggableFor(name)!;
				const rect = src.getBoundingClientRect();
				const dt = new DataTransfer();
				(window as any).__huntDT = dt;
				(window as any).__huntSrc = src;
				const ev = new DragEvent("dragstart", {
					bubbles: true,
					cancelable: true,
					clientX: rect.left + rect.width / 2,
					clientY: rect.top + rect.height / 2,
				});
				Object.defineProperty(ev, "dataTransfer", { value: dt });
				src.dispatchEvent(ev);
			},
			{ name: asset.name, x: 0, y: 0 },
		);
		await page.waitForTimeout(80);
		const dropX = timelineRect.left + 250;
		const dropY = timelineRect.top + timelineRect.height / 2;
		for (const type of ["dragenter", "dragover", "dragover", "drop"]) {
			await page.evaluate(
				({ type, x, y }) => {
					const timeline = document.querySelector(
						'section[aria-label="Timeline"]',
					)!;
					const dt = (window as any).__huntDT as DataTransfer;
					const ev = new DragEvent(type, {
						bubbles: true,
						cancelable: true,
						clientX: x,
						clientY: y,
					});
					Object.defineProperty(ev, "dataTransfer", { value: dt });
					timeline.dispatchEvent(ev);
				},
				{ type, x: dropX, y: dropY },
			);
			await page.waitForTimeout(80);
		}
		const tracks = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.timeline.getTracks().map((t) => ({
				elements: t.elements.map((e) => e.name),
			})),
		);
		console.log("[C2] tracks after list-view drag:", JSON.stringify(tracks));
	}
	await page.screenshot({ path: path.join(SHOT_DIR, "c2-final-state.png") });
});

// ---------------------------------------------------------------------------
// Item 3 — SECOND-DROP silent no-op (M15) — strongest real-bug candidate
// ---------------------------------------------------------------------------
async function realDrag(
	page: Page,
	assetName: string,
	dropClientX: number,
	dropClientY: number,
) {
	await page.evaluate((name) => {
		function findDraggableFor(n: string): HTMLElement | null {
			const span = document.querySelector(
				`span[title="${CSS.escape(n)}"]`,
			) as HTMLElement | null;
			if (span) {
				let container: Element | null = span;
				for (let i = 0; i < 8; i++) {
					container = container?.parentElement ?? null;
					if (!container) break;
					const d = container.querySelector('[draggable="true"]');
					if (d) return d as HTMLElement;
				}
			}
			const spans = Array.from(document.querySelectorAll("span"));
			const match = spans.find((s) => s.textContent === n);
			return (match?.closest('[draggable="true"]') as HTMLElement) ?? null;
		}
		const src = findDraggableFor(name);
		if (!src) throw new Error(`draggable element not found for "${name}"`);
		const rect = src.getBoundingClientRect();
		const dt = new DataTransfer();
		(window as any).__huntDT = dt;
		(window as any).__huntSrc = src;
		const ev = new DragEvent("dragstart", {
			bubbles: true,
			cancelable: true,
			clientX: rect.left + rect.width / 2,
			clientY: rect.top + rect.height / 2,
		});
		Object.defineProperty(ev, "dataTransfer", { value: dt });
		src.dispatchEvent(ev);
	}, assetName);
	await page.waitForTimeout(80);
	for (const type of ["dragenter", "dragover", "dragover"]) {
		await page.evaluate(
			({ type, x, y }) => {
				const timeline = document.querySelector(
					'section[aria-label="Timeline"]',
				)!;
				const dt = (window as any).__huntDT as DataTransfer;
				const ev = new DragEvent(type, {
					bubbles: true,
					cancelable: true,
					clientX: x,
					clientY: y,
				});
				Object.defineProperty(ev, "dataTransfer", { value: dt });
				timeline.dispatchEvent(ev);
			},
			{ type, x: dropClientX, y: dropClientY },
		);
		await page.waitForTimeout(80);
	}
	await page.evaluate(
		({ x, y }) => {
			const timeline = document.querySelector(
				'section[aria-label="Timeline"]',
			)!;
			const dt = (window as any).__huntDT as DataTransfer;
			const ev = new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
			});
			Object.defineProperty(ev, "dataTransfer", { value: dt });
			timeline.dispatchEvent(ev);
			const src = (window as any).__huntSrc as HTMLElement;
			src?.dispatchEvent(
				new DragEvent("dragend", { bubbles: true, cancelable: true }),
			);
		},
		{ x: dropClientX, y: dropClientY },
	);
	await page.waitForTimeout(80);
}

test("C-item3: second drop (image onto occupied track, then onto empty space)", async ({
	page,
}) => {
	await openEditor(page, "w3-c3-second-drop");
	const [video] = await importViaFileInput(page, VIDEO_FIXTURE);
	const [image] = await importViaFileInput(page, IMAGE_FIXTURE);
	console.log("[C3] imported:", JSON.stringify({ video, image }));

	const timelineRect = await page.evaluate(() => {
		const r = document
			.querySelector('section[aria-label="Timeline"]')!
			.getBoundingClientRect();
		return { left: r.left, top: r.top, width: r.width, height: r.height };
	});

	// Drop 1: video onto empty timeline.
	await realDrag(
		page,
		video.name,
		timelineRect.left + 200,
		timelineRect.top + timelineRect.height / 2,
	);
	let tracks = await page.evaluate(() =>
		window.__BYORN_E2E__!.editor.timeline.getTracks().map((t) => ({
			id: t.id,
			type: t.type,
			top: undefined,
			elements: t.elements.map((e) => ({
				name: e.name,
				startTime: e.startTime,
			})),
		})),
	);
	console.log(
		"[C3] after drop1 (video, empty timeline):",
		JSON.stringify(tracks),
	);
	await page.screenshot({
		path: path.join(SHOT_DIR, "c3-after-drop1-video.png"),
	});

	// Get the ACTUAL on-screen bounding box of the occupied track's clip
	// element so drop2's Y coordinate genuinely lands "onto" the occupied
	// region, not just a Y computed from the panel's overall height.
	const occupiedTrackBox = await page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid], .timeline-element, [class*="timeline-track"]',
		);
		return el ? el.getBoundingClientRect().toJSON() : null;
	});
	console.log(
		"[C3] occupied-track element probe:",
		JSON.stringify(occupiedTrackBox),
	);

	// Drop 2: image dropped at a LATER x, same-row y band -> should either
	// land on the existing track or create a new one; must NOT vanish.
	const before2 = await page.evaluate(() =>
		window
			.__BYORN_E2E__!.editor.timeline.getTracks()
			.flatMap((t) => t.elements.map((e) => e.name)),
	);
	await realDrag(
		page,
		image.name,
		timelineRect.left + 600,
		timelineRect.top + timelineRect.height / 2 - 20,
	);
	tracks = await page.evaluate(() =>
		window.__BYORN_E2E__!.editor.timeline.getTracks().map((t) => ({
			id: t.id,
			type: t.type,
			elements: t.elements.map((e) => ({
				name: e.name,
				startTime: e.startTime,
			})),
		})),
	);
	const after2 = tracks.flatMap((t) => t.elements.map((e) => e.name));
	const imageLandedOnOccupied =
		after2.includes(image.name) && !before2.includes(image.name);
	console.log(
		"[C3] after drop2 (image onto occupied-track band):",
		JSON.stringify(tracks),
	);
	console.log("[C3] image landed anywhere after drop2:", imageLandedOnOccupied);
	await page.screenshot({
		path: path.join(SHOT_DIR, "c3-after-drop2-occupied.png"),
	});

	// Drop 3: same image, dropped onto EMPTY space clearly below all tracks.
	const emptyY = timelineRect.top + timelineRect.height - 5; // near bottom, below any populated row
	const before3 = await page.evaluate(() =>
		window
			.__BYORN_E2E__!.editor.timeline.getTracks()
			.flatMap((t) => t.elements.map((e) => e.name)),
	);
	await realDrag(page, image.name, timelineRect.left + 600, emptyY);
	tracks = await page.evaluate(() =>
		window.__BYORN_E2E__!.editor.timeline.getTracks().map((t) => ({
			id: t.id,
			type: t.type,
			elements: t.elements.map((e) => ({
				name: e.name,
				startTime: e.startTime,
			})),
		})),
	);
	const after3 = tracks.flatMap((t) => t.elements.map((e) => e.name));
	const imageLandedOnEmpty =
		after3.includes(image.name) && !before3.includes(image.name);
	console.log(
		"[C3] after drop3 (image onto empty space below tracks):",
		JSON.stringify(tracks),
	);
	console.log("[C3] image landed anywhere after drop3:", imageLandedOnEmpty);
	await page.screenshot({
		path: path.join(SHOT_DIR, "c3-after-drop3-empty-space.png"),
	});
});

// ---------------------------------------------------------------------------
// Item 4 — RECORD-START under GRANTED permission (M20), with fake-device
// launch flags actually applied (config sets --use-fake-device-for-media-capture)
// ---------------------------------------------------------------------------
test("C-item4: record start under granted permission + fake device", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["microphone"]);
	await openEditor(page, "w3-c4-record-granted");

	const recordBtn = page.getByRole("button", { name: "Record voiceover" });
	await expect(recordBtn).toBeVisible();
	await page.screenshot({ path: path.join(SHOT_DIR, "c4-before-click.png") });
	await recordBtn.click();
	await page.waitForTimeout(1500);

	const stopBtn = page.getByRole("button", { name: "Stop recording" });
	const isRecordingVisible = await stopBtn.isVisible().catch(() => false);
	console.log(
		"[C4] recording state entered (with fake device flags):",
		isRecordingVisible,
	);
	await page.screenshot({ path: path.join(SHOT_DIR, "c4-after-click.png") });

	// Also capture any error toast / console errors for context.
	const errorToastVisible = await page
		.getByText(/could not access microphone/i)
		.isVisible()
		.catch(() => false);
	console.log("[C4] error toast visible:", errorToastVisible);

	if (isRecordingVisible) {
		await stopBtn.click();
		await page.waitForTimeout(300);
	}
});

// ---------------------------------------------------------------------------
// CONFIRM — duplicate accessible name "Audio"
// ---------------------------------------------------------------------------
test("Confirm: duplicate accessible name Audio (assets-tab vs generate-media-tab-audio)", async ({
	page,
}) => {
	await openEditor(page, "w3-confirm-audio-dup");
	const matches = await page.evaluate(() => {
		const all = Array.from(document.querySelectorAll("button"));
		return all
			.filter((b) => {
				const label = b.getAttribute("aria-label") || b.textContent?.trim();
				return label === "Audio";
			})
			.map((b) => ({
				role: b.getAttribute("role") ?? "button (implicit)",
				ariaLabel: b.getAttribute("aria-label"),
				textContent: b.textContent?.trim(),
				testId: b.getAttribute("data-testid"),
				outerHTMLSnippet: b.outerHTML.slice(0, 200),
			}));
	});
	console.log(
		"[CONFIRM] elements matching accessible name 'Audio':",
		JSON.stringify(matches, null, 2),
	);
	expect(matches.length).toBeGreaterThanOrEqual(1);
});
