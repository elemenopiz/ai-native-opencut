"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";

export interface AiAccessNoticeProps {
	signedIn: boolean;
	aiAccess: boolean;
	/** Pass `useAiAccess()`'s `loading` to suppress the notice until the first
	 *  fetch settles — avoids a flash of "sign in" for a soon-to-be-`true`
	 *  `aiAccess` while the underlying action stays disabled either way. */
	loading?: boolean;
	className?: string;
}

/**
 * Friendly inline notice for an AI surface the current visitor can't use —
 * standing in for a raw 401/403 per the "no errors to customers" rule.
 * Renders nothing once `aiAccess` is true (or while still `loading`), so it's
 * safe to drop in unconditionally next to any AI action.
 *
 *  - Anonymous (`!signedIn`): a one-click path to sign in.
 *  - Signed in but not entitled (early-access accounts only): an explanatory
 *    note with no sign-in button, since signing in again wouldn't change
 *    anything for this account.
 */
export function AiAccessNotice({
	signedIn,
	aiAccess,
	loading,
	className,
}: AiAccessNoticeProps) {
	if (aiAccess || loading) return null;

	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-foreground/[0.14] bg-foreground/[0.02] px-3 py-2.5",
				className,
			)}
		>
			<p className="text-xs leading-relaxed text-muted-foreground">
				{signedIn
					? "AI features are available to early-access members."
					: "Sign in to use AI features"}
			</p>
			{!signedIn && (
				<Button
					asChild
					size="sm"
					variant="outline"
					className="shrink-0 text-xs"
				>
					<Link href="/login">Sign in</Link>
				</Button>
			)}
		</div>
	);
}
