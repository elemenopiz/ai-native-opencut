import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// DNS resolution + IP-literal parsing require the Node runtime (not Edge).
export const runtime = "nodejs";

/**
 * Streams a remote generated-video URL through our own origin so the browser
 * can turn it into a File/Blob without tripping over the provider's CORS policy.
 * Only used to import a finished take onto the timeline.
 */

/** True for IPs we must never let this proxy reach (SSRF guard). */
function isBlockedIp(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return isBlockedV4(ip);
	if (kind === 6) return isBlockedV6(ip);
	return true; // not a parseable IP → refuse rather than guess
}

function isBlockedV4(ip: string): boolean {
	const p = ip.split(".").map(Number);
	if (
		p.length !== 4 ||
		p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
	) {
		return true;
	}
	const [a, b] = p;
	if (a === 0) return true; // 0.0.0.0/8 "this host"
	if (a === 10) return true; // private
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local (cloud metadata)
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a >= 224) return true; // multicast + reserved (224.0.0.0+)
	return false;
}

function isBlockedV6(ip: string): boolean {
	const addr = ip.toLowerCase().split("%")[0]; // drop zone id
	if (addr === "::" || addr === "::1") return true; // unspecified / loopback
	// IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4.
	const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return isBlockedV4(mapped[1]);
	if (
		addr.startsWith("fe8") ||
		addr.startsWith("fe9") ||
		addr.startsWith("fea") ||
		addr.startsWith("feb")
	) {
		return true; // fe80::/10 link-local
	}
	if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7 ULA
	return false;
}

/** Resolve the host and refuse if it (or any of its addresses) is private. */
async function assertPublicHost(hostname: string): Promise<void> {
	const host = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
	if (isIP(host)) {
		if (isBlockedIp(host)) throw new Error("blocked host");
		return;
	}
	// Hostname → resolve every A/AAAA record and check them all.
	const records = await lookup(host, { all: true });
	if (records.length === 0 || records.some((r) => isBlockedIp(r.address))) {
		throw new Error("blocked host");
	}
}

export async function GET(req: Request) {
	const { searchParams } = new URL(req.url);
	const url = searchParams.get("url");

	if (!url) {
		return NextResponse.json({ error: "url is required" }, { status: 400 });
	}

	// Guard against SSRF — only allow http(s) absolute URLs to PUBLIC hosts.
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return NextResponse.json({ error: "invalid url" }, { status: 400 });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return NextResponse.json(
			{ error: "unsupported protocol" },
			{ status: 400 },
		);
	}
	try {
		await assertPublicHost(parsed.hostname);
	} catch {
		return NextResponse.json(
			{ error: "url resolves to a disallowed host" },
			{ status: 400 },
		);
	}

	try {
		// `redirect: "manual"` so a public URL can't 302 us onto an internal host,
		// bypassing the check above. Legitimate provider/R2 URLs are direct 200s.
		const upstream = await fetch(parsed.toString(), { redirect: "manual" });
		if (upstream.status >= 300 && upstream.status < 400) {
			return NextResponse.json(
				{ error: "redirects are not allowed" },
				{ status: 502 },
			);
		}
		if (!upstream.ok || !upstream.body) {
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
