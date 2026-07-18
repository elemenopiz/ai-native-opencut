/**
 * `recordMcpEvent` is a fire-and-forget writer — it must never throw, never
 * block the caller on the insert, and never let a DB failure propagate into
 * the MCP request path (`/api/mcp`, `/api/mcp/tokens`, `build-mcp-server.ts`).
 *
 * bun-test gotcha (see `bun-test-global-fetch-leak` memory): `mock.module`
 * replaces a module in the PROCESS-WIDE registry, and other test files'
 * top-level `import { db } from "@/lib/db"` bindings can be resolved against
 * that swapped registry entry before this file's own `afterAll` restore ever
 * runs (module top-level `import`s across `bun test`'s file set appear to be
 * evaluated ahead of test execution). An earlier version of this test used
 * `mock.module("@/lib/db", ...)` with a stub missing `.transaction`/`.delete`
 * and broke every credits/ledger/sweep test in the same `bun test` run with
 * "db.transaction is not a function" — restoring in `afterAll` did NOT
 * prevent the leak.
 *
 * Fix: don't touch the module registry at all. Use the REAL `db` (this repo
 * already runs credits/ledger tests against real local Postgres) and force a
 * genuine async rejection with a foreign-key-violating `userId` — `mcp_events
 * .user_id` FKs to `users.id`. The only mutation this file makes is a plain
 * property assignment on the shared `logger` object's `warn` method (same
 * fix shape as the fetch leak this comment references), saved and restored
 * in `afterEach` so it can't outlive this file either.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { mcpEvents } from "@/lib/db/schema-mcp";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/observability/logger";
import { recordMcpEvent } from "../telemetry";

const realWarn = logger.warn;
const insertedIds: string[] = [];

afterEach(async () => {
	logger.warn = realWarn;
	if (insertedIds.length > 0) {
		for (const id of insertedIds.splice(0)) {
			await db
				.delete(mcpEvents)
				.where(eq(mcpEvents.id, id))
				.catch(() => {});
		}
	}
});

/**
 * Poll until `predicate` is true or `timeoutMs` elapses. The default is
 * deliberately generous: this file runs against REAL local Postgres, and on a
 * saturated host (parallel agent sessions, load ≫ core count) an insert can
 * take multiple seconds to land — a 2s deadline flaked order-dependently when
 * sibling MCP test files' fire-and-forget telemetry inserts contended for the
 * same pool. The assertion proved is unchanged (the row/warn DOES arrive).
 */
async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

describe("recordMcpEvent", () => {
	test("returns synchronously (does not await the insert) and the row lands in mcp_events", async () => {
		const userId = `mcp-telemetry-test-${crypto.randomUUID()}`;

		const start = performance.now();
		expect(() =>
			recordMcpEvent({
				userId: null, // avoid an FK dependency on a real users row
				projectId: "proj_telemetry_test",
				event: "tool_call",
				verb: "getReel",
				meta: { mutating: false, ok: true, marker: userId },
			}),
		).not.toThrow();
		// Fire-and-forget: the call must return well under the time the insert
		// takes to LAND (waitFor below measures that in seconds on a busy
		// host). 200ms — not 20ms — because on a saturated host even a
		// synchronous JS call can be preempted for tens of ms; the bound only
		// needs to prove we didn't await the round-trip, not that the host is
		// idle.
		expect(performance.now() - start).toBeLessThan(200);

		await waitFor(async () => {
			const rows = await db
				.select()
				.from(mcpEvents)
				.where(eq(mcpEvents.projectId, "proj_telemetry_test"));
			const match = rows.find(
				(r) => (r.meta as { marker?: string } | null)?.marker === userId,
			);
			if (match) insertedIds.push(match.id);
			return Boolean(match);
		});
	});

	test("a rejected insert (FK violation on a bogus userId) is caught and logged, never thrown", async () => {
		const warnCalls: Array<{
			msg: string;
			context?: Record<string, unknown>;
		}> = [];
		logger.warn = (msg: string, context?: Record<string, unknown>) => {
			warnCalls.push({ msg, context });
		};

		expect(() =>
			recordMcpEvent({
				userId: "definitely-not-a-real-user-id-xyz",
				event: "session_initialized",
			}),
		).not.toThrow();

		await waitFor(async () => warnCalls.length > 0);

		expect(warnCalls[0].msg).toBe("mcp telemetry insert failed");
		expect(warnCalls[0].context?.event).toBe("session_initialized");
	});
});
