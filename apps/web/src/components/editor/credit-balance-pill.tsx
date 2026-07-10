"use client";

import { useEffect } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Coins01Icon } from "@hugeicons/core-free-icons";
import { useSession } from "@/lib/auth/client";
import { cn } from "@/utils/ui";
import { LOW_CREDIT_THRESHOLD, useCreditsStore } from "@/stores/credits-store";

/**
 * Header balance pill — shows the signed-in user's spendable credits next to the
 * account menu. Amber when low (< LOW_CREDIT_THRESHOLD). Links to the account
 * page's Credits section. Hidden while signed out (nothing to meter).
 */
export function CreditBalancePill() {
	const { data: session, isPending } = useSession();
	const spendable = useCreditsStore((s) => s.spendable);
	const loaded = useCreditsStore((s) => s.loaded);
	const refresh = useCreditsStore((s) => s.refresh);

	const signedIn = Boolean(session?.user);

	useEffect(() => {
		if (signedIn) void refresh();
	}, [signedIn, refresh]);

	if (isPending || !signedIn) return null;

	const low = loaded && spendable < LOW_CREDIT_THRESHOLD;

	return (
		<Link
			href="/account#credits"
			title="Your credit balance"
			className={cn(
				"flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
				low
					? "border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
					: "border-border bg-background text-foreground hover:bg-accent",
			)}
		>
			<HugeiconsIcon icon={Coins01Icon} className="size-3.5" />
			<span className="tabular-nums">{loaded ? spendable : "—"}</span>
		</Link>
	);
}
