import { beforeEach, describe, expect, it, mock } from "bun:test";
import { webEnv as realWebEnv } from "@byorn/env/web";
import {
	projectInvitations,
	projectMembers,
	projectRepositories,
} from "@/lib/db/schema-version-control";
import { users } from "@/lib/db/schema";

/**
 * Coverage for the project-collaboration routes (sharing by email):
 *   - members POST: owner-only invite, self-invite rejection, email lowercasing
 *   - invitations POST: only the addressed email may respond; accept creates
 *     the membership row
 *   - members/[userId] DELETE: owner removes anyone, members may only remove
 *     themselves (leave)
 *   - sync POST: viewers may pull but a push is rejected 403 (write gate)
 *
 * Same import-time-mocking pattern as vc-routes.test.ts: register mocks, then
 * dynamically import the handlers, drive behavior via mutable `state`.
 */

interface State {
	session: {
		user: { id: string; name: string; email: string; image: string | null };
	} | null;
	rowsFor: (table: unknown) => unknown[];
	inserts: Array<{ table: unknown; values: unknown }>;
	updates: Array<{ table: unknown; values: unknown }>;
	deletes: Array<{ table: unknown }>;
	deleteReturning?: () => unknown[];
	sentEmails: Array<{ to: string; subject: string }>;
}

const state: State = {
	session: null,
	rowsFor: () => [],
	inserts: [],
	updates: [],
	deletes: [],
	sentEmails: [],
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
		leftJoin() {
			return q;
		},
		where() {
			return q;
		},
		orderBy() {
			return q;
		},
		limit() {
			return q;
		},
		offset() {
			return q;
		},
		then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
			return Promise.resolve(state.rowsFor(table)).then(resolve, reject);
		},
	};
	return q;
}

function insertResult(table: unknown, values: unknown) {
	const result: Record<string, unknown> = {
		onConflictDoNothing() {
			return result;
		},
		onConflictDoUpdate() {
			return result;
		},
		returning() {
			return Promise.resolve([values]);
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
				return insertResult(table, values);
			},
		};
	},
	update(table: unknown) {
		return {
			set(values: unknown) {
				state.updates.push({ table, values });
				const chain: Record<string, unknown> = {
					where() {
						return chain;
					},
					returning() {
						return Promise.resolve([{ id: "row" }]);
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
	delete(table: unknown) {
		state.deletes.push({ table });
		const chain: Record<string, unknown> = {
			where() {
				return chain;
			},
			returning() {
				return Promise.resolve(
					state.deleteReturning ? state.deleteReturning() : [{ id: "row" }],
				);
			},
			then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
				return Promise.resolve(undefined).then(resolve, reject);
			},
		};
		return chain;
	},
	transaction(fn: (tx: unknown) => Promise<unknown>) {
		return fn(fakeDb);
	},
};

mock.module("@/lib/db", () => ({ db: fakeDb }));
mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => state.session } },
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));
mock.module("@/lib/auth/email", () => ({
	sendEmail: async ({ to, subject }: { to: string; subject: string }) => {
		state.sentEmails.push({ to, subject });
	},
}));
// mock.module is GLOBAL to the whole bun-test run — preserve the real parsed
// env's full shape (other files read other keys) and override only the URL the
// invite email embeds.
mock.module("@byorn/env/web", () => ({
	webEnv: {
		...realWebEnv,
		NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
	},
}));

const { POST: membersPOST } = await import("../repos/[repoId]/members/route");
const { DELETE: memberDELETE } = await import(
	"../repos/[repoId]/members/[userId]/route"
);
const { POST: inviteRespondPOST } = await import(
	"../invitations/[inviteId]/route"
);
const { POST: syncPOST } = await import("../repos/[repoId]/sync/route");

function jsonRequest(body: unknown, url = "http://localhost/x") {
	return {
		url,
		json: async () => body,
		headers: new Headers(),
	} as unknown as Parameters<typeof membersPOST>[0];
}

const repoParams = (repoId: string) => ({
	params: Promise.resolve({ repoId }),
});
const memberParams = (repoId: string, userId: string) => ({
	params: Promise.resolve({ repoId, userId }),
});
const inviteParams = (inviteId: string) => ({
	params: Promise.resolve({ inviteId }),
});

function sessionFor(id: string, email: string) {
	return { user: { id, name: id, email, image: null } };
}

/** Repo owned by `ownerId`; the caller's membership row (if any) via `member`. */
function repoWithMembership(
	ownerId: string,
	member: { role: string } | null,
	extras: Partial<Record<"invitations" | "users", unknown[]>> = {},
) {
	return (table: unknown) => {
		if (table === projectRepositories) {
			return [
				{
					userId: ownerId,
					isPublic: false,
					name: "Reel",
					projectId: "proj-1",
					defaultBranch: "main",
				},
			];
		}
		if (table === projectMembers) return member ? [member] : [];
		if (table === projectInvitations) return extras.invitations ?? [];
		if (table === users) return extras.users ?? [];
		return [];
	};
}

beforeEach(() => {
	state.session = sessionFor("owner-1", "owner@byorn.app");
	state.rowsFor = () => [];
	state.inserts = [];
	state.updates = [];
	state.deletes = [];
	state.deleteReturning = undefined;
	state.sentEmails = [];
});

describe("members POST — invite authorization", () => {
	it("403s when a non-owner member tries to invite", async () => {
		state.session = sessionFor("editor-1", "editor@byorn.app");
		state.rowsFor = repoWithMembership("owner-1", { role: "editor" });
		const res = await membersPOST(
			jsonRequest({ email: "friend@byorn.app", role: "editor" }),
			repoParams("repo-1"),
		);
		expect(res.status).toBe(403);
		expect(state.inserts).toHaveLength(0);
	});

	it("404s for a complete outsider (repo existence not leaked)", async () => {
		state.session = sessionFor("attacker", "attacker@byorn.app");
		state.rowsFor = repoWithMembership("owner-1", null);
		const res = await membersPOST(
			jsonRequest({ email: "friend@byorn.app", role: "editor" }),
			repoParams("repo-1"),
		);
		expect(res.status).toBe(404);
		expect(state.inserts).toHaveLength(0);
	});

	it("owner invite creates a pending invitation with the email lowercased", async () => {
		state.rowsFor = repoWithMembership("owner-1", null);
		const res = await membersPOST(
			jsonRequest({ email: "Friend@Byorn.App", role: "viewer" }),
			repoParams("repo-1"),
		);
		expect(res.status).toBe(201);
		expect(state.inserts).toHaveLength(1);
		const values = state.inserts[0].values as Record<string, unknown>;
		expect(state.inserts[0].table).toBe(projectInvitations);
		expect(values.email).toBe("friend@byorn.app");
		expect(values.role).toBe("viewer");
		expect(values.status).toBe("pending");
		// Best-effort email went to the invitee.
		expect(state.sentEmails).toHaveLength(1);
		expect(state.sentEmails[0].to).toBe("friend@byorn.app");
	});

	it("rejects inviting yourself", async () => {
		state.rowsFor = repoWithMembership("owner-1", null);
		const res = await membersPOST(
			jsonRequest({ email: "owner@byorn.app", role: "editor" }),
			repoParams("repo-1"),
		);
		expect(res.status).toBe(400);
		expect(state.inserts).toHaveLength(0);
	});
});

describe("invitations POST — responding", () => {
	const pendingInvite = {
		id: "inv-1",
		repoId: "repo-1",
		email: "friend@byorn.app",
		role: "editor",
		status: "pending",
		invitedBy: "owner-1",
	};

	it("404s when the invite is addressed to a different email", async () => {
		state.session = sessionFor("someone", "other@byorn.app");
		state.rowsFor = (table) =>
			table === projectInvitations ? [pendingInvite] : [];
		const res = await inviteRespondPOST(
			jsonRequest({ action: "accept" }),
			inviteParams("inv-1"),
		);
		expect(res.status).toBe(404);
		expect(state.inserts).toHaveLength(0);
	});

	it("accept creates the membership and marks the invite accepted", async () => {
		state.session = sessionFor("friend-1", "friend@byorn.app");
		state.rowsFor = (table) =>
			table === projectInvitations ? [pendingInvite] : [];
		const res = await inviteRespondPOST(
			jsonRequest({ action: "accept" }),
			inviteParams("inv-1"),
		);
		expect(res.status).toBe(200);
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0].table).toBe(projectMembers);
		const member = state.inserts[0].values as Record<string, unknown>;
		expect(member.userId).toBe("friend-1");
		expect(member.repoId).toBe("repo-1");
		expect(member.role).toBe("editor");
		expect(state.updates).toHaveLength(1);
		expect((state.updates[0].values as Record<string, unknown>).status).toBe(
			"accepted",
		);
	});

	it("decline records the response without creating a membership", async () => {
		state.session = sessionFor("friend-1", "friend@byorn.app");
		state.rowsFor = (table) =>
			table === projectInvitations ? [pendingInvite] : [];
		const res = await inviteRespondPOST(
			jsonRequest({ action: "decline" }),
			inviteParams("inv-1"),
		);
		expect(res.status).toBe(200);
		expect(state.inserts).toHaveLength(0);
		expect((state.updates[0].values as Record<string, unknown>).status).toBe(
			"declined",
		);
	});
});

describe("members DELETE — removal rules", () => {
	it("owner can remove a teammate", async () => {
		state.rowsFor = repoWithMembership("owner-1", null);
		const res = await memberDELETE(
			jsonRequest({}),
			memberParams("repo-1", "editor-1"),
		);
		expect(res.status).toBe(200);
		expect(state.deletes).toHaveLength(1);
	});

	it("a member can leave (remove themselves)", async () => {
		state.session = sessionFor("editor-1", "editor@byorn.app");
		state.rowsFor = repoWithMembership("owner-1", { role: "editor" });
		const res = await memberDELETE(
			jsonRequest({}),
			memberParams("repo-1", "editor-1"),
		);
		expect(res.status).toBe(200);
		expect(state.deletes).toHaveLength(1);
	});

	it("a member cannot remove someone else", async () => {
		state.session = sessionFor("editor-1", "editor@byorn.app");
		state.rowsFor = repoWithMembership("owner-1", { role: "editor" });
		const res = await memberDELETE(
			jsonRequest({}),
			memberParams("repo-1", "other-member"),
		);
		expect(res.status).toBe(403);
		expect(state.deletes).toHaveLength(0);
	});
});

describe("sync POST — role-gated push", () => {
	it("a viewer may pull (no push payload) and gets the repo history", async () => {
		state.session = sessionFor("viewer-1", "viewer@byorn.app");
		state.rowsFor = repoWithMembership("owner-1", { role: "viewer" });
		const res = await syncPOST(
			jsonRequest({ knownCommitIds: [] }),
			repoParams("repo-1"),
		);
		expect(res.status).toBe(200);
	});

	it("a viewer pushing commits is rejected with 403 and writes nothing", async () => {
		state.session = sessionFor("viewer-1", "viewer@byorn.app");
		state.rowsFor = repoWithMembership("owner-1", { role: "viewer" });
		const res = await syncPOST(
			jsonRequest({
				knownCommitIds: [],
				pushCommits: [{ id: "c-1", message: "sneaky" }],
			}),
			repoParams("repo-1"),
		);
		expect(res.status).toBe(403);
		expect(state.inserts).toHaveLength(0);
	});

	it("an editor member may push", async () => {
		state.session = sessionFor("editor-1", "editor@byorn.app");
		state.rowsFor = repoWithMembership("owner-1", { role: "editor" });
		const res = await syncPOST(
			jsonRequest({
				knownCommitIds: [],
				pushCommits: [{ id: "c-1", message: "editor work", hash: "c-1" }],
			}),
			repoParams("repo-1"),
		);
		expect(res.status).toBe(200);
	});

	it("an outsider still gets 404", async () => {
		state.session = sessionFor("attacker", "attacker@byorn.app");
		state.rowsFor = repoWithMembership("owner-1", null);
		const res = await syncPOST(
			jsonRequest({ knownCommitIds: [] }),
			repoParams("repo-1"),
		);
		expect(res.status).toBe(404);
	});
});
