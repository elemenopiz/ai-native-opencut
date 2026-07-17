import { defineConfig, devices } from "@playwright/test";

/**
 * Fresh-fixture bug-hunt config for campaign/bug-purge-w2 (Part 2).
 *
 * Mirrors `playwright.real-export.config.ts` (E2E build with the export stub
 * turned OFF, so `fixtures-w2-hunt.e2e.ts` can drive the genuine canvas/
 * mediabunny/WebCodecs export path), but with two differences:
 *
 * 1. A dedicated port (3212) distinct from 3210 (stub suite) and 3211
 *    (golden-path-export suite) so all three can coexist.
 * 2. `channel: "chrome"` — the REAL installed Google Chrome, not Playwright's
 *    bundled open-source Chromium. The bundled Chromium build ships without
 *    proprietary H.264/HEVC decoders (see `e2e/global-setup.ts`'s header,
 *    which is why every other spec's fixtures are Chromium-encoded WebM).
 *    This hunt's fixtures are deliberately real ffmpeg-minted H.264/HEVC/AAC
 *    files (portrait H.264+AAC, 10-bit HDR HEVC, tiny H.264, AAC-only, alpha
 *    PNG) to exercise the actual `probeVideoFile`/`decideNormalization`
 *    ingest path a real user's browser would hit — that requires a browser
 *    that can actually decode H.264/HEVC via WebCodecs, which only the real
 *    Chrome channel provides in this environment (verified locally: bundled
 *    Chromium reports `VideoDecoder` config unsupported for avc1/hvc1;
 *    Chrome channel reports both supported, hardware-accelerated via
 *    VideoToolbox on this Mac).
 */

const PORT = Number(process.env.E2E_FIXTURES_W2_PORT ?? 3212);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/fixtures-w2-hunt.e2e.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	// Five real per-frame encodes across the suite — generous headroom.
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
