import { expect, test } from "@playwright/test";

/**
 * Regression lock for BUG12 — an anonymous (logged-out) editor session must
 * survive background API 401s without being bounced to /signup.
 *
 * Opening `/editor/<anything>` anonymously mounts the Generate panel, whose
 * effect calls `loadHistory` → `apiFetch("/api/studio/sets")` (plus a board
 * hydration GET to `/api/studio/board`). Anonymously these legitimately 401.
 * `apiFetch`'s shared 401 handler (`src/lib/auth/unauthorized.ts`) currently
 * treats ANY 401 — including these routine, best-effort background calls —
 * as a global "you're logged out" signal: toast + `byorn:unauthorized` event
 * → `SessionExpiredListener` pushes to `/signup?redirect=…`. The editor page
 * navigates itself away within roughly one round trip of mount, even though
 * anonymous editing is supposed to be the normal, supported state in the
 * closed beta.
 *
 * Unlike happy-path.e2e.ts, this spec does NOT mock `/api/studio/*` or
 * `/api/credits/**` — the whole point is to let the real 401s flow through
 * the real client plumbing and prove the editor keeps running anyway.
 */

test.describe("anonymous editor stability", () => {
	test("survives background 401s without redirecting to /signup", async ({
		page,
	}) => {
		// Record every 401 our own API returns during the run (excluding
		// /api/auth/*, which is deliberately exempt from the unauthorized-event
		// loop guard in unauthorized.ts and isn't part of this bug). This proves
		// the race window was actually exercised — the assertion at the bottom
		// couples this spec to the current fix shape (background calls still
		// fire and 401 silently); if a future fix instead gates the fetches
		// entirely for anonymous sessions, relax that assertion.
		const observed401s: string[] = [];
		page.on("response", (response) => {
			const url = new URL(response.url());
			if (
				url.pathname.startsWith("/api/") &&
				!url.pathname.startsWith("/api/auth") &&
				response.status() === 401
			) {
				observed401s.push(url.pathname);
			}
		});

		// Navigating to an unknown id makes the app create a fresh project and
		// redirect within /editor, same as happy-path.e2e.ts — no login, no
		// session cookie, fully anonymous.
		await page.goto("/editor/anon-stability");
		await page.waitForFunction(
			() => window.__BYORN_E2E__?.ready === true,
			null,
			{ timeout: 60_000 },
		);

		// Soak well past both the observed redirect race (~1-2s on main) and the
		// 10s debounce in unauthorized.ts, so a delayed second unauthorized
		// event would be caught too.
		await page.waitForTimeout(20_000);

		// The editor must still be where it was — not redirected to /signup.
		const pathname = new URL(page.url()).pathname;
		expect(
			pathname.startsWith("/editor/"),
			`expected to still be under /editor/, got "${pathname}" (page.url()="${page.url()}")`,
		).toBe(true);
		expect(
			pathname.includes("/signup"),
			`expected NOT to have been redirected to /signup, got "${pathname}"`,
		).toBe(false);

		// The editor core is still mounted and live — not torn down/remounted
		// elsewhere as a side effect of a navigation.
		const bridgeReady = await page.evaluate(() => window.__BYORN_E2E__?.ready);
		expect(bridgeReady).toBe(true);

		// Sanity: the race window was actually exercised (at least one 401 from
		// our own API was observed). If this is empty, the test is vacuously
		// green — investigate what status the background calls actually
		// returned before trusting a pass.
		expect(observed401s.length).toBeGreaterThan(0);
	});
});
