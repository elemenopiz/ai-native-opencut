/**
 * Browser-side sender for the IN-APP Director agent's per-verb telemetry.
 *
 * Mirrors `lib/observability/client.ts`'s error-reporting shape deliberately
 * (same fire-and-forget contract, same sendBeacon-then-fetch-keepalive
 * fallback): ships one beacon per verb call to `/api/telemetry/verb`, which
 * relays into the SAME `recordMcpEvent` writer the external MCP path uses
 * (see `lib/mcp/telemetry.ts`), tagged `source: "agent"` so the two Director
 * verb paths can be told apart.
 *
 * NEVER throws, NEVER blocks the verb it's reporting on — `agent.ts`'s
 * `executeTool` calls this AFTER the verb has already resolved, and a
 * telemetry-endpoint outage must not surface as a Director failure.
 *
 * ACTIVATION: "agent_session_activated" is the in-app analogue of the MCP
 * path's "mcp_activated" — first SUCCESSFUL verb call, not page load/mount.
 * The once-flag here is a plain module-level boolean, so its scope is one
 * browser PAGE LOAD (a hard refresh, or navigating away and back, resets it
 * and can double-count a "session" that a human would still call the same
 * session). That's the direct agent-path analogue of the MCP-session
 * closure's cross-restart tradeoff — accepted for the same reason: precise
 * session boundaries would need a real client-side session id and a server
 * round-trip to dedupe, which is out of scope for this pass.
 */

const ENDPOINT = "/api/telemetry/verb";

/** Per-page-load cap so a runaway tool loop can't hammer the intake endpoint. */
const MAX_REPORTS_PER_PAGE = 500;
let reportsSent = 0;

/** Once-per-page-load activation guard — see the ACTIVATION note above. */
let activated = false;

export type VerbTelemetryStatus = "ok" | "tool_error" | "unknown_action";

export interface VerbTelemetryReport {
	/** The Director verb name (action), e.g. "generate", "getReel". */
	verb: string;
	status: VerbTelemetryStatus;
	/** Wall time of the verb call, in whole milliseconds. */
	durationMs: number;
	/** True iff a mutating verb returned ok — the cheap "did it do something" proxy. */
	timelineChanged: boolean;
	/** The catalog's own `mutating` flag, carried through for convenience. */
	mutating: boolean;
	/** Best-effort opaque client project id, or null when it can't be resolved. */
	projectId?: string | null;
}

/**
 * Best-effort project id for the in-app path. `DirectorApi` (agent.ts's only
 * dependency) does not expose the raw project id — `director-api.ts` is out
 * of bounds for this pass, and adding a public getter there is a larger
 * change than this telemetry slice warrants — so this reads it from the
 * editor route's URL instead (`/editor/[project_id]/...`, see
 * `src/app/editor/[project_id]/page.tsx`). Returns null outside the browser
 * (SSR, tests) or off that route; a null projectId is an accepted, documented
 * gap for the agent path (the MCP path always has one from the bound token).
 */
export function currentProjectIdFromLocation(): string | null {
	if (typeof window === "undefined") return null;
	const match = window.location.pathname.match(/^\/editor\/([^/]+)/);
	return match?.[1] ?? null;
}

function send(body: string): void {
	if (
		typeof navigator !== "undefined" &&
		typeof navigator.sendBeacon === "function"
	) {
		const blob = new Blob([body], { type: "application/json" });
		if (navigator.sendBeacon(ENDPOINT, blob)) return;
	}
	fetch(ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		keepalive: true,
	}).catch(() => {});
}

/**
 * Report one in-app Director verb call. Safe to call from anywhere in client
 * code — swallows every error, returns immediately.
 *
 * Also fires `agent_session_activated` (a second, separate beacon) the FIRST
 * time a call reports `status: "ok"` this page load — never on a failed
 * first call, matching the MCP path's "first successful call" semantics.
 */
export function reportVerbTelemetry(report: VerbTelemetryReport): void {
	try {
		if (typeof window === "undefined") return;
		if (reportsSent >= MAX_REPORTS_PER_PAGE) return;
		reportsSent += 1;

		const projectId = report.projectId ?? currentProjectIdFromLocation();
		send(
			JSON.stringify({
				event: "tool_call",
				verb: report.verb,
				status: report.status,
				durationMs: report.durationMs,
				timelineChanged: report.timelineChanged,
				mutating: report.mutating,
				projectId,
			}),
		);

		if (report.status === "ok" && !activated) {
			activated = true;
			send(
				JSON.stringify({
					event: "agent_session_activated",
					verb: report.verb,
					status: "ok",
					durationMs: report.durationMs,
					timelineChanged: report.timelineChanged,
					mutating: report.mutating,
					projectId,
				}),
			);
		}
	} catch {
		// Never let the reporter itself throw.
	}
}

/** Test-only reset of the module-level once-flags (mirrors the `ForTests` convention elsewhere, e.g. `pitch-preserving-stretch.ts`). */
export function resetVerbTelemetryForTests(): void {
	reportsSent = 0;
	activated = false;
}
