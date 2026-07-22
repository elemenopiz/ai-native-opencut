/**
 * GET /api/ai-access — unauthenticated probe the client uses to know, before
 * ever hitting a paid route, whether the current visitor (signed in or not)
 * has AI access. See `lib/ai-access.ts` for the access model.
 *
 * Never requires a session and never 401s: an anonymous visitor is a normal,
 * expected caller here (not an error case) and gets
 * `{ signedIn: false, aiAccess: false }`. Any unexpected failure (a session
 * lookup error, etc.) degrades to the same anonymous/no-access shape rather
 * than surfacing a 500 — this route only ever informs UI, so failing closed
 * and quiet is safer than failing loud.
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { hasAiAccess } from "@/lib/ai-access";

export async function GET() {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		return NextResponse.json({
			signedIn: Boolean(session?.user),
			aiAccess: hasAiAccess(session?.user ?? null),
		});
	} catch {
		return NextResponse.json({ signedIn: false, aiAccess: false });
	}
}
