"use client";

import { Suspense } from "react";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export default function ResetPasswordPage() {
	// `ResetPasswordForm` reads the reset token via `useSearchParams`, which must
	// be wrapped in a Suspense boundary in the App Router.
	return (
		<Suspense fallback={<div className="bg-background min-h-screen" />}>
			<ResetPasswordForm />
		</Suspense>
	);
}
