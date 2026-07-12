import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { BETA_COOKIE, betaAccessCode } from "@/lib/beta-gate";

/**
 * Closed-beta double door, checked in order on every page request:
 *
 *  1. ACCESS GATE — the entire site sits behind a shared 4-digit code so
 *     strangers can't create accounts and drain the provider pools. Visitors
 *     without the access cookie go to /beta-gate, which checks the code
 *     server-side (POST /api/beta-gate) and mints the httpOnly cookie.
 *  2. AUTH WALL — once inside the gate, everything requires an account:
 *     no session cookie → /signup (sign-in is one click from there). Only the
 *     auth pages themselves and the legal pages (readable before consenting
 *     to an account) are exempt.
 *
 * The session check is OPTIMISTIC (cookie presence, edge-safe, no DB hit) —
 * real validation stays where it always was: every paid/gated API route
 * verifies the session server-side and 401s. A forged cookie gets past the
 * redirect but can't reach data or paid actions.
 *
 * /api/* is excluded by the matcher — API routes carry their own auth and
 * rate limits, and webhooks (Polar) + /api/health must stay reachable.
 */

// Reachable inside the gate without a session: the auth flow itself + legal.
const AUTH_EXEMPT_PREFIXES = [
	"/login",
	"/signup",
	"/forgot-password",
	"/reset-password",
	"/terms",
	"/privacy",
];

// The e2e runner drives the app with no cookies; same flag that gates the
// E2EBridge. Never set in real deployments.
const E2E_BUILD = process.env.NEXT_PUBLIC_E2E === "1";

export async function proxy(request: NextRequest) {
	if (E2E_BUILD) return NextResponse.next();

	const { pathname } = request.nextUrl;

	// The gate page itself, and any static asset (has a file extension —
	// logos, og images, sitemap.xml, robots.txt), stay reachable.
	if (pathname.startsWith("/beta-gate") || /\.[a-zA-Z0-9]+$/.test(pathname)) {
		return NextResponse.next();
	}

	// Door 1: the shared beta code.
	const beta = request.cookies.get(BETA_COOKIE)?.value;
	if (beta !== betaAccessCode()) {
		const gate = new URL("/beta-gate", request.url);
		const returnTo = `${pathname}${request.nextUrl.search}`;
		if (returnTo !== "/") gate.searchParams.set("next", returnTo);
		return NextResponse.redirect(gate);
	}

	// Door 2: an account.
	const authExempt = AUTH_EXEMPT_PREFIXES.some(
		(p) => pathname === p || pathname.startsWith(`${p}/`),
	);
	if (!authExempt && !getSessionCookie(request)) {
		const signup = new URL("/signup", request.url);
		const returnTo = `${pathname}${request.nextUrl.search}`;
		if (returnTo !== "/") signup.searchParams.set("redirect", returnTo);
		return NextResponse.redirect(signup);
	}

	return NextResponse.next();
}

export const config = {
	matcher: [
		/*
		 * Match all request paths except for the ones starting with:
		 * - api (API routes)
		 * - _next/static (static files)
		 * - _next/image (image optimization files)
		 * - favicon.ico (favicon file)
		 */
		"/((?!api|_next/static|_next/image|favicon.ico).*)",
	],
};
