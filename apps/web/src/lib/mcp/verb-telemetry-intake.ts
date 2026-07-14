/**
 * `/api/telemetry/verb` payload validation — pure module (no Next.js imports)
 * so the shape is unit-testable in isolation, mirroring
 * `lib/observability/intake.ts`'s split for the client-error intake.
 *
 * The endpoint is session-authed (unlike `/api/telemetry/error`, which is
 * intentionally anonymous), so this schema carries no PII/free-text fields —
 * just the enums and numbers `verb-telemetry-client.ts` sends. `userId` comes
 * from the session, never the body.
 */

import { z } from "zod";

/** Hard cap on the raw request body. Real payloads are well under 1KB. */
export const MAX_BODY_BYTES = 4 * 1024;

/**
 * `tool_call` — one per in-app Director verb call (mirrors the external MCP
 * path's `tool_call` event). `agent_session_activated` — the in-app analogue
 * of `mcp_activated`, fired at most once per page load on the first `status:
 * "ok"` report (see `verb-telemetry-client.ts`).
 */
export const verbTelemetrySchema = z.object({
	event: z.enum(["tool_call", "agent_session_activated"]),
	verb: z.string().min(1).max(100),
	status: z.enum(["ok", "tool_error", "unknown_action"]),
	durationMs: z.number().min(0).max(600_000),
	timelineChanged: z.boolean(),
	mutating: z.boolean(),
	/** Opaque client-side project id (same convention as `mcp_tokens.project_id`); best-effort, may be absent. */
	projectId: z.string().max(200).nullable().optional(),
});

export type VerbTelemetryPayload = z.infer<typeof verbTelemetrySchema>;
