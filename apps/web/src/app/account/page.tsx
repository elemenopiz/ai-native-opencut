"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { useSession } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { DeleteAccountDialog } from "@/components/auth/delete-account-dialog";
import { CreditsSection } from "@/components/auth/credits-section";
import { VerifyEmailBanner } from "@/components/auth/verify-email-banner";

export default function AccountPage() {
	const { data: session, isPending } = useSession();
	const router = useRouter();
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

	// Guard the page: send signed-out visitors to login once the session resolves.
	useEffect(() => {
		if (!isPending && !session?.user) {
			router.replace("/login");
		}
	}, [isPending, session, router]);

	return (
		<div className="bg-background min-h-screen">
			<header className="sticky top-0 z-20 bg-background px-8">
				<div className="flex h-16 items-center pt-2">
					<Link href="/projects">
						<Button variant="text" className="text-muted-foreground gap-2 pl-0">
							<HugeiconsIcon icon={ArrowLeft02Icon} className="size-4" />
							Back to projects
						</Button>
					</Link>
				</div>
			</header>
			<main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 pt-6 pb-24">
				<div className="flex flex-col gap-2">
					<h1 className="text-2xl font-bold tracking-tight">Account</h1>
					<p className="text-muted-foreground">
						Manage your account details and sign-in.
					</p>
				</div>

				<VerifyEmailBanner />

				<Card>
					<CardHeader>
						<CardTitle>Profile</CardTitle>
						<CardDescription>
							The details associated with your account.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						{isPending || !session?.user ? (
							<>
								<Skeleton className="h-10 w-full" />
								<Skeleton className="h-10 w-full" />
							</>
						) : (
							<>
								<div className="flex flex-col gap-1.5">
									<Label>Name</Label>
									<div className="text-sm">{session.user.name || "—"}</div>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label>Email</Label>
									<div className="text-sm">{session.user.email}</div>
								</div>
							</>
						)}
					</CardContent>
				</Card>

				{isPending || !session?.user ? null : <CreditsSection />}

				<Card className="border-destructive/30">
					<CardHeader>
						<CardTitle className="text-destructive">Danger zone</CardTitle>
						<CardDescription>
							Permanently delete your account and all associated data. This
							cannot be undone.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Button
							variant="destructive"
							onClick={() => setIsDeleteDialogOpen(true)}
							disabled={isPending || !session?.user}
						>
							Delete account
						</Button>
					</CardContent>
				</Card>
			</main>

			<DeleteAccountDialog
				isOpen={isDeleteDialogOpen}
				onOpenChange={setIsDeleteDialogOpen}
			/>
		</div>
	);
}
