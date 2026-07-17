import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { BETA_COOKIE, betaAccessCode } from "@/lib/beta-gate";

/**
 * Closed-beta access-code check. The code is compared SERVER-side so it never
 * ships in the client bundle; on success the access cookie is set (httpOnly —
 * the proxy reads it from the request, the browser never needs to) and the
 * client reloads into the site. Per-IP rate-limited: a 4-digit code is only
 * secretive because guessing is capped.
 */

/**
 * Constant-time string comparison — a plain `!==` leaks byte-position
 * mismatch timing, unnecessary attack surface even behind the per-IP rate
 * limit above. Length is checked first (cheap, and not itself a useful
 * timing oracle for a fixed-format code) because `timingSafeEqual` throws on
 * unequal-length buffers rather than returning false.
 */
function constantTimeEquals(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export async function POST(req: Request) {
	const limited = await enforceRateLimit({ name: "beta:gate", request: req });
	if (limited) return limited;

	const body = (await req.json().catch(() => null)) as { code?: string } | null;
	const code = body?.code?.trim();
	const expected = betaAccessCode();

	if (!code || !constantTimeEquals(code, expected)) {
		return NextResponse.json({ error: "invalid_code" }, { status: 401 });
	}

	const res = NextResponse.json({ ok: true });
	res.cookies.set(BETA_COOKIE, expected, {
		httpOnly: true,
		sameSite: "lax",
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge: 60 * 60 * 24 * 365, // the whole beta and then some
	});
	return res;
}
