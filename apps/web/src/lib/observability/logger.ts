/**
 * Structured server logger + THE error-reporting seam.
 *
 * Zero-dep, tiny on purpose. Two output modes:
 *  - production: single-line JSON objects (`{ts, level, msg, ...context}`) so
 *    Vercel / Docker log drains can parse each line.
 *  - development: human-readable `HH:MM:SS LEVEL msg {context}`.
 *
 * IMPORTANT: production output goes through `process.stdout/stderr.write`, NOT
 * `console.*` — next.config.ts sets `compiler.removeConsole` in production,
 * which would strip console calls out of the compiled server code and silently
 * eat every log line.
 *
 * {@link reportError} is the single seam for error reporting. Every capture
 * path funnels here:
 *  - `instrumentation.ts` `onRequestError` (unhandled server/route errors)
 *  - `/api/telemetry/error` (client-side errors relayed from the browser)
 *  - any manual `reportError(err, {...})` call in server code
 *
 * A future third-party provider (Sentry or similar) plugs in by implementing
 * {@link ErrorReportingAdapter} and calling {@link setErrorReportingAdapter}
 * from `instrumentation.ts` — inside this file is the ONLY place the adapter
 * is invoked, so swapping providers never touches capture sites.
 *
 * ADR-002 follow-up — generic vendor-alerting webhook: see {@link sendAlert}
 * below. Dep-free, env-gated, fail-soft; unset env ⇒ byte-identical to no
 * adapter at all.
 */

import { redactSecrets } from "./intake";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

function isProduction(): boolean {
	return process.env.NODE_ENV === "production";
}

/** Minimum level actually emitted. `LOG_LEVEL` env overrides the default. */
function minLevel(): LogLevel {
	const raw = process.env.LOG_LEVEL;
	if (raw && raw in LEVEL_RANK) return raw as LogLevel;
	return isProduction() ? "info" : "debug";
}

/** Node stream shape we need; resolved via globalThis so the edge-runtime
 * bundler doesn't flag a static `process.stdout` reference (it is guarded at
 * runtime and only used where it exists). */
type WritableLike = { write?: (chunk: string) => unknown };

/**
 * Write one line to stdout (debug/info) or stderr (warn/error). Uses the raw
 * streams so `compiler.removeConsole` can't strip production logs; falls back
 * to `console` where streams are unavailable (edge runtime).
 */
function writeLine(level: LogLevel, line: string): void {
	const proc = (
		globalThis as { process?: { stdout?: WritableLike; stderr?: WritableLike } }
	).process;
	const stream =
		level === "warn" || level === "error" ? proc?.stderr : proc?.stdout;
	if (typeof stream?.write === "function") {
		stream.write(`${line}\n`);
		return;
	}
	// Edge runtime fallback. console.error survives removeConsole (excluded in
	// next.config.ts); lower levels may be stripped there — acceptable.
	if (level === "error" || level === "warn") console.error(line);
	else console.log(line);
}

/** JSON.stringify that never throws (circular refs, BigInt, etc.). */
function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return JSON.stringify(value, (_key, v) => {
			if (typeof v === "bigint") return v.toString();
			if (typeof v === "object" && v !== null) {
				if (seen.has(v)) return "[circular]";
				seen.add(v);
			}
			return v;
		});
	} catch {
		return '"[unserializable]"';
	}
}

function emit(level: LogLevel, msg: string, context?: LogContext): void {
	if (LEVEL_RANK[level] < LEVEL_RANK[minLevel()]) return;

	if (isProduction()) {
		const entry: Record<string, unknown> = {
			ts: new Date().toISOString(),
			level,
			msg,
			...context,
		};
		writeLine(level, safeStringify(entry));
		return;
	}

	const time = new Date().toISOString().slice(11, 19);
	const suffix =
		context && Object.keys(context).length > 0
			? ` ${safeStringify(context)}`
			: "";
	writeLine(level, `${time} ${level.toUpperCase().padEnd(5)} ${msg}${suffix}`);
}

export const logger = {
	debug: (msg: string, context?: LogContext) => emit("debug", msg, context),
	info: (msg: string, context?: LogContext) => emit("info", msg, context),
	warn: (msg: string, context?: LogContext) => emit("warn", msg, context),
	error: (msg: string, context?: LogContext) => emit("error", msg, context),
};

/** Normalized shape every reported error is reduced to. */
export interface NormalizedError {
	name: string;
	message: string;
	stack?: string;
	/** Next.js production error digest, when present. */
	digest?: string;
}

/**
 * Contract a future provider (Sentry etc.) implements. Wire it once via
 * {@link setErrorReportingAdapter}; it is invoked ONLY inside
 * {@link reportError}.
 */
export interface ErrorReportingAdapter {
	captureError(error: NormalizedError, context: LogContext): void;
}

let adapter: ErrorReportingAdapter | null = null;

export function setErrorReportingAdapter(next: ErrorReportingAdapter): void {
	adapter = next;
}

/** Reduce any thrown value to {@link NormalizedError}. */
export function normalizeError(error: unknown): NormalizedError {
	if (error instanceof Error) {
		const digest = (error as { digest?: unknown }).digest;
		return {
			name: error.name || "Error",
			message: error.message || "(no message)",
			stack: error.stack,
			...(typeof digest === "string" ? { digest } : {}),
		};
	}
	if (typeof error === "string") return { name: "Error", message: error };
	// Error-like plain objects (e.g. relayed client errors, foreign realms).
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof (error as { message: unknown }).message === "string"
	) {
		const e = error as {
			message: string;
			name?: unknown;
			stack?: unknown;
			digest?: unknown;
		};
		return {
			name: typeof e.name === "string" && e.name ? e.name : "Error",
			message: e.message,
			...(typeof e.stack === "string" ? { stack: e.stack } : {}),
			...(typeof e.digest === "string" ? { digest: e.digest } : {}),
		};
	}
	return { name: "NonError", message: safeStringify(error) };
}

/* ---------------------------------------------------------------------------
 * ADR-002 vendor-alerting adapter: generic webhook forwarder.
 *
 * Unset `OBSERVABILITY_ALERT_WEBHOOK_URL` ⇒ this whole block is a no-op and
 * `reportError`'s behavior is byte-identical to before this existed. Set it
 * to any HTTPS endpoint that accepts a JSON POST (Slack incoming webhook,
 * PagerDuty Events API v2, Zapier/Make catch hook, a custom relay, …) to get
 * push alerts on top of the structured log lines.
 *
 * NOT a Sentry SDK integration: hand-rolling Sentry's envelope/store HTTP API
 * (X-Sentry-Auth header, event-id + envelope framing, DSN parsing) is easy to
 * get subtly wrong in ways that silently drop events, which defeats the point
 * of an alerting adapter. That's exactly what an SDK is for. When the user
 * picks a vendor, `@sentry/nextjs` (or similar) remains the one-file change
 * ADR-002 promises — replace this block's body, or register an
 * {@link ErrorReportingAdapter} via {@link setErrorReportingAdapter}. Shipping
 * only the generic forwarder here, not a SENTRY_DSN path, is a deliberate
 * scope call, not an oversight.
 * ------------------------------------------------------------------------- */

const ALERT_WEBHOOK_URL_ENV = "OBSERVABILITY_ALERT_WEBHOOK_URL";

/** Hard cap on the JSON body POSTed to the webhook. */
const MAX_ALERT_PAYLOAD_BYTES = 8 * 1024;
const MAX_ALERT_MESSAGE_CHARS = 2_000;
const MAX_ALERT_STACK_CHARS = 4_000;

/** Fixed-window in-module rate limit so an error storm can't DDoS the webhook. */
const ALERT_RATE_LIMIT_MAX = 10;
const ALERT_RATE_LIMIT_WINDOW_MS = 60_000;
let alertRateWindowStart = 0;
let alertRateWindowCount = 0;
let alertDropCount = 0;
let alertFailureCount = 0;

/** Test-only introspection/reset — never used from production code paths. */
export function __resetAlertStateForTests(): void {
	alertRateWindowStart = 0;
	alertRateWindowCount = 0;
	alertDropCount = 0;
	alertFailureCount = 0;
}
export function __getAlertStatsForTests(): {
	drops: number;
	failures: number;
} {
	return { drops: alertDropCount, failures: alertFailureCount };
}

function takeAlertRateLimitToken(now: number): boolean {
	if (now - alertRateWindowStart >= ALERT_RATE_LIMIT_WINDOW_MS) {
		alertRateWindowStart = now;
		alertRateWindowCount = 0;
	}
	if (alertRateWindowCount >= ALERT_RATE_LIMIT_MAX) {
		alertDropCount += 1;
		return false;
	}
	alertRateWindowCount += 1;
	return true;
}

function truncateForAlert(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

/** Redact every string value in an arbitrary context record before it leaves the process. */
function redactContext(context: LogContext): LogContext {
	const out: LogContext = {};
	for (const [key, value] of Object.entries(context)) {
		out[key] = typeof value === "string" ? redactSecrets(value) : value;
	}
	return out;
}

function buildAlertPayload(
	normalized: NormalizedError,
	context: LogContext,
): string {
	const payload = {
		ts: new Date().toISOString(),
		level: "error" as const,
		errorName: normalized.name,
		message: redactSecrets(
			truncateForAlert(normalized.message, MAX_ALERT_MESSAGE_CHARS),
		),
		stack: normalized.stack
			? redactSecrets(truncateForAlert(normalized.stack, MAX_ALERT_STACK_CHARS))
			: undefined,
		digest: normalized.digest,
		context: redactContext(context),
	};

	const json = safeStringify(payload);
	if (json.length <= MAX_ALERT_PAYLOAD_BYTES) return json;

	// Oversized even after field-level truncation (context is unbounded) —
	// drop context first, then hard-truncate as a last resort so we never send
	// an unbounded body.
	const minimal = safeStringify({ ...payload, context: { truncated: true } });
	return minimal.length <= MAX_ALERT_PAYLOAD_BYTES
		? minimal
		: minimal.slice(0, MAX_ALERT_PAYLOAD_BYTES);
}

/**
 * Fire-and-forget POST to the generic alert webhook. Synchronous from the
 * caller's perspective — never awaited, never throws, never lets a rejected
 * fetch promise go unhandled. A dead/slow webhook must never slow down or
 * fail the request that triggered the error.
 *
 * Caveat: on serverless platforms (Vercel) a function can freeze immediately
 * after the response is sent, which can race an in-flight un-awaited fetch.
 * Acceptable for a best-effort alert channel; a future iteration could use
 * `waitUntil` where the runtime provides it.
 */
function sendAlert(normalized: NormalizedError, context: LogContext): void {
	const url = process.env[ALERT_WEBHOOK_URL_ENV];
	if (!url) return;

	try {
		if (!takeAlertRateLimitToken(Date.now())) return;

		const body = buildAlertPayload(normalized, context);
		const hasAbortController = typeof AbortController !== "undefined";
		const controller = hasAbortController ? new AbortController() : undefined;
		const timeoutId = controller
			? setTimeout(() => controller.abort(), 5_000)
			: undefined;

		Promise.resolve(
			fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
				signal: controller?.signal,
			}),
		)
			.catch(() => {
				alertFailureCount += 1;
			})
			.finally(() => {
				if (timeoutId !== undefined) clearTimeout(timeoutId);
			});
	} catch {
		// Never let the alerting path take the request down with it.
		alertFailureCount += 1;
	}
}

/**
 * THE seam: report an error with context. Logs a structured error line and
 * forwards to the provider adapter when one is registered. Never throws —
 * error reporting must not create new errors.
 */
export function reportError(error: unknown, context: LogContext = {}): void {
	try {
		const normalized = normalizeError(error);
		emit("error", normalized.message, {
			errorName: normalized.name,
			stack: normalized.stack,
			...(normalized.digest ? { digest: normalized.digest } : {}),
			...context,
		});
		adapter?.captureError(normalized, context);
		sendAlert(normalized, context);
	} catch {
		// Swallow: the reporter must never take the app down with it.
	}
}
