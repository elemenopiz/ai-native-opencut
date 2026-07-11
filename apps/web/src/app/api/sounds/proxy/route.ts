import { type NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Same-origin relay for library audio downloads.
 *
 * ccMixter media is unusable directly from the browser: the files are
 * hotlink-protected (403 unless the Referer is ccmixter.org — browsers send OUR
 * origin) and the responses carry no Access-Control-Allow-Origin header, so
 * both `<audio>` preview and the fetch + decodeAudioData timeline import fail.
 * Streaming through our origin fixes both.
 *
 * This is NOT an open proxy: only HTTPS URLs on the fixed Freesound/ccMixter
 * hostname allowlist are fetched, redirects are re-validated against the same
 * allowlist before being followed, and the body is capped in size — so it
 * cannot be used to reach internal hosts (SSRF) or relay arbitrary content.
 */

const ALLOWED_HOSTS = new Set([
	"ccmixter.org",
	"www.ccmixter.org",
	"ccmixtermedia.org",
	"freesound.org",
	"cdn.freesound.org",
]);

// Streams the whole audio file through this function.
export const maxDuration = 60;

/** Songs are a few MB; 100MB comfortably bounds even long WAV uploads. */
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 3;

/**
 * Parse + allowlist a target URL. Plain http is upgraded to https (both hosts
 * serve TLS; ccMixter's API occasionally hands out http URLs).
 */
function validateTarget(raw: string): URL | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol === "http:") url.protocol = "https:";
	if (url.protocol !== "https:") return null;
	if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
	return url;
}

export async function GET(request: NextRequest) {
	const { limited } = await checkRateLimit({ request });
	if (limited) {
		return NextResponse.json({ error: "Too many requests" }, { status: 429 });
	}

	const raw = request.nextUrl.searchParams.get("url");
	if (!raw) {
		return NextResponse.json({ error: "url is required" }, { status: 400 });
	}

	let target = validateTarget(raw);
	if (!target) {
		return NextResponse.json(
			{ error: "url must be an https Freesound or ccMixter URL" },
			{ status: 400 },
		);
	}

	try {
		// One initial fetch plus up to MAX_REDIRECT_HOPS allowlist-checked follows.
		for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
			const upstream = await fetch(target.toString(), {
				redirect: "manual",
				headers: {
					// ccMixter hotlink protection requires a same-site Referer.
					Referer: `${target.origin}/`,
					Accept: "audio/*,application/octet-stream,*/*",
				},
			});

			if (upstream.status >= 300 && upstream.status < 400) {
				const location = upstream.headers.get("location");
				if (!location) {
					return NextResponse.json(
						{ error: `upstream redirect without location ${upstream.status}` },
						{ status: 502 },
					);
				}
				let resolved: string;
				try {
					resolved = new URL(location, target).toString();
				} catch {
					return NextResponse.json(
						{ error: "invalid redirect location" },
						{ status: 502 },
					);
				}
				// Redirects may only land on the same allowlist — never elsewhere.
				const next = validateTarget(resolved);
				if (!next) {
					return NextResponse.json(
						{ error: "redirect to a disallowed host" },
						{ status: 502 },
					);
				}
				target = next;
				continue;
			}

			if (upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
				return NextResponse.json(
					{ error: `upstream fetch failed ${upstream.status}` },
					{ status: 502 },
				);
			}

			const contentLength = Number(upstream.headers.get("content-length"));
			if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
				return NextResponse.json({ error: "file too large" }, { status: 413 });
			}

			// Enforce the size cap while streaming too (content-length can be
			// missing or wrong) — abort the stream past the limit.
			let received = 0;
			const limiter = new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					received += chunk.byteLength;
					if (received > MAX_BYTES) {
						controller.error(new Error("response exceeded size limit"));
						return;
					}
					controller.enqueue(chunk);
				},
			});

			return new NextResponse(upstream.body.pipeThrough(limiter), {
				status: 200,
				headers: {
					"Content-Type":
						upstream.headers.get("content-type") ?? "application/octet-stream",
					"Cache-Control": "public, max-age=86400",
				},
			});
		}

		return NextResponse.json({ error: "too many redirects" }, { status: 502 });
	} catch (error) {
		console.error("Sounds proxy error:", error);
		return NextResponse.json({ error: "proxy failed" }, { status: 502 });
	}
}
