"use client";

import { useState } from "react";
import { toast } from "sonner";
import { sendVerificationEmail, useSession } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

/**
 * Shown on the account page for signed-in users whose email isn't verified yet.
 * Offers a one-click "resend verification email" action. Renders nothing when
 * the user is verified (or the session is still loading), so it's safe to drop
 * in unconditionally.
 */
export function VerifyEmailBanner() {
	const { data: session } = useSession();
	const [isSending, setIsSending] = useState(false);

	const user = session?.user;
	if (!user || user.emailVerified) return null;

	const handleResend = async () => {
		if (isSending) return;
		setIsSending(true);
		try {
			const { error } = await sendVerificationEmail({
				email: user.email,
				callbackURL: "/account",
			});
			if (error) {
				toast.error("Couldn't send verification email", {
					description: error.message ?? "Please try again",
				});
				return;
			}
			toast.success("Verification email sent", {
				description: `Check ${user.email} for the verification link.`,
			});
		} catch (error) {
			toast.error("Something went wrong", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		} finally {
			setIsSending(false);
		}
	};

	return (
		<Card className="border-amber-500/30 bg-amber-500/5">
			<CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex flex-col gap-1">
					<p className="text-sm font-semibold">Verify your email</p>
					<p className="text-muted-foreground text-sm">
						Confirm {user.email} to secure your account.
					</p>
				</div>
				<Button
					variant="outline"
					onClick={handleResend}
					disabled={isSending}
					className="shrink-0"
				>
					{isSending && <Spinner />}
					Resend verification email
				</Button>
			</CardContent>
		</Card>
	);
}
