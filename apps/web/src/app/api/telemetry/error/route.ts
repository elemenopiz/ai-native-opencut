import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
	MAX_BODY_BYTES,
	clientErrorSchema,
	redactPayload,
} from "@/lib/observability/intake";
import { reportError } from "@/lib/observability/logger";

/**
 * Client-error intake. Browsers (error boundaries, window.onerror,
 * unhandledrejection — see `src/lib/observability/client.ts`) POST here and
 * the payload is relayed into the server observability seam (`reportError`).
 *
 * Unauthenticated on purpose — errors happen logged-out — so it is abuse-safe
 * instead: tight per-IP rate limit, hard body-size cap, strict zod schema,
 * and secret redaction before anything reaches the logs.
 *
 * This route must NEVER 500: it is called from code that is already failing,
 * and an error here would just recurse into more reports.
 */

export const runtime = "nodejs";

export async function POST(request: Request) {
	try {
		const limited = await enforceRateLimit({
			name: "telemetry:error",
			request,
		});
		if (limited) return limited;

		const contentLength = Number(request.headers.get("content-length") ?? 0);
		if (contentLength > MAX_BODY_BYTES) {
			return NextResponse.json({ error: "Payload too large" }, { status: 413 });
		}

		// sendBeacon bodies may arrive without a JSON content-type; read text and
		// parse manually. Re-check the size — content-length can lie or be absent.
		const raw = await request.text();
		if (raw.length > MAX_BODY_BYTES) {
			return NextResponse.json({ error: "Payload too large" }, { status: 413 });
		}

		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
		}

		const parsed = clientErrorSchema.safeParse(json);
		if (!parsed.success) {
			return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
		}

		const clean = redactPayload(parsed.data);
		reportError(
			{ name: clean.name ?? "ClientError", message: clean.message },
			{
				source: "client",
				clientSource: clean.source,
				stack: clean.stack,
				componentStack: clean.componentStack,
				digest: clean.digest,
				route: clean.route,
				userAgent: clean.userAgent,
			},
		);

		return new NextResponse(null, { status: 204 });
	} catch (error) {
		// Never 500 from the error reporter — log locally and accept.
		reportError(error, { source: "server", route: "/api/telemetry/error" });
		return new NextResponse(null, { status: 204 });
	}
}
