import { beforeEach, describe, expect, it, mock } from "bun:test";
import { commitMediaRefs, mediaObjects } from "@/lib/db/schema-version-control";

/**
 * BUG24 (tenancy floor, MED) regression: GET /api/version-control/media/[hash]
 * was session-gated but had no repo-access check — any authenticated user who
 * knew a SHA-256 hash could fetch another user's media via a global lookup +
 * 302 redirect to R2. The fix requires EITHER the caller to be the uploader
 * OR checkRepoAccess to succeed for at least one repo referencing the hash.
 *
 * This is the only file mocking these modules (route-test convention — see
 * repos/[repoId]/__tests__/vc-routes.test.ts), so mock.module registration
 * here can't bleed into other test files run in the same process.
 */

interface MediaRow {
	hash: string;
	size: number;
	mimeType: string;
	storageUrl: string;
	width: number | null;
	height: number | null;
	duration: number | null;
	uploadedBy: string | null;
	uploadedAt: Date;
}

interface State {
	session: { user: { id: string; name: string; image: string | null } } | null;
	mediaRow: MediaRow | null;
	/** repoIds returned as the distinct commits.repoId set referencing the hash. */
	referencingRepoIds: string[];
	/** repoIds checkRepoAccess should grant the current caller. */
	accessibleRepoIds: Set<string>;
	/** Captured (repoId, userId) pairs passed to checkRepoAccess, in call order. */
	accessChecks: Array<{ repoId: string; userId: string }>;
}

const state: State = {
	session: { user: { id: "caller-1", name: "Caller", image: null } },
	mediaRow: null,
	referencingRepoIds: [],
	accessibleRepoIds: new Set(),
	accessChecks: [],
};

function makeQuery() {
	let table: unknown;
	const q: Record<string, unknown> = {
		from(t: unknown) {
			table = t;
			return q;
		},
		innerJoin() {
			return q;
		},
		where() {
			return q;
		},
		limit() {
			return q;
		},
		// biome-ignore lint/suspicious/noThenProperty: fake query builder is a deliberate thenable so the route can `await` a drizzle select — mirrors sibling vc-routes.test.ts
		then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
			let rows: unknown[] = [];
			if (table === mediaObjects) {
				rows = state.mediaRow ? [state.mediaRow] : [];
			} else if (table === commitMediaRefs) {
				rows = state.referencingRepoIds.map((repoId) => ({ repoId }));
			}
			return Promise.resolve(rows).then(resolve, reject);
		},
	};
	return q;
}

const fakeDb = {
	select() {
		return makeQuery();
	},
	selectDistinct() {
		return makeQuery();
	},
};

mock.module("@/lib/db", () => ({ db: fakeDb }));
mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => state.session } },
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));
mock.module("@/lib/db/version-control-utils", () => ({
	checkRepoAccess: async (repoId: string, userId: string) => {
		state.accessChecks.push({ repoId, userId });
		return state.accessibleRepoIds.has(repoId);
	},
}));

// Import the handler only AFTER the mocks are registered.
const { GET } = await import("../route");

const params = (hash: string) => ({ params: Promise.resolve({ hash }) });

function baseRow(overrides: Partial<MediaRow> = {}): MediaRow {
	return {
		hash: "hash-abc",
		size: 1024,
		mimeType: "video/mp4",
		storageUrl: "https://r2.example/media/hash-abc",
		width: null,
		height: null,
		duration: null,
		uploadedBy: "someone-else",
		uploadedAt: new Date(),
		...overrides,
	};
}

beforeEach(() => {
	state.session = { user: { id: "caller-1", name: "Caller", image: null } };
	state.mediaRow = null;
	state.referencingRepoIds = [];
	state.accessibleRepoIds = new Set();
	state.accessChecks = [];
});

describe("GET /api/version-control/media/[hash] — tenancy (BUG24)", () => {
	it("403s a caller with no access to any referencing repo and uploadedBy someone else, and does NOT redirect", async () => {
		state.mediaRow = baseRow({ uploadedBy: "victim" });
		state.referencingRepoIds = ["repo-victim"];
		state.accessibleRepoIds = new Set(); // no access granted

		const res = await GET(
			{} as unknown as Parameters<typeof GET>[0],
			params("hash-abc"),
		);

		expect(res.status).toBe(403);
		expect(res.headers.get("location")).toBeNull();
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Forbidden");
		// The route must have actually consulted checkRepoAccess for the
		// referencing repo, not just skipped straight to denial.
		expect(state.accessChecks).toEqual([
			{ repoId: "repo-victim", userId: "caller-1" },
		]);
	});

	it("redirects when the caller has access to a repo referencing the hash", async () => {
		state.mediaRow = baseRow({
			uploadedBy: "someone-else",
			storageUrl: "https://r2.example/media/hash-abc",
		});
		state.referencingRepoIds = ["repo-a", "repo-b"];
		state.accessibleRepoIds = new Set(["repo-b"]);

		const res = await GET(
			{} as unknown as Parameters<typeof GET>[0],
			params("hash-abc"),
		);

		expect([302, 307]).toContain(res.status);
		expect(res.headers.get("location")).toBe(
			"https://r2.example/media/hash-abc",
		);
	});

	it("redirects the uploader even with zero referencing repos (upload -> register-refs window)", async () => {
		state.mediaRow = baseRow({
			uploadedBy: "caller-1",
			storageUrl: "https://r2.example/media/hash-abc",
		});
		state.referencingRepoIds = [];

		const res = await GET(
			{} as unknown as Parameters<typeof GET>[0],
			params("hash-abc"),
		);

		expect([302, 307]).toContain(res.status);
		expect(res.headers.get("location")).toBe(
			"https://r2.example/media/hash-abc",
		);
		// Uploader match short-circuits before any repo-access check.
		expect(state.accessChecks).toHaveLength(0);
	});

	it("401s when unauthenticated, before touching the db", async () => {
		state.session = null;
		state.mediaRow = baseRow();

		const res = await GET(
			{} as unknown as Parameters<typeof GET>[0],
			params("hash-abc"),
		);

		expect(res.status).toBe(401);
		expect(state.accessChecks).toHaveLength(0);
	});

	it("404s on an unknown hash", async () => {
		state.mediaRow = null;

		const res = await GET(
			{} as unknown as Parameters<typeof GET>[0],
			params("no-such-hash"),
		);

		expect(res.status).toBe(404);
	});
});
