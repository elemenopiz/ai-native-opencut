"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { SUBSCRIPTION_TIERS, TOP_UP_PACKS } from "@/lib/payments/catalog";

/**
 * Buy-credits modal: one-time top-up packs + recurring subscription tiers. Each
 * button POSTs to the session-gated POST /api/credits/checkout with its
 * packKey/tierKey and redirects the browser to the returned Polar checkout URL.
 *
 * Controlled (open / onOpenChange) so it can be opened from the account page's
 * Credits section AND from the "Out of credits" modal's Top-up button.
 */
export function BuyCreditsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	// Which entry's checkout is in flight (disables its button, shows "Redirecting…").
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function startCheckout(
		selection: { packKey: string } | { tierKey: string },
		id: string,
	) {
		setPending(id);
		setError(null);
		try {
			const res = await fetch("/api/credits/checkout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(selection),
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				setError(
					data.error === "payments_not_configured"
						? "Payments aren't available yet. Please check back soon."
						: "Couldn't start checkout. Please try again.",
				);
				setPending(null);
				return;
			}
			const { url } = (await res.json()) as { url: string };
			// Hand off to Polar's hosted checkout.
			window.location.href = url;
		} catch {
			setError("Couldn't start checkout. Please try again.");
			setPending(null);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Buy credits</DialogTitle>
					<DialogDescription>
						Credits pay for cloud generation. Local editing is always free.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="gap-6">
					{error ? (
						<div className="text-sm text-destructive">{error}</div>
					) : null}

					<section className="flex flex-col gap-3">
						<h3 className="text-sm font-medium">One-time top-up</h3>
						<div className="flex flex-col gap-2">
							{TOP_UP_PACKS.map((pack) => (
								<div
									key={pack.key}
									className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2"
								>
									<div className="flex flex-col">
										<span className="text-sm font-medium">{pack.label}</span>
										<span className="text-xs text-muted-foreground">
											{pack.description}
										</span>
									</div>
									<Button
										size="sm"
										disabled={pending !== null}
										onClick={() =>
											startCheckout({ packKey: pack.key }, pack.key)
										}
									>
										{pending === pack.key ? "Redirecting…" : "Buy"}
									</Button>
								</div>
							))}
						</div>
					</section>

					<section className="flex flex-col gap-3">
						<h3 className="text-sm font-medium">Monthly subscription</h3>
						<div className="flex flex-col gap-2">
							{SUBSCRIPTION_TIERS.map((tier) => (
								<div
									key={tier.key}
									className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2"
								>
									<div className="flex flex-col">
										<span className="text-sm font-medium">{tier.label}</span>
										<span className="text-xs text-muted-foreground">
											{tier.description}
										</span>
									</div>
									<Button
										size="sm"
										variant="secondary"
										disabled={pending !== null}
										onClick={() =>
											startCheckout({ tierKey: tier.key }, tier.key)
										}
									>
										{pending === tier.key ? "Redirecting…" : "Subscribe"}
									</Button>
								</div>
							))}
						</div>
					</section>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
