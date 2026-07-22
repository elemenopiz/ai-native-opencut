import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Byorn is a public app. There is no access code and no forced sign-up wall:
 * anonymous visitors can use the whole product — home, the editor, projects,
 * marketing, and legal pages — with no account at all. Sign-in is OPTIONAL,
 * offered where it's useful (saving/syncing a project), never required to
 * try the app.
 *
 * The only pages that require an account are under `/account` — no session
 * cookie there redirects to /login, with a `redirect` return-to param so the
 * user lands back where they started once signed in.
 *
 * AI features (generate, chat, credits, ...) are NOT gated here — that
 * happens separately, server-side, per API route. This check is OPTIMISTIC
 * (cookie presence, edge-safe, no DB hit): a forged cookie can get past this
 * redirect, but it still can't reach data or paid actions, because every
 * gated API route independently verifies the session server-side and 401s
 * on its own.
 *
 * /api/* is excluded by the matcher below — API routes carry their own auth
 * and rate limits, and webhooks (Polar) + /api/health must stay reachable.
 */

// Pages that require a signed-in account. Everything else is public.
const ACCOUNT_ONLY_PREFIXES = ["/account"];

// The e2e runner drives the app with no cookies; same flag that gates the
// E2EBridge. Never set in real deployments.
const E2E_BUILD = process.env.NEXT_PUBLIC_E2E === "1";

export async function proxy(request: NextRequest) {
	if (E2E_BUILD) return NextResponse.next();

	const { pathname } = request.nextUrl;

	const accountOnly = ACCOUNT_ONLY_PREFIXES.some(
		(p) => pathname === p || pathname.startsWith(`${p}/`),
	);
	if (accountOnly && !getSessionCookie(request)) {
		const login = new URL("/login", request.url);
		const returnTo = `${pathname}${request.nextUrl.search}`;
		if (returnTo !== "/") login.searchParams.set("redirect", returnTo);
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
