import { defineConfig, devices } from "@playwright/test";

/**
 * W3 (bug-purge-w4 wave-closer) — disambiguation + contract-verification
 * driver. Points at the already-running `NEXT_PUBLIC_E2E=1 PORT=3303 bun run
 * dev` server (worktree agent-aa07da3cbe86f796e, task/w2-interaction-ui,
 * wave-3 integrated tip) — no webServer block, same reuse pattern as
 * playwright.hunt-w-drag.config.ts.
 */

const PORT = Number(process.env.E2E_HUNT_W_DRAG_PORT ?? 3303);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./e2e/hunt",
	testMatch: "**/*.w3.e2e.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
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
			use: {
				...devices["Desktop Chrome"],
				channel: "chrome",
				viewport: { width: 1680, height: 1000 },
				launchOptions: {
					args: [
						"--use-fake-ui-for-media-capture",
						"--use-fake-device-for-media-capture",
					],
				},
			},
		},
	],
});
