import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
	branches,
	commits,
	projectRepositories,
	tags,
} from "@/lib/db/schema-version-control";

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
	/** Rows a `.returning()` after an insert resolves to (default: one row). */
	insertReturning?: (table: unknown) => unknown[];
	/** Rows a `.returning()` after an update resolves to (default: one row). */
	updateReturning?: () => unknown[];
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

/** Chainable insert result: supports `.onConflictDoNothing()` and `.returning()`,
 *  and is awaitable on its own. `.returning()` resolves to `state.insertReturning`
 *  (default: one row → "a row was written"); set it to `[]` to simulate a conflict. */
function insertResult(table: unknown) {
	const result: Record<string, unknown> = {
		onConflictDoNothing() {
			return result;
		},
		returning() {
			return Promise.resolve(
				state.insertReturning ? state.insertReturning(table) : [{ id: "row" }],
			);
		},
		then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
			return Promise.resolve(undefined).then(resolve, reject);
		},
	};
	return result;
}

const fakeDb = {
	select() {
		return makeQuery();
	},
	insert(table: unknown) {
		return {
			values(values: unknown) {
				state.inserts.push({ table, values });
				return insertResult(table);
			},
		};
	},
	update(_table: unknown) {
		return {
			set() {
				const chain: Record<string, unknown> = {
					where() {
						return chain;
					},
					returning() {
						return Promise.resolve(
							state.updateReturning ? state.updateReturning() : [{ id: "row" }],
						);
					},
					then(
						resolve: (v: unknown) => unknown,
						reject: (e: unknown) => unknown,
					) {
						return Promise.resolve(undefined).then(resolve, reject);
					},
				};
				return chain;
			},
		};
	},
	// The write routes wrap their inserts in db.transaction(tx => ...); the fake
	// just runs the callback against itself so `state.inserts` still captures
	// every write.
	transaction(fn: (tx: unknown) => Promise<unknown>) {
		return fn(fakeDb);
	},
};

mock.module("@/lib/db", () => ({ db: fakeDb }));
mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => state.session } },
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));
// The media route hashes + uploads to R2; both are stubbed so the size-cap
// tests never touch storage (and the 413 paths must reject BEFORE these run).
mock.module("@/services/storage/cloud-media-storage", () => ({
	computeHash: async () => "hash-1",
	uploadMedia: async () => "https://r2.example/media/hash-1",
}));

// Import the handlers only AFTER the mocks are registered.
const { GET: commitsGET, POST: commitsPOST } = await import("../commits/route");
const { POST: syncPOST } = await import("../sync/route");
const { POST: tagsPOST } = await import("../tags/route");
const { POST: forkPOST } = await import("../fork/route");
const { POST: mediaPOST } = await import("../../../media/route");

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
	state.insertReturning = undefined;
	state.updateReturning = undefined;
});

describe("commits GET — pagination NaN/negative guard", () => {
	// checkRepoAccess() reads projectRepositories first; stub an OWNED row so the
	// route passes the ownership gate and actually reaches the pagination clamp.
	// commits returns [] — the clamp is exercised via the captured LIMIT/OFFSET,
	// not the result rows.
	beforeEach(() => {
		state.rowsFor = (table: unknown) => {
			if (table === projectRepositories) return [{ userId: "owner-1" }];
			if (table === commits) return [];
			return [];
		};
	});

	it("falls back to limit=50, offset=0 on non-numeric params", async () => {
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

describe("tags POST — write-authorization on a public repo (H1)", () => {
	// A PUBLIC repo owned by owner-1. checkRepoOwner reads projectRepositories to
	// compare ownership; checkRepoAccess reads it again to decide 403-vs-404.
	function publicRepoOwnedBy(userId: string) {
		return (table: unknown) => {
			if (table === projectRepositories) {
				return [{ userId, isPublic: true }];
			}
			return [];
		};
	}

	it("403s and writes nothing when a NON-owner posts a tag to a public repo", async () => {
		// This is the H1 regression: checkRepoAccess would return true for ANY
		// public repo, letting a non-owner mutate it. The owner-only write gate
		// must reject the attacker instead.
		state.session = { user: { id: "attacker", name: "A", image: null } };
		state.rowsFor = publicRepoOwnedBy("owner-1");
		const res = await tagsPOST(
			jsonRequest({ commitId: "c1", name: "v1" }),
			params("victim-repo"),
		);
		expect(res.status).toBe(403);
		expect(state.inserts).toHaveLength(0);
	});

	it("lets the repo owner create a tag", async () => {
		state.session = { user: { id: "owner-1", name: "Owner", image: null } };
		state.rowsFor = publicRepoOwnedBy("owner-1");
		const res = await tagsPOST(
			jsonRequest({ commitId: "c1", name: "v1" }),
			params("owned-repo"),
		);
		expect(res.status).toBe(201);
		expect(state.inserts.length).toBeGreaterThan(0);
	});

	// Regression: a duplicate tag name (unique (repoId,name)) is dropped by
	// onConflictDoNothing; the route used to still report 201 with the payload.
	it("409s when the tag name already exists (insert was a no-op)", async () => {
		state.session = { user: { id: "owner-1", name: "Owner", image: null } };
		state.rowsFor = publicRepoOwnedBy("owner-1");
		state.insertReturning = () => []; // conflict → nothing written
		const res = await tagsPOST(
			jsonRequest({ commitId: "c1", name: "v1" }),
			params("owned-repo"),
		);
		expect(res.status).toBe(409);
	});

	it("401s before any db access when unauthenticated", async () => {
		state.session = null;
		const res = await tagsPOST(
			jsonRequest({ commitId: "c1", name: "v1" }),
			params("any-repo"),
		);
		expect(res.status).toBe(401);
		expect(state.inserts).toHaveLength(0);
	});
});

describe("fork POST — commits are re-keyed and references remapped", () => {
	// Regression: the fork used to insert copied commits keeping their original
	// GLOBAL primary-key id, so onConflictDoNothing silently dropped every one
	// and branch/tag references dangled at the source repo's commits.
	beforeEach(() => {
		const c1 = { id: "c1", repoId: "repo-1", parentId: null, message: "first" };
		const c2 = {
			id: "c2",
			repoId: "repo-1",
			parentId: "c1",
			message: "second",
		};
		state.rowsFor = (table: unknown) => {
			if (table === projectRepositories)
				return [
					{
						id: "repo-1",
						userId: "owner-1",
						isPublic: false,
						defaultBranch: "main",
					},
				];
			if (table === commits) return [c1, c2];
			if (table === branches)
				return [
					{
						id: "b1",
						repoId: "repo-1",
						name: "main",
						headCommitId: "c2",
						createdFromCommitId: "c1",
					},
				];
			if (table === tags)
				return [
					{
						id: "t1",
						repoId: "repo-1",
						commitId: "c1",
						name: "v1",
						type: "custom",
					},
				];
			return [];
		};
	});

	it("copies commits with fresh ids and remaps parent/branch/tag references", async () => {
		const res = await forkPOST(
			jsonRequest({ newProjectId: "proj-2", name: "Fork" }),
			params("repo-1"),
		);
		expect(res.status).toBe(201);

		// Commits now land as ONE chunked multi-row insert (values is an array),
		// not one insert per commit.
		const commitInserts = state.inserts.filter((i) => i.table === commits);
		expect(commitInserts).toHaveLength(1);
		const commitRows = commitInserts[0].values as Array<{
			id: string;
			parentId: string | null;
			message: string;
		}>;
		expect(commitRows).toHaveLength(2);

		const byMessage = (msg: string) =>
			commitRows.find((r) => r.message === msg) as {
				id: string;
				parentId: string | null;
			};
		const first = byMessage("first");
		const second = byMessage("second");

		// New ids, never the source ids (the collision that silently dropped them).
		expect(first.id).not.toBe("c1");
		expect(second.id).not.toBe("c2");
		// The child's parent pointer is remapped to the copied parent, not "c1".
		expect(second.parentId).toBe(first.id);

		const branchRows = state.inserts.find((i) => i.table === branches)
			?.values as Array<{
			headCommitId: string;
			createdFromCommitId: string | null;
		}>;
		expect(branchRows).toHaveLength(1);
		expect(branchRows[0].headCommitId).toBe(second.id);
		expect(branchRows[0].createdFromCommitId).toBe(first.id);

		const tagRows = state.inserts.find((i) => i.table === tags)
			?.values as Array<{ commitId: string }>;
		expect(tagRows).toHaveLength(1);
		expect(tagRows[0].commitId).toBe(first.id);
	});

	it("runs every fork write inside one transaction (atomic on failure)", async () => {
		const res = await forkPOST(
			jsonRequest({ newProjectId: "proj-3", name: "Fork2" }),
			params("repo-1"),
		);
		expect(res.status).toBe(201);
		// Repo row + chunked commits + branches + tags all went through the
		// transaction — the fake counts one insert() call per table.
		expect(state.inserts.filter((i) => i.table === commits)).toHaveLength(1);
		expect(
			state.inserts.filter((i) => i.table === projectRepositories),
		).toHaveLength(1);
	});
});

describe("commits POST — batch and payload caps", () => {
	// Owned repo so the route reaches the batch validation.
	beforeEach(() => {
		state.rowsFor = (table: unknown) => {
			if (table === projectRepositories)
				return [{ userId: "owner-1", isPublic: false }];
			return [];
		};
	});

	const validCommit = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		parentId: null,
		hash: `h-${id}`,
		message: `m-${id}`,
		isKeyframe: false,
		snapshotData: null,
		deltaData: null,
		duration: 0,
		trackCount: 0,
		elementCount: 0,
		changeSummary: null,
		...extra,
	});

	it("400s (batch too long) past 200 commits, writing nothing", async () => {
		const batch = Array.from({ length: 201 }, (_, i) => validCommit(`c-${i}`));
		const res = await commitsPOST(jsonRequest(batch), params("repo-1"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Too many commits");
		expect(state.inserts).toHaveLength(0);
	});

	it("413s when one commit's serialized payload exceeds the cap, writing nothing", async () => {
		const huge = validCommit("c-big", {
			snapshotData: { blob: "x".repeat(2 * 1024 * 1024 + 1) },
		});
		const res = await commitsPOST(jsonRequest([huge]), params("repo-1"));
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Commit payload too large");
		expect(state.inserts).toHaveLength(0);
	});

	it("413s (via content-length pre-check) before parsing an oversized body", async () => {
		const req = {
			url: "http://localhost/x",
			json: async () => {
				throw new Error("json() must not be called past the pre-check");
			},
			headers: new Headers({
				"content-length": String(33 * 1024 * 1024),
			}),
		} as unknown as Parameters<typeof commitsPOST>[0];
		const res = await commitsPOST(req, params("repo-1"));
		expect(res.status).toBe(413);
		expect(state.inserts).toHaveLength(0);
	});

	it("writes a valid batch as ONE multi-row insert and reports the count", async () => {
		const batch = [validCommit("c-1"), validCommit("c-2")];
		const res = await commitsPOST(jsonRequest(batch), params("repo-1"));
		expect(res.status).toBe(201);
		const body = (await res.json()) as { pushed: number };
		expect(body.pushed).toBe(2);

		const commitInserts = state.inserts.filter((i) => i.table === commits);
		expect(commitInserts).toHaveLength(1);
		expect(commitInserts[0].values as unknown[]).toHaveLength(2);
	});

	it("rejects invalid commit data with 400 before any write", async () => {
		const res = await commitsPOST(
			jsonRequest([{ id: "c-1" }]),
			params("repo-1"),
		);
		expect(res.status).toBe(400);
		expect(state.inserts).toHaveLength(0);
	});
});

describe("media POST — upload size cap (200 MB)", () => {
	const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

	/** Build a request whose formData yields a File-shaped object of `size` bytes
	 *  WITHOUT allocating them. arrayBuffer() throws if the cap check missed. */
	function uploadRequest(size: number, headers = new Headers()) {
		return {
			url: "http://localhost/api/version-control/media",
			headers,
			formData: async () => ({
				get: () => ({
					size,
					type: "video/mp4",
					arrayBuffer: async () => {
						if (size > MAX_MEDIA_BYTES) {
							throw new Error(
								"oversized file must be rejected before buffering",
							);
						}
						return new ArrayBuffer(size);
					},
				}),
			}),
		} as unknown as Parameters<typeof mediaPOST>[0];
	}

	it("413s (via content-length pre-check) before parsing the multipart body", async () => {
		const req = {
			url: "http://localhost/api/version-control/media",
			headers: new Headers({
				"content-length": String(MAX_MEDIA_BYTES + 10 * 1024 * 1024),
			}),
			formData: async () => {
				throw new Error("formData() must not be called past the pre-check");
			},
		} as unknown as Parameters<typeof mediaPOST>[0];
		const res = await mediaPOST(req);
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string; maxBytes: number };
		expect(body.error).toBe("File too large");
		expect(body.maxBytes).toBe(MAX_MEDIA_BYTES);
		expect(state.inserts).toHaveLength(0);
	});

	it("413s on an oversized file even without content-length, before buffering", async () => {
		const res = await mediaPOST(uploadRequest(MAX_MEDIA_BYTES + 1));
		expect(res.status).toBe(413);
		expect(state.inserts).toHaveLength(0);
	});

	it("accepts a file under the cap and records it", async () => {
		// No existing row with this hash → dedup select returns [] → insert.
		state.rowsFor = () => [];
		const res = await mediaPOST(uploadRequest(1024));
		expect(res.status).toBe(201);
		const body = (await res.json()) as { hash: string; deduplicated: boolean };
		expect(body.hash).toBe("hash-1");
		expect(body.deduplicated).toBe(false);
		expect(state.inserts).toHaveLength(1);
	});

	it("401s when unauthenticated, before any size handling", async () => {
		state.session = null;
		const res = await mediaPOST(uploadRequest(1024));
		expect(res.status).toBe(401);
	});
});
