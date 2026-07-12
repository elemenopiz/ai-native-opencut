"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";

/**
 * Mirrors /login's `?redirect=` handling (same-origin relative paths only) so
 * the sign-up-at-the-money-moment flow can return the user to the editor they
 * were generating in.
 */
function safeRedirect(target: string | null): string | undefined {
	if (!target || !target.startsWith("/") || target.startsWith("//")) {
		return undefined;
	}
	return target;
}

function SignupForm() {
	const params = useSearchParams();
	return (
		<AuthForm mode="signup" redirectTo={safeRedirect(params.get("redirect"))} />
	);
}

export default function SignupPage() {
	// useSearchParams needs a Suspense boundary during prerender.
	return (
		<Suspense fallback={null}>
			<SignupForm />
		</Suspense>
	);
}
