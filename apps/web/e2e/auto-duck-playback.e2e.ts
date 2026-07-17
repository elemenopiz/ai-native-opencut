import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * campaign/audio-suite (C9), W4 — real-browser PLAYBACK evidence for
 * "auto-duck under voiceover" (W3, already merged to campaign/audio-suite).
 *
 * W3 could only unit-test `computeDuckKeyframes`/`deriveVoiceoverSpans`
 * (`hooks/use-auto-duck.ts`) and the gain-automation math
 * (`buildVolumeAutomationPlan`) in isolation — nothing exercised the actual
 * WebAudio playback path end to end. This spec does, in one real Chromium
 * session:
 *
 *  1. Lands a MUSIC audio element (~7s at t=0) via the Generate panel's
 *     Audio tab Music mode ("Add to timeline" — `audio-panel.tsx`'s
 *     `MusicMode.addToTimeline`), same real pipeline `audio-gen.e2e.ts`
 *     drives (`/api/studio/audio` + `/api/studio/proxy` mocked,
 *     `addItemsToProjectMedia` runs for real).
 *  2. Lands a VOICEOVER audio element (~2s at t=2, overlapping the music)
 *     via the Assets panel's Audio -> Voiceover sub-tab's full-voiceover
 *     "Add to timeline as voice track" affordance (`views/voiceover.tsx`'s
 *     `handleAddToTimeline` -> `landVoiceoverAudio` -> `importAudioAsset`),
 *     same real pipeline `voiceover-single-ui.e2e.ts` drives (`/api/tts`
 *     mocked). Both elements land through the real media-import pipeline —
 *     hand-constructing timeline elements bypasses `processMediaAssets` and
 *     crashes the timeline render, so this is the only usable path.
 *
 *     Note on element identity: `buildUploadAudioElement` (what
 *     `landVoiceoverAudio` uses) does NOT set `generation.kind` — the full
 *     "Add to timeline as voice track" path is a plain durable upload clip
 *     named "Voiceover". `deriveVoiceoverSpans`'s `isVoiceoverElement` only
 *     trusts `generation.kind==="voiceover"` when `generation` is present;
 *     absent that, it falls back to a name pattern (`/voiceover|.../i`) that
 *     "Voiceover" satisfies. So this element is picked up by auto-duck via
 *     the NAME fallback, not `generation.kind` — worth knowing, since the
 *     per-segment Take pipeline (`addVoiceoverSlot`) is the one that
 *     actually sets `generation.kind`. Either path is a legitimate
 *     "voiceover element on the timeline", which is what auto-duck's
 *     "voiceover-elements" span mode (the default) is documented to key off.
 *  3. Drives the real Auto-Duck panel (Assets -> Audio -> Enhance ->
 *     Auto-Duck) and asserts the MUSIC element now carries `volume`
 *     animation keyframes with a ducked value (~0.126, i.e. -18dB) landing
 *     inside the voiceover's span.
 *  4. Seeks to 0 and starts playback via a REAL click on the transport's
 *     Play button (a genuine user gesture — required for the AudioContext
 *     to actually resume in headless Chromium; calling
 *     `editor.playback.play()` from `page.evaluate` does NOT count as a
 *     user gesture and leaves the context suspended). Asserts:
 *       (a) no error boundary rendered, and
 *       (b) `editor.audio`'s private `clipGainNodes` map (the load-bearing
 *           W3 runtime state — see `getOrCreateAnimatedClipGain` in
 *           `core/managers/audio-manager.ts`) gained at least one entry,
 *           proving the animated-gain branch ran against a real
 *           AudioContext + a genuinely decoded audio buffer, not a mock.
 *
 * Network boundary: only `/api/tts`, `/api/studio/audio`,
 * `/api/studio/proxy`, and the usual Generate-panel baseline
 * (`/api/studio/backends`, `/api/credits/balance`, `/api/studio/sets`) are
 * mocked — no real provider is ever hit, no credits are spent. Everything
 * else (project creation, media import/probe, timeline insertion, the
 * WebAudio graph) runs for real via the E2EBridge seam
 * (`window.__BYORN_E2E__`), matching every other spec in this suite.
 */

const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

const MUSIC_RESULT_URL = "https://mock.byorn.local/auto-duck-music-bed.wav";

/**
 * Mint a small, genuinely decodable mono 16-bit PCM WAV in-process (same
 * recipe as `voiceover-single-ui.e2e.ts`'s `mintTinyWav` — a hand-built WAV
 * header decodes natively in every browser, no Chromium encode needed).
 * Duration is real audio-metadata duration once probed by the real pipeline
 * (`getAudioDuration` / `processMediaAssets`), not a fabricated value.
 */
function mintWav({
	seconds,
	sampleRate = 8000,
	freq = 440,
}: {
	seconds: number;
	sampleRate?: number;
	freq?: number;
}): Buffer {
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
	for (let i = 0; i < numSamples; i++) {
		const t = i / sampleRate;
		const sample = Math.round(amplitude * Math.sin(2 * Math.PI * freq * t));
		buffer.writeInt16LE(sample, 44 + i * 2);
	}

	return buffer;
}

// ~7s music bed at t=0, ~2s voiceover overlapping it at t=2..4.
const MUSIC_WAV = mintWav({ seconds: 7, freq: 220 });
const TTS_WAV = mintWav({ seconds: 2, freq: 440 });

/** Baseline mocks the Generate panel's Audio tab needs on mount even before
 *  Music is submitted — `use-backends.ts` and the credits store fetch these
 *  unconditionally. Mirrors `audio-gen.e2e.ts` / `voiceover-single-ui.e2e.ts`. */
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
	await page.route("**/api/studio/audio", async (route) => {
		const body = route.request().postDataJSON() as { action?: string };
		expect(body.action).toBe("music");
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				id: "auto-duck-music-job",
				jobId: "auto-duck-music-job",
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
	await page.route("**/api/studio/proxy**", async (route) => {
		const target = new URL(route.request().url()).searchParams.get("url") ?? "";
		if (target === MUSIC_RESULT_URL) {
			await route.fulfill({
				status: 200,
				contentType: "audio/wav",
				body: MUSIC_WAV,
			});
			return;
		}
		await route.fulfill({ status: 404, body: "not found" });
	});
	await page.route("**/api/tts", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "audio/wav",
			body: TTS_WAV,
		});
	});
}

/** Opens a fresh project in the editor and waits for the real editor core +
 *  chrome to be live, dismissing the first-run guide — same recipe as every
 *  other spec in this suite. Also blocks the `react-scan` dev overlay script
 *  (`layout.tsx` loads it from unpkg whenever `NODE_ENV==="development"`,
 *  which the standalone-dev-server run path this spec was verified against
 *  triggers — production/`build:e2e` runs never load it). Purely cosmetic
 *  for screenshots; doesn't affect any assertion. */
async function openEditor(page: Page, projectId: string) {
	await page.route("**/react-scan/**", (route) => route.abort());
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

/** Assets panel's "Audio" tab icon has a unique `aria-label="Audio"` — the
 *  Generate panel's media segmented control also has an "Audio" accessible
 *  name once mounted, so scope to the aria-label attribute directly (same
 *  disambiguation `voiceover-single-ui.e2e.ts` uses). */
function assetsAudioTabButton(page: Page) {
	return page.locator('button[aria-label="Audio"]');
}

async function openGenerateAudioTab(page: Page) {
	const generateTab = page.getByRole("button", {
		name: "Generate",
		exact: true,
	});
	if (await generateTab.isVisible().catch(() => false)) {
		await generateTab.click();
	}
	await page.getByTestId("generate-media-tab-audio").click();
}

interface VolumeKeyframeSnapshot {
	time: number;
	value: number;
}

interface ElementSnapshot {
	id: string;
	type: string;
	name: string;
	startTime: number;
	duration: number;
	generationKind?: string;
	volumeKeyframes: VolumeKeyframeSnapshot[];
}

interface TrackSnapshot {
	id: string;
	type: string;
	name: string;
	elements: ElementSnapshot[];
}

/** `ElementAnimations` is `{ channels: Record<propertyPath, AnimationChannel> }`
 *  (see `types/animation.ts`) — flatten straight to the `volume` channel's
 *  keyframes here so every assertion site doesn't have to know that shape. */
async function getTracks(page: Page): Promise<TrackSnapshot[]> {
	return page.evaluate(() =>
		(window.__BYORN_E2E__?.editor.timeline.getTracks() ?? []).map((t) => ({
			id: t.id,
			type: t.type,
			name: t.name,
			elements: t.elements.map((e) => {
				const el = e as unknown as {
					id: string;
					type: string;
					name: string;
					startTime: number;
					duration: number;
					generation?: { kind?: string };
					animations?: {
						channels?: Record<
							string,
							{ keyframes: Array<{ time: number; value: number }> }
						>;
					};
				};
				return {
					id: el.id,
					type: el.type,
					name: el.name,
					startTime: el.startTime,
					duration: el.duration,
					generationKind: el.generation?.kind,
					volumeKeyframes: el.animations?.channels?.volume?.keyframes ?? [],
				};
			}),
		})),
	);
}

/** `editor.audio.clipGainNodes` is TS-`private` (compiler-only privacy, not a
 *  real JS `#private` field) — readable at runtime via bracket access, which
 *  TypeScript itself permits as the documented escape hatch. Cast through
 *  `unknown` so `bun run typecheck` stays green without `any`. */
async function getClipGainNodeCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		const bridge = window.__BYORN_E2E__;
		if (!bridge) return -1;
		const audio = bridge.editor.audio as unknown as {
			clipGainNodes: Map<string, unknown>;
		};
		return audio.clipGainNodes.size;
	});
}

async function hasErrorBoundary(page: Page): Promise<boolean> {
	return page
		.getByText("hit an unexpected error")
		.isVisible()
		.catch(() => false);
}

test.describe("auto-duck under voiceover — real playback", () => {
	test.beforeAll(async () => {
		await mkdir(SCREENSHOT_DIR, { recursive: true });
	});

	test("music ducks under an overlapping voiceover element, audibly (animated gain node) during real playback", async ({
		page,
	}) => {
		await mockBaseline(page);
		await openEditor(page, "e2e-auto-duck-playback");

		// ── 1. Land the MUSIC bed at t=0 (~7s) via the Generate panel's Audio
		// tab Music mode. Playhead starts at 0 on a fresh project, so
		// MusicMode.addToTimeline's `editor.playback.getCurrentTime()` lands it
		// there. Added FIRST + at track index 0 (see MusicMode.addToTimeline /
		// AddTrackCommand): the voiceover track added next also inserts at
		// index 0, pushing this one to index 1 — the position use-auto-duck's
		// fallback target-track selection (last audio track when none is named
		// "music"/"bgm"/"bg") relies on.
		await openGenerateAudioTab(page);
		await page.getByRole("button", { name: "Music", exact: true }).click();
		await page
			.getByPlaceholder(/Describe the track/)
			.fill("a warm instrumental bed for a product montage");
		await page.getByTestId("audio-gen-submit").click();

		const musicAddToTimeline = page.getByRole("button", {
			name: "Add to timeline",
		});
		await expect(musicAddToTimeline).toBeVisible({ timeout: 20_000 });
		await musicAddToTimeline.click();

		await expect
			.poll(
				async () => {
					const tracks = await getTracks(page);
					return tracks.filter((t) => t.type === "audio").length;
				},
				{ timeout: 10_000 },
			)
			.toBe(1);

		let tracks = await getTracks(page);
		let audioTracks = tracks.filter((t) => t.type === "audio");
		expect(audioTracks).toHaveLength(1);
		const musicElement = audioTracks[0].elements[0];
		expect(musicElement).toBeTruthy();
		expect(musicElement.startTime).toBeCloseTo(0, 1);
		// Probed real duration off the 7s minted WAV — generous bounds for
		// header/decode rounding.
		expect(musicElement.duration).toBeGreaterThan(6);
		expect(musicElement.duration).toBeLessThan(8);

		// ── 2. Land the VOICEOVER element (~2s) at t=2, overlapping the music
		// (2..~4). Seek the playhead first — the full-voiceover "Add to
		// timeline as voice track" path reads `editor.playback.getCurrentTime()`
		// at click time.
		await page.evaluate(() => {
			window.__BYORN_E2E__!.editor.playback.seek({ time: 2 });
		});

		// Switch the Generate panel off its Audio mode first — Radix
		// `TabsContent` unmounts inactive tabs, but AudioPanel's own Score/
		// Music/Voiceover mode picker also renders a "Voiceover"-labeled
		// button, which otherwise stays mounted alongside the Assets panel's
		// Voiceover sub-tab and makes every "Voiceover" role query ambiguous.
		await page.getByTestId("generate-media-tab-generate").click();

		await assetsAudioTabButton(page).click();
		await page.getByRole("button", { name: "Voiceover", exact: true }).click();
		await expect(
			page.getByPlaceholder("Type or paste text to convert to speech..."),
		).toBeVisible();
		await page
			.getByPlaceholder("Type or paste text to convert to speech...")
			.fill("This overlaps the music bed and should get ducked under.");
		await page.getByRole("button", { name: "Generate full voiceover" }).click();

		const voAddToTimeline = page.getByRole("button", {
			name: "Add to timeline as voice track",
		});
		await expect(voAddToTimeline).toBeVisible({ timeout: 20_000 });
		await voAddToTimeline.click();

		// Track creation (`addTrack`) is synchronous, but the element only lands
		// once `landVoiceoverAudio`'s async decode + `importAudioAsset` (real
		// `processMediaAssets`) resolves — poll on element count, not just
		// track count, or this races ahead of the actual insert.
		await expect
			.poll(
				async () => {
					const t = await getTracks(page);
					return t
						.filter((tr) => tr.type === "audio")
						.reduce((n, tr) => n + tr.elements.length, 0);
				},
				{ timeout: 20_000 },
			)
			.toBe(2);

		tracks = await getTracks(page);
		audioTracks = tracks.filter((t) => t.type === "audio");
		expect(audioTracks).toHaveLength(2);
		const allAudioElements = audioTracks.flatMap((t) => t.elements);
		expect(allAudioElements).toHaveLength(2);
		const voElement = allAudioElements.find((e) => e.id !== musicElement.id);
		expect(voElement).toBeTruthy();
		expect(voElement?.startTime).toBeCloseTo(2, 1);
		expect(voElement?.duration).toBeGreaterThan(1.5);
		expect(voElement?.duration).toBeLessThan(2.5);
		// See file-header note: this path names the clip "Voiceover" but does
		// NOT set `generation.kind` (buildUploadAudioElement doesn't set
		// `generation`) — auto-duck's `isVoiceoverElement` picks it up via the
		// name-pattern fallback instead. Assert the actual (accurate) shape
		// rather than the kind field, so this spec fails loudly if that ever
		// changes rather than silently asserting something untrue.
		expect(voElement?.generationKind).toBeUndefined();
		expect(voElement?.name).toMatch(/voice/i);

		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "01-music-and-voiceover-landed.png"),
		});

		// ── 3. Drive the real Auto-Duck panel and apply it.
		await assetsAudioTabButton(page).click();
		await page.getByRole("button", { name: "Enhance", exact: true }).click();
		await expect(page.getByText("Auto-Duck", { exact: true })).toBeVisible();
		// Default span mode is already "voiceover-elements" (the highlighted
		// chip) — no extra click needed.
		await expect(
			page.getByRole("button", { name: "Voiceover", exact: true }).last(),
		).toHaveClass(/bg-primary/);

		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "02-auto-duck-panel-before-apply.png"),
		});

		const applyButton = page.getByRole("button", { name: "Apply Auto-Duck" });
		await expect(applyButton).toBeVisible();
		await applyButton.click();

		await expect(page.getByText(/Applied auto-duck:/)).toBeVisible({
			timeout: 10_000,
		});
		expect(await hasErrorBoundary(page)).toBe(false);

		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "03-auto-duck-applied-toast.png"),
		});

		// The MUSIC element (not the voiceover) now carries `volume` keyframes,
		// with a ducked value (~-18dB => ~0.126) whose time falls inside the
		// voiceover's span (element-relative: fade-in at 1.7, duck at 2, hold
		// through ~4, fade-out complete at 4.3 — see computeDuckKeyframes).
		tracks = await getTracks(page);
		const musicAfter = tracks
			.flatMap((t) => t.elements)
			.find((e) => e.id === musicElement.id);
		expect(musicAfter).toBeTruthy();
		const volumeKeyframes = musicAfter?.volumeKeyframes ?? [];
		expect(volumeKeyframes.length).toBeGreaterThan(0);

		const duckedKeyframe = volumeKeyframes.find(
			(k) => k.value > 0.1 && k.value < 0.16,
		);
		expect(
			duckedKeyframe,
			`expected a ~0.126 (-18dB) ducked keyframe, got: ${JSON.stringify(volumeKeyframes)}`,
		).toBeTruthy();
		expect(duckedKeyframe?.time).toBeGreaterThanOrEqual(1.5);
		expect(duckedKeyframe?.time).toBeLessThanOrEqual(4.5);

		// The voiceover element itself must NOT have been ducked (it's the
		// thing being ducked *under*, not a target).
		const voAfter = tracks
			.flatMap((t) => t.elements)
			.find((e) => e.id === voElement?.id);
		expect(voAfter?.volumeKeyframes ?? []).toHaveLength(0);

		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "04-timeline-after-auto-duck.png"),
		});

		// ── 4. Real playback: seek to 0, click the actual Play button (a
		// genuine Playwright user-gesture click — NOT `editor.playback.play()`
		// via `page.evaluate`, which does not carry user-activation and leaves
		// Chromium's AudioContext stuck `suspended`), and confirm the
		// animated-gain branch actually ran.
		await page.evaluate(() => {
			window.__BYORN_E2E__!.editor.playback.seek({ time: 0 });
		});

		expect(await getClipGainNodeCount(page)).toBe(0);

		// Scope by accessible name (icon-only button, so its title IS its
		// accessible name), not a `title^=` attribute selector — the preview
		// toolbar also has a "Playback quality" dropdown whose title starts
		// with "Play" and would otherwise make this ambiguous.
		const playButton = page.getByRole("button", { name: /^Play\b/ });
		await expect(playButton).toBeVisible();
		await playButton.click();

		await expect
			.poll(async () => getClipGainNodeCount(page), {
				timeout: 5_000,
				intervals: [100, 200, 300, 500],
			})
			.toBeGreaterThanOrEqual(1);

		// ~1.2s of real playback headroom before inspecting state, per the
		// acceptance criteria.
		await page.waitForTimeout(1_200);

		expect(await hasErrorBoundary(page)).toBe(false);
		const gainNodeCountDuringPlayback = await getClipGainNodeCount(page);
		expect(gainNodeCountDuringPlayback).toBeGreaterThanOrEqual(1);

		await page.screenshot({
			path: path.join(SCREENSHOT_DIR, "05-during-real-playback.png"),
		});

		// Stop playback the same way (real click) rather than leaving it
		// running into test teardown.
		const pauseButton = page.getByRole("button", { name: /^Pause\b/ });
		if (await pauseButton.isVisible().catch(() => false)) {
			await pauseButton.click();
		}
	});
});
