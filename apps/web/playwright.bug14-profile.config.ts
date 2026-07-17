import { defineConfig, devices } from "@playwright/test";

/**
 * BUG14 profiling harness (queue §2, campaign perf-wave).
 *
 * Drives a real 4K HEVC import through the actual media panel and captures a
 * CDP CPU profile + Long Task samples across a timeline mutation performed
 * WHILE proxy/thumbnail background work is still running, to find the
 * synchronous main-thread offender behind the 10-30s stall.
 *
 * Uses the real Chrome channel (not Playwright's bundled Chromium, which has
 * no HEVC decode) and the standard (non-stub-export) E2E build, since export
 * is not exercised here — only import + timeline mutation.
 */

const PORT = Number(process.env.E2E_BUG14_PORT ?? 3130);
const BASE_URL = `http://localhost:${PORT}`;

// The spec self-skips unless this is set, so the default `test:e2e` suite
// (bundled Chromium, no HEVC decode) never tries to run the profiling
// harness. Running through THIS config is the opt-in.
process.env.BUG14_PROFILE = "1";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/bug14-import-stall-profile.e2e.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	timeout: 300_000,
	expect: { timeout: 30_000 },
	reporter: [["list"]],
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		video: "off",
	},
	projects: [
		{
			name: "chrome",
			use: {
				...devices["Desktop Chrome"],
				channel: "chrome",
				launchOptions: {
					args: [
						"--disable-backgrounding-occluded-windows",
						"--disable-background-timer-throttling",
						"--disable-renderer-backgrounding",
					],
				},
			},
		},
	],
	webServer: {
		command: `cross-env NEXT_PUBLIC_E2E=1 PORT=${PORT} bun run start`,
		url: BASE_URL,
		timeout: 180_000,
		reuseExistingServer: !process.env.CI,
		stdout: "pipe",
		stderr: "pipe",
	},
});
