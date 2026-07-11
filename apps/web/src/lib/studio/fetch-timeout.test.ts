import { afterEach, describe, expect, it } from "bun:test";
import { fetchWithTimeout } from "./fetch-timeout";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** A fetch stub that never responds and only settles when its signal aborts. */
function installHangingFetch() {
	globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) return; // hangs forever — the test would time out
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		})) as typeof fetch;
}

describe("fetchWithTimeout", () => {
	it("rejects with a timeout error once timeoutMs elapses", async () => {
		installHangingFetch();
		const started = Date.now();
		await expect(
			fetchWithTimeout("https://provider.invalid/hang", { timeoutMs: 25 }),
		).rejects.toThrow(/timed out after 25ms/);
		// It must be the timeout that fired, not some other rejection path.
		expect(Date.now() - started).toBeGreaterThanOrEqual(20);
	});

	it("does not leak the target URL into the timeout message", async () => {
		installHangingFetch();
		const err = await fetchWithTimeout(
			"https://r2.example/media?X-Amz-Signature=secret",
			{ timeoutMs: 10 },
		).catch((e: unknown) => e as Error);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).not.toContain("secret");
	});

	it("passes a fast response straight through", async () => {
		globalThis.fetch = ((_input: unknown, _init?: RequestInit) =>
			Promise.resolve(new Response("ok", { status: 200 }))) as typeof fetch;
		const res = await fetchWithTimeout("https://provider.invalid/fast", {
			timeoutMs: 1000,
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("surfaces non-timeout failures unchanged", async () => {
		globalThis.fetch = ((_input: unknown, _init?: RequestInit) =>
			Promise.reject(new Error("connection refused"))) as typeof fetch;
		await expect(
			fetchWithTimeout("https://provider.invalid/down", { timeoutMs: 1000 }),
		).rejects.toThrow("connection refused");
	});
});
