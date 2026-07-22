import { afterAll, describe, expect, it, mock } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * AUTH-CRITICAL route-protection sweep (launch rubric: auth-path coverage).
 *
 * Two layers, both table-driven so FUTURE routes get caught automatically:
 *
 *  1. EXECUTED 401 sweep — every session-gated handler below is invoked with a
 *     sessionless request and must return 401. The routes' 401 branch runs for
 *     real; a null session is injected via the same three-module mock set the
 *     sibling suites use (studio-idor.test.ts, vc-routes.test.ts,
 *     credit-metering.test.ts). The REAL behavior of `auth.api.getSession`
 *     (cookie in → user out, no cookie → null) is integration-tested against
 *     real Postgres in src/lib/auth/__tests__/auth-flows.test.ts.
 *
 *  2. CLASSIFICATION GUARD — every `route.ts` under `src/app/api` must be
 *     accounted for: either its source contains the session-check pattern and
 *     it appears in the executed sweep, or it sits on the explicit
 *     PUBLIC_ROUTES allowlist with a written justification. A brand-new API
 *     route that is neither session-checked nor consciously declared public
 *     FAILS this test — shipping an unauthenticated route must be a decision,
 *     never an accident.
 *
 * MOCKING NOTES (conventions this repo's api-route suites already follow):
 *  - `next/headers` throws outside a Next request scope, so it always needs a
 *    stub. An empty Headers bag = no session cookie = logged-out caller.
 *  - `@/lib/auth/server` is stubbed to a null session — the sweep asserts the
 *    routes' REACTION to "no session", not better-auth itself.
 *  - `@/lib/studio/backends` is stubbed because merely importing the real
 *    barrel registers every provider adapter in the PROCESS-GLOBAL backend
 *    registry (adapters self-register at module load), which pollutes
 *    src/lib/studio/backends/__tests__/router.test.ts in a full run.
 */

mock.module("next/headers", () => ({ headers: async () => new Headers() }));

// Sessionless caller for every route in the sweep.
mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => null } },
}));

// Import-side-effect firewall — the sweep never gets past the 401, so these
// stubs are unreachable at run time; they exist so the real adapter registry
// is never populated from this file. Shape mirrors credit-metering.test.ts.
// Snapshot + restore in afterAll (below) — other test files import the real
// barrel (getBackend etc.), and bun shares one module registry per process.
const realBackends = { ...(await import("@/lib/studio/backends")) };
mock.module("@/lib/studio/backends", () => ({
	ensureBackendsRegistered: () => {},
	normalizeSeedLock: () => {
		throw new Error("unreachable: sweep requests are sessionless (401)");
	},
	toTakeCost: () => {
		throw new Error("unreachable: sweep requests are sessionless (401)");
	},
	routeSlot: () => {
		throw new Error("unreachable: sweep requests are sessionless (401)");
	},
	getBackend: () => {
		throw new Error("unreachable: sweep requests are sessionless (401)");
	},
	allBackends: () => [],
	availableBackends: () => [],
	defaultBackend: () => {
		throw new Error("unreachable: sweep requests are sessionless (401)");
	},
	relativeCostTier: () => "standard",
}));
afterAll(() => {
	mock.module("@/lib/studio/backends", () => realBackends);
});

// Some routes deliberately 503 BEFORE the session check when their provider key
// is unconfigured (tts, enhance-prompt: "no key → hide the feature" contract).
// Pin a fake key when the machine has none so the sweep reaches the 401 gate it
// exists to assert; `||=` keeps real keys untouched. Same direct-mutation
// pattern as api/tts/__tests__/route.test.ts (webEnv is a shared live object).
import { webEnv } from "@byorn/env/web";
webEnv.OPENAI_API_KEY ||= "sweep-fake-key";
// llm/gemini has the same key-before-session 503 contract (client brain-fallback
// signal) — pin a fake key so its 401 gate is reachable too.
webEnv.GEMINI_API_KEY ||= "sweep-fake-key";

const API_DIR = path.join(import.meta.dir, "..");

/** Session-check pattern shared by every gated route in this repo. */
const SESSION_CHECK = "auth.api.getSession";

/**
 * Routes that are deliberately PUBLIC (no better-auth session). Each entry
 * carries the reason it is allowed to skip the session gate — if you add a
 * route here, write down why it is safe unauthenticated.
 */
const PUBLIC_ROUTES: Record<string, string> = {
	"arrangements/route.ts":
		"public share/publish by design (no-login-to-try posture); payload validated server-side",
	"arrangements/[id]/route.ts": "public share read/remix by design",
	"auth/[...all]/route.ts":
		"the better-auth handler itself — IS the auth system",
	"health/route.ts": "deploy health probe, no user data",
	"images/search/route.ts":
		"key-based auth of its own (server env key or per-request X-Pexels-Api-Key); 401s without either",
	"sounds/search/route.ts": "public Freesound search proxy, no user data",
	"sounds/proxy/route.ts": "public Freesound audio proxy (SSRF-guarded)",
	"studio/backends/route.ts":
		"client-safe backend catalog — availability metadata only, never keys",
	"studio/provider-keys/route.ts":
		"per-provider configured-or-not booleans only, never key values",
	"telemetry/error/route.ts": "anonymous client error intake",
	"webhooks/polar/route.ts":
		"webhook signature verification (POLAR_WEBHOOK_SECRET), not sessions",
	"mcp/route.ts":
		"per-project bearer-token auth (verifyProjectToken), not sessions",
};

/**
 * Session-checked routes that cannot run in this sweep. Keep this list SHORT
 * and justified.
 */
const EXCLUDED_SESSION_ROUTES: Record<string, string> = {
	"ai-access/route.ts":
		"calls auth.api.getSession but is a deliberately public probe — it reports " +
		"{ signedIn, aiAccess } for ANY caller (session or none) and always 200s, " +
		"even with no session, so it can never satisfy this sweep's " +
		"`expect(status).toBe(401)` assertion (see lib/ai-access.ts)",
	"mcp/bridge/route.ts":
		"session-gated in production but intentionally falls back to a dev-wildcard " +
		"user outside production (see DEV_WILDCARD_USER) — under bun test " +
		"(NODE_ENV=test) a sessionless request would register instead of 401ing, " +
		"so the prod behavior is not observable here",
};

type Handler = (...args: never[]) => Promise<Response>;
type RouteModule = Record<string, unknown>;

function makeRequest(method: string, url: string, body?: unknown): Request {
	return new Request(url, {
		method,
		...(body !== undefined
			? {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}
			: {}),
	});
}

const params = (p: Record<string, string>) => ({
	params: Promise.resolve(p),
});

interface SweepCase {
	/** Route file, relative to src/app/api — must match the on-disk path. */
	file: string;
	/** HTTP method → arguments the handler is invoked with. */
	calls: Record<string, unknown[]>;
}

const BASE = "http://localhost:3000/api";

/**
 * The executed sweep table. Every session-gated route file must appear here
 * (the classification guard enforces it), with EVERY exported method invoked.
 */
const SWEEP: SweepCase[] = [
	{
		file: "admin/credits/grant/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/admin/credits/grant`, {
					userId: "u1",
					amount: 10,
				}),
			],
		},
	},
	{
		file: "credits/balance/route.ts",
		calls: { GET: [] },
	},
	{
		file: "credits/checkout/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/credits/checkout`, { packKey: "small" }),
			],
		},
	},
	{
		file: "credits/history/route.ts",
		calls: { GET: [makeRequest("GET", `${BASE}/credits/history`)] },
	},
	{
		file: "llm/agent/route.ts",
		calls: {
			POST: [makeRequest("POST", `${BASE}/llm/agent`, { messages: [] })],
		},
	},
	{
		file: "llm/gemini/route.ts",
		calls: {
			POST: [makeRequest("POST", `${BASE}/llm/gemini`, { contents: [] })],
		},
	},
	{
		file: "llm/enhance-prompt/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/llm/enhance-prompt`, { prompt: "x" }),
			],
		},
	},
	{
		file: "mcp/tokens/route.ts",
		calls: {
			POST: [makeRequest("POST", `${BASE}/mcp/tokens`, { projectId: "p1" })],
			GET: [makeRequest("GET", `${BASE}/mcp/tokens`)],
			DELETE: [makeRequest("DELETE", `${BASE}/mcp/tokens?id=t1`)],
		},
	},
	{
		file: "studio/audio/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/studio/audio`, {
					action: "music",
					prompt: "x",
				}),
			],
		},
	},
	{
		file: "studio/audio/[jobId]/route.ts",
		calls: {
			GET: [
				makeRequest("GET", `${BASE}/studio/audio/j1`),
				params({ jobId: "j1" }),
			],
		},
	},
	{
		file: "studio/board/route.ts",
		calls: {
			GET: [],
			POST: [makeRequest("POST", `${BASE}/studio/board`, { takeId: "t1" })],
			DELETE: [makeRequest("DELETE", `${BASE}/studio/board?id=b1`)],
		},
	},
	{
		file: "studio/generate/route.ts",
		calls: {
			POST: [makeRequest("POST", `${BASE}/studio/generate`, { prompt: "x" })],
		},
	},
	{
		file: "studio/generate/[jobId]/route.ts",
		calls: {
			GET: [
				makeRequest("GET", `${BASE}/studio/generate/j1`),
				params({ jobId: "j1" }),
			],
		},
	},
	{
		file: "studio/image/route.ts",
		calls: {
			POST: [makeRequest("POST", `${BASE}/studio/image`, { prompt: "x" })],
		},
	},
	{
		file: "studio/personas/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/studio/personas`, {
					name: "N",
					descriptor: "D",
					anchorImageUrl: "http://img",
				}),
			],
			GET: [],
		},
	},
	{
		file: "studio/personas/[id]/route.ts",
		calls: {
			DELETE: [
				makeRequest("DELETE", `${BASE}/studio/personas/p1`),
				params({ id: "p1" }),
			],
		},
	},
	{
		file: "studio/personas/[id]/still/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/studio/personas/p1/still`, {}),
				params({ id: "p1" }),
			],
		},
	},
	{
		file: "studio/proxy/route.ts",
		calls: {
			GET: [
				makeRequest(
					"GET",
					`${BASE}/studio/proxy?url=${encodeURIComponent("https://example.com/v.mp4")}`,
				),
			],
		},
	},
	{
		file: "studio/sets/route.ts",
		calls: { GET: [] },
	},
	{
		file: "studio/takes/[takeId]/route.ts",
		calls: {
			PATCH: [
				makeRequest("PATCH", `${BASE}/studio/takes/t1`, { starred: true }),
				params({ takeId: "t1" }),
			],
		},
	},
	{
		file: "studio/takes/[takeId]/promote/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/studio/takes/t1/promote`, {}),
				params({ takeId: "t1" }),
			],
		},
	},
	{
		file: "studio/upload-url/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/studio/upload-url`, {
					mimeType: "image/png",
					sizeBytes: 1024,
				}),
			],
		},
	},
	{
		file: "studio/upload/route.ts",
		calls: {
			POST: [makeRequest("POST", `${BASE}/studio/upload`)],
		},
	},
	{
		file: "telemetry/verb/route.ts",
		calls: {
			POST: [makeRequest("POST", `${BASE}/telemetry/verb`, {})],
		},
	},
	{
		file: "tts/route.ts",
		calls: {
			POST: [makeRequest("POST", `${BASE}/tts`, { text: "hello" })],
		},
	},
	{
		file: "version-control/invitations/[inviteId]/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/version-control/invitations/i1`, {}),
				params({ inviteId: "i1" }),
			],
			DELETE: [
				makeRequest("DELETE", `${BASE}/version-control/invitations/i1`),
				params({ inviteId: "i1" }),
			],
		},
	},
	{
		file: "version-control/media/route.ts",
		calls: {
			POST: [makeRequest("POST", `${BASE}/version-control/media`)],
		},
	},
	{
		file: "version-control/media/[hash]/route.ts",
		calls: {
			GET: [
				makeRequest("GET", `${BASE}/version-control/media/abc`),
				params({ hash: "abc" }),
			],
		},
	},
	{
		file: "version-control/repos/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/version-control/repos`, {
					projectId: "p1",
					name: "repo",
				}),
			],
			GET: [makeRequest("GET", `${BASE}/version-control/repos?projectId=p1`)],
		},
	},
	{
		file: "version-control/repos/[repoId]/branches/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/version-control/repos/r1/branches`, {
					name: "b",
				}),
				params({ repoId: "r1" }),
			],
			GET: [
				makeRequest("GET", `${BASE}/version-control/repos/r1/branches`),
				params({ repoId: "r1" }),
			],
		},
	},
	{
		file: "version-control/repos/[repoId]/branches/[name]/route.ts",
		calls: {
			PUT: [
				makeRequest("PUT", `${BASE}/version-control/repos/r1/branches/b`, {}),
				params({ repoId: "r1", name: "b" }),
			],
			DELETE: [
				makeRequest("DELETE", `${BASE}/version-control/repos/r1/branches/b`),
				params({ repoId: "r1", name: "b" }),
			],
		},
	},
	{
		file: "version-control/repos/[repoId]/commits/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/version-control/repos/r1/commits`, {
					message: "m",
				}),
				params({ repoId: "r1" }),
			],
			GET: [
				makeRequest("GET", `${BASE}/version-control/repos/r1/commits`),
				params({ repoId: "r1" }),
			],
		},
	},
	{
		file: "version-control/repos/[repoId]/commits/[commitId]/route.ts",
		calls: {
			GET: [
				makeRequest("GET", `${BASE}/version-control/repos/r1/commits/c1`),
				params({ repoId: "r1", commitId: "c1" }),
			],
		},
	},
	{
		file: "version-control/repos/[repoId]/fork/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/version-control/repos/r1/fork`, {}),
				params({ repoId: "r1" }),
			],
		},
	},
	{
		file: "version-control/repos/[repoId]/members/route.ts",
		calls: {
			GET: [
				makeRequest("GET", `${BASE}/version-control/repos/r1/members`),
				params({ repoId: "r1" }),
			],
			POST: [
				makeRequest("POST", `${BASE}/version-control/repos/r1/members`, {
					email: "x@example.test",
					role: "editor",
				}),
				params({ repoId: "r1" }),
			],
		},
	},
	{
		file: "version-control/repos/[repoId]/members/[userId]/route.ts",
		calls: {
			PATCH: [
				makeRequest("PATCH", `${BASE}/version-control/repos/r1/members/u1`, {
					role: "viewer",
				}),
				params({ repoId: "r1", userId: "u1" }),
			],
			DELETE: [
				makeRequest("DELETE", `${BASE}/version-control/repos/r1/members/u1`),
				params({ repoId: "r1", userId: "u1" }),
			],
		},
	},
	{
		file: "version-control/repos/[repoId]/media/route.ts",
		calls: {
			GET: [
				makeRequest("GET", `${BASE}/version-control/repos/r1/media`),
				params({ repoId: "r1" }),
			],
			POST: [
				makeRequest("POST", `${BASE}/version-control/repos/r1/media`, {
					hashes: [],
				}),
				params({ repoId: "r1" }),
			],
		},
	},
	{
		file: "version-control/repos/[repoId]/sync/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/version-control/repos/r1/sync`, {}),
				params({ repoId: "r1" }),
			],
		},
	},
	{
		file: "version-control/repos/[repoId]/tags/route.ts",
		calls: {
			POST: [
				makeRequest("POST", `${BASE}/version-control/repos/r1/tags`, {
					name: "v1",
				}),
				params({ repoId: "r1" }),
			],
			GET: [
				makeRequest("GET", `${BASE}/version-control/repos/r1/tags`),
				params({ repoId: "r1" }),
			],
		},
	},
	{
		file: "version-control/repos/[repoId]/tags/[name]/route.ts",
		calls: {
			DELETE: [
				makeRequest("DELETE", `${BASE}/version-control/repos/r1/tags/v1`),
				params({ repoId: "r1", name: "v1" }),
			],
		},
	},
	{
		file: "version-control/shared/route.ts",
		calls: {
			GET: [makeRequest("GET", `${BASE}/version-control/shared`)],
		},
	},
];

/** Recursively find every route.ts under src/app/api, relative to API_DIR. */
function discoverRouteFiles(): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__tests__") continue;
				walk(full);
			} else if (entry.name === "route.ts") {
				found.push(path.relative(API_DIR, full));
			}
		}
	};
	walk(API_DIR);
	return found.sort();
}

describe("route-protection sweep — every session-gated handler 401s without a session", () => {
	for (const { file, calls } of SWEEP) {
		for (const [method, args] of Object.entries(calls)) {
			it(`${method} ${file.replace(/\/route\.ts$/, "")} → 401`, async () => {
				const mod = (await import(path.join(API_DIR, file))) as RouteModule;
				const handler = mod[method] as Handler | undefined;
				if (typeof handler !== "function") {
					throw new Error(
						`${file} does not export ${method} — update the sweep table`,
					);
				}
				const res = await handler(...(args as never[]));
				expect(res.status).toBe(401);
			});
		}
	}
});

describe("route-protection classification — no route ships unclassified", () => {
	const discovered = discoverRouteFiles();
	const sweepFiles = new Set(SWEEP.map((c) => c.file));

	it("every API route is session-checked (and swept) or explicitly public", () => {
		const problems: string[] = [];
		for (const file of discovered) {
			const source = readFileSync(path.join(API_DIR, file), "utf8");
			const hasSessionCheck = source.includes(SESSION_CHECK);
			const isPublic = file in PUBLIC_ROUTES;
			const isExcluded = file in EXCLUDED_SESSION_ROUTES;

			if (hasSessionCheck) {
				if (!sweepFiles.has(file) && !isExcluded) {
					problems.push(
						`${file} is session-gated but missing from the executed sweep table — add it to SWEEP`,
					);
				}
			} else if (!isPublic) {
				problems.push(
					`${file} has NO session check and is not on the PUBLIC_ROUTES allowlist — ` +
						`gate it with auth.api.getSession or consciously declare it public (with a reason)`,
				);
			}
		}
		expect(problems).toEqual([]);
	});

	it("the sweep table, allowlist, and exclusions only reference routes that exist", () => {
		const discoveredSet = new Set(discovered);
		const stale = [
			...sweepFiles,
			...Object.keys(PUBLIC_ROUTES),
			...Object.keys(EXCLUDED_SESSION_ROUTES),
		].filter((f) => !discoveredSet.has(f));
		expect(stale).toEqual([]);
	});

	it("no route is classified as both public and swept", () => {
		const both = Object.keys(PUBLIC_ROUTES).filter((f) => sweepFiles.has(f));
		expect(both).toEqual([]);
	});

	it("every swept method is exported by its route (no rotted table entries)", async () => {
		const missing: string[] = [];
		for (const { file, calls } of SWEEP) {
			const mod = (await import(path.join(API_DIR, file))) as RouteModule;
			for (const method of Object.keys(calls)) {
				if (typeof mod[method] !== "function") {
					missing.push(`${file} does not export ${method}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});
});
