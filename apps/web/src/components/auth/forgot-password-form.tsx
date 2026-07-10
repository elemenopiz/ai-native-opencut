"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { requestPasswordReset } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ByornLogo } from "@/components/footer";

export function ForgotPasswordForm() {
	const [email, setEmail] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isSent, setIsSent] = useState(false);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSubmitting) return;
		setIsSubmitting(true);

		try {
			const { error } = await requestPasswordReset({
				email,
				redirectTo: "/reset-password",
			});

			if (error) {
				toast.error("Couldn't send reset email", {
					description: error.message ?? "Please try again",
				});
				return;
			}

			// The API responds success even when the email doesn't exist (to avoid
			// leaking which addresses are registered), so always show confirmation.
			setIsSent(true);
		} catch (error) {
			toast.error("Something went wrong", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div className="bg-background flex min-h-screen flex-col items-center justify-center px-6 py-12">
			<Link href="/" className="mb-8 flex items-center gap-3">
				<ByornLogo size={36} />
				<span className="text-base font-bold tracking-tight">Byorn</span>
			</Link>
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="text-xl">
						{isSent ? "Check your email" : "Reset your password"}
					</CardTitle>
					<CardDescription>
						{isSent
							? `If an account exists for ${email}, we've sent a link to reset your password.`
							: "Enter your email and we'll send you a link to reset your password."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{isSent ? (
						<div className="flex flex-col gap-4">
							<p className="text-muted-foreground text-sm">
								Didn't get it? Check your spam folder, or{" "}
								<button
									type="button"
									className="text-primary underline-offset-4 hover:underline"
									onClick={() => setIsSent(false)}
								>
									try a different email
								</button>
								.
							</p>
							<Button asChild size="lg" variant="outline">
								<Link href="/login">Back to sign in</Link>
							</Button>
						</div>
					) : (
						<form onSubmit={handleSubmit} className="flex flex-col gap-4">
							<div className="flex flex-col gap-2">
								<Label htmlFor="email">Email</Label>
								<Input
									id="email"
									type="email"
									placeholder="you@example.com"
									size="lg"
									autoComplete="email"
									required
									value={email}
									onChange={(event) => setEmail(event.target.value)}
								/>
							</div>
							<Button
								type="submit"
								size="lg"
								disabled={isSubmitting}
								className="mt-2"
							>
								{isSubmitting && <Spinner />}
								Send reset link
							</Button>
						</form>
					)}
				</CardContent>
			</Card>
			<p className="text-muted-foreground mt-6 text-sm">
				Remember your password?{" "}
				<Link
					href="/login"
					className="text-primary underline-offset-4 hover:underline"
				>
					Sign in
				</Link>
			</p>
		</div>
	);
}
