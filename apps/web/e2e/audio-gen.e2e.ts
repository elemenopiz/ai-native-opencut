import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { WEBM_FIXTURE } from "./global-setup";

/**
 * campaign/audio-suite (C9), W2 — gen-audio flows land on the timeline.
 *
 * Covers the gap recon found: Score mode (MMAudio V2, async fal.ai queue)
 * already places its scored VIDEO back at the captured span — this spec adds
 * a regression net for that untouched path. Music mode (ElevenLabs Music,
 * sync) previously only added its result to Assets with no way onto the
 * timeline; this spec drives the new "Add to timeline" affordance
 * (`audio-panel.tsx`'s `MusicMode.addToTimeline`) end to end and asserts an
 * AUDIO track genuinely holds the placed element.
 *
 * Everything at the network boundary is mocked (`/api/studio/*`,
 * `/api/credits/*`) — no real provider is ever hit, no credits are spent.
 * Real client-side pipelines run for real: `processMediaAssets` (mediabunny
 * probe) for the Score source video, `uploadReferenceFile` for the
 * reference-video upload path, and the genuine `editor.timeline`/`editor.media`
 * managers for both placements.
 */

const TAKE_WEBM = readFileSync(WEBM_FIXTURE);
const TONE_WAV = readFileSync(
	path.join(__dirname, "fixtures", "tiny-tone.wav"),
);

const SCORE_RESULT_URL = "https://mock.byorn.local/scored-result.webm";
const MUSIC_RESULT_URL = "https://mock.byorn.local/music-track.wav";
const SCORE_SOURCE_UPLOAD_URL = "https://mock.byorn.local/score-source.webm";
const SCORE_JOB_ID = "score-job-1";

/** Baseline mocks every test in this file needs: an empty backend catalog
 *  (Score/Music fall back to their hardcoded defaults — see audio-panel.tsx's
 *  `SCORE_MAX_DURATION_SEC`), a generous credit balance, no prior generation
 *  history, and the proxy route `addItemsToProjectMedia` fetches through —
 *  branched by the mocked result URL so Score gets real WebM bytes and Music
 *  gets a real (tiny, decodable) WAV, letting the genuine mediabunny/
 *  `getMediaDuration` probe run on each. */
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
	await page.route("**/api/studio/proxy**", async (route: Route) => {
		const target = new URL(route.request().url()).searchParams.get("url") ?? "";
		if (target === SCORE_RESULT_URL || target === SCORE_SOURCE_UPLOAD_URL) {
			await route.fulfill({
				status: 200,
				contentType: "video/webm",
				body: TAKE_WEBM,
			});
			return;
		}
		if (target === MUSIC_RESULT_URL) {
			await route.fulfill({
				status: 200,
				contentType: "audio/wav",
				body: TONE_WAV,
			});
			return;
		}
		await route.fulfill({ status: 404, body: "not found" });
	});
}

/** Score-only mocks: the reference-video upload path `uploadReferenceFile`
 *  drives (`ScoreMode`'s mount effect auto-attaches the selected timeline
 *  clip as the source, then uploads it before Generate is enabled). Force
 *  the presigned-URL leg unavailable so the simpler buffered
 *  `/api/studio/upload` fallback is exercised. */
async function mockUploadFlow(page: Page) {
	await page.route("**/api/studio/upload-url", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ available: false }),
		});
	});
	await page.route("**/api/studio/upload", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ url: SCORE_SOURCE_UPLOAD_URL, kind: "video" }),
		});
	});
}

/** Opens a fresh project in the editor and waits for the real editor core to
 *  be live, dismissing the first-run guide — same recipe as
 *  takes-board-routing.e2e.ts. */
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
}

async function openAudioTab(page: Page) {
	const generateTab = page.getByRole("button", {
		name: "Generate",
		exact: true,
	});
	if (await generateTab.isVisible().catch(() => false)) {
		await generateTab.click();
	}
	await page.getByTestId("generate-media-tab-audio").click();
}

interface AssetSnapshot {
	id: string;
	type: string;
}

async function getAssets(page: Page): Promise<AssetSnapshot[]> {
	return page.evaluate(() =>
		(window.__BYORN_E2E__?.editor.media.getAssets() ?? []).map((a) => ({
			id: a.id,
			type: a.type,
		})),
	);
}

/** Real import through the Media panel's Import button -> native file-chooser
 *  -> `processMediaAssets`, mirroring `fixtures-w2-hunt.e2e.ts`'s
 *  `importViaFileInput` helper. Real pipeline, no network involved. */
async function importViaFileInput(
	page: Page,
	filePath: string,
): Promise<string> {
	const mediaTab = page.getByRole("button", { name: "Media", exact: true });
	if (await mediaTab.isVisible().catch(() => false)) {
		await mediaTab.click();
	}
	const before = await getAssets(page);
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
		before.map((a) => a.id),
		{ timeout: 60_000 },
	);

	const after = await getAssets(page);
	const added = after.find((a) => !before.some((b) => b.id === a.id));
	if (!added) throw new Error("import did not produce a new asset");
	return added.id;
}

/** Places `mediaId` on a fresh video track at t=0 and selects it — the
 *  precondition `ScoreMode`'s mount-effect needs to auto-attach it as the
 *  scoring source (see audio-panel.tsx's `defaultAppliedRef` effect). */
async function seedSelectedVideoClip(page: Page, mediaId: string) {
	await page.evaluate((id) => {
		const bridge = window.__BYORN_E2E__!;
		const asset = bridge.editor.media.getAssets().find((a) => a.id === id);
		if (!asset) throw new Error("seed asset missing");
		const trackId = bridge.editor.timeline.addTrack({ type: "video" });
		const elementId = bridge.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: asset.id,
				name: asset.name,
				duration: Math.min(asset.duration ?? 1, 1),
				startTime: 0,
				trimStart: 0,
				trimEnd: 0,
			},
			placement: { mode: "explicit", trackId },
		});
		bridge.editor.selection.setSelectedElements({
			elements: [{ trackId, elementId }],
		});
	}, mediaId);
}

interface TrackSnapshot {
	id: string;
	type: string;
	elements: Array<{ id: string; type: string; mediaId?: string }>;
}

async function getTracks(page: Page): Promise<TrackSnapshot[]> {
	return page.evaluate(() =>
		(window.__BYORN_E2E__?.editor.timeline.getTracks() ?? []).map((t) => ({
			id: t.id,
			type: t.type,
			elements: t.elements.map((e) => ({
				id: e.id,
				type: e.type,
				mediaId: "mediaId" in e ? (e.mediaId as string) : undefined,
			})),
		})),
	);
}

test.describe("audio-gen flows land on the timeline", () => {
	test("Music: generated take gets an Add to timeline affordance that lands on an audio track", async ({
		page,
	}) => {
		await mockBaseline(page);
		await page.route("**/api/studio/audio", async (route) => {
			const body = route.request().postDataJSON() as { action?: string };
			expect(body.action).toBe("music");
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					id: "music-job-1",
					jobId: "music-job-1",
					action: "music",
					status: "completed",
					resultUrl: MUSIC_RESULT_URL,
					provenance: {
						backendId: "elevenlabs-music",
						vendor: "elevenlabs",
						model: "elevenlabs-music",
						safetyTier: "standard",
						routedBy: "auto",
						intent: "text-music",
						seedLocked: false,
						generatedAt: Date.now(),
					},
					cost: { estimated: false, min: 5, max: 5 },
				}),
			});
		});

		await openGeneratePanel(page, "e2e-audio-music");
		await openAudioTab(page);
		await page.getByRole("button", { name: "Music", exact: true }).click();

		const before = await getAssets(page);

		await page
			.getByPlaceholder(/Describe the track/)
			.fill("a warm lo-fi bed for a product montage");
		await page.getByTestId("audio-gen-submit").click();

		await expect
			.poll(async () => (await getAssets(page)).length, { timeout: 20_000 })
			.toBe(before.length + 1);

		const after = await getAssets(page);
		const added = after.find((a) => !before.some((b) => b.id === a.id));
		expect(added?.type).toBe("audio");

		// The result preview + placement affordance both render off `lastResult`.
		await expect(page.locator("audio[src]")).toHaveCount(1);
		const addToTimeline = page.getByRole("button", { name: "Add to timeline" });
		await expect(addToTimeline).toBeVisible();

		const tracksBefore = await getTracks(page);
		await addToTimeline.click();

		await expect
			.poll(
				async () => {
					const tracks = await getTracks(page);
					return tracks.some(
						(t) =>
							t.type === "audio" &&
							t.elements.some(
								(e) => e.type === "audio" && e.mediaId === added?.id,
							),
					);
				},
				{ timeout: 10_000 },
			)
			.toBe(true);

		const tracksAfter = await getTracks(page);
		const audioTrackCountBefore = tracksBefore.filter(
			(t) => t.type === "audio",
		).length;
		const audioTrackCountAfter = tracksAfter.filter(
			(t) => t.type === "audio",
		).length;
		// addTrack always creates a fresh track (see AddTrackCommand) — the same
		// idiom views/voiceover.tsx's handleAddToTimeline uses.
		expect(audioTrackCountAfter).toBe(audioTrackCountBefore + 1);
	});

	test("Score: scored take lands in Assets and offers place-at-span", async ({
		page,
	}) => {
		await mockBaseline(page);
		await mockUploadFlow(page);

		let scoreCalls = 0;
		await page.route("**/api/studio/audio", async (route) => {
			const body = route.request().postDataJSON() as { action?: string };
			expect(body.action).toBe("score");
			scoreCalls += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					id: SCORE_JOB_ID,
					jobId: SCORE_JOB_ID,
					action: "score",
					status: "processing",
					resultUrl: null,
					provenance: {
						backendId: "fal-mmaudio",
						vendor: "fal",
						model: "fal-mmaudio",
						safetyTier: "standard",
						routedBy: "auto",
						intent: "video-score",
						seedLocked: false,
						generatedAt: Date.now(),
					},
					cost: { estimated: false, min: 3, max: 3 },
				}),
			});
		});
		await page.route(`**/api/studio/audio/${SCORE_JOB_ID}`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					status: "completed",
					resultUrl: SCORE_RESULT_URL,
				}),
			});
		});

		await openGeneratePanel(page, "e2e-audio-score");
		const sourceMediaId = await importViaFileInput(page, WEBM_FIXTURE);
		await seedSelectedVideoClip(page, sourceMediaId);

		await openAudioTab(page);
		// Score is the default mode — mounting picks up the selection made above
		// via ScoreMode's mount-only `defaultAppliedRef` effect, which uploads
		// the clip as the reference source (mocked upload-url/upload routes).
		const submit = page.getByTestId("audio-gen-submit");
		await expect(submit).toBeEnabled({ timeout: 20_000 });

		const before = await getAssets(page);
		await submit.click();

		// The MMAudio poll sleeps ~3s before its first check (see audio-panel.tsx's
		// `pollAudioJob`/`abortableSleep`), so give this enough headroom.
		await expect
			.poll(async () => (await getAssets(page)).length, { timeout: 20_000 })
			.toBe(before.length + 1);
		expect(scoreCalls).toBe(1);

		const after = await getAssets(page);
		const added = after.find((a) => !before.some((b) => b.id === a.id));
		expect(added?.type).toBe("video");

		const placeButton = page.getByRole("button", {
			name: "Place on timeline at that span",
		});
		await expect(placeButton).toBeVisible();

		const tracksBefore = await getTracks(page);
		await placeButton.click();
		await expect(
			page.getByText("Placed on the timeline at that span."),
		).toBeVisible();

		const tracksAfter = await getTracks(page);
		const totalElementsBefore = tracksBefore.reduce(
			(n, t) => n + t.elements.length,
			0,
		);
		const totalElementsAfter = tracksAfter.reduce(
			(n, t) => n + t.elements.length,
			0,
		);
		expect(totalElementsAfter).toBe(totalElementsBefore + 1);
		expect(
			tracksAfter.some((t) =>
				t.elements.some((e) => e.type === "video" && e.mediaId === added?.id),
			),
		).toBe(true);
	});
});
