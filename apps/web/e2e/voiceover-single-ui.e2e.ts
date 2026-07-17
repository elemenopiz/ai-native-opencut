import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * BUG5 regression coverage — "two duplicate voiceover UIs, reconcile into
 * one" (campaign/audio-suite, C9/W1).
 *
 * Recon (2026-07-17) found the duplicate full voiceover UI
 * (`components/editor/ai/voiceover-panel.tsx`) was already deleted in
 * `d72df321`, leaving exactly ONE canonical TTS pipeline:
 * `components/editor/panels/assets/views/voiceover.tsx` (`VoiceoverView`,
 * imported into the Assets panel's Audio tab via `AudioCombinedView`). The
 * Generate panel's own Audio tab (`components/studio/audio-panel.tsx`) does
 * NOT re-implement voiceover — its "Voiceover" mode renders a `VoiceoverRedirect`
 * that deep-links to the canonical pipeline via `openAudioSubTab("voiceover")`
 * (`stores/assets-panel-store.tsx`).
 *
 * This spec proves the single-UI state end to end, in a real browser:
 *  1. The Assets panel's Audio tab -> Voiceover sub-tab renders the real
 *     pipeline (VoiceoverView), unassisted by the redirect.
 *  2. Driving a generation through that pipeline (with `/api/tts` mocked)
 *     actually lands audio: a new project MediaAsset AND a timeline audio
 *     track element, via VoiceoverView's real "Add to timeline" path
 *     (`landVoiceoverAudio` -> `importAudioAsset` -> the real mediabunny
 *     media-processing pipeline, given a genuinely decodable WAV blob).
 *  3. The Generate panel's Audio tab shows the redirect affordance (not a
 *     second implementation), and clicking it lands on the Assets panel's
 *     Audio -> Voiceover sub-tab — the SAME `VoiceoverView` instance type,
 *     not a look-alike.
 *
 * Network boundary: only `/api/tts` (the TTS provider call) and the usual
 * Generate-panel baseline (`/api/studio/backends`, `/api/credits/balance`,
 * `/api/studio/sets`) are mocked. Everything else — project creation, media
 * import/probe, timeline insertion — runs for real via the E2EBridge seam
 * (`window.__BYORN_E2E__`), same pattern as `takes-board-routing.e2e.ts`.
 */

const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

/**
 * Mint a small, genuinely decodable mono 16-bit PCM WAV in-process (no
 * Chromium encode needed — unlike VP9/Opus WebM, a hand-built WAV header is
 * trivial and every browser's native `<audio>` element decodes raw PCM
 * directly). ~0.3s of a quiet 440Hz tone at 8kHz — big enough to carry real
 * duration metadata through `getAudioDuration`/`getMediaDuration` (both use
 * a native `<audio>`/`<video>` element's `loadedmetadata` event), small
 * enough to stay a trivial fixture.
 */
function mintTinyWav({
	seconds = 0.3,
	sampleRate = 8000,
}: {
	seconds?: number;
	sampleRate?: number;
} = {}): Buffer {
	const numSamples = Math.round(seconds * sampleRate);
	const dataSize = numSamples * 2; // 16-bit mono
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16); // fmt chunk size
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // mono
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
	buffer.writeUInt16LE(2, 32); // block align
	buffer.writeUInt16LE(16, 34); // bits per sample
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataSize, 40);

	const amplitude = 4000; // quiet — well under int16 range
	const freq = 440;
	for (let i = 0; i < numSamples; i++) {
		const t = i / sampleRate;
		const sample = Math.round(amplitude * Math.sin(2 * Math.PI * freq * t));
		buffer.writeInt16LE(sample, 44 + i * 2);
	}

	return buffer;
}

const TTS_WAV = mintTinyWav();

/** Baseline mocks the Generate panel's Audio tab needs on mount even when the
 *  test never submits Score/Music — `use-backends.ts` and the credits store
 *  fetch these unconditionally. Mirrors `takes-board-routing.e2e.ts`. */
async function mockGenerateBaseline(page: Page) {
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
}

/** Opens a fresh project in the editor and waits for the real editor core +
 *  chrome to be live, dismissing the first-run guide if it covers the panels
 *  under test. Same pattern as every other spec in this suite. */
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
}

/** Assets panel's "Audio" tab icon has a unique `aria-label="Audio"` and no
 *  visible text (icon-only) — the Generate panel's Video/Image/Audio/Personas
 *  segmented control ALSO has an "Audio" accessible name (from its visible
 *  label text), so a plain role+name query is ambiguous whenever both are
 *  mounted. Scope to the aria-label attribute directly to always hit the
 *  Assets panel's tab, never the segmented control. */
function assetsAudioTabButton(page: Page) {
	return page.locator('button[aria-label="Audio"]');
}

test.describe("BUG5 — single voiceover UI", () => {
	test.beforeAll(async () => {
		await mkdir(SCREENSHOT_DIR, { recursive: true });
	});

	test.beforeEach(async ({ page }) => {
		await mockGenerateBaseline(page);
	});

	test("(a) Assets panel Audio -> Voiceover sub-tab renders the canonical pipeline", async ({
		page,
	}) => {
		await openEditor(page, "e2e-vo-a");

		await assetsAudioTabButton(page).click();
		await expect(
			page.getByRole("button", { name: "Voiceover", exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Voiceover", exact: true }).click();

		// The real VoiceoverView pipeline — its distinguishing controls, not a
		// look-alike stub.
		await expect(page.getByText("Voice engine")).toBeVisible();
		await expect(
			page.getByPlaceholder("Type or paste text to convert to speech..."),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Generate full voiceover" }),
		).toBeVisible();

		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "01-voiceover-pipeline-ui.png"),
		});
	});

	test("(b) mocked TTS generation lands audio on the timeline via the canonical pipeline", async ({
		page,
	}) => {
		let ttsCalls = 0;
		await page.route("**/api/tts", async (route) => {
			ttsCalls += 1;
			await route.fulfill({
				status: 200,
				contentType: "audio/wav",
				body: TTS_WAV,
			});
		});

		await openEditor(page, "e2e-vo-b");

		await assetsAudioTabButton(page).click();
		await page.getByRole("button", { name: "Voiceover", exact: true }).click();
		await expect(
			page.getByPlaceholder("Type or paste text to convert to speech..."),
		).toBeVisible();

		const before = await page.evaluate(() => ({
			assets: window.__BYORN_E2E__!.editor.media.getAssets().length,
			audioTrackElements: window
				.__BYORN_E2E__!.editor.timeline.getTracks()
				.filter((t) => t.type === "audio")
				.reduce((n, t) => n + t.elements.length, 0),
		}));

		await page
			.getByPlaceholder("Type or paste text to convert to speech...")
			.fill("This is a regression test for the single voiceover pipeline.");

		await page.getByRole("button", { name: "Generate full voiceover" }).click();

		// The preview player + "Add to timeline" affordance only appear once
		// generateSpeech (mocked /api/tts) has resolved and been decoded.
		const addToTimelineBtn = page.getByRole("button", {
			name: "Add to timeline as voice track",
		});
		await expect(addToTimelineBtn).toBeVisible({ timeout: 20_000 });
		expect(ttsCalls).toBe(1);

		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "02-voiceover-generated-preview.png"),
		});

		await addToTimelineBtn.click();

		await expect
			.poll(
				async () =>
					page.evaluate(() =>
						window
							.__BYORN_E2E__!.editor.timeline.getTracks()
							.filter((t) => t.type === "audio")
							.reduce((n, t) => n + t.elements.length, 0),
					),
				{ timeout: 20_000 },
			)
			.toBe(before.audioTrackElements + 1);

		// The landed clip went through the durable media-asset path (real
		// project, so `importAudioAsset` -> `processMediaAssets` ran), not the
		// ephemeral blob: fallback — a new registered asset backs it.
		const after = await page.evaluate(() => ({
			assets: window.__BYORN_E2E__!.editor.media.getAssets().length,
		}));
		expect(after.assets).toBe(before.assets + 1);

		const audioElement = await page.evaluate(() => {
			const track = window
				.__BYORN_E2E__!.editor.timeline.getTracks()
				.find((t) => t.type === "audio" && t.elements.length > 0);
			const el = track?.elements[0] as
				| { type: string; sourceType?: string; mediaId?: string }
				| undefined;
			return el
				? { type: el.type, sourceType: el.sourceType, mediaId: el.mediaId }
				: null;
		});
		expect(audioElement).not.toBeNull();
		expect(audioElement?.type).toBe("audio");
		expect(audioElement?.mediaId).toBeTruthy();

		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "03-voiceover-landed-on-timeline.png"),
		});
	});

	test("(c) Generate panel Audio tab's Voiceover mode redirects to the Assets Audio -> Voiceover sub-tab", async ({
		page,
	}) => {
		await openEditor(page, "e2e-vo-c");

		// Right panel defaults to "Generate"; its media segmented control
		// (Video/Image/Audio/Personas) is always mounted, so the "Audio" segment
		// is reachable by testid without touching the Assets panel at all yet.
		await page.getByTestId("generate-media-tab-audio").click();

		// Score/Music/Voiceover text-tab switch (AudioPanel's own mode picker) —
		// unambiguous here since the Assets panel's Audio sub-tab bar hasn't been
		// opened in this test yet, so there's only one "Voiceover"-labeled control
		// in the DOM at this point.
		await page.getByRole("button", { name: "Voiceover", exact: true }).click();

		// The redirect affordance — proof this surface does NOT re-implement the
		// pipeline, just links to it.
		await expect(page.getByText("Full voiceover pipeline")).toBeVisible();
		const openVoiceoverBtn = page.getByRole("button", {
			name: "Open Voiceover",
		});
		await expect(openVoiceoverBtn).toBeVisible();

		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "04-generate-panel-redirect.png"),
		});

		await openVoiceoverBtn.click();

		// openAudioSubTab("voiceover") fired: toast + the Assets panel switches to
		// Audio -> Voiceover, mounting the SAME canonical VoiceoverView.
		await expect(
			page.getByText("Opened the Voiceover pipeline."),
		).toBeVisible();
		await expect(
			page.getByPlaceholder("Type or paste text to convert to speech..."),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Generate full voiceover" }),
		).toBeVisible();

		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "05-redirect-landed-on-pipeline.png"),
		});
	});
});
