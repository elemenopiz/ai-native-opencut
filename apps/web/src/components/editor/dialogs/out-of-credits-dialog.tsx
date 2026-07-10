"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { BuyCreditsDialog } from "@/components/auth/buy-credits-dialog";
import { useCreditsStore } from "@/stores/credits-store";

/**
 * "Out of credits" modal. Opened by the client 402 gate (`gateOn402`) when a
 * paid studio action is blocked for insufficient credits. The Top-up CTA opens
 * the buy-credits flow (Phase 2 payments).
 *
 * Rendered once, globally (from the editor header), and driven entirely by the
 * credits store so any studio action can trigger it.
 */
export function OutOfCreditsDialog() {
	const outOfCredits = useCreditsStore((s) => s.outOfCredits);
	const close = useCreditsStore((s) => s.closeOutOfCredits);
	const [buyOpen, setBuyOpen] = useState(false);

	const { open, needed, spendable } = outOfCredits;

	return (
		<>
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
							spendable. Local editing is always free — only cloud generation
							uses credits.
						</p>
					</DialogBody>
					<DialogFooter>
						<Button variant="outline" onClick={close}>
							Close
						</Button>
						<Button
							onClick={() => {
								// Hand off to the buy-credits flow; leave the out-of-credits
								// modal closed behind it.
								close();
								setBuyOpen(true);
							}}
						>
							Top up
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<BuyCreditsDialog open={buyOpen} onOpenChange={setBuyOpen} />
		</>
	);
}
