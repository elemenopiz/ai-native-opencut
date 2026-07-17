/**
 * Unit coverage for POST /api/telemetry/verb — the in-app Director agent's
 * verb telemetry intake (poach/verb-telemetry, palmier-delta-refresh-2026-07-14
 * §4.6). Drives the REAL route handler with a fake auth session (same
 * `mock.module("@/lib/auth/server", ...)` + `next/headers` shape as
 * `src/app/api/tts/__tests__/route.test.ts`) and the REAL rate-limit AND db
 * modules (query-suffix trick, same as that file, to stay immune to the
 * documented `mock.module` cross-file leakage gotcha — see
 * PROD-READINESS.md and `lib/mcp/__tests__/telemetry.test.ts`'s header: other
 * route test files in this repo `mock.module("@/lib/db", fakeDb)` with a stub
 * missing `.catch`, and in a FULL-SUITE `bun test` run that leaks into any
 * file that resolves later and imports the plain "@/lib/db" specifier — this
 * file both asserts against and is imported alongside a route that does
 * exactly that, so it re-pins BOTH modules to their real implementations).
 *
 * DB assertions run against REAL local Postgres (bun loads `.env.local`),
 * same posture as `lib/mcp/__tests__/telemetry.test.ts` and
 * `lib/credits/__tests__/ledger.test.ts` — a real throwaway user row is
 * seeded (FK: `mcp_events.user_id` -> `users.id`) and cleaned up in `afterAll`.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";
import { mcpEvents } from "@/lib/db/schema-mcp";

// ── fakes ────────────────────────────────────────────────────────────────────

const authState: { user: { id: string } | null } = { user: null };
mock.module("@/lib/auth/server", () => ({
	auth: {
		api: { getSession: async () => (authState.user ? authState : null) },
	},
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));

// Load the REAL rate-limit AND db implementations, immune to cross-file mock
// leakage — same trick as tts/__tests__/route.test.ts, extended to `@/lib/db`
// (see the module doc above for why this file needs it).
const realRateLimit = (await import(
	"../../../../lib/rate-limit.ts?real" as string
)) as typeof import("@/lib/rate-limit");
mock.module("@/lib/rate-limit", () => ({ ...realRateLimit }));

const realDb = (await import(
	"../../../../lib/db/index.ts?real" as string
)) as typeof import("@/lib/db");
mock.module("@/lib/db", () => ({ ...realDb }));
const { db } = realDb;

const { InMemoryRateLimiter, RATE_LIMITS } = realRateLimit;
const VERB_BURST = RATE_LIMITS["telemetry:verb"].perMinute;

const { POST } = await import("../verb/route");

// ── real throwaway user (FK target for mcp_events.user_id) ───────────────────

const USER_ID = `verbtelemetry-${crypto.randomUUID()}`;

async function seedUser(): Promise<void> {
	await db.insert(users).values({
		id: USER_ID,
		name: "Verb Telemetry Test",
		email: `${USER_ID}@example.test`,
		emailVerified: false,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
}

async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

beforeAll(async () => {
	await seedUser();
});

beforeEach(async () => {
	(
		globalThis as {
			__byornRateLimiter?: InstanceType<typeof InMemoryRateLimiter>;
		}
	).__byornRateLimiter = new InMemoryRateLimiter();
	authState.user = { id: USER_ID };
});

afterAll(async () => {
	await db
		.delete(mcpEvents)
		.where(eq(mcpEvents.userId, USER_ID))
		.catch(() => {});
	await db
		.delete(users)
		.where(eq(users.id, USER_ID))
		.catch(() => {});
});

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReq(body: unknown, ip = "203.0.113.9"): Request {
	return new Request("http://localhost/api/telemetry/verb", {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers: { "content-type": "application/json", "x-forwarded-for": ip },
	});
}

function validPayload(overrides: Record<string, unknown> = {}) {
	return {
		event: "tool_call",
		verb: "getReel",
		status: "ok",
		durationMs: 12,
		timelineChanged: false,
		mutating: false,
		projectId: "proj_verb_telemetry_test",
		...overrides,
	};
}

// ── tests ────────────────────────────────────────────────────────────────────

test("401 when there is no signed-in user (session-authed, not anonymous)", async () => {
	authState.user = null;
	const res = await POST(makeReq(validPayload()));
	expect(res.status).toBe(401);
});

test("400 on non-JSON body", async () => {
	const res = await POST(makeReq("not json{"));
	expect(res.status).toBe(400);
});

test("400 on a schema violation (bad status enum)", async () => {
	const res = await POST(makeReq(validPayload({ status: "bogus" })));
	expect(res.status).toBe(400);
});

test("400 when a required field is missing (verb)", async () => {
	const payload = validPayload();
	delete (payload as Record<string, unknown>).verb;
	const res = await POST(makeReq(payload));
	expect(res.status).toBe(400);
});

test("413 when the body exceeds the size cap", async () => {
	const huge = validPayload({ verb: "x".repeat(10 * 1024) });
	const res = await POST(makeReq(huge));
	expect(res.status).toBe(413);
});

test("429 once the per-minute burst cap is exhausted", async () => {
	for (let i = 0; i < VERB_BURST; i++) {
		const ok = await POST(makeReq(validPayload({ verb: `burst-${i}` })));
		expect(ok.status).toBe(204);
	}
	const limited = await POST(makeReq(validPayload({ verb: "one-too-many" })));
	expect(limited.status).toBe(429);
});

test("happy path: 204, and a matching row lands in mcp_events tagged source=agent", async () => {
	const marker = crypto.randomUUID();
	const res = await POST(
		makeReq(
			validPayload({
				verb: "generate",
				status: "ok",
				durationMs: 4321,
				timelineChanged: true,
				mutating: true,
				projectId: marker,
			}),
		),
	);
	expect(res.status).toBe(204);

	let row: typeof mcpEvents.$inferSelect | undefined;
	await waitFor(async () => {
		const rows = await db
			.select()
			.from(mcpEvents)
			.where(eq(mcpEvents.projectId, marker));
		row = rows[0];
		return Boolean(row);
	});

	expect(row?.userId).toBe(USER_ID);
	expect(row?.event).toBe("tool_call");
	expect(row?.verb).toBe("generate");
	const meta = row?.meta as Record<string, unknown>;
	expect(meta.source).toBe("agent");
	expect(meta.status).toBe("ok");
	expect(meta.durationMs).toBe(4321);
	expect(meta.timelineChanged).toBe(true);
	expect(meta.mutating).toBe(true);
});

test("a failed verb call (status: tool_error) is recorded but never as an activation", async () => {
	const marker = crypto.randomUUID();
	const res = await POST(
		makeReq(
			validPayload({
				event: "tool_call",
				verb: "trim",
				status: "tool_error",
				timelineChanged: false,
				mutating: true,
				projectId: marker,
			}),
		),
	);
	expect(res.status).toBe(204);

	let row: typeof mcpEvents.$inferSelect | undefined;
	await waitFor(async () => {
		const rows = await db
			.select()
			.from(mcpEvents)
			.where(eq(mcpEvents.projectId, marker));
		row = rows[0];
		return Boolean(row);
	});
	const meta = row?.meta as Record<string, unknown>;
	expect(meta.status).toBe("tool_error");
	// The route itself is a dumb relay — it never invents an activation event;
	// that decision is made client-side (verb-telemetry-client.ts), so a
	// tool_error payload only ever produces the one tool_call row.
});

test("agent_session_activated event is stored verbatim", async () => {
	const marker = crypto.randomUUID();
	const res = await POST(
		makeReq(
			validPayload({
				event: "agent_session_activated",
				verb: "getReel",
				projectId: marker,
			}),
		),
	);
	expect(res.status).toBe(204);

	let row: typeof mcpEvents.$inferSelect | undefined;
	await waitFor(async () => {
		const rows = await db
			.select()
			.from(mcpEvents)
			.where(eq(mcpEvents.projectId, marker));
		row = rows[0];
		return Boolean(row);
	});
	expect(row?.event).toBe("agent_session_activated");
});
