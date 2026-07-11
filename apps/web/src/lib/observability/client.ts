/**
 * Browser-side error reporting. Ships errors to `/api/telemetry/error`, which
 * relays them into the server observability seam (`reportError`).
 *
 * Fire-and-forget by design: prefers `navigator.sendBeacon` (survives page
 * unload), falls back to `fetch` with `keepalive`. Never throws, never awaits —
 * a broken reporter must not add a second error on top of the first.
 */

const ENDPOINT = "/api/telemetry/error";

/** Per-page-load cap so an error loop can't hammer the intake endpoint. */
const MAX_REPORTS_PER_PAGE = 10;
let reportsSent = 0;

export interface ClientErrorReport {
	message: string;
	name?: string;
	stack?: string;
	componentStack?: string;
	digest?: string;
	source?:
		| "window.onerror"
		| "unhandledrejection"
		| "global-error"
		| "route-error"
		| "manual";
}

/** Send one error report. Safe to call from anywhere in client code. */
export function reportClientError(report: ClientErrorReport): void {
	try {
		if (typeof window === "undefined") return;
		if (reportsSent >= MAX_REPORTS_PER_PAGE) return;
		reportsSent += 1;

		// Truncate to the intake schema's limits (src/lib/observability/intake.ts)
		// so one huge stack can't get the whole report rejected.
		const body = JSON.stringify({
			...report,
			message: report.message.slice(0, 4_000),
			stack: report.stack?.slice(0, 12_000),
			componentStack: report.componentStack?.slice(0, 8_000),
			route: window.location.pathname,
			userAgent: navigator.userAgent.slice(0, 1_000),
		});

		if (typeof navigator.sendBeacon === "function") {
			const blob = new Blob([body], { type: "application/json" });
			if (navigator.sendBeacon(ENDPOINT, blob)) return;
		}
		fetch(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			keepalive: true,
		}).catch(() => {});
	} catch {
		// Never let the reporter itself throw.
	}
}

/** Reduce a thrown value into a report, tagged with where it was caught. */
export function reportFromException(
	error: unknown,
	source: ClientErrorReport["source"],
	extra?: Partial<ClientErrorReport>,
): void {
	if (error instanceof Error) {
		reportClientError({
			message: error.message || "(no message)",
			name: error.name,
			stack: error.stack,
			digest: (error as { digest?: string }).digest,
			source,
			...extra,
		});
		return;
	}
	reportClientError({
		message: typeof error === "string" ? error : safeString(error),
		name: "NonError",
		source,
		...extra,
	});
}

function safeString(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

declare global {
	interface Window {
		__byornErrorHandlersInstalled?: boolean;
	}
}

/**
 * Hook `window.onerror` + `unhandledrejection` once. Idempotent — repeated
 * calls (React strict mode, HMR, multiple layouts) install nothing new.
 */
export function installGlobalErrorHandlers(): void {
	if (typeof window === "undefined") return;
	if (window.__byornErrorHandlersInstalled) return;
	window.__byornErrorHandlersInstalled = true;

	window.addEventListener("error", (event) => {
		// Resource-load errors (img/script) fire this event with no `error`
		// object and an empty message; skip those.
		if (!event.error && !event.message) return;
		reportFromException(event.error ?? event.message, "window.onerror");
	});

	window.addEventListener("unhandledrejection", (event) => {
		reportFromException(event.reason, "unhandledrejection");
	});
}
