"use client";

import { useEffect, useState } from "react";
import { ArrangementCard } from "./arrangement-card";
import { SEED_ARRANGEMENTS } from "@/lib/arrangements";
import { useArrangementStore } from "@/stores/arrangement-store";
import type { Arrangement } from "@/types/arrangement";

/**
 * The arrangement gallery: featured seed templates plus the user's own locally
 * saved arrangements. Picking a card fires `onSelect` with the chosen
 * arrangement — the caller decides what "load" means (new project, etc.).
 */
export function ArrangementGallery({
	onSelect,
}: {
	onSelect: (arrangement: Arrangement) => void;
}) {
	const saved = useArrangementStore((s) => s.saved);
	// Avoid hydration mismatch: only render persisted (client) items after mount.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	return (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-3">
				<h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
					Featured
				</h4>
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{SEED_ARRANGEMENTS.map((arrangement) => (
						<ArrangementCard
							key={arrangement.id}
							arrangement={arrangement}
							onSelect={() => onSelect(arrangement)}
						/>
					))}
				</div>
			</section>

			{mounted && saved.length > 0 && (
				<section className="flex flex-col gap-3">
					<h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
						Your arrangements
					</h4>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{saved.map((entry) => (
							<ArrangementCard
								key={entry.localId}
								arrangement={entry.arrangement}
								onSelect={() => onSelect(entry.arrangement)}
							/>
						))}
					</div>
				</section>
			)}
		</div>
	);
}
