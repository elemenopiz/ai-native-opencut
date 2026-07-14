"use client";

import { useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ClockIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useSession } from "@/lib/auth/client";

interface LedgerEntry {
	id: string;
	delta: number;
	balanceAfter: number;
	reason: string;
	refType: string | null;
	refId: string | null;
	createdAt: string;
}

/** Human label for a ledger row's reason — mirrors
 *  `components/auth/credits-section.tsx`'s account-page rendering. */
function reasonLabel(reason: string): string {
	switch (reason) {
		case "settle":
			return "Generation";
		case "grant":
		case "admin_grant":
		case "cli_grant":
			return "Credit grant";
		default:
			return reason;
	}
}

function formatDate(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? "—"
		: d.toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			});
}

/**
 * Header credit-history icon-button — sits beside `CreditBalancePill`. Opens a
 * popover listing the signed-in user's most recent credit ledger entries (GET
 * /api/credits/history, same endpoint the account page's `CreditsSection`
 * reads). Fetches lazily on first open rather than on mount, since most
 * sessions never open it. Hidden while signed out.
 */
export function CreditHistoryButton() {
	const { data: session, isPending } = useSession();
	const [open, setOpen] = useState(false);
	const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fetchedOnce, setFetchedOnce] = useState(false);

	const signedIn = Boolean(session?.user);

	async function load() {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/credits/history?limit=10");
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			const json = (await res.json()) as { entries: LedgerEntry[] };
			setEntries(json.entries);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load history");
		} finally {
			setLoading(false);
			setFetchedOnce(true);
		}
	}

	if (isPending || !signedIn) return null;

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next && !fetchedOnce) void load();
			}}
		>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					className="h-8 w-8"
					title="Credit history"
				>
					<HugeiconsIcon icon={ClockIcon} className="size-3.5" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-0">
				<div className="border-b px-3 py-2 text-xs font-medium">
					Credit history
				</div>
				<div className="max-h-72 overflow-y-auto">
					{loading ? (
						<div className="px-3 py-6 text-center text-xs text-muted-foreground">
							Loading…
						</div>
					) : error ? (
						<div className="px-3 py-6 text-center text-xs text-destructive">
							{error}
						</div>
					) : !entries || entries.length === 0 ? (
						<div className="px-3 py-6 text-center text-xs text-muted-foreground">
							No credit activity yet.
						</div>
					) : (
						<ul className="divide-y divide-border/50">
							{entries.map((e) => (
								<li
									key={e.id}
									className="flex items-center justify-between px-3 py-2 text-xs"
								>
									<div className="flex flex-col">
										<span>{reasonLabel(e.reason)}</span>
										<span className="text-[10px] text-muted-foreground">
											{formatDate(e.createdAt)}
										</span>
									</div>
									<span
										className={
											e.delta >= 0
												? "font-medium tabular-nums text-emerald-600 dark:text-emerald-400"
												: "font-medium tabular-nums text-foreground"
										}
									>
										{e.delta >= 0 ? `+${e.delta}` : e.delta}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
				<div className="border-t px-3 py-2">
					<Link
						href="/account#credits"
						className="text-[11px] text-muted-foreground hover:text-foreground"
						onClick={() => setOpen(false)}
					>
						View full history →
					</Link>
				</div>
			</PopoverContent>
		</Popover>
	);
}
