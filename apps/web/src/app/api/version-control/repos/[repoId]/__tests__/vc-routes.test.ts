import { beforeEach, describe, expect, it, mock } from "bun:test";
import { commits, projectRepositories } from "@/lib/db/schema-version-control";

/**
 * Regression coverage for two bughunt fixes on the version-control routes:
 *   - commits GET pagination guard (commit dad849d): ?limit=abc / negative
 *     ?offset must never reach SQL as NaN/negative. limit clamps to [1,200],
 *     offset to >=0.
 *   - sync POST repo-ownership / IDOR enforcement (commit 4608410): the caller
 *     must own the repo before any commit/branch/tag history is read or written;
 *     otherwise 404 and NO writes.
 *
 * The routes bind `db` / `auth` at import time, so we register the mocks BEFORE
 * dynamically importing the handlers. Behavior is driven by per-test mutable
 * `state` reset in beforeEach. This is the only test file that mocks these
 * modules, so the global mock.module registration can't bleed into others.
 */

interface State {
	session: { user: { id: string; name: string; image: string | null } } | null;
	/** Rows the fake db returns for a `.from(table)` select, by table identity. */
	rowsFor: (table: unknown) => unknown[];
	/** Captured LIMIT / OFFSET from the last paginated select. */
	limit?: number;
	offset?: number;
	/** Every insert the handler attempted (table + values). */
	inserts: Array<{ table: unknown; values: unknown }>;
}

const state: State = {
	session: { user: { id: "owner-1", name: "Owner", image: null } },
	rowsFor: () => [],
	inserts: [],
};

function makeQuery() {
	let table: unknown;
	const q: Record<string, unknown> = {
		from(t: unknown) {
			table = t;
			return q;
		},
		where() {
			return q;
		},
		orderBy() {
			return q;
		},
		limit(n: number) {
			state.limit = n;
			return q;
		},
		offset(n: number) {
			state.offset = n;
			return q;
		},
		then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
			return Promise.resolve(state.rowsFor(table)).then(resolve, reject);
		},
	};
	return q;
}

const fakeDb = {
	select() {
		return makeQuery();
	},
	insert(table: unknown) {
		return {
			values(values: unknown) {
				state.inserts.push({ table, values });
				return { onConflictDoNothing: async () => undefined };
			},
		};
	},
};

mock.module("@/lib/db", () => ({ db: fakeDb }));
mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => state.session } },
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));

// Import the handlers only AFTER the mocks are registered.
const { GET: commitsGET } = await import("../commits/route");
const { POST: syncPOST } = await import("../sync/route");

function jsonRequest(body: unknown, url = "http://localhost/x") {
	return {
		url,
		json: async () => body,
		headers: new Headers(),
	} as unknown as Parameters<typeof syncPOST>[0];
}

function urlRequest(url: string) {
	return { url, headers: new Headers() } as unknown as Parameters<
		typeof commitsGET
	>[0];
}

const params = (repoId: string) => ({ params: Promise.resolve({ repoId }) });

beforeEach(() => {
	state.session = { user: { id: "owner-1", name: "Owner", image: null } };
	state.rowsFor = () => [];
	state.limit = undefined;
	state.offset = undefined;
	state.inserts = [];
});

describe("commits GET — pagination NaN/negative guard", () => {
	it("falls back to limit=50, offset=0 on non-numeric params", async () => {
		state.rowsFor = () => [];
		await commitsGET(
			urlRequest("http://localhost/c?limit=abc&offset=xyz"),
			params("repo-1"),
		);
		expect(state.limit).toBe(50);
		expect(state.offset).toBe(0);
	});

	it("clamps limit to a max of 200", async () => {
		await commitsGET(
			urlRequest("http://localhost/c?limit=9999"),
			params("repo-1"),
		);
		expect(state.limit).toBe(200);
	});

	it("raises a below-1 limit up to 1", async () => {
		await commitsGET(
			urlRequest("http://localhost/c?limit=0"),
			params("repo-1"),
		);
		expect(state.limit).toBe(1);
	});

	it("floors a negative offset to 0", async () => {
		await commitsGET(
			urlRequest("http://localhost/c?offset=-25"),
			params("repo-1"),
		);
		expect(state.offset).toBe(0);
	});

	it("passes valid limit/offset straight through", async () => {
		await commitsGET(
			urlRequest("http://localhost/c?limit=25&offset=10"),
			params("repo-1"),
		);
		expect(state.limit).toBe(25);
		expect(state.offset).toBe(10);
	});

	it("401s (before touching the db) when unauthenticated", async () => {
		state.session = null;
		const res = await commitsGET(
			urlRequest("http://localhost/c"),
			params("repo-1"),
		);
		expect(res.status).toBe(401);
		expect(state.limit).toBeUndefined();
	});
});

describe("sync POST — repo ownership (IDOR) enforcement", () => {
	// Route the ownership probe: projectRepositories → the owning-row lookup.
	function ownedBy(userId: string | null) {
		return (table: unknown) => {
			if (table === projectRepositories) {
				return userId ? [{ userId }] : [];
			}
			if (table === commits) return [];
			return [];
		};
	}

	it("404s and writes nothing when the repo does not exist", async () => {
		state.rowsFor = ownedBy(null);
		const res = await syncPOST(
			jsonRequest({
				knownCommitIds: [],
				pushCommits: [{ id: "c1", message: "m" }],
			}),
			params("ghost-repo"),
		);
		expect(res.status).toBe(404);
		expect(state.inserts).toHaveLength(0);
	});

	it("404s and writes nothing when another user owns the repo (IDOR)", async () => {
		state.session = { user: { id: "attacker", name: "A", image: null } };
		state.rowsFor = ownedBy("owner-1");
		const res = await syncPOST(
			jsonRequest({
				knownCommitIds: [],
				pushCommits: [{ id: "c1", message: "m" }],
			}),
			params("victim-repo"),
		);
		expect(res.status).toBe(404);
		expect(state.inserts).toHaveLength(0);
	});

	it("proceeds when the caller owns the repo", async () => {
		state.session = { user: { id: "owner-1", name: "Owner", image: null } };
		state.rowsFor = ownedBy("owner-1");
		const res = await syncPOST(
			jsonRequest({
				knownCommitIds: [],
				pushCommits: [{ id: "c1", message: "m" }],
			}),
			params("owned-repo"),
		);
		expect(res.status).toBe(200);
		// The owned push actually inserted the commit.
		expect(state.inserts.length).toBeGreaterThan(0);
		const body = (await res.json()) as { pushed: number };
		expect(body.pushed).toBe(1);
	});

	it("401s before the ownership probe when unauthenticated", async () => {
		state.session = null;
		const res = await syncPOST(
			jsonRequest({ knownCommitIds: [] }),
			params("any-repo"),
		);
		expect(res.status).toBe(401);
		expect(state.inserts).toHaveLength(0);
	});
});
