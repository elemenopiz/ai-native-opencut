"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { signIn, signUp } from "@/lib/auth/client";
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

export function AuthForm({
	mode,
	redirectTo = "/projects",
}: {
	mode: "login" | "signup";
	redirectTo?: string;
}) {
	const router = useRouter();
	const isSignup = mode === "signup";

	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSubmitting) return;
		setIsSubmitting(true);

		try {
			const { error } = isSignup
				? await signUp.email({ name: name.trim(), email, password })
				: await signIn.email({ email, password });

			if (error) {
				toast.error(
					isSignup ? "Failed to create account" : "Failed to sign in",
					{
						description:
							error.message ?? "Please check your details and try again",
					},
				);
				return;
			}

			router.push(redirectTo);
			router.refresh();
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
						{isSignup ? "Create your account" : "Welcome back"}
					</CardTitle>
					<CardDescription>
						{isSignup
							? "Sign up to save projects and connect AI agents."
							: "Sign in to continue to your projects."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						{isSignup && (
							<div className="flex flex-col gap-2">
								<Label htmlFor="name">Name</Label>
								<Input
									id="name"
									type="text"
									placeholder="Jane Doe"
									size="lg"
									autoComplete="name"
									required
									value={name}
									onChange={(event) => setName(event.target.value)}
								/>
							</div>
						)}
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
						<div className="flex flex-col gap-2">
							<div className="flex items-center justify-between">
								<Label htmlFor="password">Password</Label>
								{!isSignup && (
									<Link
										href="/forgot-password"
										className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
									>
										Forgot password?
									</Link>
								)}
							</div>
							<Input
								id="password"
								type="password"
								placeholder={
									isSignup ? "At least 8 characters" : "Your password"
								}
								size="lg"
								autoComplete={isSignup ? "new-password" : "current-password"}
								required
								minLength={8}
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								showPassword={showPassword}
								onShowPasswordChange={setShowPassword}
							/>
						</div>
						<Button
							type="submit"
							size="lg"
							disabled={isSubmitting}
							className="mt-2"
						>
							{isSubmitting && <Spinner />}
							{isSignup ? "Create account" : "Sign in"}
						</Button>
					</form>
				</CardContent>
			</Card>
			<p className="text-muted-foreground mt-6 text-sm">
				{isSignup ? (
					<>
						Already have an account?{" "}
						<Link
							href="/login"
							className="text-primary underline-offset-4 hover:underline"
						>
							Sign in
						</Link>
					</>
				) : (
					<>
						Don&apos;t have an account?{" "}
						<Link
							href="/signup"
							className="text-primary underline-offset-4 hover:underline"
						>
							Sign up
						</Link>
					</>
				)}
			</p>
		</div>
	);
}
