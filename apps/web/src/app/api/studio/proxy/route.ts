import { NextResponse } from "next/server";
import {
	pinnedFetch,
	SsrfError,
	validateProxyTarget,
} from "@/lib/studio/ssrf-guard";

// DNS resolution + IP-literal parsing require the Node runtime (not Edge).
export const runtime = "nodejs";

/**
 * Streams a remote generated-video URL through our own origin so the browser
 * can turn it into a File/Blob without tripping over the provider's CORS policy.
 * Only used to import a finished take onto the timeline.
 *
 * The SSRF guard lives in `@/lib/studio/ssrf-guard`: it validates the target is
 * a public host and pins the connection to the validated IP so a rebinding
 * attacker cannot swap in an internal address after the check.
 */
export async function GET(req: Request) {
	const { searchParams } = new URL(req.url);
	const url = searchParams.get("url");

	if (!url) {
		return NextResponse.json({ error: "url is required" }, { status: 400 });
	}

	let target: Awaited<ReturnType<typeof validateProxyTarget>>;
	try {
		target = await validateProxyTarget(url);
	} catch (err) {
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
			return NextResponse.json(
				{ error: "url resolves to a disallowed host" },
				{ status: 400 },
			);
		}
		return NextResponse.json(
			{ error: "url resolves to a disallowed host" },
			{ status: 400 },
		);
	}

	try {
		// Connection is pinned to the pre-validated IP and does not follow
		// redirects, so a public URL can't 302 us onto an internal host.
		const upstream = await pinnedFetch(target.url, target.pinnedIp);
		if (upstream.status >= 300 && upstream.status < 400) {
			return NextResponse.json(
				{ error: "redirects are not allowed" },
				{ status: 502 },
			);
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
	} catch (err) {
		const message = err instanceof Error ? err.message : "proxy failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
