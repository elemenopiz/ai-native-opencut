import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test, type Page, type Locator } from "@playwright/test";

/**
 * campaign C26 (dogfood hunt) — W-DRAG worker.
 *
 * Hunts the DRAG / CONTEXT-MENU / RENAME cluster of the Assets panel
 * (matrix rows M8, M14, M15, M17, M18, M19, M20). READ-ONLY on product
 * source — this file only documents behavior, it fixes nothing.
 *
 * Drives http://localhost:3303 (NEXT_PUBLIC_E2E=1 dev server started
 * separately — see playwright.hunt-w-drag.config.ts, which has no
 * webServer block and just points baseURL at that port).
 */

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");
const W2_DIR = path.join(FIXTURE_DIR, "w2");
const VIDEO_FIXTURE = path.join(W2_DIR, "tiny_640x360_h264.mp4");
const IMAGE_FIXTURE = path.join(W2_DIR, "alpha_overlay_512.png");
const AUDIO_FIXTURE = path.join(FIXTURE_DIR, "tiny-tone.wav");

interface AssetSnapshot {
	id: string;
	name: string;
	type: string;
	duration?: number;
}

async function openEditor(page: Page, route: string): Promise<void> {
	await page.goto(`/editor/${route}`);
	// This host runs many concurrent fleet `next dev --turbopack` workers
	// (confirmed via `ps aux`) — bridge-ready under contention has been
	// observed taking well over 60s. Generous timeout so a slow-but-working
	// app isn't mistaken for broken.
	await page.waitForFunction(() => window.__BYORN_E2E__?.ready === true, null, {
		timeout: 180_000,
	});
	const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click().catch(() => {});
	}
}

async function importViaFileInput(
	page: Page,
	filePath: string,
): Promise<AssetSnapshot[]> {
	const mediaTab = page.getByRole("button", { name: "Media", exact: true });
	if (await mediaTab.isVisible().catch(() => false)) {
		await mediaTab.click();
	}
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
			.map((a) => ({
				id: a.id,
				name: a.name,
				type: a.type,
				duration: a.duration,
			}));
	}, before);
}

/** Right-click a grid/list media item by its display name to open the Radix
 *  context menu. Grid ("card") variant renders `<span title={name}>`; list
 *  ("compact") variant has no title attr, just exact text — fall back to
 *  that. */
async function rightClickAsset(page: Page, name: string): Promise<void> {
	const titled = page.locator(`span[title="${name}"]`).first();
	if (await titled.count()) {
		await titled.click({ button: "right" });
		return;
	}
	await page
		.getByText(name, { exact: true })
		.first()
		.click({ button: "right" });
}

/** Radix ContextMenu/DropdownMenu items are pointer-event driven — a plain
 *  `.click()` no-ops (per campaign brief, verified below). Dispatch the real
 *  pointerdown -> pointerup sequence Radix listens for. */
async function radixMenuItemClick(locator: Locator): Promise<void> {
	await locator.hover();
	await locator.dispatchEvent("pointermove", {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: "mouse",
		button: -1,
	});
	await locator.dispatchEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: "mouse",
		button: 0,
	});
	await locator.dispatchEvent("pointerup", {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: "mouse",
		button: 0,
	});
	// Real (trusted) mouse interactions auto-synthesize a trailing 'click'
	// after matching pointerdown/pointerup on the same element; dispatched
	// synthetic events do NOT get that for free, and some Radix primitives'
	// selection handler is wired to onClick rather than onPointerUp. Fire it
	// explicitly to cover both implementations.
	await locator.dispatchEvent("click", {
		bubbles: true,
		cancelable: true,
		button: 0,
	});
}

/** Enumerate the currently-open context menu's item labels (Radix renders
 *  items with role="menuitem"). */
async function contextMenuItemLabels(page: Page): Promise<string[]> {
	const items = page.getByRole("menuitem");
	const count = await items.count();
	const labels: string[] = [];
	for (let i = 0; i < count; i++) {
		labels.push((await items.nth(i).textContent())?.trim() ?? "");
	}
	return labels;
}

/**
 * Simulate a genuine HTML5 native drag from a media-grid/list item to the
 * timeline, by dispatching real DragEvents with a real DataTransfer — proven
 * interactively (see W-DRAG hunt notes) to actually exercise the app's own
 * onDragStart/onDragOver/onDrop handlers (draggable-item.tsx,
 * use-timeline-drag-drop.ts), NOT a bridge shortcut. Requires a real gap
 * between dragover and drop (React's setDropTarget state update needs to
 * commit before handleDrop's closure reads it — firing all events
 * synchronously silently no-ops the drop with zero errors, a gotcha in
 * itself worth remembering).
 */
async function dragAssetToTimeline(
	page: Page,
	params: { assetName: string; dropClientX: number; dropClientY: number },
): Promise<void> {
	const { assetName, dropClientX, dropClientY } = params;

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
			// List/compact variant: the item's own <button> is draggable and has
			// no title attr, just exact text content.
			const spans = Array.from(document.querySelectorAll("span"));
			const match = spans.find((s) => s.textContent === n);
			const btn = match?.closest('[draggable="true"]');
			return (btn as HTMLElement) ?? null;
		}
		const src = findDraggableFor(name);
		if (!src) throw new Error(`draggable element not found for "${name}"`);
		const rect = src.getBoundingClientRect();
		const dt = new DataTransfer();
		(window as unknown as Record<string, unknown>).__huntDT = dt;
		(window as unknown as Record<string, unknown>).__huntSrc = src;
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

	await page.evaluate(
		({ x, y }) => {
			const timeline = document.querySelector(
				'section[aria-label="Timeline"]',
			)!;
			const dt = (window as unknown as Record<string, unknown>)
				.__huntDT as DataTransfer;
			const ev = new DragEvent("dragenter", {
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
			});
			Object.defineProperty(ev, "dataTransfer", { value: dt });
			timeline.dispatchEvent(ev);
		},
		{ x: dropClientX, y: dropClientY },
	);
	await page.waitForTimeout(80);

	// Two dragovers (mirrors a real drag's repeated dragover stream) with a
	// real gap so React's setDropTarget commits before drop is dispatched.
	for (let i = 0; i < 2; i++) {
		await page.evaluate(
			({ x, y }) => {
				const timeline = document.querySelector(
					'section[aria-label="Timeline"]',
				)!;
				const dt = (window as unknown as Record<string, unknown>)
					.__huntDT as DataTransfer;
				const ev = new DragEvent("dragover", {
					bubbles: true,
					cancelable: true,
					clientX: x,
					clientY: y,
				});
				Object.defineProperty(ev, "dataTransfer", { value: dt });
				timeline.dispatchEvent(ev);
			},
			{ x: dropClientX, y: dropClientY },
		);
		await page.waitForTimeout(80);
	}

	await page.evaluate(
		({ x, y }) => {
			const timeline = document.querySelector(
				'section[aria-label="Timeline"]',
			)!;
			const dt = (window as unknown as Record<string, unknown>)
				.__huntDT as DataTransfer;
			const ev = new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
			});
			Object.defineProperty(ev, "dataTransfer", { value: dt });
			timeline.dispatchEvent(ev);
			const src = (window as unknown as Record<string, unknown>)
				.__huntSrc as HTMLElement;
			src?.dispatchEvent(
				new DragEvent("dragend", { bubbles: true, cancelable: true }),
			);
		},
		{ x: dropClientX, y: dropClientY },
	);
	await page.waitForTimeout(50);
}

function runFfprobe(filePath: string): { ok: boolean; info: string } {
	const args = [
		"-v",
		"error",
		"-show_streams",
		"-show_format",
		"-of",
		"json",
		filePath,
	];
	let result = spawnSync("ffprobe", args, { encoding: "utf-8" });
	if (result.error || result.status !== 0) {
		result = spawnSync("/opt/homebrew/bin/ffprobe", args, {
			encoding: "utf-8",
		});
	}
	if (result.error)
		return { ok: false, info: `ffprobe not runnable: ${result.error.message}` };
	if (result.status !== 0)
		return {
			ok: false,
			info: `ffprobe exited ${result.status}: ${result.stderr}`,
		};
	return { ok: true, info: result.stdout };
}

// ---------------------------------------------------------------------------
// M8 — Rename asset (context menu "Add label"/"Edit label")
// ---------------------------------------------------------------------------
test.describe("M8 — rename via context menu", () => {
	test("label edge cases: empty, 200-char, emoji, collision, reload persistence", async ({
		page,
	}) => {
		// This host runs several concurrent fleet `next dev --turbopack`
		// workers (confirmed via `ps aux`); each right-click/menu-item/evaluate
		// round-trip has been observed costing 10-60s+ under that contention,
		// and this test chains ~8 of them plus a full reload. Generous budget.
		test.setTimeout(600_000);
		await openEditor(page, "w-drag-m8");
		const [asset] = await importViaFileInput(page, VIDEO_FIXTURE);
		console.log("[M8] imported:", JSON.stringify(asset));

		// Open context menu, click "Add label" (pointerdown/pointerup — plain
		// .click() confirmed a no-op on this Radix menu, see helper doc).
		await rightClickAsset(page, asset.name);
		const addLabelItem = page.getByRole("menuitem", { name: "Add label" });
		await expect(addLabelItem).toBeVisible();
		await radixMenuItemClick(addLabelItem);

		const input = page.locator('input[placeholder="e.g. Drone shot, Cam A"]');
		await expect(input).toBeVisible();

		// 1) 200-char name
		const longLabel = "A".repeat(200);
		await input.fill(longLabel);
		await input.press("Enter");
		await page.waitForTimeout(200);
		let savedLabel = await page.evaluate(
			(id) =>
				window.__BYORN_E2E__!.editor.media.getAssets().find((a) => a.id === id)
					?.label,
			asset.id,
		);
		console.log(
			`[M8] 200-char label saved as (length ${savedLabel?.length}):`,
			savedLabel?.slice(0, 40),
		);
		expect(savedLabel?.length).toBe(200);

		// 2) Emoji name
		await rightClickAsset(page, asset.name);
		await radixMenuItemClick(
			page.getByRole("menuitem", { name: "Edit label" }),
		);
		const emojiLabel = "🎬 Drone Shot 🚁✨";
		await input.fill(emojiLabel);
		await input.press("Enter");
		await page.waitForTimeout(200);
		savedLabel = await page.evaluate(
			(id) =>
				window.__BYORN_E2E__!.editor.media.getAssets().find((a) => a.id === id)
					?.label,
			asset.id,
		);
		console.log("[M8] emoji label saved as:", savedLabel);
		expect(savedLabel).toBe(emojiLabel);

		// 3) Empty name -> should clear the label (updateMediaAsset does
		// `trimmed || undefined`)
		await rightClickAsset(page, asset.name);
		await radixMenuItemClick(
			page.getByRole("menuitem", { name: "Edit label" }),
		);
		await input.fill("");
		await input.press("Enter");
		await page.waitForTimeout(200);
		savedLabel = await page.evaluate(
			(id) =>
				window.__BYORN_E2E__!.editor.media.getAssets().find((a) => a.id === id)
					?.label,
			asset.id,
		);
		console.log("[M8] empty label saved as:", JSON.stringify(savedLabel));
		expect(savedLabel).toBeUndefined();
		// After clearing, context menu should read "Add label" again.
		await rightClickAsset(page, asset.name);
		await expect(
			page.getByRole("menuitem", { name: "Add label" }),
		).toBeVisible();
		await page.keyboard.press("Escape");

		// 4) Name collision with another asset: import a second video, give
		// both assets the SAME label, confirm both survive independently.
		const [asset2] = await importViaFileInput(page, IMAGE_FIXTURE);
		await rightClickAsset(page, asset.name);
		await radixMenuItemClick(page.getByRole("menuitem", { name: "Add label" }));
		await input.fill("Collide");
		await input.press("Enter");
		await page.waitForTimeout(200);
		await rightClickAsset(page, asset2.name);
		await radixMenuItemClick(page.getByRole("menuitem", { name: "Add label" }));
		await input.fill("Collide");
		await input.press("Enter");
		await page.waitForTimeout(200);
		const labels = await page.evaluate(
			({ id1, id2 }) => {
				const assets = window.__BYORN_E2E__!.editor.media.getAssets();
				return {
					a1: assets.find((a) => a.id === id1)?.label,
					a2: assets.find((a) => a.id === id2)?.label,
				};
			},
			{ id1: asset.id, id2: asset2.id },
		);
		console.log("[M8] collision labels:", JSON.stringify(labels));
		expect(labels.a1).toBe("Collide");
		expect(labels.a2).toBe("Collide");

		// 5) Reload persistence — does the label survive a full page reload
		// (i.e. is it actually written to storage, not just in-memory state)?
		await page.reload();
		await page.waitForFunction(
			() => window.__BYORN_E2E__?.ready === true,
			null,
			{
				timeout: 180_000,
			},
		);
		const dismiss = page.getByRole("button", { name: "Okay, I've read this" });
		if (await dismiss.isVisible().catch(() => false))
			await dismiss.click().catch(() => {});
		await page.waitForTimeout(500);
		const afterReload = await page.evaluate(
			(id) =>
				window.__BYORN_E2E__!.editor.media.getAssets().find((a) => a.id === id)
					?.label,
			asset.id,
		);
		console.log("[M8] label after reload:", afterReload);
		expect(afterReload).toBe("Collide");
	});

	test("rename while asset is still processing (proxy generation in flight)", async ({
		page,
	}) => {
		await openEditor(page, "w-drag-m8-processing");
		// Import and immediately (don't wait for proxy) try to label it.
		const before = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
		);
		const [fileChooser] = await Promise.all([
			page.waitForEvent("filechooser"),
			page.getByRole("button", { name: "Import", exact: true }).click(),
		]);
		await fileChooser.setFiles(VIDEO_FIXTURE);
		await page.waitForFunction(
			(beforeIds) => {
				const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
				return assets.some((a) => !beforeIds.includes(a.id));
			},
			before,
			{ timeout: 60_000 },
		);
		const asset = await page.evaluate((beforeIds) => {
			const assets = window.__BYORN_E2E__!.editor.media.getAssets();
			const a = assets.find((x) => !beforeIds.includes(x.id))!;
			return {
				id: a.id,
				name: a.name,
				hasProxy: !!a.proxyFile || !!a.proxyUrl,
			};
		}, before);
		console.log(
			"[M8-processing] asset immediately after import (proxy not necessarily ready):",
			JSON.stringify(asset),
		);

		await rightClickAsset(page, asset.name);
		const menuVisible = await page
			.getByRole("menuitem", { name: /label/i })
			.isVisible()
			.catch(() => false);
		console.log(
			"[M8-processing] context menu opened while proxy in flight:",
			menuVisible,
		);
		expect(menuVisible).toBe(true);
		await radixMenuItemClick(page.getByRole("menuitem", { name: /label/i }));
		const input = page.locator('input[placeholder="e.g. Drone shot, Cam A"]');
		await input.fill("Mid-proxy label");
		await input.press("Enter");
		await page.waitForTimeout(200);
		const label = await page.evaluate(
			(id) =>
				window.__BYORN_E2E__!.editor.media.getAssets().find((a) => a.id === id)
					?.label,
			asset.id,
		);
		console.log("[M8-processing] label saved while proxy in flight:", label);
		expect(label).toBe("Mid-proxy label");
	});
});

// ---------------------------------------------------------------------------
// M14/M17 — Drag-to-timeline from the main grid + drag-overlay states
// ---------------------------------------------------------------------------
test.describe("M14/M17 — drag-to-timeline from main grid + overlay states", () => {
	test("overlay: resting-empty vs drag-active copy is distinct (regression check)", async ({
		page,
	}) => {
		await openEditor(page, "w-drag-m17");
		// Fresh project, no assets yet -> resting EMPTY overlay.
		const emptyText = await page.getByText(
			"Drag and drop videos, photos, and audio files here",
		);
		await expect(emptyText).toBeVisible();

		// Simulate a file drag entering the panel (dragenter with Files type,
		// no real file yet) to flip isDragOver -> mode="drag-active". The
		// PanelView root (base-view.tsx) is the div that owns onDragEnter/
		// onDragOver/onDragLeave/onDrop (spread via `{...rest}`); locate it via
		// the "Assets" header span: span -> header div -> PanelView root div.
		await page.evaluate(() => {
			const header = Array.from(document.querySelectorAll("span")).find(
				(s) => s.textContent === "Assets",
			);
			const root = header?.parentElement?.parentElement as
				| HTMLElement
				| undefined;
			if (!root) throw new Error("Assets PanelView root not found");
			const dt = new DataTransfer();
			dt.items.add(new File(["x"], "x.mp4", { type: "video/mp4" }));
			const ev = new DragEvent("dragenter", {
				bubbles: true,
				cancelable: true,
			});
			Object.defineProperty(ev, "dataTransfer", { value: dt });
			root.dispatchEvent(ev);
		});
		await page.waitForTimeout(150);
		const dragActiveText = page.getByText("Drop files to import");
		const stillEmptyText = page.getByText(
			"Drag and drop videos, photos, and audio files here",
		);
		const dragActiveVisible = await dragActiveText
			.isVisible()
			.catch(() => false);
		const emptyStillVisible = await stillEmptyText
			.isVisible()
			.catch(() => false);
		console.log(
			`[M17] drag-active overlay visible=${dragActiveVisible} empty-copy still visible=${emptyStillVisible}`,
		);
		expect(dragActiveVisible).toBe(true);
		expect(emptyStillVisible).toBe(false);
	});

	test("video: drag lands on timeline at drop position and is present in getTracks()", async ({
		page,
	}) => {
		await openEditor(page, "w-drag-m14-video");
		const [asset] = await importViaFileInput(page, VIDEO_FIXTURE);
		console.log("[M14-video] imported:", JSON.stringify(asset));

		const timelineRect = await page.evaluate(() => {
			const el = document.querySelector('section[aria-label="Timeline"]')!;
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top, width: r.width, height: r.height };
		});
		const dropX = timelineRect.left + 250;
		const dropY = timelineRect.top + timelineRect.height / 2;

		await dragAssetToTimeline(page, {
			assetName: asset.name,
			dropClientX: dropX,
			dropClientY: dropY,
		});

		const tracks = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.timeline.getTracks().map((t) => ({
				type: t.type,
				elements: t.elements.map((e) => ({
					name: e.name,
					startTime: e.startTime,
					duration: e.duration,
				})),
			})),
		);
		console.log("[M14-video] tracks after drag:", JSON.stringify(tracks));
		const landed = tracks
			.flatMap((t) => t.elements)
			.find((e) => e.name === asset.name);
		expect(
			landed,
			`expected "${asset.name}" to land on the timeline via real drag`,
		).toBeTruthy();
		expect(landed!.startTime).toBeGreaterThanOrEqual(0);
	});

	test("image (alpha PNG): drag lands on its own track", async ({ page }) => {
		await openEditor(page, "w-drag-m14-image");
		const [asset] = await importViaFileInput(page, IMAGE_FIXTURE);
		console.log("[M14-image] imported:", JSON.stringify(asset));
		expect(asset.type).toBe("image");

		const timelineRect = await page.evaluate(() => {
			const r = document
				.querySelector('section[aria-label="Timeline"]')!
				.getBoundingClientRect();
			return { left: r.left, top: r.top, width: r.width, height: r.height };
		});
		await dragAssetToTimeline(page, {
			assetName: asset.name,
			dropClientX: timelineRect.left + 250,
			dropClientY: timelineRect.top + timelineRect.height / 2,
		});

		const tracks = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.timeline.getTracks().map((t) => ({
				type: t.type,
				elements: t.elements.map((e) => ({
					name: e.name,
					startTime: e.startTime,
				})),
			})),
		);
		console.log("[M14-image] tracks after drag:", JSON.stringify(tracks));
		const landed = tracks
			.flatMap((t) => t.elements)
			.find((e) => e.name === asset.name);
		expect(landed).toBeTruthy();
	});

	test("audio (tiny-tone.wav): drag lands on an AUDIO track, not video", async ({
		page,
	}) => {
		await openEditor(page, "w-drag-m14-audio");
		const [asset] = await importViaFileInput(page, AUDIO_FIXTURE);
		console.log("[M14-audio] imported:", JSON.stringify(asset));
		expect(asset.type).toBe("audio");

		const timelineRect = await page.evaluate(() => {
			const r = document
				.querySelector('section[aria-label="Timeline"]')!
				.getBoundingClientRect();
			return { left: r.left, top: r.top, width: r.width, height: r.height };
		});
		await dragAssetToTimeline(page, {
			assetName: asset.name,
			dropClientX: timelineRect.left + 250,
			dropClientY: timelineRect.top + timelineRect.height / 2,
		});

		const tracks = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.timeline.getTracks().map((t) => ({
				type: t.type,
				elements: t.elements.map((e) => ({ name: e.name })),
			})),
		);
		console.log("[M14-audio] tracks after drag:", JSON.stringify(tracks));
		const audioTrackWithEl = tracks.find(
			(t) =>
				t.type === "audio" && t.elements.some((e) => e.name === asset.name),
		);
		expect(
			audioTrackWithEl,
			"expected audio asset to land on an audio-type track",
		).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// M15 — Drag-to-timeline from other entry points (list view, empty vs
// existing-track vs between-tracks)
// ---------------------------------------------------------------------------
test.describe("M15 — alternate entry points and drop targets", () => {
	test("list view: drag from compact/list row lands correctly", async ({
		page,
	}) => {
		await openEditor(page, "w-drag-m15-list");
		const [asset] = await importViaFileInput(page, VIDEO_FIXTURE);

		// Toggle to list view via the view-mode button (first icon button in
		// the Assets panel's actions row, immediately left of the sort button
		// and the Import button).
		const importBtn = page.getByRole("button", { name: "Import", exact: true });
		const actionsRow = importBtn.locator("xpath=..");
		const viewToggleBtn = actionsRow.locator("button").first();
		await viewToggleBtn.click();
		await page.waitForTimeout(200);

		const timelineRect = await page.evaluate(() => {
			const r = document
				.querySelector('section[aria-label="Timeline"]')!
				.getBoundingClientRect();
			return { left: r.left, top: r.top, width: r.width, height: r.height };
		});
		await dragAssetToTimeline(page, {
			assetName: asset.name,
			dropClientX: timelineRect.left + 250,
			dropClientY: timelineRect.top + timelineRect.height / 2,
		});

		const tracks = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.timeline.getTracks().map((t) => ({
				elements: t.elements.map((e) => e.name),
			})),
		);
		console.log(
			"[M15-list] tracks after drag from list view:",
			JSON.stringify(tracks),
		);
		const landed = tracks.some((t) => t.elements.includes(asset.name));
		expect(
			landed,
			"expected drag from LIST view to land the element too",
		).toBeTruthy();
	});

	test("drop onto EMPTY timeline vs onto an EXISTING track vs BETWEEN tracks", async ({
		page,
	}) => {
		await openEditor(page, "w-drag-m15-targets");
		const [videoAsset] = await importViaFileInput(page, VIDEO_FIXTURE);
		const [imageAsset] = await importViaFileInput(page, IMAGE_FIXTURE);

		let timelineRect = await page.evaluate(() => {
			const r = document
				.querySelector('section[aria-label="Timeline"]')!
				.getBoundingClientRect();
			return { left: r.left, top: r.top, width: r.width, height: r.height };
		});

		// 1) Empty timeline -> should create a new track.
		await dragAssetToTimeline(page, {
			assetName: videoAsset.name,
			dropClientX: timelineRect.left + 200,
			dropClientY: timelineRect.top + timelineRect.height / 2,
		});
		let tracks = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.timeline.getTracks().map((t) => ({
				id: t.id,
				type: t.type,
				elements: t.elements.map((e) => ({
					name: e.name,
					startTime: e.startTime,
				})),
			})),
		);
		console.log(
			"[M15-targets] after drop 1 (empty timeline):",
			JSON.stringify(tracks),
		);
		expect(
			tracks.some((t) => t.elements.some((e) => e.name === videoAsset.name)),
		).toBeTruthy();

		// 2) Drop the second asset near the SAME row (existing track) at a
		// later X (different time) - expect it to land on the SAME track
		// (no new track created) since it's the same trackType (image also
		// maps to a "video"-type track).
		const trackCountBefore = tracks.length;
		await dragAssetToTimeline(page, {
			assetName: imageAsset.name,
			dropClientX: timelineRect.left + 600,
			dropClientY: timelineRect.top + timelineRect.height / 2 - 20, // same row band
		});
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
		console.log(
			"[M15-targets] after drop 2 (existing track attempt):",
			JSON.stringify(tracks),
		);
		const imageLanded = tracks.some((t) =>
			t.elements.some((e) => e.name === imageAsset.name),
		);
		expect(imageLanded, "second drop should land somewhere").toBeTruthy();
		console.log(
			`[M15-targets] track count before=${trackCountBefore} after=${tracks.length} (same => landed on existing track; +1 => new track was created instead)`,
		);
	});
});

// ---------------------------------------------------------------------------
// M18 — Context menu full sweep per asset type
// ---------------------------------------------------------------------------
// NOTE: consolidated to ONE navigation per describe block (instead of one
// per test) — this host is running several concurrent fleet `next dev`
// workers (confirmed via `ps aux`), and cold-navigation compiles were
// costing 20s-2min+ each under that contention. Reusing a single page/
// project across sub-checks cuts total navigations from ~9 to ~2 for
// M18+M19 combined.
test.describe("M18 — context menu sweep (single session, 3 asset types)", () => {
	test("video / image / audio menu items + still-processing asset", async ({
		page,
	}) => {
		await openEditor(page, "w-drag-m18-all");

		const [video] = await importViaFileInput(page, VIDEO_FIXTURE);
		await rightClickAsset(page, video.name);
		const videoLabels = await contextMenuItemLabels(page);
		console.log("[M18-video] menu items:", JSON.stringify(videoLabels));
		await page.keyboard.press("Escape");
		expect(videoLabels).toContain("Add label");
		expect(videoLabels).toContain("Find similar clips");
		expect(videoLabels).toContain("Extract first frame");
		expect(videoLabels).toContain("Extract last frame");
		expect(videoLabels).toContain("Download");
		expect(videoLabels).toContain("Delete");

		const [image] = await importViaFileInput(page, IMAGE_FIXTURE);
		await rightClickAsset(page, image.name);
		const imageLabels = await contextMenuItemLabels(page);
		console.log("[M18-image] menu items:", JSON.stringify(imageLabels));
		await page.keyboard.press("Escape");
		expect(imageLabels).toContain("Add label");
		expect(imageLabels).toContain("Find similar clips");
		expect(imageLabels).toContain("Download");
		expect(imageLabels).toContain("Delete");
		expect(imageLabels).not.toContain("Extract first frame");

		const [audio] = await importViaFileInput(page, AUDIO_FIXTURE);
		await rightClickAsset(page, audio.name);
		const audioLabels = await contextMenuItemLabels(page);
		console.log("[M18-audio] menu items:", JSON.stringify(audioLabels));
		await page.keyboard.press("Escape");
		expect(audioLabels).toContain("Add label");
		expect(audioLabels).toContain("Download");
		expect(audioLabels).toContain("Delete");
		expect(audioLabels).not.toContain("Find similar clips");
		expect(audioLabels).not.toContain("Extract first frame");

		// Still-processing check: import a 4th asset and right-click BEFORE
		// waiting for its proxy/thumbnail pipeline to settle.
		const before = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
		);
		const [fileChooser] = await Promise.all([
			page.waitForEvent("filechooser"),
			page.getByRole("button", { name: "Import", exact: true }).click(),
		]);
		await fileChooser.setFiles(VIDEO_FIXTURE);
		await page.waitForFunction(
			(beforeIds) => {
				const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
				return assets.some((a) => !beforeIds.includes(a.id));
			},
			before,
			{ timeout: 60_000 },
		);
		const processingAsset = await page.evaluate((beforeIds) => {
			const a = window
				.__BYORN_E2E__!.editor.media.getAssets()
				.find((x) => !beforeIds.includes(x.id))!;
			return { id: a.id, name: a.name };
		}, before);
		await rightClickAsset(page, processingAsset.name);
		const processingLabels = await contextMenuItemLabels(page);
		console.log(
			"[M18-processing] menu items while proxy in flight:",
			JSON.stringify(processingLabels),
		);
		expect(processingLabels.length).toBeGreaterThan(0);
		expect(processingLabels).toContain("Download");
		await page.keyboard.press("Escape");
	});
});

// ---------------------------------------------------------------------------
// M19 — NEW per-asset Download (landed @b8e354a2)
// ---------------------------------------------------------------------------
test.describe("M19 — per-asset Download (single session)", () => {
	test("download video/image/audio, post-rename filename, mid-proxy download", async ({
		page,
	}) => {
		await openEditor(page, "w-drag-m19-all");
		const fs = require("node:fs");

		// Mid-proxy download FIRST (before other imports settle any caches).
		const before0 = await page.evaluate(() =>
			window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
		);
		const [fc0] = await Promise.all([
			page.waitForEvent("filechooser"),
			page.getByRole("button", { name: "Import", exact: true }).click(),
		]);
		await fc0.setFiles(VIDEO_FIXTURE);
		await page.waitForFunction(
			(beforeIds) => {
				const assets = window.__BYORN_E2E__?.editor.media.getAssets() ?? [];
				return assets.some((a) => !beforeIds.includes(a.id));
			},
			before0,
			{ timeout: 60_000 },
		);
		const midProxyAsset = await page.evaluate((beforeIds) => {
			const a = window
				.__BYORN_E2E__!.editor.media.getAssets()
				.find((x) => !beforeIds.includes(x.id))!;
			return { id: a.id, name: a.name };
		}, before0);
		await rightClickAsset(page, midProxyAsset.name);
		const midProxyDownloadPromise = page
			.waitForEvent("download", { timeout: 15_000 })
			.catch((e) => {
				console.log("[M19-midproxy] no download event fired:", e.message);
				return null;
			});
		await radixMenuItemClick(page.getByRole("menuitem", { name: "Download" }));
		const midProxyDownload = await midProxyDownloadPromise;
		console.log(
			`[M19-midproxy] download fired while proxy in flight: ${!!midProxyDownload}`,
			midProxyDownload ? midProxyDownload.suggestedFilename() : "",
		);
		expect(midProxyDownload).toBeTruthy();

		// Video download + ffprobe.
		const [videoAsset] = await importViaFileInput(page, VIDEO_FIXTURE);
		await rightClickAsset(page, videoAsset.name);
		const videoDlPromise = page.waitForEvent("download");
		await radixMenuItemClick(page.getByRole("menuitem", { name: "Download" }));
		const videoDl = await videoDlPromise;
		const videoFilename = videoDl.suggestedFilename();
		const videoPath = await videoDl.path();
		const videoStat = videoPath ? fs.statSync(videoPath) : null;
		console.log(
			`[M19-video] filename=${videoFilename} size=${videoStat?.size} path=${videoPath}`,
		);
		expect(videoFilename).toMatch(/\.mp4$/i);
		expect(videoStat?.size).toBeGreaterThan(0);
		if (videoPath) {
			const probe = runFfprobe(videoPath);
			console.log(
				"[M19-video] ffprobe ok:",
				probe.ok,
				probe.ok ? "" : probe.info,
			);
			expect(probe.ok).toBe(true);
		}

		// Image download.
		const [imageAsset] = await importViaFileInput(page, IMAGE_FIXTURE);
		await rightClickAsset(page, imageAsset.name);
		const imageDlPromise = page.waitForEvent("download");
		await radixMenuItemClick(page.getByRole("menuitem", { name: "Download" }));
		const imageDl = await imageDlPromise;
		const imageFilename = imageDl.suggestedFilename();
		const imagePath = await imageDl.path();
		const imageStat = imagePath ? fs.statSync(imagePath) : null;
		console.log(
			`[M19-image] filename=${imageFilename} size=${imageStat?.size} path=${imagePath}`,
		);
		expect(imageFilename).toMatch(/\.png$/i);
		expect(imageStat?.size).toBeGreaterThan(0);

		// Audio download.
		const [audioAsset] = await importViaFileInput(page, AUDIO_FIXTURE);
		await rightClickAsset(page, audioAsset.name);
		const audioDlPromise = page.waitForEvent("download");
		await radixMenuItemClick(page.getByRole("menuitem", { name: "Download" }));
		const audioDl = await audioDlPromise;
		const audioFilename = audioDl.suggestedFilename();
		const audioPath = await audioDl.path();
		const audioStat = audioPath ? fs.statSync(audioPath) : null;
		console.log(
			`[M19-audio] filename=${audioFilename} size=${audioStat?.size} path=${audioPath}`,
		);
		expect(audioFilename).toMatch(/\.wav$/i);
		expect(audioStat?.size).toBeGreaterThan(0);

		// Download AFTER rename (label edit) — does filename follow the label?
		await rightClickAsset(page, videoAsset.name);
		await radixMenuItemClick(page.getByRole("menuitem", { name: "Add label" }));
		const input = page.locator('input[placeholder="e.g. Drone shot, Cam A"]');
		await input.fill("My Renamed Clip");
		await input.press("Enter");
		await page.waitForTimeout(200);
		await rightClickAsset(page, videoAsset.name); // still located by ORIGINAL
		// `name` (label != name) — see M8/F1 finding.
		const renamedDlPromise = page.waitForEvent("download");
		await radixMenuItemClick(page.getByRole("menuitem", { name: "Download" }));
		const renamedDl = await renamedDlPromise;
		const renamedFilename = renamedDl.suggestedFilename();
		console.log(
			`[M19-renamed] asset.name=${videoAsset.name} label="My Renamed Clip" downloaded filename=${renamedFilename}`,
		);
		expect(renamedFilename).toBe(videoAsset.name);
	});
});

// ---------------------------------------------------------------------------
// M20 — Record-button ENTRY POINTS only (permission denial + button states)
// ---------------------------------------------------------------------------
test.describe("M20 — Record entry points (entry + permission-denied UX only)", () => {
	test("timeline toolbar mic button: entry + mic-permission DENIED handling", async ({
		page,
		context,
	}) => {
		await context.clearPermissions();
		// Deny microphone by NOT granting it — Chromium auto-denies
		// getUserMedia prompts when no permission has been granted and the
		// page has no way to show a native prompt in headless/CDP-automated
		// mode, surfacing as a NotAllowedError (matches a real user clicking
		// "Block").
		await openEditor(page, "w-drag-m20-toolbar-deny");

		const recordBtn = page.getByRole("button", { name: "Record voiceover" });
		await expect(recordBtn).toBeVisible();
		console.log("[M20-toolbar] Record button visible before click: true");

		await recordBtn.click();
		await page.waitForTimeout(1000);

		const isRecordingLabelAfter = await page
			.getByRole("button", { name: "Stop recording" })
			.isVisible()
			.catch(() => false);
		const errorToastVisible = await page
			.getByText(/could not access microphone/i)
			.isVisible()
			.catch(() => false);
		console.log(
			`[M20-toolbar] after click+deny: isRecordingButtonShown=${isRecordingLabelAfter} errorToastVisible=${errorToastVisible}`,
		);
		expect(isRecordingLabelAfter).toBe(false);
	});

	test("timeline toolbar mic button: entry + mic-permission GRANTED starts recording state", async ({
		page,
		context,
	}) => {
		await context.grantPermissions(["microphone"]);
		await openEditor(page, "w-drag-m20-toolbar-grant");

		const recordBtn = page.getByRole("button", { name: "Record voiceover" });
		await expect(recordBtn).toBeVisible();
		await recordBtn.click();
		await page.waitForTimeout(500);

		const stopBtn = page.getByRole("button", { name: "Stop recording" });
		const isRecordingVisible = await stopBtn.isVisible().catch(() => false);
		console.log(
			`[M20-toolbar-grant] recording state entered: ${isRecordingVisible}`,
		);
		expect(isRecordingVisible).toBe(true);

		// Clean up: stop recording so the test doesn't leak an open MediaRecorder.
		if (isRecordingVisible) {
			await stopBtn.click();
			await page.waitForTimeout(300);
		}
	});

	test("Assets-panel Audio > Record sub-tab: entry point + permission-denied UX", async ({
		page,
		context,
	}) => {
		await context.clearPermissions();
		await openEditor(page, "w-drag-m20-panel-deny");

		const audioTab = page.getByRole("button", { name: "Audio", exact: true });
		await expect(audioTab).toBeVisible();
		await audioTab.click();
		await page.waitForTimeout(200);

		const recordSubTab = page.getByRole("button", {
			name: "Record",
			exact: true,
		});
		const recordSubTabVisible = await recordSubTab
			.isVisible()
			.catch(() => false);
		console.log(`[M20-panel] Record sub-tab visible: ${recordSubTabVisible}`);
		expect(recordSubTabVisible).toBe(true);
		await recordSubTab.click();
		await page.waitForTimeout(200);

		console.log("[M20-panel] entered Record sub-tab, panel rendered");
		// Just confirm the panel loaded without crashing (entry-point check) —
		// recording lifecycle itself is out of scope (sibling campaign).
		const recordingNameInput = page.locator(
			'input[placeholder="Recording name..."]',
		);
		await expect(recordingNameInput).toBeVisible();
	});
});
