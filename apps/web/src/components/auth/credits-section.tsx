"use client";

import { useEffect, useState } from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface LedgerEntry {
	id: string;
	delta: number;
	balanceAfter: number;
	reason: string;
	refType: string | null;
	refId: string | null;
	createdAt: string;
}

interface HistoryResponse {
	balance: number;
	reserved: number;
	spendable: number;
	entries: LedgerEntry[];
}

/** Human label for a ledger row's reason. */
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
 * Account-page Credits section: current balance + recent ledger history. Reads
 * the session-gated GET /api/credits/history. Anchored at #credits so the header
 * balance pill can deep-link here.
 */
export function CreditsSection() {
	const [data, setData] = useState<HistoryResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch("/api/credits/history?limit=25");
				if (!res.ok) throw new Error(`Failed to load (${res.status})`);
				const json = (await res.json()) as HistoryResponse;
				if (!cancelled) setData(json);
			} catch (err) {
				if (!cancelled) {
					setError(
						err instanceof Error ? err.message : "Failed to load credits",
					);
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<Card id="credits" className="scroll-mt-20">
			<CardHeader>
				<CardTitle>Credits</CardTitle>
				<CardDescription>
					Credits pay for cloud generation. Local editing is always free.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				{loading ? (
					<>
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-24 w-full" />
					</>
				) : error ? (
					<div className="text-sm text-destructive">{error}</div>
				) : data ? (
					<>
						<div className="flex flex-wrap gap-6">
							<Stat label="Spendable" value={data.spendable} emphasize />
							<Stat label="Balance" value={data.balance} />
							<Stat label="On hold" value={data.reserved} />
						</div>

						<div className="flex flex-col gap-2">
							<div className="text-sm font-medium">Recent activity</div>
							{data.entries.length === 0 ? (
								<div className="text-sm text-muted-foreground">
									No credit activity yet.
								</div>
							) : (
								<ul className="divide-y divide-border/50 rounded-md border border-border/50">
									{data.entries.map((e) => (
										<li
											key={e.id}
											className="flex items-center justify-between px-3 py-2 text-sm"
										>
											<div className="flex flex-col">
												<span>{reasonLabel(e.reason)}</span>
												<span className="text-xs text-muted-foreground">
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
					</>
				) : null}
			</CardContent>
		</Card>
	);
}

function Stat({
	label,
	value,
	emphasize,
}: {
	label: string;
	value: number;
	emphasize?: boolean;
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span
				className={
					emphasize
						? "text-2xl font-bold tabular-nums"
						: "text-2xl font-semibold tabular-nums text-muted-foreground"
				}
			>
				{value}
			</span>
		</div>
	);
}
