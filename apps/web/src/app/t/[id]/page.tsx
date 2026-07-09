"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArrangementCard } from "@/components/arrangements/arrangement-card";
import { fetchArrangement } from "@/lib/arrangements";
import { useLoadArrangement } from "@/hooks/use-load-arrangement";
import type { Arrangement } from "@/types/arrangement";

/**
 * Public "Remix this" landing — `/t/[id]`. Opens a shared arrangement with NO
 * login required to view or try. "Remix" spins up a fresh local project with the
 * arrangement's empty generative slots pre-loaded, ready to fill.
 */
export default function RemixArrangementPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = use(params);
	const loadArrangement = useLoadArrangement();
	const [arrangement, setArrangement] = useState<Arrangement | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	useEffect(() => {
		let cancelled = false;
		fetchArrangement(id)
			.then((a) => {
				if (!cancelled) setArrangement(a);
			})
			.catch(() => {
				if (!cancelled) setError("This arrangement could not be found.");
			});
		return () => {
			cancelled = true;
		};
	}, [id]);

	const handleRemix = async () => {
		if (!arrangement) return;
		setStarting(true);
		await loadArrangement(arrangement);
	};

	if (error) {
		return (
			<Centered>
				<p className="text-destructive text-sm">{error}</p>
				<Button asChild variant="outline">
					<Link href="/projects">Go to your projects</Link>
				</Button>
			</Centered>
		);
	}

	if (!arrangement) {
		return (
			<Centered>
				<Loader2 className="text-muted-foreground size-8 animate-spin" />
				<p className="text-muted-foreground text-sm">Loading arrangement…</p>
			</Centered>
		);
	}

	return (
		<div className="bg-background flex min-h-screen items-center justify-center p-4">
			<div className="flex w-full max-w-md flex-col gap-6">
				<div className="flex flex-col gap-1 text-center">
					<span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
						Remix this arrangement
					</span>
					<h1 className="text-2xl font-semibold">{arrangement.name}</h1>
				</div>

				<ArrangementCard arrangement={arrangement} />

				<Button size="lg" onClick={handleRemix} disabled={starting}>
					{starting ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Remix this — no login needed"
					)}
				</Button>
				<p className="text-muted-foreground text-center text-xs">
					Opens a new project with the empty slots pre-loaded. Fill each slot by
					uploading your own footage or generating it.
				</p>
			</div>
		</div>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return (
		<div className="bg-background flex min-h-screen w-full items-center justify-center">
			<div className="flex flex-col items-center gap-4">{children}</div>
		</div>
	);
}
