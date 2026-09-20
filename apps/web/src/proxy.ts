import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import {
	isPrivateAccessEnabled,
	isPrivateAccessPublicPath,
} from "@/lib/private-access";

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

	// Private-testing lock (`PRIVATE_ACCESS_ALLOWLIST`). Unset → this block is
	// inert and the app stays public, exactly as documented above. Set → every
	// page except the auth screens needs a session, or nobody locked out could
	// ever sign in as someone who is allowed. This is the OPTIMISTIC half: the
	// edge has no session to read an email from, so the authoritative email
	// check lives in the root layout. See `lib/private-access.ts`.
	if (
		isPrivateAccessEnabled() &&
		!isPrivateAccessPublicPath(pathname) &&
		!getSessionCookie(request)
	) {
		const login = new URL("/login", request.url);
		const returnTo = `${pathname}${request.nextUrl.search}`;
		if (returnTo !== "/") login.searchParams.set("redirect", returnTo);
		return NextResponse.redirect(login);
	}

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
