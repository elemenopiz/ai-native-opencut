import { defineConfig, devices } from "@playwright/test";

/**
 * Export FIDELITY MATRIX config (campaign C24) — "what you preview is what
 * you export": real timeline → real export → ffprobe + decoded-sample
 * (RMS/pixel) assertions on the ACTUAL produced bytes.
 *
 * Mirrors `playwright.fixtures-w2.config.ts` (real-export build,
 * `channel: "chrome"` — the real installed Google Chrome, not Playwright's
 * bundled codec-less Chromium, per that config's header) on a fresh port
 * (3213) so this suite coexists with the stub suite (3210), golden-path
 * (3211), and fixtures-w2 (3212).
 *
 * No `globalSetup` here: every fixture this suite needs (tone WAVs, a tiny
 * A/V webm) is minted deterministically in-process inside
 * `e2e/export-fidelity/helpers.ts` (WAV: pure Node PCM synthesis; webm: a
 * throwaway `page.evaluate` canvas+oscillator capture before the app is even
 * navigated to) — no shared fixture-minting script to couple to.
 */

const PORT = Number(process.env.E2E_FIDELITY_PORT ?? 3213);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/export-fidelity/fidelity-matrix.e2e.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	// Several real per-frame encodes across the matrix — generous headroom.
	timeout: 300_000,
	expect: { timeout: 30_000 },
	reporter: [["list"]],
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		video: "retain-on-failure",
	},
	projects: [
		{
			name: "chrome",
			use: { ...devices["Desktop Chrome"], channel: "chrome" },
		},
	],
	webServer: {
		command: `cross-env NEXT_PUBLIC_E2E=1 NEXT_PUBLIC_E2E_STUB_EXPORT=0 PORT=${PORT} bun run start`,
		url: BASE_URL,
		timeout: 180_000,
		reuseExistingServer: !process.env.CI,
		stdout: "pipe",
		stderr: "pipe",
	},
});
