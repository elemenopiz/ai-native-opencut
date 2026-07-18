import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * C21b bug-purge-w4, worker W3 — TASK A: C25 audio-lifecycle contracts
 * (BUG34 fix regression-check + record->discard/stop). Driven through the
 * real UI (filechooser import, real drag, real menu clicks, real
 * keyboard undo) — bridge is read-only for probing state, never for
 * seeding the actions under test.
 */

const AUDIO_FIXTURE = path.join(__dirname, "..", "fixtures", "tiny-tone.wav");

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
	await page.waitForTimeout(150);
}

async function probeDecodable(
	page: Page,
	assetId: string,
): Promise<{ ok: boolean; duration?: number; error?: string }> {
	return page.evaluate((id) => {
		return new Promise((resolve) => {
			const asset = window
				.__BYORN_E2E__!.editor.media.getAssets()
				.find((a) => a.id === id);
			if (!asset || !asset.file) {
				resolve({ ok: false, error: "asset or asset.file not found" });
				return;
			}
			const url = URL.createObjectURL(asset.file);
			const audio = new Audio();
			const cleanup = () => URL.revokeObjectURL(url);
			audio.onloadedmetadata = () => {
				resolve({ ok: true, duration: audio.duration });
				cleanup();
			};
			audio.onerror = () => {
				resolve({ ok: false, error: "audio element failed to decode" });
				cleanup();
			};
			audio.src = url;
			setTimeout(() => resolve({ ok: false, error: "timeout" }), 5000);
		});
	}, assetId);
}

// ---------------------------------------------------------------------------
// CONTRACT 1 — delete asset -> undo restores asset + timeline clip + decodability
// ---------------------------------------------------------------------------
test("Contract1: delete audio asset then Cmd+Z restores asset, clip, and decodability", async ({
	page,
}) => {
	await openEditor(page, "w3-contract1-delete-undo");
	const [asset] = await importViaFileInput(page, AUDIO_FIXTURE);
	console.log("[Contract1] imported:", JSON.stringify(asset));
	expect(asset.type).toBe("audio");

	const timelineRect = await page.evaluate(() => {
		const r = document
			.querySelector('section[aria-label="Timeline"]')!
			.getBoundingClientRect();
		return { left: r.left, top: r.top, width: r.width, height: r.height };
	});
	await realDrag(
		page,
		asset.name,
		timelineRect.left + 200,
		timelineRect.top + timelineRect.height / 2,
	);

	const beforeDelete = await page.evaluate(() => ({
		assets: window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
		clips: window
			.__BYORN_E2E__!.editor.timeline.getTracks()
			.flatMap((t) => t.elements.map((e) => e.name)),
	}));
	console.log("[Contract1] before delete:", JSON.stringify(beforeDelete));
	expect(beforeDelete.clips).toContain(asset.name);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taska-c1-before-delete.png"),
	});

	// Delete via the real Assets-panel context menu.
	const titled = page.locator(`span[title="${asset.name}"]`).first();
	if (await titled.count()) {
		await titled.click({ button: "right" });
	} else {
		await page
			.getByText(asset.name, { exact: true })
			.first()
			.click({ button: "right" });
	}
	const deleteItem = page.getByRole("menuitem", { name: "Delete" });
	await expect(deleteItem).toBeVisible();
	// Radix menu items are pointer-event driven, not a plain .click() —
	// dispatch the real sequence (per w-drag suite's documented gotcha).
	await deleteItem.hover();
	await deleteItem.dispatchEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: "mouse",
		button: 0,
	});
	await deleteItem.dispatchEvent("pointerup", {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: "mouse",
		button: 0,
	});
	await deleteItem.dispatchEvent("click", {
		bubbles: true,
		cancelable: true,
		button: 0,
	});
	await page.waitForTimeout(400);

	const afterDelete = await page.evaluate(() => ({
		assets: window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
		clips: window
			.__BYORN_E2E__!.editor.timeline.getTracks()
			.flatMap((t) => t.elements.map((e) => e.name)),
	}));
	console.log("[Contract1] after delete:", JSON.stringify(afterDelete));
	const assetGoneFromPanel = !afterDelete.assets.includes(asset.id);
	const clipGoneFromTimeline = !afterDelete.clips.includes(asset.name);
	console.log(
		`[Contract1] asset removed from panel=${assetGoneFromPanel} clip removed from timeline=${clipGoneFromTimeline}`,
	);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taska-c1-after-delete.png"),
	});

	// Undo.
	await page.keyboard.press("Meta+z");
	await page.waitForTimeout(500);

	const afterUndo = await page.evaluate(() => ({
		assets: window.__BYORN_E2E__!.editor.media.getAssets().map((a) => a.id),
		clips: window
			.__BYORN_E2E__!.editor.timeline.getTracks()
			.flatMap((t) => t.elements.map((e) => e.name)),
	}));
	console.log("[Contract1] after Cmd+Z:", JSON.stringify(afterUndo));
	const assetRestored = afterUndo.assets.includes(asset.id);
	const clipRestored = afterUndo.clips.includes(asset.name);
	console.log(
		`[Contract1] asset restored=${assetRestored} clip restored=${clipRestored}`,
	);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taska-c1-after-undo.png"),
	});

	const decode = await probeDecodable(page, asset.id);
	console.log(
		"[Contract1] decodability probe after undo:",
		JSON.stringify(decode),
	);

	const verdict =
		assetGoneFromPanel &&
		clipGoneFromTimeline &&
		assetRestored &&
		clipRestored &&
		decode.ok;
	console.log(`[Contract1] OVERALL VERDICT: ${verdict ? "PASS" : "FAIL"}`);
	expect(
		assetGoneFromPanel,
		"asset should be gone from panel after delete",
	).toBe(true);
	expect(
		clipGoneFromTimeline,
		"clip should be gone from timeline after delete",
	).toBe(true);
	expect(assetRestored, "asset should reappear in panel after undo").toBe(true);
	expect(clipRestored, "clip should be restored on timeline after undo").toBe(
		true,
	);
	expect(
		decode.ok,
		`audio should still be decodable after undo: ${decode.error}`,
	).toBe(true);
});

// ---------------------------------------------------------------------------
// CONTRACT 2 — record -> discard (zero new assets/clips), then record -> stop (exactly one)
// ---------------------------------------------------------------------------
test("Contract2: record->discard yields zero new assets, record->stop yields exactly one", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["microphone"]);
	await openEditor(page, "w3-contract2-record-discard");

	const countState = async () =>
		page.evaluate(() => ({
			assetCount: window.__BYORN_E2E__!.editor.media.getAssets().length,
			clipCount: window
				.__BYORN_E2E__!.editor.timeline.getTracks()
				.flatMap((t) => t.elements).length,
		}));

	const before = await countState();
	console.log("[Contract2] before any recording:", JSON.stringify(before));

	// --- record -> DISCARD ---
	const recordBtn = page.getByRole("button", { name: "Record voiceover" });
	await expect(recordBtn).toBeVisible();
	await recordBtn.click();
	await page.waitForTimeout(1200);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taska-c2-recording-in-progress.png"),
	});

	const discardBtn = page.getByRole("button", { name: "Discard recording" });
	const discardVisible = await discardBtn.isVisible().catch(() => false);
	console.log(
		"[Contract2] Discard button visible while recording:",
		discardVisible,
	);
	expect(discardVisible).toBe(true);
	await discardBtn.click();
	await page.waitForTimeout(600);

	const afterDiscard = await countState();
	console.log("[Contract2] after discard:", JSON.stringify(afterDiscard));
	const noNewAssetsAfterDiscard = afterDiscard.assetCount === before.assetCount;
	const noNewClipsAfterDiscard = afterDiscard.clipCount === before.clipCount;
	console.log(
		`[Contract2] discard clean: noNewAssets=${noNewAssetsAfterDiscard} noNewClips=${noNewClipsAfterDiscard}`,
	);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taska-c2-after-discard.png"),
	});

	// --- record -> STOP ---
	await recordBtn.click();
	await page.waitForTimeout(1200);
	const stopBtn = page.getByRole("button", { name: "Stop recording" });
	await expect(stopBtn).toBeVisible();
	await stopBtn.click();
	await page.waitForTimeout(1000);

	const afterStop = await countState();
	console.log("[Contract2] after stop:", JSON.stringify(afterStop));
	const exactlyOneNewAsset =
		afterStop.assetCount === afterDiscard.assetCount + 1;
	console.log(
		`[Contract2] exactly one new asset after stop: ${exactlyOneNewAsset}`,
	);
	await page.screenshot({
		path: path.join(SHOT_DIR, "taska-c2-after-stop.png"),
	});

	const verdict =
		noNewAssetsAfterDiscard && noNewClipsAfterDiscard && exactlyOneNewAsset;
	console.log(`[Contract2] OVERALL VERDICT: ${verdict ? "PASS" : "FAIL"}`);
	expect(
		noNewAssetsAfterDiscard,
		"discard should add zero new media assets",
	).toBe(true);
	expect(
		noNewClipsAfterDiscard,
		"discard should add zero new timeline clips",
	).toBe(true);
	expect(
		exactlyOneNewAsset,
		"stop should add exactly one new media asset",
	).toBe(true);
});
