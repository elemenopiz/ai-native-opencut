import { NextResponse } from "next/server";

/**
 * Streams a remote generated-video URL through our own origin so the browser
 * can turn it into a File/Blob without tripping over the provider's CORS policy.
 * Only used to import a finished take onto the timeline.
 */
export async function GET(req: Request) {
	const { searchParams } = new URL(req.url);
	const url = searchParams.get("url");

	if (!url) {
		return NextResponse.json({ error: "url is required" }, { status: 400 });
	}

	// Guard against SSRF — only allow http(s) absolute URLs.
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return NextResponse.json({ error: "invalid url" }, { status: 400 });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return NextResponse.json({ error: "unsupported protocol" }, { status: 400 });
	}

	try {
		const upstream = await fetch(parsed.toString());
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
