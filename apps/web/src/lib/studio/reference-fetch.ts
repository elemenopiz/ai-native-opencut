/**
 * Shared safe fetch for client-supplied reference media URLs (reference
 * images, last-frame stills, etc.) used by the image/video generation
 * backend adapters.
 *
 * These URLs (`referenceImageUrl`, `referenceImages[]`, `lastFrameUrl`) come
 * straight from the request body — the caller fully controls the host — so
 * fetching them server-side is the same SSRF surface as `studio/proxy`
 * (see `ssrf-guard.ts`'s module doc). Every adapter that downloads a
 * reference URL should call `fetchReferenceMediaSafely` instead of a bare
 * `fetch`/`fetchWithTimeout`: it validates the target is a public host
 * (blocking loopback/private/link-local/reserved v4+v6 via
 * `validateProxyTarget`) and pins the connection to the validated IP via
 * `pinnedFetch`, so a DNS-rebinding attacker can't swap in an internal
 * address between the check and the connect. Redirects are followed the same
 * way `studio/proxy`'s route does: each hop's resolved absolute URL is
 * re-validated before being chased, so a public URL that 302s to a signed
 * CDN still works but a redirect toward an internal host is rejected.
 *
 * Error hygiene: every failure — guard rejection, a non-2xx upstream status,
 * or a network/timeout error — throws a single `ReferenceFetchError` with a
 * fixed, generic message. Raw DNS/connect errors, upstream status detail, and
 * resolved IPs are never included in that message: propagating them to the
 * caller would turn a generation error into an internal-network recon
 * oracle. The detail is logged server-side instead.
 */

import {
	pinnedFetch,
	SsrfError,
	validateProxyTarget,
	type PinnedResponse,
	type ValidatedTarget,
} from "@/lib/studio/ssrf-guard";
import { MEDIA_TIMEOUT_MS } from "@/lib/studio/fetch-timeout";
import { logger } from "@/lib/observability/logger";

/** Structurally compatible with ssrf-guard's internal (unexported) DNS
 *  lookup seam — only ever overridden by tests. */
type ReferenceLookup = (
	host: string,
) => Promise<Array<{ address: string; family: number }>>;

export const REFERENCE_FETCH_ERROR_MESSAGE = "Failed to fetch reference media";

/** Thrown by {@link fetchReferenceMediaSafely} on any failure. Always carries
 *  the same generic message — never the upstream/DNS detail. */
export class ReferenceFetchError extends Error {
	constructor() {
		super(REFERENCE_FETCH_ERROR_MESSAGE);
		this.name = "ReferenceFetchError";
	}
}

export interface FetchReferenceMediaOptions {
	/** Whole-request budget (connect + headers + body). Defaults to the
	 *  shared media-download budget (`MEDIA_TIMEOUT_MS`). */
	timeoutMs?: number;
	/** Test-only DNS override — same injection seam `validateProxyTarget`
	 *  exposes. Never set from production code. */
	lookup?: ReferenceLookup;
	/** Test-only transport override, standing in for `pinnedFetch`. Lets
	 *  tests exercise the redirect/body-conversion logic below without a real
	 *  socket — mirroring `validateProxyTarget`'s own `lookup` injection seam.
	 *  Never set from production code. */
	pinnedFetchImpl?: (
		url: URL,
		pinnedIp: string,
		timeoutMs?: number,
	) => Promise<PinnedResponse>;
}

export interface ReferenceMediaBytes {
	contentType: string;
	arrayBuffer: ArrayBuffer;
}

/** Max redirect hops to chase before giving up (mirrors studio/proxy). */
const MAX_REDIRECT_HOPS = 3;

function logRejection(err: unknown): void {
	const reason = err instanceof SsrfError ? err.reason : "fetch-error";
	logger.warn("reference media fetch rejected", {
		reason,
		detail: err instanceof Error ? err.message : String(err),
	});
}

/**
 * Validate + fetch a caller-supplied reference media URL. Resolves with the
 * raw bytes and content-type on success. Throws {@link ReferenceFetchError}
 * (generic message, no upstream/DNS detail) if the URL is rejected by the
 * SSRF guard, every redirect hop is exhausted, or the fetch itself fails.
 */
export async function fetchReferenceMediaSafely(
	url: string,
	opts: FetchReferenceMediaOptions = {},
): Promise<ReferenceMediaBytes> {
	let target: ValidatedTarget;
	try {
		target = await validateProxyTarget(url, { lookup: opts.lookup });
	} catch (err) {
		logRejection(err);
		throw new ReferenceFetchError();
	}

	const doFetch = opts.pinnedFetchImpl ?? pinnedFetch;

	try {
		// One initial fetch plus up to MAX_REDIRECT_HOPS safe redirect follows —
		// same shape as studio/proxy's route.
		for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
			const upstream = await doFetch(
				target.url,
				target.pinnedIp,
				opts.timeoutMs ?? MEDIA_TIMEOUT_MS,
			);

			if (upstream.status >= 300 && upstream.status < 400) {
				const location = upstream.headers.get("location");
				if (!location) {
					throw new Error(
						`upstream redirect without location ${upstream.status}`,
					);
				}
				const resolved = new URL(location, target.url).toString();
				// Re-validate the redirect target before chasing it — a public URL
				// can't 302 us onto an internal host.
				target = await validateProxyTarget(resolved, { lookup: opts.lookup });
				continue;
			}

			if (upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
				throw new Error(`upstream fetch failed ${upstream.status}`);
			}

			const arrayBuffer = await new Response(upstream.body).arrayBuffer();
			const contentType =
				upstream.headers.get("content-type") ?? "application/octet-stream";
			return { contentType, arrayBuffer };
		}

		throw new Error("too many redirects");
	} catch (err) {
		logRejection(err);
		throw new ReferenceFetchError();
	}
}
