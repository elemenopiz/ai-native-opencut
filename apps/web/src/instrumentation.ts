/**
 * Next.js instrumentation (on by default in Next 15).
 *
 * `onRequestError` is Next's server-side hook for every unhandled error in a
 * route handler, server component render, or server action. It funnels into
 * `reportError` — the single observability seam in
 * `src/lib/observability/logger.ts`.
 *
 * When a third-party error provider (Sentry or similar) is adopted, initialize
 * its SDK here in `register()` and hand it to the seam via
 * `setErrorReportingAdapter` — no capture site needs to change.
 */

import { reportError } from "@/lib/observability/logger";

export function register(): void {
	// Placeholder: future provider adapter is initialized here, e.g.
	//   setErrorReportingAdapter(createSentryAdapter());
}

type RequestErrorContext = {
	routerKind: string;
	routePath: string;
	routeType: string;
	renderSource?: string;
	revalidateReason?: string;
};

export function onRequestError(
	error: unknown,
	request: { path: string; method: string },
	context: RequestErrorContext,
): void {
	reportError(error, {
		source: "server",
		path: request.path,
		method: request.method,
		routePath: context.routePath,
		routeType: context.routeType,
		routerKind: context.routerKind,
	});
}
