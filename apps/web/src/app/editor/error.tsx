"use client";

import { useEffect } from "react";
import { reportFromException } from "@/lib/observability/client";

/**
 * Editor segment error boundary. Editor project state is persisted locally
 * (IndexedDB/OPFS) as the user works, so the copy leads with reassurance:
 * an editor crash does not lose their project.
 */
export default function EditorError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		reportFromException(error, "route-error");
	}, [error]);

	return (
		<div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
			<div className="max-w-md p-6 text-center">
				<h1 className="mb-2 text-xl font-semibold">
					The editor hit an unexpected error
				</h1>
				<p className="mb-5 text-sm leading-relaxed text-muted-foreground">
					Don&apos;t worry — your project is saved locally on this device, and
					none of your work is lost. The error has been reported.
				</p>
				<div className="flex items-center justify-center gap-3">
					<button
						type="button"
						onClick={reset}
						className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
					>
						Try again
					</button>
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
					>
						Reload editor
					</button>
				</div>
				{error?.digest ? (
					<p className="mt-4 text-[11px] text-muted-foreground/60">
						Error ID: {error.digest}
					</p>
				) : null}
			</div>
		</div>
	);
}
