import { expect, test } from "@playwright/test";
import {
	decodePcmF32Mono,
	extractRawFrameRgb24,
	importBufferViaFileInput,
	insertAudioElement,
	insertTextElement,
	insertVideoElement,
	lumaVariance,
	mintAvWebmBuffer,
	mintToneWav,
	openEditor,
	rmsWindow,
	runRealExportAndProbe,
	setSolidBackground,
	upsertVolumeKeyframes,
} from "./helpers";

/**
 * Export FIDELITY MATRIX (campaign C24) — "what you preview is what you
 * export".
 *
 * Every case below builds a small, deterministic project via the real
 * `E2EBridge` timeline API (`window.__BYORN_E2E__.editor.timeline`), runs a
 * REAL export through the actual export-dialog UI (no stub — see
 * `playwright.export-fidelity.config.ts` / `golden-path-export.e2e.ts`'s
 * header for the two-layer stub-build self-skip), and then asserts on the
 * ACTUAL produced bytes: ffprobe's stream list, and — for audio — a
 * decoded-sample RMS comparison (`ffmpeg -f f32le ...` piped back into Node,
 * per the decoded-sample recipe) rather than trusting metadata alone.
 *
 * Two known bugs on `main` this matrix is built to CATCH (see campaign brief
 * for full context — sibling workers are fixing these in parallel; this
 * matrix's job is to assert the CORRECT behavior and stay red until they
 * land):
 *
 *  - BUG32: per-clip `volume` (both static and `volume` automation
 *    keyframes) is silently dropped by the export audio mixdown
 *    (`collectAudioElements` in `src/lib/media/audio.ts` never carries
 *    `volume`/`animations` onto `CollectedAudioElement`, and
 *    `mixAudioChannels` never multiplies by any gain at all — every clip
 *    mixes down at its raw, unattenuated source amplitude regardless of what
 *    the properties panel/automation says). Cases 1 and 3 below pin this
 *    down with a measured RMS ratio that should be far from 1.0 and isn't.
 *  - BUG17: an audio-only project (zero video/image/text elements) still
 *    emits a full 1920x1080 H.264 video stream on export
 *    (`SceneExporter.export` in `src/services/renderer/scene-exporter.ts`
 *    unconditionally calls `output.addVideoTrack`, and
 *    `RendererManager.exportProject` always builds the scene/renderer at
 *    `activeProject.settings.canvasSize`, which stays at the
 *    `DEFAULT_CANVAS_SIZE` 1920x1080 whenever no visual element has ever set
 *    it). Case 4 below pins this down against ffprobe's actual stream list.
 *
 * These are NOT weakened/fixme'd — they assert the correct behavior and are
 * expected to be RED on this branch. See the campaign report for the
 * measured numbers.
 */

const SAMPLE_RATE = 44100;

test.describe("export fidelity matrix — preview vs export (campaign C24)", () => {
	// ── MUST 1: static per-clip volume ────────────────────────────────────────
	test("static per-clip volume: 0.25x clip mixes quieter than a 1.0x sibling from the same source", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await openEditor(page, "fidelity-static-volume");

		// One 4s tone asset, placed twice: [0,2) at volume 0.25 ("A"), [2,4) at
		// volume 1.0 ("B"). Same source tone, only the `volume` field differs.
		const tone = mintToneWav({ seconds: 4, freq: 440 });
		const asset = await importBufferViaFileInput(page, {
			buffer: tone,
			name: "static-volume-tone.wav",
			mimeType: "audio/wav",
		});
		expect(asset.type).toBe("audio");

		await insertAudioElement(page, {
			assetId: asset.id,
			name: "Clip A (volume 0.25)",
			startTime: 0,
			duration: 2,
			volume: 0.25,
		});
		await insertAudioElement(page, {
			assetId: asset.id,
			name: "Clip B (volume 1.0)",
			startTime: 2,
			duration: 2,
			volume: 1.0,
		});

		const { resultMeta, outFile } = await runRealExportAndProbe(
			page,
			"static-volume.mp4",
		);
		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);

		const samples = decodePcmF32Mono(outFile, SAMPLE_RATE);
		// Windows kept >=0.5s wide and >=100ms inside each clip's boundaries,
		// per the decoded-sample recipe.
		const rmsA = rmsWindow(samples, SAMPLE_RATE, 0.5, 1.5);
		const rmsB = rmsWindow(samples, SAMPLE_RATE, 2.5, 3.5);
		const ratio = rmsA / rmsB;

		console.log(
			`[static-volume] measured: RMS(A, vol=0.25)=${rmsA.toFixed(5)} ` +
				`RMS(B, vol=1.0)=${rmsB.toFixed(5)} ratio(A/B)=${ratio.toFixed(4)} ` +
				"(expected ~0.25 if per-clip volume is honored; ~1.0 is BUG32 evidence — " +
				"volume dropped by the export mixdown)",
		);

		expect(
			ratio,
			`expected RMS(A)/RMS(B) ~= 0.25 (±0.08), measured ${ratio.toFixed(4)} ` +
				`(RMS A=${rmsA.toFixed(5)}, B=${rmsB.toFixed(5)}) — a ratio near 1.0 ` +
				"means the clip's static `volume` field was ignored by the export " +
				"mixdown (BUG32).",
		).toBeGreaterThanOrEqual(0.25 - 0.08);
		expect(ratio).toBeLessThanOrEqual(0.25 + 0.08);
	});

	// ── MUST 2: clip mute ────────────────────────────────────────────────────
	test("muted clip is silent in export while a sibling unmuted clip isn't", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await openEditor(page, "fidelity-mute");

		const tone = mintToneWav({ seconds: 4, freq: 523 });
		const asset = await importBufferViaFileInput(page, {
			buffer: tone,
			name: "mute-tone.wav",
			mimeType: "audio/wav",
		});

		await insertAudioElement(page, {
			assetId: asset.id,
			name: "Muted clip",
			startTime: 0,
			duration: 2,
			muted: true,
		});
		await insertAudioElement(page, {
			assetId: asset.id,
			name: "Unmuted clip",
			startTime: 2,
			duration: 2,
			muted: false,
		});

		const { resultMeta, outFile } = await runRealExportAndProbe(
			page,
			"mute.mp4",
		);
		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);

		const samples = decodePcmF32Mono(outFile, SAMPLE_RATE);
		const rmsMuted = rmsWindow(samples, SAMPLE_RATE, 0.5, 1.5);
		const rmsUnmuted = rmsWindow(samples, SAMPLE_RATE, 2.5, 3.5);

		console.log(
			`[mute] measured: RMS(muted)=${rmsMuted.toFixed(6)} ` +
				`RMS(unmuted)=${rmsUnmuted.toFixed(5)}`,
		);

		expect(
			rmsMuted,
			`expected the muted clip's window to be silence (<0.005), measured ${rmsMuted.toFixed(6)}`,
		).toBeLessThan(0.005);
		expect(
			rmsUnmuted,
			`expected the sibling unmuted clip's window to be audible (>=0.01), measured ${rmsUnmuted.toFixed(6)}`,
		).toBeGreaterThanOrEqual(0.01);
	});

	// ── MUST 3: volume automation (ramp 1 -> 0 across a 4s clip) ────────────────
	test("volume automation ramp (1 -> 0 across 4s) attenuates the tail relative to the head", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await openEditor(page, "fidelity-volume-automation");

		const tone = mintToneWav({ seconds: 4, freq: 349, amplitude: 0.7 });
		const asset = await importBufferViaFileInput(page, {
			buffer: tone,
			name: "automation-tone.wav",
			mimeType: "audio/wav",
		});

		const { elementId, trackId } = await insertAudioElement(page, {
			assetId: asset.id,
			name: "Ramping clip",
			startTime: 0,
			duration: 4,
			volume: 1,
		});

		// Same landing seam auto-duck uses (`upsertKeyframes` with
		// propertyPath: "volume", element-relative `time`, linear
		// interpolation) — see `use-auto-duck.ts`'s `computeDuckKeyframes` ->
		// `applyAutoDuck`.
		await upsertVolumeKeyframes(page, {
			trackId,
			elementId,
			keyframes: [
				{ time: 0, value: 1 },
				{ time: 4, value: 0 },
			],
		});

		const { resultMeta, outFile } = await runRealExportAndProbe(
			page,
			"volume-automation.mp4",
		);
		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);

		const samples = decodePcmF32Mono(outFile, SAMPLE_RATE);
		// First second (near value~1) vs last second (near value~0), both kept
		// >=100ms inside the clip's [0,4) boundaries.
		const rmsFirst = rmsWindow(samples, SAMPLE_RATE, 0.3, 0.9);
		const rmsLast = rmsWindow(samples, SAMPLE_RATE, 3.0, 3.9);
		const ratio = rmsFirst / rmsLast;

		console.log(
			`[volume-automation] measured: RMS(first second)=${rmsFirst.toFixed(5)} ` +
				`RMS(last second)=${rmsLast.toFixed(5)} ratio=${ratio.toFixed(4)} ` +
				"(expected >4x if volume automation is honored; ~1.0 is BUG32 evidence — " +
				"keyframed volume automation dropped by the export mixdown)",
		);

		expect(
			ratio,
			`expected RMS(first second) > 4x RMS(last second), measured ratio ${ratio.toFixed(4)} ` +
				`(first=${rmsFirst.toFixed(5)}, last=${rmsLast.toFixed(5)}) — a ratio near 1.0 ` +
				"means the `volume` animation channel was ignored by the export mixdown (BUG32).",
		).toBeGreaterThan(4);
	});

	// ── MUST 4: audio-only project export ───────────────────────────────────
	test("audio-only project (zero visual elements) exports with no video stream", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await openEditor(page, "fidelity-audio-only");

		const tone = mintToneWav({ seconds: 3, freq: 660 });
		const asset = await importBufferViaFileInput(page, {
			buffer: tone,
			name: "audio-only-tone.wav",
			mimeType: "audio/wav",
		});
		expect(asset.type).toBe("audio");

		await insertAudioElement(page, {
			assetId: asset.id,
			name: "Only clip",
			startTime: 0,
			duration: 3,
		});

		// Sanity: this project genuinely has zero VISUAL ELEMENTS before we
		// export — the point of the case. (A fresh project always carries an
		// empty default main video track — `buildDefaultScene` — so assert on
		// element placement, not on which track shells exist.)
		const elementPlacement = await page.evaluate(() =>
			window
				.__BYORN_E2E__!.editor.timeline.getTracks()
				.map((t) => ({ type: t.type, elementCount: t.elements.length })),
		);
		const visualElementCount = elementPlacement
			.filter((t) => t.type !== "audio")
			.reduce((n, t) => n + t.elementCount, 0);
		const audioElementCount = elementPlacement
			.filter((t) => t.type === "audio")
			.reduce((n, t) => n + t.elementCount, 0);
		expect(
			visualElementCount,
			`expected zero visual elements, got placement ${JSON.stringify(elementPlacement)}`,
		).toBe(0);
		expect(audioElementCount).toBe(1);

		const { resultMeta, probe } = await runRealExportAndProbe(
			page,
			"audio-only.mp4",
		);
		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);

		const videoStreams = probe.streams.filter((s) => s.codec_type === "video");
		const audioStreams = probe.streams.filter((s) => s.codec_type === "audio");

		console.log(
			`[audio-only] measured ffprobe streams: video=${videoStreams.length} ` +
				`(${JSON.stringify(videoStreams.map((s) => `${s.codec_name} ${s.width}x${s.height}`))}) ` +
				`audio=${audioStreams.length} (expected video=0 if the exporter skips a ` +
				"visual track for an audio-only project; a 1920x1080 h264 video stream " +
				"here is BUG17 evidence)",
		);

		expect(
			videoStreams.length,
			`expected 0 video streams for an audio-only project, got ${videoStreams.length}: ` +
				`${JSON.stringify(videoStreams)} — a non-empty video stream (typically a blank ` +
				"1920x1080 h264 track) means the exporter emits a visual track unconditionally " +
				"instead of skipping it for audio-only content (BUG17).",
		).toBe(0);
		expect(audioStreams.length).toBeGreaterThanOrEqual(1);
	});

	// ── MUST 5: speed + pitch (2x playbackRate) ─────────────────────────────
	test("2x playbackRate clip: exported duration matches the timeline slot, no half-silence tail", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await openEditor(page, "fidelity-speed-pitch");

		const SLOT_DURATION = 2;
		const RATE = 2;
		// Source must cover at least duration*rate of continuous tone (plus
		// margin) so a correct rate-aware mixdown never runs out of source
		// before the timeline slot ends.
		const tone = mintToneWav({ seconds: SLOT_DURATION * RATE + 1, freq: 300 });
		const asset = await importBufferViaFileInput(page, {
			buffer: tone,
			name: "speed-pitch-tone.wav",
			mimeType: "audio/wav",
		});

		await insertAudioElement(page, {
			assetId: asset.id,
			name: "2x clip",
			startTime: 0,
			duration: SLOT_DURATION,
			playbackRate: RATE,
		});

		const { resultMeta, outFile, probe } = await runRealExportAndProbe(
			page,
			"speed-pitch.mp4",
		);
		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);

		const actualDuration = Number.parseFloat(probe.format.duration ?? "0");
		const tolerance = Math.max(0.7, SLOT_DURATION * 0.2);
		console.log(
			`[speed-pitch] measured: ffprobe duration=${actualDuration}s ` +
				`(expected ~${SLOT_DURATION}s ±${tolerance}s)`,
		);
		expect(
			Math.abs(actualDuration - SLOT_DURATION),
			`expected ~${SLOT_DURATION}s (±${tolerance}s), probed ${actualDuration}s`,
		).toBeLessThanOrEqual(tolerance);

		const samples = decodePcmF32Mono(outFile, SAMPLE_RATE);
		// Window near the END of the 2s slot, 100ms inside the boundary — if
		// the mixdown ran out of (rate-consumed) source early, this window
		// would be silent ("half-silence tail").
		const rmsTail = rmsWindow(samples, SAMPLE_RATE, 1.4, 1.9);
		console.log(
			`[speed-pitch] measured: RMS(tail window 1.4-1.9s)=${rmsTail.toFixed(5)}`,
		);
		expect(
			rmsTail,
			`expected audio present through the whole slot (tail RMS >=0.01), measured ${rmsTail.toFixed(6)} — ` +
				"a near-silent tail means the mixdown ran out of source before the slot ended.",
		).toBeGreaterThanOrEqual(0.01);
	});

	// ── SHOULD 6: detached/separated source audio reflects enabled state ───────
	test("video clip with source audio detached is silent in export; an enabled sibling isn't", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await openEditor(page, "fidelity-audio-separation");

		// Mint the tiny A/V webm directly against this test's own `page` before
		// navigating — `about:blank` supports Canvas/AudioContext/MediaRecorder
		// (see `mintAvWebmBuffer`'s header). Must happen before `openEditor`
		// navigates away, since the page context is reused afterward.
		await page.goto("about:blank");
		const avBuffer = await mintAvWebmBuffer(page, {
			targetSeconds: 4.5,
			freq: 523,
		});

		await openEditor(page, "fidelity-audio-separation");

		const asset = await importBufferViaFileInput(page, {
			buffer: avBuffer,
			name: "separation-source.webm",
			mimeType: "video/webm",
		});
		expect(asset.type).toBe("video");

		await insertVideoElement(page, {
			assetId: asset.id,
			name: "Audio enabled",
			startTime: 0,
			duration: 2,
		});
		await insertVideoElement(page, {
			assetId: asset.id,
			name: "Audio detached",
			startTime: 2,
			duration: 2,
			isSourceAudioEnabled: false,
		});

		const { resultMeta, outFile } = await runRealExportAndProbe(
			page,
			"audio-separation.mp4",
		);
		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);

		const samples = decodePcmF32Mono(outFile, SAMPLE_RATE);
		const rmsEnabled = rmsWindow(samples, SAMPLE_RATE, 0.5, 1.5);
		const rmsDetached = rmsWindow(samples, SAMPLE_RATE, 2.5, 3.5);

		console.log(
			`[audio-separation] measured: RMS(enabled)=${rmsEnabled.toFixed(5)} ` +
				`RMS(detached)=${rmsDetached.toFixed(6)}`,
		);

		expect(
			rmsEnabled,
			`expected the audio-enabled clip's window to be audible (>=0.01), measured ${rmsEnabled.toFixed(6)}`,
		).toBeGreaterThanOrEqual(0.01);
		expect(
			rmsDetached,
			`expected the audio-detached clip's window to be silence (<0.005), measured ${rmsDetached.toFixed(6)}`,
		).toBeLessThan(0.005);
	});

	// ── SHOULD 7: video frame probe — text overlay over a solid background ───
	test("text overlay over a solid background produces a non-uniform exported frame", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await openEditor(page, "fidelity-text-overlay");

		// Distinct dark navy background so white text pixels are unambiguously
		// different either way (default project background is #000000).
		await setSolidBackground(page, "#152238");

		await insertTextElement(page, {
			content: "FIDELITY",
			startTime: 0,
			duration: 2,
			fontSize: 160,
			color: "#ffffff",
		});

		const { resultMeta, outFile } = await runRealExportAndProbe(
			page,
			"text-overlay.mp4",
		);
		expect(resultMeta.success, JSON.stringify(resultMeta)).toBe(true);

		const rawFrame = extractRawFrameRgb24(outFile, 1.0);
		const variance = lumaVariance(rawFrame);

		console.log(
			`[text-overlay] measured: luma variance at t=1.0s = ${variance.toFixed(3)} ` +
				"(a uniform/blank frame has variance ~0; text/edges push it well above 5)",
		);

		expect(
			variance,
			`expected a non-uniform frame (text pixels differing from the solid background), measured luma variance ${variance.toFixed(3)}`,
		).toBeGreaterThan(5);
	});
});
