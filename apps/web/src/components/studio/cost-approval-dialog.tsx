"use client";

// concept: cost-preview gate — before a batch generation spends real API
// credits, show the estimate and require an explicit click to proceed. This is
// the shared confirmation surface for every manual batch-generation trigger.

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import { Coins01Icon } from "@hugeicons/core-free-icons";
import { formatCostRange, type CostRange } from "@/lib/studio/cost";

interface CostApprovalDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Estimated cost range for the pending action. */
	estimate: CostRange;
	/** How many clips/takes the action would render. */
	clips: number;
	/** Runs the action the user just approved. */
	onApprove: () => void;
	/** Optional override for the confirm button label. */
	confirmLabel?: string;
}

/**
 * Confirmation gate for an expensive generation. Spells out the clip count and
 * the estimated spend, and only runs `onApprove` when the user explicitly
 * confirms — no surprise API bills, and a guardrail against a bad batch plan.
 */
export function CostApprovalDialog({
	open,
	onOpenChange,
	estimate,
	clips,
	onApprove,
	confirmLabel,
}: CostApprovalDialogProps) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Approve generation?</AlertDialogTitle>
					<AlertDialogDescription>
						This will generate{" "}
						<span className="font-semibold text-foreground">
							{clips} clip{clips === 1 ? "" : "s"}
						</span>{" "}
						at an estimated{" "}
						<span className="inline-flex items-center gap-1 font-semibold text-foreground tabular-nums">
							<HugeiconsIcon icon={Coins01Icon} className="size-3.5" />
							{formatCostRange(estimate)}
						</span>
						. Nothing is spent until you approve.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={onApprove}>
						{confirmLabel ?? `Approve · ${formatCostRange(estimate)}`}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
