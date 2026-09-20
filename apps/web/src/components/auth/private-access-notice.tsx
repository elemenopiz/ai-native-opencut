"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { ByornLogo } from "@/components/footer";

/**
 * What a signed-in account that is NOT on `PRIVATE_ACCESS_ALLOWLIST` sees
 * instead of the product, while the site is in private testing.
 *
 * Deliberately says nothing technical: no env var, no allowlist, no provider,
 * no "403". It reads as a product state ("not open yet") rather than a fault,
 * because to the person in front of it that is exactly what it is. The sign-out
 * affordance matters — without it, someone signed in with the wrong account has
 * no way to reach the account that IS allowed.
 */
export function PrivateAccessNotice() {
	const router = useRouter();
	const [isSigningOut, setIsSigningOut] = useState(false);

	async function handleSignOut() {
		if (isSigningOut) return;
		setIsSigningOut(true);
		try {
			await signOut();
			router.push("/login");
			router.refresh();
		} finally {
			setIsSigningOut(false);
		}
	}

	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
			<ByornLogo size={32} />
			<div className="space-y-2">
				<h1 className="text-xl font-semibold">Byorn is in private testing</h1>
				<p className="max-w-sm text-sm text-muted-foreground">
					This account doesn&apos;t have access yet. If you were expecting to
					get in, try the account you were invited on.
				</p>
			</div>
			<Button variant="outline" onClick={handleSignOut} disabled={isSigningOut}>
				{isSigningOut ? "Signing out…" : "Use a different account"}
			</Button>
		</main>
	);
}
