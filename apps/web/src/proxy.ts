import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Private-beta auth wall. The app surfaces (projects, editor, account) require
 * a signed-in user; marketing pages and the auth pages themselves stay public.
 *
 * This is the OPTIMISTIC gate — it only checks that a better-auth session
 * cookie exists (edge-safe, no DB hit) and bounces cookie-less visitors to
 * /login with the intended destination preserved. Real session validation
 * still happens where it always has: every paid/gated API route verifies the
 * session server-side and 401s, which the client turns into the login flow
 * (see lib/auth/unauthorized.ts). A forged cookie gets past this redirect but
 * can't reach any data or paid action.
 */

const GATED_PREFIXES = ["/projects", "/editor", "/account"];

// The e2e runner cannot mint sessions (better-auth's prod-mode rate limiting
// with the runner's unreachable Upstash → auth-flow.e2e self-skips), so the
// smoke suites drive /editor anonymously. Same flag that gates the E2EBridge;
// never set in real deployments.
const E2E_BUILD = process.env.NEXT_PUBLIC_E2E === "1";

export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	const gated =
		!E2E_BUILD &&
		GATED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
	if (gated && !getSessionCookie(request)) {
		const login = new URL("/login", request.url);
		const returnTo = `${pathname}${request.nextUrl.search}`;
		login.searchParams.set("redirect", returnTo);
		return NextResponse.redirect(login);
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
