"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { resetPassword } from "@/lib/auth/client";
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

export function ResetPasswordForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	// better-auth appends the reset token to the redirect URL as `?token=`.
	// If the token is missing or invalid it uses `?error=INVALID_TOKEN`.
	const token = searchParams.get("token");
	const tokenError = searchParams.get("error");

	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const invalidToken = !token || tokenError !== null;

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSubmitting || !token) return;

		if (password !== confirmPassword) {
			toast.error("Passwords don't match", {
				description: "Please make sure both fields are the same.",
			});
			return;
		}

		setIsSubmitting(true);
		try {
			const { error } = await resetPassword({ newPassword: password, token });

			if (error) {
				toast.error("Couldn't reset password", {
					description:
						error.message ?? "Your reset link may have expired. Try again.",
				});
				return;
			}

			toast.success("Password updated", {
				description: "You can now sign in with your new password.",
			});
			router.push("/login");
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
						{invalidToken ? "Invalid or expired link" : "Choose a new password"}
					</CardTitle>
					<CardDescription>
						{invalidToken
							? "This password reset link is no longer valid. Request a new one to continue."
							: "Enter a new password for your account."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{invalidToken ? (
						<Button asChild size="lg" className="w-full">
							<Link href="/forgot-password">Request a new link</Link>
						</Button>
					) : (
						<form onSubmit={handleSubmit} className="flex flex-col gap-4">
							<div className="flex flex-col gap-2">
								<Label htmlFor="password">New password</Label>
								<Input
									id="password"
									type="password"
									placeholder="At least 8 characters"
									size="lg"
									autoComplete="new-password"
									required
									minLength={8}
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									showPassword={showPassword}
									onShowPasswordChange={setShowPassword}
								/>
							</div>
							<div className="flex flex-col gap-2">
								<Label htmlFor="confirmPassword">Confirm new password</Label>
								<Input
									id="confirmPassword"
									type="password"
									placeholder="Re-enter your new password"
									size="lg"
									autoComplete="new-password"
									required
									minLength={8}
									value={confirmPassword}
									onChange={(event) => setConfirmPassword(event.target.value)}
								/>
							</div>
							<Button
								type="submit"
								size="lg"
								disabled={isSubmitting}
								className="mt-2"
							>
								{isSubmitting && <Spinner />}
								Update password
							</Button>
						</form>
					)}
				</CardContent>
			</Card>
			<p className="text-muted-foreground mt-6 text-sm">
				<Link
					href="/login"
					className="text-primary underline-offset-4 hover:underline"
				>
					Back to sign in
				</Link>
			</p>
		</div>
	);
}
