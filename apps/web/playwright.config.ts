import { defineConfig, devices } from "@playwright/test";

/**
 * E2E happy-path smoke config.
 *
 * The editor is a client-only app (projects live in IndexedDB), so no backend is
 * required — the one provider boundary (`/api/studio/*`) is mocked in the spec.
 * The dev server is served from a production build that MUST be built with
 * `NEXT_PUBLIC_E2E=1` (see the `build:e2e` script) so the `E2EBridge` test seam
 * is compiled in. `start:e2e` sets the same flag at runtime for good measure.
 */

const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./e2e",
	// `.e2e.ts` (not `.spec.ts`) so `bun test` doesn't try to run these — its
	// globber picks up `*.spec.ts`, but Playwright tests must run under Playwright.
	testMatch: "**/*.e2e.ts",
	globalSetup: "./e2e/global-setup.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	timeout: 90_000,
	expect: { timeout: 20_000 },
	reporter: process.env.CI
		? [["list"], ["html", { open: "never" }]]
		: [["list"]],
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		video: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: `cross-env NEXT_PUBLIC_E2E=1 PORT=${PORT} bun run start`,
		url: BASE_URL,
		timeout: 180_000,
		reuseExistingServer: !process.env.CI,
		stdout: "pipe",
		stderr: "pipe",
	},
});
