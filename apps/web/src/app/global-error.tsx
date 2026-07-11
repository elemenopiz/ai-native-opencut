"use client";

import { useEffect } from "react";
import { reportFromException } from "@/lib/observability/client";

/**
 * Root error boundary — replaces the entire document when the root layout
 * itself throws (production only; dev shows the overlay). Global CSS may not
 * have loaded, so styling is inline and self-contained.
 */
export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		reportFromException(error, "global-error");
	}, [error]);

	return (
		<html lang="en">
			<body
				style={{
					margin: 0,
					minHeight: "100vh",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					background: "#0a0a0a",
					color: "#fafafa",
					fontFamily:
						"ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
				}}
			>
				<div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
					<h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
						Something broke
					</h1>
					<p
						style={{
							fontSize: 14,
							lineHeight: 1.6,
							color: "#a1a1aa",
							marginBottom: 20,
						}}
					>
						An unexpected error crashed this page. It has been reported —
						reloading usually fixes it.
					</p>
					<button
						type="button"
						onClick={() => {
							try {
								reset();
							} finally {
								window.location.reload();
							}
						}}
						style={{
							padding: "10px 20px",
							borderRadius: 8,
							border: "1px solid #3f3f46",
							background: "#fafafa",
							color: "#0a0a0a",
							fontSize: 14,
							fontWeight: 500,
							cursor: "pointer",
						}}
					>
						Reload
					</button>
					{error?.digest ? (
						<p style={{ fontSize: 11, color: "#52525b", marginTop: 16 }}>
							Error ID: {error.digest}
						</p>
					) : null}
				</div>
			</body>
		</html>
	);
}
