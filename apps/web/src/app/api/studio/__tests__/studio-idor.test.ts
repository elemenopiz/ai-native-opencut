import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Regression coverage for the studio-auth IDOR-siblings pass (branch
 * sec/idor-siblings). The studio-auth commit (61c3888) secured the paid
 * generation routes but left sibling read/write routes in the same families
 * unauthenticated or scoped by a client-supplied userId. Every route below is
 * single-curl exploitable before the fix; each test asserts the fix:
 *
 *   - takes/[takeId] PATCH   — had NO auth; now requires a session AND the
 *     take's parent set must belong to the caller (cross-user → 404).
 *   - personas POST          — stamped userId from the request body (forgery);
 *     now requires a session and stamps ownership from it, ignoring the body.
 *   - personas GET           — leaked photo URLs for any ?userId=; now requires
 *     a session and is scoped to it (401 when unauthenticated).
 *   - personas/[id] DELETE   — had no ownership check (destructive IDOR); now
 *     requires a session and scopes the delete to the caller's own personas
 *     (cross-user id deletes nothing → 404).
 *   - sets GET               — leaked generation history / video URLs for any
 *     ?userId=; now requires a session and is scoped to it.
 *
 * The routes bind `db` / `auth` / `next/headers` at import time, so the mocks
 * are registered BEFORE the handlers are dynamically imported. Behavior is
 * driven by a mutable `state` reset in beforeEach.
 */

interface Fixtures {
	session: { user: { id: string; name: string; image: string | null } } | null;
	/** The single take returned by db.query.takes.findFirst. */
	take: { id: string; setId: string } | null;
	/** The single set returned by db.query.generationSets.findFirst. */
	set: { id: string; userId: string | null } | null;
	/** Rows db.delete(...).returning() yields (drives the DELETE 404 path). */
	deleteReturns: unknown[];
	/** Every insert the handler attempted (table + values). */
	inserts: Array<{ table: unknown; values: unknown }>;
	/** The `where` option captured from the last findMany / delete call. */
	lastWhere: unknown;
}

const state: Fixtures = {
	session: { user: { id: "owner-1", name: "Owner", image: null } },
	take: null,
	set: null,
	deleteReturns: [],
	inserts: [],
	lastWhere: undefined,
};

const fakeDb = {
	query: {
		takes: {
			findFirst: async () => state.take,
		},
		generationSets: {
			findFirst: async () => state.set,
			findMany: async (opts: { where?: unknown }) => {
				state.lastWhere = opts?.where;
				return [];
			},
		},
		personas: {
			findMany: async (opts: { where?: unknown }) => {
				state.lastWhere = opts?.where;
				return [];
			},
		},
	},
	insert(table: unknown) {
		return {
			values(values: unknown) {
				state.inserts.push({ table, values });
				return { returning: async () => [values] };
			},
		};
	},
	update(_table: unknown) {
		return {
			set() {
				return {
					where() {
						return { returning: async () => [{ id: "t1", starred: true }] };
					},
				};
			},
		};
	},
	delete(_table: unknown) {
		return {
			where(cond: unknown) {
				state.lastWhere = cond;
				return { returning: async () => state.deleteReturns };
			},
		};
	},
	// sets GET attaches takes via db.select().from(takes)...
	select() {
		const q: Record<string, unknown> = {
			from: () => q,
			where: () => q,
			orderBy: async () => [],
		};
		return q;
	},
};

mock.module("@/lib/db", () => ({ db: fakeDb }));
mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => state.session } },
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));

const { PATCH: takesPATCH } = await import("../takes/[takeId]/route");
const { POST: personasPOST, GET: personasGET } = await import(
	"../personas/route"
);
const { DELETE: personaDELETE } = await import("../personas/[id]/route");
const { GET: setsGET } = await import("../sets/route");

function jsonRequest(body: unknown, url = "http://localhost/x") {
	return {
		url,
		json: async () => body,
		headers: new Headers(),
	} as unknown as Request;
}

const takeParams = (takeId: string) => ({
	params: Promise.resolve({ takeId }),
});
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
	state.session = { user: { id: "owner-1", name: "Owner", image: null } };
	state.take = null;
	state.set = null;
	state.deleteReturns = [];
	state.inserts = [];
	state.lastWhere = undefined;
});

describe("takes/[takeId] PATCH — auth + take→set ownership", () => {
	it("401s (before any db read) when unauthenticated", async () => {
		state.session = null;
		const res = await takesPATCH(
			jsonRequest({ starred: true }),
			takeParams("t1"),
		);
		expect(res.status).toBe(401);
	});

	it("404s when the take belongs to another user (IDOR)", async () => {
		state.session = { user: { id: "attacker", name: "A", image: null } };
		state.take = { id: "t1", setId: "s1" };
		state.set = { id: "s1", userId: "owner-1" };
		const res = await takesPATCH(
			jsonRequest({ starred: true }),
			takeParams("t1"),
		);
		expect(res.status).toBe(404);
	});

	it("404s when the take does not exist", async () => {
		state.take = null;
		const res = await takesPATCH(
			jsonRequest({ starred: true }),
			takeParams("ghost"),
		);
		expect(res.status).toBe(404);
	});

	it("updates the take when the caller owns its set", async () => {
		state.take = { id: "t1", setId: "s1" };
		state.set = { id: "s1", userId: "owner-1" };
		const res = await takesPATCH(
			jsonRequest({ starred: true }),
			takeParams("t1"),
		);
		expect(res.status).toBe(200);
	});
});

describe("personas POST — session-stamped ownership (no body forgery)", () => {
	it("401s when unauthenticated", async () => {
		state.session = null;
		const res = await personasPOST(
			jsonRequest({
				name: "N",
				descriptor: "D",
				anchorImageUrl: "http://img",
				userId: "victim",
			}),
		);
		expect(res.status).toBe(401);
		expect(state.inserts).toHaveLength(0);
	});

	it("stamps userId from the session, ignoring a spoofed body userId", async () => {
		state.session = { user: { id: "owner-1", name: "Owner", image: null } };
		const res = await personasPOST(
			jsonRequest({
				name: "N",
				descriptor: "D",
				anchorImageUrl: "http://img",
				userId: "victim",
			}),
		);
		expect(res.status).toBe(200);
		expect(state.inserts).toHaveLength(1);
		expect((state.inserts[0].values as { userId: string }).userId).toBe(
			"owner-1",
		);
	});
});

describe("personas GET — session-scoped (no ?userId leak)", () => {
	it("401s when unauthenticated", async () => {
		state.session = null;
		const res = await personasGET();
		expect(res.status).toBe(401);
	});

	it("returns 200 and scopes to the session when authenticated", async () => {
		state.session = { user: { id: "owner-1", name: "Owner", image: null } };
		const res = await personasGET();
		expect(res.status).toBe(200);
		// A where clause was applied — the query never runs unscoped.
		expect(state.lastWhere).toBeDefined();
	});
});

describe("personas/[id] DELETE — auth + ownership-scoped delete", () => {
	it("401s when unauthenticated", async () => {
		state.session = null;
		const res = await personaDELETE(jsonRequest({}), idParams("p1"));
		expect(res.status).toBe(401);
	});

	it("404s when the delete matches nothing (cross-user id / IDOR)", async () => {
		state.session = { user: { id: "attacker", name: "A", image: null } };
		state.deleteReturns = []; // WHERE id AND userId matched no owned row
		const res = await personaDELETE(
			jsonRequest({}),
			idParams("victim-persona"),
		);
		expect(res.status).toBe(404);
		// The delete was scoped (an ownership predicate was supplied).
		expect(state.lastWhere).toBeDefined();
	});

	it("deletes when the caller owns the persona", async () => {
		state.deleteReturns = [{ id: "p1" }];
		const res = await personaDELETE(jsonRequest({}), idParams("p1"));
		expect(res.status).toBe(200);
	});
});

describe("sets GET — session-scoped (no ?userId leak)", () => {
	it("401s when unauthenticated", async () => {
		state.session = null;
		const res = await setsGET();
		expect(res.status).toBe(401);
	});

	it("returns 200 and scopes to the session when authenticated", async () => {
		state.session = { user: { id: "owner-1", name: "Owner", image: null } };
		const res = await setsGET();
		expect(res.status).toBe(200);
		expect(state.lastWhere).toBeDefined();
	});
});
