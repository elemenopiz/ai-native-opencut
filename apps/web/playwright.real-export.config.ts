import { defineConfig, devices } from "@playwright/test";

/**
 * Real-export golden-path config — mirrors `playwright.config.ts` (same
 * client-only app, same global fixture minting), but points at a build with
 * the export stub turned OFF (`NEXT_PUBLIC_E2E_STUB_EXPORT=0`, see
 * `src/components/editor/e2e-bridge.tsx`) so `golden-path-export.e2e.ts` can
 * drive the *genuine* canvas/mediabunny/WebCodecs export path and assert on
 * real produced bytes (ffprobe'd video + audio streams), not a stub buffer.
 *
 * A different port (3211) than the stub suite's 3210 so both configs' dev
 * servers can coexist without colliding, and `testMatch` is narrowed to only
 * this one spec — the stub suite's config globs `**\/*.e2e.ts` too and WILL
 * pick this file up if pointed at a real-export build; the spec itself
 * self-skips via `window.__BYORN_E2E__.stubExport` as a second layer of
 * protection (see the spec's `test.beforeEach`).
 */

const PORT = Number(process.env.E2E_REAL_EXPORT_PORT ?? 3211);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/real-export/golden-path-export.e2e.ts",
	globalSetup: "./e2e/global-setup.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	// Real encode (WebCodecs, per-frame render loop) is slow relative to the
	// stubbed suite — give it real headroom.
	timeout: 240_000,
	expect: { timeout: 30_000 },
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
		command: `cross-env NEXT_PUBLIC_E2E=1 NEXT_PUBLIC_E2E_STUB_EXPORT=0 PORT=${PORT} bun run start`,
		url: BASE_URL,
		timeout: 180_000,
		reuseExistingServer: !process.env.CI,
		stdout: "pipe",
		stderr: "pipe",
	},
});
