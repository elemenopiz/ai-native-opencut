"use client";

import { useState } from "react";
import Link from "next/link";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	ClockIcon,
	Video02Icon,
	Image02Icon,
	AudioWave01Icon,
	Coins01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
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
	/** Server-resolved type + short display label (`/api/credits/history`
	 *  looks `metadata.backendId` up in the studio backend registry) — e.g.
	 *  `{ kind: "image", label: "Image · Nano Banana Pro" }`. Optional so an
	 *  older cached response (or a future unclassified reason) degrades to the
	 *  bare `reasonLabel` fallback below instead of breaking. */
	kind?: "video" | "image" | "audio" | "grant" | "generation";
	label?: string;
}

/** Human label for a ledger row's reason — mirrors
 *  `components/auth/credits-section.tsx`'s account-page rendering. Fallback
 *  for rows the history route didn't (or couldn't) classify. */
function reasonLabel(reason: string): string {
	switch (reason) {
		case "settle":
			return "Generation";
		case "grant":
		case "admin_grant":
		case "cli_grant":
		case "beta_courtesy":
			return "Credit grant";
		default:
			return reason;
	}
}

/** Small type-specific icon per row `kind` — mirrors the Video/Image/Audio
 *  iconography already used in the Generate panel's segmented control
 *  (`panels/assets/views/generate.tsx`), plus Coins01Icon (credit-balance
 *  pill) for grants, so the history popover reads consistently with the rest
 *  of the editor chrome. */
const KIND_ICON: Record<NonNullable<LedgerEntry["kind"]>, IconSvgElement> = {
	video: Video02Icon,
	image: Image02Icon,
	audio: AudioWave01Icon,
	grant: Coins01Icon,
	generation: SparklesIcon,
};

function iconFor(entry: LedgerEntry): IconSvgElement {
	return KIND_ICON[entry.kind ?? "generation"];
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
									className="flex items-center gap-2 px-3 py-2 text-xs"
								>
									<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
										<HugeiconsIcon icon={iconFor(e)} className="size-3.5" />
									</span>
									<div className="flex min-w-0 flex-1 flex-col">
										<span className="truncate">
											{e.label ?? reasonLabel(e.reason)}
										</span>
										<span className="text-[10px] text-muted-foreground">
											{formatDate(e.createdAt)}
										</span>
									</div>
									<span
										className={
											e.delta >= 0
												? "shrink-0 font-medium tabular-nums text-emerald-600 dark:text-emerald-400"
												: "shrink-0 font-medium tabular-nums text-foreground"
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
