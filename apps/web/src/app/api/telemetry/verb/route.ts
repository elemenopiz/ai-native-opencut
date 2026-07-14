import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
	MAX_BODY_BYTES,
	verbTelemetrySchema,
} from "@/lib/mcp/verb-telemetry-intake";
import { recordMcpEvent } from "@/lib/mcp/telemetry";

/**
 * In-app Director agent verb telemetry intake. `verb-telemetry-client.ts`
 * (browser, fire-and-forget sendBeacon/fetch-keepalive) POSTs here after
 * every Director verb call; this route relays into the SAME `recordMcpEvent`
 * writer the external MCP path uses, tagged `source: "agent"` — see
 * `lib/mcp/telemetry.ts`'s module doc for the shared event shape.
 *
 * SESSION-AUTHED (unlike the anonymous `/api/telemetry/error`): the caller is
 * already signed in for the whole editor session, and `userId` is stamped
 * from the session, never trusted from the body. Rate-limited per user via
 * the shared `lib/rate-limit.ts` seam (`telemetry:verb`).
 *
 * Must never surface as a Director-path failure: any unexpected error here
 * degrades to a swallowed 204, same posture as `/api/telemetry/error`. The
 * one exception is auth — a genuinely unauthenticated caller gets a real 401
 * before that catch-all.
 */

export const runtime = "nodejs";

export async function POST(request: Request) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const limited = await enforceRateLimit({
			name: "telemetry:verb",
			request,
			userId: session.user.id,
		});
		if (limited) return limited;

		const contentLength = Number(request.headers.get("content-length") ?? 0);
		if (contentLength > MAX_BODY_BYTES) {
			return NextResponse.json({ error: "Payload too large" }, { status: 413 });
		}

		// sendBeacon bodies may arrive without a JSON content-type; read text and
		// parse manually (same as /api/telemetry/error). Re-check the size —
		// content-length can lie or be absent.
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

		const parsed = verbTelemetrySchema.safeParse(json);
		if (!parsed.success) {
			return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
		}

		recordMcpEvent({
			userId: session.user.id,
			projectId: parsed.data.projectId ?? null,
			event: parsed.data.event,
			verb: parsed.data.verb,
			source: "agent",
			meta: {
				status: parsed.data.status,
				durationMs: parsed.data.durationMs,
				timelineChanged: parsed.data.timelineChanged,
				mutating: parsed.data.mutating,
			},
		});

		return new NextResponse(null, { status: 204 });
	} catch {
		// Never fail the caller from the telemetry intake itself.
		return new NextResponse(null, { status: 204 });
	}
}
