import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	__getAlertStatsForTests,
	__resetAlertStateForTests,
	reportError,
} from "../logger";

/**
 * Coverage for the ADR-002 vendor-alerting webhook forwarder inside
 * `reportError` (logger.ts). The contract: unset env ⇒ zero behavior change
 * (no fetch, ever); set env ⇒ a size-capped, secret-redacted JSON POST that
 * never throws, never blocks the caller, and self-limits under an error
 * storm. Mirrors the save/restore pattern used in `../../rate-limit.test.ts`
 * (env) and `../../studio/fetch-timeout.test.ts` (global.fetch) — direct
 * assignment restore, not `mock.restore()`, per the known bun-test
 * global.fetch leak gotcha.
 */

const ALERT_ENV = "OBSERVABILITY_ALERT_WEBHOOK_URL";
const realFetch = globalThis.fetch;
const savedAlertUrl = process.env[ALERT_ENV];

beforeEach(() => {
	__resetAlertStateForTests();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	if (savedAlertUrl === undefined) {
		delete process.env[ALERT_ENV];
	} else {
		process.env[ALERT_ENV] = savedAlertUrl;
	}
	__resetAlertStateForTests();
});

interface FetchCall {
	url: string;
	init?: RequestInit;
}

function installMockFetch(
	impl?: (url: string, init?: RequestInit) => Promise<Response>,
): FetchCall[] {
	const calls: FetchCall[] = [];
	globalThis.fetch = ((url: string, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return impl
			? impl(url, init)
			: Promise.resolve(new Response("ok", { status: 200 }));
	}) as typeof fetch;
	return calls;
}

describe("reportError — vendor-alerting webhook (ADR-002)", () => {
	it("env unset: never calls fetch (byte-identical default behavior)", () => {
		delete process.env[ALERT_ENV];
		const calls = installMockFetch();

		reportError(new Error("boom"));

		expect(calls.length).toBe(0);
	});

	it("env set: POSTs a JSON payload with the expected shape", () => {
		process.env[ALERT_ENV] = "https://hooks.example/alert";
		const calls = installMockFetch();

		reportError(new Error("kaboom"), { userId: "u1", route: "/editor/p1" });

		expect(calls.length).toBe(1);
		expect(calls[0].url).toBe("https://hooks.example/alert");
		expect(calls[0].init?.method).toBe("POST");
		expect(
			(calls[0].init?.headers as Record<string, string>)["content-type"],
		).toBe("application/json");

		const body = JSON.parse(calls[0].init?.body as string);
		expect(body.level).toBe("error");
		expect(body.errorName).toBe("Error");
		expect(body.message).toBe("kaboom");
		expect(typeof body.ts).toBe("string");
		expect(body.context).toEqual({ userId: "u1", route: "/editor/p1" });
	});

	it("redacts secrets from message, stack, and context before sending", () => {
		process.env[ALERT_ENV] = "https://hooks.example/alert";
		const calls = installMockFetch();

		const err = new Error("failed token=abc123 while fetching");
		err.stack = "Error: x\n at fn (/x.ts:1:1) key=sk-super-secret-value";

		// redactSecrets scrubs pattern-matched content within each string value —
		// same as `redactPayload` in intake.ts — so the context value itself must
		// carry a secret-shaped pattern (a `key=...` assignment here) to exercise
		// it, mirroring how a debug URL or logged header string would look.
		reportError(err, { debugUrl: "https://x.example/cb?token=abc123&ok=1" });

		const body = JSON.parse(calls[0].init?.body as string);
		expect(body.message).toBe("failed token=[redacted] while fetching");
		expect(body.stack).toContain("[redacted]");
		expect(body.stack).not.toContain("sk-super-secret-value");
		expect(body.context.debugUrl).toBe(
			"https://x.example/cb?token=[redacted]&ok=1",
		);
	});

	it("caps the outgoing payload size even under an unbounded context", () => {
		process.env[ALERT_ENV] = "https://hooks.example/alert";
		const calls = installMockFetch();

		const hugeContext: Record<string, string> = {};
		for (let i = 0; i < 2_000; i++) hugeContext[`k${i}`] = "x".repeat(50);

		reportError(new Error("boom"), hugeContext);

		const raw = calls[0].init?.body as string;
		expect(raw.length).toBeLessThanOrEqual(8 * 1024);
		// The oversized context was dropped rather than silently mangled mid-JSON.
		const parsed = JSON.parse(raw);
		expect(parsed.context).toEqual({ truncated: true });
	});

	it("is fail-soft when fetch rejects: never throws, records a failure count", async () => {
		process.env[ALERT_ENV] = "https://hooks.example/alert";
		installMockFetch(() => Promise.reject(new Error("network down")));

		expect(() => reportError(new Error("boom"))).not.toThrow();

		// Let the un-awaited rejection settle without becoming an unhandled
		// rejection.
		await Promise.resolve();
		await Promise.resolve();

		expect(__getAlertStatsForTests().failures).toBe(1);
	});

	it("rate-limits: drops alerts beyond the per-window cap", () => {
		process.env[ALERT_ENV] = "https://hooks.example/alert";
		const calls = installMockFetch();

		for (let i = 0; i < 15; i++) {
			reportError(new Error(`boom ${i}`));
		}

		expect(calls.length).toBe(10);
		expect(__getAlertStatsForTests().drops).toBe(5);
	});

	it("never throws out of reportError even if the webhook URL is malformed", () => {
		process.env[ALERT_ENV] = "not a url";
		installMockFetch(() => {
			throw new TypeError("Invalid URL");
		});

		expect(() => reportError(new Error("boom"))).not.toThrow();
	});
});
