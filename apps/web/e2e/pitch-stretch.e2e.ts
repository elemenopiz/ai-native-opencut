import { expect, test } from "@playwright/test";

/**
 * Audible-correctness check for pitch-preserved speed changes ("chipmunk fix").
 *
 * Renders a pure 440 Hz sine through the REAL pitch-preserving seam
 * (`stretchAudioBufferSegment` — the exact function both the preview
 * AudioManager and the export mixdown call), exercising the genuine
 * signalsmith-stretch WASM AudioWorklet inside an OfflineAudioContext in
 * Chromium. Asserts:
 *
 *  - 2x speed: output still ~440 Hz (raw rate-scaling would give ~880 Hz) and
 *    fills the 1 s timeline slot.
 *  - 0.5x speed: output still ~440 Hz (raw would give ~220 Hz) and fills the
 *    2 s slot.
 *
 * Frequency is estimated by zero-crossing count over the settled middle of the
 * render (skipping STFT onset/tail smear).
 */

interface StretchProbe {
	ok: boolean;
	reason?: string;
	dominantHz?: number;
	durationSeconds?: number;
	sampleRate?: number;
	rms?: number;
}

async function probeStretch(
	page: import("@playwright/test").Page,
	{ rate, slotSeconds }: { rate: number; slotSeconds: number },
): Promise<StretchProbe> {
	return page.evaluate(
		async ({ rate, slotSeconds }) => {
			const bridge = window.__BYORN_E2E__;
			if (!bridge?.stretchAudioBufferSegment) {
				return { ok: false, reason: "bridge missing stretch seam" };
			}

			const sampleRate = 48000;
			const freq = 440;
			// Source must cover slotSeconds * rate of material.
			const sourceSeconds = Math.ceil(slotSeconds * rate) + 1;
			const source = new AudioBuffer({
				length: sourceSeconds * sampleRate,
				numberOfChannels: 1,
				sampleRate,
			});
			const data = source.getChannelData(0);
			for (let i = 0; i < data.length; i++) {
				data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.8;
			}

			const stretched = await bridge.stretchAudioBufferSegment({
				buffer: source,
				playbackRate: rate,
				trimStart: 0,
				duration: slotSeconds,
				targetSampleRate: sampleRate,
			});
			if (!stretched) return { ok: false, reason: "stretch resolved null" };

			// Analyze the settled middle 50% of the render.
			const out = stretched.getChannelData(0);
			const begin = Math.floor(out.length * 0.25);
			const end = Math.floor(out.length * 0.75);
			let crossings = 0;
			let sumSquares = 0;
			for (let i = begin + 1; i < end; i++) {
				if (
					(out[i - 1] < 0 && out[i] >= 0) ||
					(out[i - 1] >= 0 && out[i] < 0)
				) {
					crossings++;
				}
				sumSquares += out[i] * out[i];
			}
			const analyzedSeconds = (end - begin) / stretched.sampleRate;
			const dominantHz = crossings / 2 / analyzedSeconds;
			const rms = Math.sqrt(sumSquares / (end - begin));

			return {
				ok: true,
				dominantHz,
				durationSeconds: stretched.duration,
				sampleRate: stretched.sampleRate,
				rms,
			};
		},
		{ rate, slotSeconds },
	);
}

test.describe("pitch-preserved speed changes", () => {
	// Fallback warnings from the stretch seam land on the page console; surface
	// them in failure messages so a WASM/worklet regression is diagnosable.
	let consoleLines: string[] = [];

	test.beforeEach(async ({ page }) => {
		consoleLines = [];
		page.on("console", (message) => {
			consoleLines.push(`[${message.type()}] ${message.text()}`);
		});
		await page.addInitScript(() => {
			window.localStorage.setItem("hasSeenOnboarding-v2", "true");
		});
		await page.goto("/editor/e2e-pitch-stretch");
		await page.waitForFunction(
			() => window.__BYORN_E2E__?.ready === true,
			null,
			{
				timeout: 60_000,
			},
		);
	});

	test("2x speed keeps a 440 Hz tone at 440 Hz (not 880) and fills the slot", async ({
		page,
	}) => {
		const probe = await probeStretch(page, { rate: 2, slotSeconds: 1 });

		expect(
			probe.ok,
			`${probe.reason}\n--- page console ---\n${consoleLines.join("\n")}`,
		).toBe(true);
		const { dominantHz = 0, durationSeconds = 0, rms = 0 } = probe;
		// Pitch preserved: ~440 Hz, comfortably far from the 880 Hz chipmunk value.
		expect(dominantHz).toBeGreaterThan(410);
		expect(dominantHz).toBeLessThan(470);
		// Time model: the render IS the 1 s timeline slot at the context rate.
		expect(durationSeconds).toBeCloseTo(1, 2);
		expect(probe.sampleRate).toBe(48000);
		// Actually contains signal, not silence.
		expect(rms).toBeGreaterThan(0.1);
	});

	test("0.5x speed keeps a 440 Hz tone at 440 Hz (not 220) and fills the slot", async ({
		page,
	}) => {
		const probe = await probeStretch(page, { rate: 0.5, slotSeconds: 2 });

		expect(
			probe.ok,
			`${probe.reason}\n--- page console ---\n${consoleLines.join("\n")}`,
		).toBe(true);
		const { dominantHz = 0, durationSeconds = 0, rms = 0 } = probe;
		expect(dominantHz).toBeGreaterThan(410);
		expect(dominantHz).toBeLessThan(470);
		expect(durationSeconds).toBeCloseTo(2, 2);
		expect(rms).toBeGreaterThan(0.1);
	});
});
