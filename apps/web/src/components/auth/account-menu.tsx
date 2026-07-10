"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Logout05Icon,
	Settings01Icon,
	UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { signOut, useSession } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function getInitials(name?: string | null, email?: string | null): string {
	const source = name?.trim() || email?.trim() || "";
	if (!source) return "?";
	const parts = source.split(/\s+/);
	if (parts.length >= 2) {
		return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
	}
	return source.slice(0, 2).toUpperCase();
}

export function AccountMenu() {
	const { data: session, isPending } = useSession();
	const router = useRouter();
	const [isSigningOut, setIsSigningOut] = useState(false);

	// Avoid a login/account flash before the session resolves.
	if (isPending) return null;

	if (!session?.user) {
		return (
			<Link href="/login">
				<Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
					<HugeiconsIcon icon={UserCircleIcon} className="size-3.5" />
					Log in
				</Button>
			</Link>
		);
	}

	const { name, email } = session.user;

	const handleSignOut = async () => {
		if (isSigningOut) return;
		setIsSigningOut(true);
		try {
			await signOut();
			router.push("/login");
			router.refresh();
		} catch (error) {
			toast.error("Failed to sign out", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
			setIsSigningOut(false);
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-8 rounded-full p-0"
					aria-label="Account menu"
				>
					<Avatar className="size-8">
						<AvatarFallback className="text-xs font-medium">
							{getInitials(name, email)}
						</AvatarFallback>
					</Avatar>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="z-100 w-56">
				<div className="flex flex-col gap-0.5 px-2 py-1.5">
					{name && <span className="text-sm font-medium truncate">{name}</span>}
					<span className="text-xs text-muted-foreground truncate">
						{email}
					</span>
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					asChild
					icon={<HugeiconsIcon icon={Settings01Icon} />}
				>
					<Link href="/account">Account settings</Link>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					variant="destructive"
					onClick={handleSignOut}
					disabled={isSigningOut}
					icon={<HugeiconsIcon icon={Logout05Icon} />}
				>
					Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
