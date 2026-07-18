import type * as React from "react";

import { cn } from "@/utils/ui";

/**
 * Keyboard-shortcut chip. Token-clean replacement for the five hand-rolled
 * `<kbd className="text-[10px] ... border-border/50 bg-muted/30">` copies
 * scattered across editor-header.tsx, command-palette.tsx,
 * ai-command-panel.tsx and empty-editor-guide.tsx (Phase-B w1 primitive —
 * those call sites are migrated separately).
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
	return (
		<kbd
			className={cn(
				"inline-flex items-center justify-center rounded border border-border/60 bg-surface-raised px-1.5 py-0.5 font-sans text-2xs leading-none text-muted-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export { Kbd };
