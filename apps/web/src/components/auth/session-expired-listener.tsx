"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { UNAUTHORIZED_EVENT } from "@/lib/auth/unauthorized";

/**
 * Mounted once in the root layout. Listens for the global `byorn:unauthorized`
 * event that {@link handleUnauthorized} dispatches on any 401 and sends the user
 * to `/login`, preserving the current location (path + query) as the post-login
 * return path. Skips the redirect when already on an auth page so a 401 there
 * can't loop.
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
