import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
	pinnedFetch,
	SsrfError,
	validateProxyTarget,
	type ValidatedTarget,
} from "@/lib/studio/ssrf-guard";

// DNS resolution + IP-literal parsing require the Node runtime (not Edge).
export const runtime = "nodejs";

// Streams the whole generated video through this function; matches the
// client's 120s media budget in lib/studio/fetch-timeout.ts.
export const maxDuration = 120;

/** Max redirect hops to chase before giving up (prevents redirect loops). */
const MAX_REDIRECT_HOPS = 3;

/**
 * Streams a remote generated-video URL through our own origin so the browser
 * can turn it into a File/Blob without tripping over the provider's CORS policy.
 * Only used to import a finished take onto the timeline.
 *
 * The SSRF guard lives in `@/lib/studio/ssrf-guard`: it validates the target is
 * a public host and pins the connection to the validated IP so a rebinding
 * attacker cannot swap in an internal address after the check.
 *
 * Redirects are followed SAFELY: each hop's resolved absolute URL is re-run
 * through `validateProxyTarget` before we connect, so a public URL that 302s to
 * a signed CDN works, but a redirect toward an internal host is rejected.
 */
export async function GET(req: Request) {
	// This relay bills nothing directly but is an SSRF-guarded fetcher on our
	// egress; gate it like the sibling studio routes. The import flow only runs
	// after an authenticated generate, and the browser fetch is same-origin so
	// the session cookie is present.
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	// Imports can be frequent (a project pulls many clips), so the cap is
	// generous — it exists to bound abuse of the relay, not normal imports.
	const limited = await enforceRateLimit({
		name: "studio:proxy",
		request: req,
		userId: session.user.id,
	});
	if (limited) return limited;

	const { searchParams } = new URL(req.url);
	const url = searchParams.get("url");

	if (!url) {
		return NextResponse.json({ error: "url is required" }, { status: 400 });
	}

	let target: ValidatedTarget;
	try {
		target = await validateProxyTarget(url);
	} catch (err) {
		return ssrfErrorResponse(err);
	}

	try {
		// One initial fetch plus up to MAX_REDIRECT_HOPS safe redirect follows.
		for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
			// Connection is pinned to the pre-validated IP so a public URL can't
			// DNS-rebind us onto an internal host between validation and connect.
			const upstream = await pinnedFetch(target.url, target.pinnedIp);

			// Follow redirects safely: re-validate each resolved target for SSRF
			// before chasing it. A 3xx toward an internal host is rejected; a 302
			// to a signed public CDN is followed.
			if (upstream.status >= 300 && upstream.status < 400) {
				const location = upstream.headers.get("location");
				if (!location) {
					return NextResponse.json(
						{ error: `upstream redirect without location ${upstream.status}` },
						{ status: 502 },
					);
				}
				// Resolve relative Location headers against the current target URL.
				let resolved: string;
				try {
					resolved = new URL(location, target.url).toString();
				} catch {
					return NextResponse.json(
						{ error: "invalid redirect location" },
						{ status: 502 },
					);
				}
				try {
					target = await validateProxyTarget(resolved);
				} catch (err) {
					return ssrfErrorResponse(err);
				}
				continue;
			}

			if (upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
				return NextResponse.json(
					{ error: `upstream fetch failed ${upstream.status}` },
					{ status: 502 },
				);
			}

			const contentType =
				upstream.headers.get("content-type") ?? "application/octet-stream";

			return new NextResponse(upstream.body, {
				status: 200,
				headers: {
					"Content-Type": contentType,
					"Cache-Control": "private, max-age=3600",
				},
			});
		}

		// Exhausted the redirect budget without reaching a terminal response.
		return NextResponse.json({ error: "too many redirects" }, { status: 502 });
	} catch (err) {
		const message = err instanceof Error ? err.message : "proxy failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Map an SSRF validation failure to the appropriate 4xx response. */
function ssrfErrorResponse(err: unknown): NextResponse {
	if (err instanceof SsrfError) {
		if (err.reason === "invalid-url") {
			return NextResponse.json({ error: "invalid url" }, { status: 400 });
		}
		if (err.reason === "unsupported-protocol") {
			return NextResponse.json(
				{ error: "unsupported protocol" },
				{ status: 400 },
			);
		}
	}
	return NextResponse.json(
		{ error: "url resolves to a disallowed host" },
		{ status: 400 },
	);
}
