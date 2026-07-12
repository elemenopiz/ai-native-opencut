import { NextResponse, type NextRequest } from "next/server";
import { BETA_COOKIE, betaAccessCode } from "@/lib/beta-gate";

/**
 * Closed-beta access gate — the ENTIRE site sits behind a shared 4-digit code
 * so strangers can't create accounts and drain the provider pools. Visitors
 * without the access cookie are sent to /beta-gate, which checks the code
 * server-side (POST /api/beta-gate), sets the cookie, and returns them to
 * where they were headed.
 *
 * Sign-in is deliberately NOT forced here: local editing is free and
 * anonymous once inside the gate. Accounts are only prompted at the money
 * moment — a paid AI action 401s and the client turns that into the
 * "sign up to use AI features" flow (lib/auth/unauthorized.ts).
 *
 * /api/* is excluded by the matcher — API routes carry their own auth and
 * rate limits, and webhooks (Polar) + /api/health must stay reachable.
 */

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

	const cookie = request.cookies.get(BETA_COOKIE)?.value;
	if (cookie !== betaAccessCode()) {
		const gate = new URL("/beta-gate", request.url);
		const returnTo = `${pathname}${request.nextUrl.search}`;
		if (returnTo !== "/") gate.searchParams.set("next", returnTo);
		return NextResponse.redirect(gate);
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
