"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCredits } from "@/lib/studio/backends/cost";
import type { SafetyTier, Take } from "@/types/timeline";
import { cn } from "@/utils/ui";

/**
 * Compact per-take provenance + cost chrome — the visible half of the
 * indemnity tiering Firefly buries in a legal PDF. Reads `take.provenance`
 * (backend/model/safety tier) and `take.cost` (normalized credits) and renders
 * nothing when a take predates both fields.
 */
export function TakeProvenanceBadge({
	take,
	className,
}: {
	take: Take;
	className?: string;
}) {
	const { provenance, cost } = take;
	if (!provenance && !cost) return null;

	return (
		<span className={cn("inline-flex items-center gap-1", className)}>
			{provenance && (
				<Tooltip>
					<TooltipTrigger asChild>
						<span
							className={cn(
								"inline-flex max-w-24 items-center truncate rounded border px-1 py-0 text-[9px] font-medium leading-[14px]",
								SAFETY_TIER_CLASSES[provenance.safetyTier],
							)}
						>
							{provenance.vendor || provenance.model}
						</span>
					</TooltipTrigger>
					<TooltipContent side="top" className="max-w-56 text-xs">
						<div className="space-y-0.5">
							<p className="font-medium">{provenance.model}</p>
							<p className="text-muted-foreground">
								{SAFETY_TIER_LABELS[provenance.safetyTier]}
							</p>
							{provenance.routedBy && (
								<p className="text-muted-foreground">
									{provenance.routedBy === "auto"
										? "Auto-routed"
										: "Manually pinned"}
									{provenance.intent ? ` · ${provenance.intent}` : ""}
								</p>
							)}
							{provenance.seedLocked !== undefined && (
								<p className="text-muted-foreground">
									{provenance.seedLocked
										? "Identity seed-locked"
										: "Reference-conditioned (no seed lock)"}
								</p>
							)}
						</div>
					</TooltipContent>
				</Tooltip>
			)}

			{cost && (
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="inline-flex items-center gap-0.5 rounded border border-border bg-muted/60 px-1 py-0 text-[9px] font-medium tabular-nums text-muted-foreground">
							{cost.estimated && <span className="italic">est.</span>}
							{formatCredits(cost.credits)}
						</span>
					</TooltipTrigger>
					<TooltipContent side="top" className="max-w-56 text-xs">
						<p>
							{formatCredits(cost.credits)} credits
							{cost.estimated ? " (estimate)" : ""}
						</p>
						{cost.basis && (
							<p className="text-muted-foreground">{cost.basis}</p>
						)}
					</TooltipContent>
				</Tooltip>
			)}
		</span>
	);
}

const SAFETY_TIER_LABELS: Record<SafetyTier, string> = {
	"indemnified-equivalent": "Indemnified-equivalent — safest for brand work",
	partner: "Partner model — standard provider terms",
	experimental: "Experimental — preview / unstable",
};

const SAFETY_TIER_CLASSES: Record<SafetyTier, string> = {
	"indemnified-equivalent":
		"border-constructive/30 bg-constructive/15 text-constructive",
	partner: "border-primary/30 bg-primary/15 text-primary",
	experimental: "border-tone-warning/30 bg-tone-warning/15 text-tone-warning",
};
