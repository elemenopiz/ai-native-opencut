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
 */

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
	} catch {
		// Swallow: the reporter must never take the app down with it.
	}
}
