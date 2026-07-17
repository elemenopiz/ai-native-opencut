/**
 * `fetchReferenceMediaSafely` — the shared SSRF-guarded fetch every
 * generation-backend adapter uses for caller-supplied reference media URLs
 * (`referenceImageUrl` / `referenceImages[]` / `lastFrameUrl`).
 *
 * Rejection cases (loopback / private-range / IPv6-loopback) use the real
 * `validateProxyTarget` — no mocking needed, the same way `ssrf-guard.test.ts`
 * exercises its own "URL-level SSRF vectors" with plain IP-literal URLs: for
 * an IP literal, `validateProxyTarget` never performs any I/O (no DNS lookup,
 * no socket) before throwing, so passing a `pinnedFetchImpl` that fails the
 * test if invoked proves the transport layer is never reached.
 *
 * The "still flows" case injects `lookup` (same seam `validateProxyTarget`
 * exposes, reused via `ssrf-guard.test.ts`'s `lookupTo` pattern) plus a
 * `pinnedFetchImpl` stand-in for `pinnedFetch` — both test-only options on
 * `fetchReferenceMediaSafely` — so the redirect/body-conversion logic is
 * exercised without a real socket or real DNS.
 */
import { describe, expect, it } from "bun:test";
import {
	fetchReferenceMediaSafely,
	REFERENCE_FETCH_ERROR_MESSAGE,
	ReferenceFetchError,
} from "../reference-fetch";
import type { PinnedResponse } from "../ssrf-guard";

const lookupTo =
	(...addrs: Array<{ address: string; family: number }>) =>
	async () =>
		addrs;

/** A `pinnedFetchImpl` that fails the test if it is ever invoked — proves the
 *  SSRF guard rejected the target before any transport attempt. */
function unreachableFetch(): (
	url: URL,
	pinnedIp: string,
) => Promise<PinnedResponse> {
	return () => {
		throw new Error("pinnedFetch must not be called for a blocked target");
	};
}

function textResponse(
	body: string,
	init: { status?: number; headers?: Record<string, string> } = {},
): PinnedResponse {
	const headers = new Headers(init.headers ?? { "content-type": "text/plain" });
	const bytes = new TextEncoder().encode(body);
	return {
		status: init.status ?? 200,
		headers,
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	};
}

describe("fetchReferenceMediaSafely — SSRF rejection, no network attempted", () => {
	it("rejects a loopback IPv4 literal (http://127.0.0.1/x)", async () => {
		await expect(
			fetchReferenceMediaSafely("http://127.0.0.1/x", {
				pinnedFetchImpl: unreachableFetch(),
			}),
		).rejects.toThrow(ReferenceFetchError);
	});

	it("rejects a private-range IPv4 literal (http://10.0.0.1/x)", async () => {
		await expect(
			fetchReferenceMediaSafely("http://10.0.0.1/x", {
				pinnedFetchImpl: unreachableFetch(),
			}),
		).rejects.toThrow(ReferenceFetchError);
	});

	it("rejects an IPv6 loopback literal (http://[::1]/x)", async () => {
		await expect(
			fetchReferenceMediaSafely("http://[::1]/x", {
				pinnedFetchImpl: unreachableFetch(),
			}),
		).rejects.toThrow(ReferenceFetchError);
	});

	it("rejects a link-local / cloud-metadata literal (http://169.254.169.254/latest/)", async () => {
		await expect(
			fetchReferenceMediaSafely("http://169.254.169.254/latest/", {
				pinnedFetchImpl: unreachableFetch(),
			}),
		).rejects.toThrow(ReferenceFetchError);
	});

	it("rejects a hostname that resolves to a private address (DNS-rebinding shape)", async () => {
		await expect(
			fetchReferenceMediaSafely("http://rebind.evil.test/x", {
				lookup: lookupTo({ address: "192.168.1.1", family: 4 }),
				pinnedFetchImpl: unreachableFetch(),
			}),
		).rejects.toThrow(ReferenceFetchError);
	});

	it("the rejection error is exactly the generic message — no IP/DNS/status detail", async () => {
		try {
			await fetchReferenceMediaSafely("http://127.0.0.1/admin/secrets", {
				pinnedFetchImpl: unreachableFetch(),
			});
			throw new Error("expected fetchReferenceMediaSafely to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ReferenceFetchError);
			const message = (err as Error).message;
			expect(message).toBe(REFERENCE_FETCH_ERROR_MESSAGE);
			// Nothing upstream-specific leaks into the message a caller sees.
			expect(message).not.toMatch(/127\.0\.0\.1/);
			expect(message).not.toMatch(/blocked-host/i);
			expect(message).not.toMatch(/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/);
		}
	});

	it("rejects a non-http(s) protocol before any transport attempt", async () => {
		await expect(
			fetchReferenceMediaSafely("file:///etc/passwd", {
				pinnedFetchImpl: unreachableFetch(),
			}),
		).rejects.toThrow(ReferenceFetchError);
	});
});

describe("fetchReferenceMediaSafely — valid public URL still flows", () => {
	it("resolves to the upstream bytes + content-type on a plain 200", async () => {
		const result = await fetchReferenceMediaSafely(
			"https://cdn.example.com/ref.png",
			{
				lookup: lookupTo({ address: "93.184.216.34", family: 4 }),
				pinnedFetchImpl: async (url) => {
					expect(url.hostname).toBe("cdn.example.com");
					return textResponse("fake-image-bytes", {
						headers: { "content-type": "image/png" },
					});
				},
			},
		);

		expect(result.contentType).toBe("image/png");
		expect(new TextDecoder().decode(result.arrayBuffer)).toBe(
			"fake-image-bytes",
		);
	});

	it("re-validates and follows a same-target-shape redirect to a public URL", async () => {
		let calls = 0;
		const result = await fetchReferenceMediaSafely(
			"https://cdn.example.com/ref.png",
			{
				lookup: lookupTo({ address: "93.184.216.34", family: 4 }),
				pinnedFetchImpl: async (url) => {
					calls += 1;
					if (calls === 1) {
						expect(url.hostname).toBe("cdn.example.com");
						return textResponse("", {
							status: 302,
							headers: {
								location: "https://signed.cdn.example.com/ref-final.png",
							},
						});
					}
					expect(url.hostname).toBe("signed.cdn.example.com");
					return textResponse("final-bytes", {
						headers: { "content-type": "image/jpeg" },
					});
				},
			},
		);

		expect(calls).toBe(2);
		expect(result.contentType).toBe("image/jpeg");
		expect(new TextDecoder().decode(result.arrayBuffer)).toBe("final-bytes");
	});

	it("rejects (generically) a redirect that resolves onto a private host", async () => {
		await expect(
			fetchReferenceMediaSafely("https://cdn.example.com/ref.png", {
				lookup: lookupTo({ address: "93.184.216.34", family: 4 }),
				pinnedFetchImpl: async (url) => {
					if (url.hostname === "cdn.example.com") {
						return textResponse("", {
							status: 302,
							headers: { location: "http://169.254.169.254/latest/meta-data/" },
						});
					}
					throw new Error("must not chase the redirect onto the internal host");
				},
			}),
		).rejects.toThrow(ReferenceFetchError);
	});

	it("wraps a non-2xx terminal status in the generic error, not the raw status", async () => {
		try {
			await fetchReferenceMediaSafely("https://cdn.example.com/missing.png", {
				lookup: lookupTo({ address: "93.184.216.34", family: 4 }),
				pinnedFetchImpl: async () => textResponse("not found", { status: 404 }),
			});
			throw new Error("expected fetchReferenceMediaSafely to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ReferenceFetchError);
			expect((err as Error).message).toBe(REFERENCE_FETCH_ERROR_MESSAGE);
		}
	});

	it("wraps a transport-level throw (network error) in the generic error", async () => {
		try {
			await fetchReferenceMediaSafely("https://cdn.example.com/ref.png", {
				lookup: lookupTo({ address: "93.184.216.34", family: 4 }),
				pinnedFetchImpl: async () => {
					throw new Error("getaddrinfo ENOTFOUND cdn.example.com — DNS detail");
				},
			});
			throw new Error("expected fetchReferenceMediaSafely to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ReferenceFetchError);
			const message = (err as Error).message;
			expect(message).toBe(REFERENCE_FETCH_ERROR_MESSAGE);
			expect(message).not.toMatch(/ENOTFOUND/);
		}
	});
});
