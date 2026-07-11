import Link from "next/link";
import { cn } from "@/utils/ui";
import type { HomeVariant } from "./variants";
import { HOME_VARIANTS } from "./variants";

// Temporary review chrome while a final homepage direction is picked —
// delete this file (and the variant param in page.tsx) once decided.
export function VariantSwitcher({ active }: { active: HomeVariant }) {
	return (
		<div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
			<div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/80 p-1 shadow-lg backdrop-blur-md">
				{HOME_VARIANTS.map((v) => (
					<Link
						key={v.slug}
						href={v.slug === "instrument" ? "/" : `/?v=${v.slug}`}
						className={cn(
							"rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
							v.slug === active
								? "bg-foreground text-background"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{v.label}
					</Link>
				))}
			</div>
		</div>
	);
}
