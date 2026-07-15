"use client";

import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/utils/ui";

/**
 * Placeholder for a gated-but-not-deleted feature — the tab/mode entry point
 * stays visible (so it isn't a dead end users can't find again later), but
 * its content is this instead of the real panel. For features removed
 * outright with no path back, don't use this — just remove the entry point.
 */
export function ComingSoon({
	title,
	description,
	className,
}: {
	title: string;
	description: string;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center",
				className,
			)}
		>
			<HugeiconsIcon
				icon={Clock01Icon}
				className="size-6 text-muted-foreground"
			/>
			<div className="flex flex-col items-center gap-1.5">
				<div className="flex items-center gap-1.5">
					<span className="text-sm font-medium">{title}</span>
					<Badge variant="secondary" className="text-[9px] px-1.5 py-0">
						Coming soon
					</Badge>
				</div>
				<p className="max-w-[26ch] text-[11px] text-muted-foreground">
					{description}
				</p>
			</div>
		</div>
	);
}
