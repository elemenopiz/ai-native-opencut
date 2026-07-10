"use client";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useCreditsStore } from "@/stores/credits-store";

/**
 * "Out of credits" modal. Opened by the client 402 gate (`gateOn402`) when a
 * paid studio action is blocked for insufficient credits. The top-up CTA is a
 * placeholder this phase — payments land later; balances are seeded via the
 * admin grant path for the soft launch.
 *
 * Rendered once, globally (from the editor header), and driven entirely by the
 * credits store so any studio action can trigger it.
 */
export function OutOfCreditsDialog() {
	const outOfCredits = useCreditsStore((s) => s.outOfCredits);
	const close = useCreditsStore((s) => s.closeOutOfCredits);

	const { open, needed, spendable } = outOfCredits;

	return (
		<Dialog open={open} onOpenChange={(o) => (o ? undefined : close())}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Out of credits</DialogTitle>
				</DialogHeader>
				<DialogBody className="gap-3">
					<p className="text-sm text-muted-foreground">
						This generation needs{" "}
						<span className="font-medium text-foreground">{needed}</span>{" "}
						credits, but you have{" "}
						<span className="font-medium text-foreground">{spendable}</span>{" "}
						spendable. Local editing is always free — only cloud generation uses
						credits.
					</p>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={close}>
						Close
					</Button>
					<Button disabled title="Payments are coming soon">
						Top up (coming soon)
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
