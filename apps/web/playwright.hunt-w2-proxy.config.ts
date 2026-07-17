import { defineConfig, devices } from "@playwright/test";

/**
 * Throwaway hunt config for campaign C26 (W-PROXY worker) — Assets panel
 * PREVIEW/PROXY/THUMBNAIL cluster (M9/M10/M11/M12/M13/M16).
 *
 * Reuses the already-running `NEXT_PUBLIC_E2E=1 PORT=3302` dev server
 * (started manually for this hunt) rather than spawning its own, since this
 * is read-only exploration, not a CI-wired suite. `channel: "chrome"` is
 * mandatory here too — the bundled Chromium can't decode H.264/HEVC via
 * WebCodecs, which would silently divert every scenario down the
 * unsupported-codec fallback path and invalidate the findings.
 *
 * NOT wired into CI. Not for merging — hunt scratch artifact only.
 */

const PORT = Number(process.env.E2E_HUNT_W2_PORT ?? 3302);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./e2e/hunt",
	testMatch: "**/*.e2e.ts",
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
		screenshot: "off",
	},
	projects: [
		{
			name: "chrome",
			use: {
				...devices["Desktop Chrome"],
				channel: "chrome",
				viewport: { width: 1280, height: 800 },
			},
		},
	],
	webServer: {
		command: `cross-env NEXT_PUBLIC_E2E=1 PORT=${PORT} bun run dev`,
		url: BASE_URL,
		timeout: 180_000,
		reuseExistingServer: true,
		stdout: "pipe",
		stderr: "pipe",
	},
});
