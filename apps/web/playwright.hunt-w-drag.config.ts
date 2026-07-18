import { defineConfig, devices } from "@playwright/test";

/**
 * campaign C26 (dogfood hunt) — W-DRAG worker config.
 *
 * Points at the manually-started `NEXT_PUBLIC_E2E=1 PORT=3303 bun run dev`
 * dev server (no webServer block here — we reuse whatever's already up on
 * 3303 rather than racing another `next dev` instance). Real Chrome channel
 * (not Playwright's bundled Chromium) so H.264/HEVC decode paths behave like
 * a real user's browser, matching the pattern in
 * playwright.fixtures-w2.config.ts.
 */

const PORT = Number(process.env.E2E_HUNT_W_DRAG_PORT ?? 3303);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./e2e/hunt",
	testMatch: "**/*.hunt.e2e.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	// This box runs many concurrent `next dev --turbopack` fleet workers
	// (see `ps aux`) — cold Turbopack compiles observed taking 20-100s under
	// contention. Generous timeouts here so a slow-but-working app isn't
	// mistaken for a broken one.
	timeout: 300_000,
	expect: { timeout: 20_000 },
	reporter: [["list"]],
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		navigationTimeout: 240_000,
		actionTimeout: 30_000,
	},
	projects: [
		{
			name: "chrome",
			use: { ...devices["Desktop Chrome"], channel: "chrome" },
		},
	],
});
