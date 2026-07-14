/**
 * `verb-telemetry-client.ts` — the browser-side sender agent.ts's
 * `executeTool` calls after every in-app Director verb.
 *
 * bun test has no DOM (`typeof window === "undefined"`), which the module
 * itself treats as "not in a browser, no-op" — exactly the guard tests need
 * to stub around. `window`/`navigator`/`fetch` are saved and restored in
 * `afterEach`, the same save/restore discipline the codebase already uses
 * for `global.fetch` (see the `bun-test-global-fetch-leak` lesson in
 * `lib/mcp/__tests__/telemetry.test.ts`'s header) — no `mock.module` involved,
 * so there is no cross-file module-registry leak risk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	currentProjectIdFromLocation,
	reportVerbTelemetry,
	resetVerbTelemetryForTests,
} from "../verb-telemetry-client";

const realWindow = (globalThis as { window?: unknown }).window;
const realNavigator = globalThis.navigator;
const realFetch = globalThis.fetch;

interface CapturedBeacon {
	url: string;
	body: Record<string, unknown>;
}

let sentBeacons: CapturedBeacon[];
let sentFetches: CapturedBeacon[];

function installWindow(pathname: string): void {
	(globalThis as { window?: unknown }).window = {
		location: { pathname },
	};
}

function installSendBeacon(): void {
	(globalThis as unknown as { navigator: Navigator }).navigator = {
		...realNavigator,
		sendBeacon: ((url: string, data: Blob) => {
			// Blob#text() is async, but sendBeacon itself is sync — resolve the
			// body inline via arrayBuffer's sync-friendly text decode isn't
			// available, so stash the blob and decode in a microtask the test
			// awaits via a short `waitFor`.
			void data.text().then((text) => {
				sentBeacons.push({ url, body: JSON.parse(text) });
			});
			return true;
		}) as Navigator["sendBeacon"],
	} as Navigator;
}

function installNoSendBeacon(): void {
	// Force the fetch-keepalive fallback branch.
	const { sendBeacon: _drop, ...rest } = realNavigator as unknown as Record<
		string,
		unknown
	>;
	(globalThis as unknown as { navigator: unknown }).navigator = rest;
}

function installFetch(): void {
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		sentFetches.push({
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")),
		});
		return new Response(null, { status: 204 });
	}) as typeof fetch;
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

beforeEach(() => {
	sentBeacons = [];
	sentFetches = [];
	resetVerbTelemetryForTests();
});

afterEach(() => {
	(globalThis as { window?: unknown }).window = realWindow;
	(globalThis as unknown as { navigator: unknown }).navigator = realNavigator;
	globalThis.fetch = realFetch;
});

describe("currentProjectIdFromLocation", () => {
	test("returns null outside the browser (no window)", () => {
		(globalThis as { window?: unknown }).window = undefined;
		expect(currentProjectIdFromLocation()).toBeNull();
	});

	test("extracts the project id from /editor/<id>/... ", () => {
		installWindow("/editor/proj_abc123/timeline");
		expect(currentProjectIdFromLocation()).toBe("proj_abc123");
	});

	test("returns null off the editor route", () => {
		installWindow("/dashboard");
		expect(currentProjectIdFromLocation()).toBeNull();
	});
});

describe("reportVerbTelemetry", () => {
	test("no-op outside the browser (no window) — never throws", () => {
		(globalThis as { window?: unknown }).window = undefined;
		expect(() =>
			reportVerbTelemetry({
				verb: "getReel",
				status: "ok",
				durationMs: 5,
				timelineChanged: false,
				mutating: false,
			}),
		).not.toThrow();
	});

	test("a non-ok status sends exactly one tool_call beacon and never activates", async () => {
		installWindow("/editor/proj_x/timeline");
		installSendBeacon();

		reportVerbTelemetry({
			verb: "trim",
			status: "tool_error",
			durationMs: 9,
			timelineChanged: false,
			mutating: true,
		});

		await waitFor(() => sentBeacons.length >= 1);
		// Give a tick for a (wrongly) second beacon to land, if any.
		await new Promise((r) => setTimeout(r, 20));

		expect(sentBeacons.length).toBe(1);
		expect(sentBeacons[0].body.event).toBe("tool_call");
		expect(sentBeacons[0].body.status).toBe("tool_error");
		expect(sentBeacons[0].body.projectId).toBe("proj_x");
	});

	test("the FIRST ok call sends tool_call + agent_session_activated; a SECOND ok call sends only tool_call", async () => {
		installWindow("/editor/proj_y/timeline");
		installSendBeacon();

		reportVerbTelemetry({
			verb: "getReel",
			status: "ok",
			durationMs: 3,
			timelineChanged: false,
			mutating: false,
		});
		await waitFor(() => sentBeacons.length >= 2);

		expect(sentBeacons.length).toBe(2);
		expect(sentBeacons.map((b) => b.body.event).sort()).toEqual(
			["agent_session_activated", "tool_call"].sort(),
		);

		reportVerbTelemetry({
			verb: "generate",
			status: "ok",
			durationMs: 3,
			timelineChanged: true,
			mutating: true,
		});
		await waitFor(() => sentBeacons.length >= 3);
		await new Promise((r) => setTimeout(r, 20));

		// Only one MORE beacon (the second call's tool_call) — no second activation.
		expect(sentBeacons.length).toBe(3);
		expect(
			sentBeacons.filter((b) => b.body.event === "agent_session_activated")
				.length,
		).toBe(1);
	});

	test("a failed first call does NOT activate; a later ok call does", async () => {
		installWindow("/editor/proj_z/timeline");
		installSendBeacon();

		reportVerbTelemetry({
			verb: "trim",
			status: "tool_error",
			durationMs: 1,
			timelineChanged: false,
			mutating: true,
		});
		await waitFor(() => sentBeacons.length >= 1);
		expect(
			sentBeacons.some((b) => b.body.event === "agent_session_activated"),
		).toBe(false);

		reportVerbTelemetry({
			verb: "getReel",
			status: "ok",
			durationMs: 1,
			timelineChanged: false,
			mutating: false,
		});
		await waitFor(() =>
			sentBeacons.some((b) => b.body.event === "agent_session_activated"),
		);
		expect(
			sentBeacons.filter((b) => b.body.event === "agent_session_activated")
				.length,
		).toBe(1);
	});

	test("falls back to fetch(keepalive) when sendBeacon is unavailable", async () => {
		installWindow("/editor/proj_fallback/timeline");
		installNoSendBeacon();
		installFetch();

		reportVerbTelemetry({
			verb: "getReel",
			status: "ok",
			durationMs: 2,
			timelineChanged: false,
			mutating: false,
		});

		await waitFor(() => sentFetches.length >= 2);
		expect(sentFetches.every((f) => f.url === "/api/telemetry/verb")).toBe(
			true,
		);
	});

	test("an explicit projectId wins over the URL-derived one", async () => {
		installWindow("/editor/proj_from_url/timeline");
		installSendBeacon();

		reportVerbTelemetry({
			verb: "getReel",
			status: "tool_error",
			durationMs: 1,
			timelineChanged: false,
			mutating: false,
			projectId: "proj_explicit",
		});
		await waitFor(() => sentBeacons.length >= 1);
		expect(sentBeacons[0].body.projectId).toBe("proj_explicit");
	});

	test("never throws even when the transport throws", () => {
		installWindow("/editor/proj_x/timeline");
		(globalThis as unknown as { navigator: unknown }).navigator = {
			sendBeacon: () => {
				throw new Error("boom");
			},
		};
		expect(() =>
			reportVerbTelemetry({
				verb: "getReel",
				status: "ok",
				durationMs: 1,
				timelineChanged: false,
				mutating: false,
			}),
		).not.toThrow();
	});
});
