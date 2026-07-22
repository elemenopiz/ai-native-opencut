"use client";

import { useEffect } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Coins01Icon } from "@hugeicons/core-free-icons";
import { useAiAccess } from "@/hooks/use-ai-access";
import { cn } from "@/utils/ui";
import { LOW_CREDIT_THRESHOLD, useCreditsStore } from "@/stores/credits-store";

/**
 * Header balance pill — shows the signed-in user's spendable credits next to the
 * account menu. Amber when low (< LOW_CREDIT_THRESHOLD). Links to the account
 * page's Credits section. Hidden for anyone without AI access — signed out, or
 * signed in without the early-access/owner entitlement — since there's nothing
 * to meter (credits only apply to accounts that can spend them on AI).
 */
export function CreditBalancePill() {
	const { aiAccess, loading } = useAiAccess();
	const spendable = useCreditsStore((s) => s.spendable);
	const loaded = useCreditsStore((s) => s.loaded);
	const refresh = useCreditsStore((s) => s.refresh);

	useEffect(() => {
		if (aiAccess) void refresh();
	}, [aiAccess, refresh]);

	if (loading || !aiAccess) return null;

	const low = loaded && spendable < LOW_CREDIT_THRESHOLD;

	return (
		<Link
			href="/account#credits"
			title="Your credit balance"
			className={cn(
				"flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
				low
					? // `dark:` pair folded — forcedTheme="dark" means the base half of
						// `text-amber-600 dark:text-amber-400` never rendered. Routed
						// through the shared warning status tone.
						"border-amber-500/40 bg-amber-500/10 text-tone-warning hover:bg-amber-500/20"
					: "border-border bg-background text-foreground hover:bg-accent",
			)}
		>
			<HugeiconsIcon icon={Coins01Icon} className="size-3.5" />
			<span className="tabular-nums">{loaded ? spendable : "—"}</span>
		</Link>
	);
}
