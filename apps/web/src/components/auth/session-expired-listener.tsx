"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { UNAUTHORIZED_EVENT } from "@/lib/auth/unauthorized";

/**
 * Mounted once in the root layout. Listens for the global `byorn:unauthorized`
 * event that {@link handleUnauthorized} dispatches on a prompt-mode 401 (not a
 * silent one — background hydration calls opt into "silent" precisely so they
 * never reach this listener, see unauthorized.ts) and sends the user to
 * `/login`. The app is public with optional sign-in, so a prompt-mode 401 means
 * a signed-out visitor tried an account-gated action; existing users sign in
 * there to continue (AI features are for existing accounts — see lib/ai-access.ts),
 * and new visitors can reach signup from the form. Preserves the current
 * location (path + query) as the post-auth return path. Skips the redirect when
 * already on an auth page so a 401 there can't loop.
 */
export function SessionExpiredListener() {
	const router = useRouter();
	const pathname = usePathname();

	useEffect(() => {
		const onUnauthorized = () => {
			if (pathname === "/login" || pathname === "/signup") return;
			const returnTo = `${window.location.pathname}${window.location.search}`;
			router.push(`/login?redirect=${encodeURIComponent(returnTo)}`);
		};
		window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
		return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
	}, [router, pathname]);

	return null;
}
