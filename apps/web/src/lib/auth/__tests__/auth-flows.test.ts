import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like, or, sql } from "drizzle-orm";
import { webEnv } from "@byorn/env/web";
import { accounts, sessions, users, verifications } from "@/lib/db/schema";
import { commits, projectRepositories } from "@/lib/db/schema-version-control";

// ── Real-module re-pin (the arrangements/__tests__/route.test.ts pattern) ────
// Bun's `mock.module` registry is process-global and keyed by RESOLVED module
// path. Several route suites (studio-idor, vc-routes, collaboration-routes,
// llm/*, the route-protection sweep) register fakes for "@/lib/auth/server"
// and "@/lib/db" for their own purposes; in a full `bun test` run those fakes
// leak into any file that imports the plain alias. This suite needs the REAL
// better-auth server wired to the REAL drizzle/Postgres db, so:
//  1. load each real implementation through a query-suffixed specifier — a
//     DISTINCT module entry that bypasses the mock registry;
//  2. re-pin the alias to a pass-through of the real exports, so the real
//     auth server's own `import { db } from "@/lib/db"` also resolves real.
// Order matters: the db alias must be re-pinned BEFORE the auth server module
// is evaluated, because better-auth captures `db` at module init.
const realDbModule = (await import(
	"../../db/index.ts?real" as string
)) as typeof import("@/lib/db");
mock.module("@/lib/db", () => ({ ...realDbModule }));

const realAuthModule = (await import(
	"../server.ts?real" as string
)) as typeof import("@/lib/auth/server");
mock.module("@/lib/auth/server", () => ({ ...realAuthModule }));

const { db } = realDbModule;
const { auth } = realAuthModule;

// ── Deletion-floor capability probe (migration 0009) ─────────────────────────
// The delete-account-with-commits regression below asserts the FIXED behavior:
// vc_commits.author_id ON DELETE SET NULL. That constraint ships in migration
// 0009, which — per the gated-migration workflow — is NOT applied to the shared
// dev/test Postgres by the packet author. So the connected DB may still be at
// 0008 (no fix). Rather than fail on an un-migrated DB, we introspect the live
// constraint once and skip the regression LOUDLY when the floor isn't present.
// The real behavior is proven against a throwaway scratch DB in the migration
// packet's report; this test locks it in for any DB that HAS applied 0009.
async function probeDeleteFloor(): Promise<boolean> {
	const rows = (await db.execute(sql`
		SELECT c.confdeltype AS del
		FROM pg_constraint c
		JOIN pg_attribute a
		  ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.contype = 'f'
		  AND c.conrelid = 'vc_commits'::regclass
		  AND a.attname = 'author_id'
		  AND c.confrelid = 'users'::regclass
		LIMIT 1
	`)) as unknown as Array<{ del: string }>;
	// 'n' = SET NULL. Anything else (typically 'a' = NO ACTION on a pre-0009 DB)
	// means the deletion floor is not in place yet.
	return rows[0]?.del === "n";
}

const deleteFloorActive = await probeDeleteFloor();
if (!deleteFloorActive) {
	console.warn(
		"[auth-flows.test] SKIPPING delete-account-with-commits regression: the " +
			"connected database has NOT applied migration 0009 " +
			"(vc_commits.author_id is not yet ON DELETE SET NULL). This activates " +
			"once 0009 is applied. Real behavior is verified against a scratch DB " +
			"in the 0009 migration packet report.",
	);
}

/**
 * AUTH-CRITICAL integration coverage, real better-auth server + real local
 * Postgres (bun test preloads apps/web/.env.local — same harness as the
 * credit-ledger suites). Nothing between the test and production wiring except
 * the HTTP transport: requests are dispatched straight at `auth.handler`, the
 * exact function `app/api/auth/[...all]/route.ts` wraps (a source-scan test
 * below pins that wiring), so the session cookie contract, the drizzle
 * adapter, and the configured better-auth options are all the real thing.
 *
 * WHY `auth.handler`: dispatching requests straight at the handler function
 * that `app/api/auth/[...all]/route.ts` wraps exercises the exact production
 * wiring without needing a Next server. The real instance is obtained via the
 * `?real` re-pin above (see that comment) — plain alias imports of
 * "@/lib/auth/server" are poisoned by other suites' mocks in a full run. If
 * the re-pin ever breaks and a mock leaks in, the sign-up test fails loudly
 * ("auth.handler is not a function") rather than silently passing.
 *
 * better-auth INTERNALS are not under test — OUR wiring is:
 *
 *  - sign-up mints a user row + a usable session cookie (requireEmailVerification
 *    is OFF by design — see lib/auth/server.ts — so this also locks in that
 *    signup is not verification-blocked);
 *  - sign-in mints a session; bad credentials are rejected WITHOUT revealing
 *    whether the email exists (same status + body for both);
 *  - sign-out revokes the session server-side (cookie replay → no session);
 *  - delete-user requires a session AND the correct password, and actually
 *    removes the user row (plus sessions/accounts) — the destructive path the
 *    account page's DeleteAccountDialog drives;
 *  - request-password-reset responds IDENTICALLY for known and unknown emails
 *    (no account-existence oracle). Email sending itself is the dev fallback
 *    (RESEND_API_KEY unset locally) which logs instead of sending and never
 *    throws.
 *
 * Rate limiting is disabled outside production (better-auth default), so the
 * Upstash storage configured in lib/auth/server.ts is never touched here.
 *
 * Every test user carries the `authtest-` email prefix; afterEach removes the
 * users created by that test and afterAll sweeps stragglers, mirroring the
 * self-cleaning convention of lib/credits/__tests__.
 */

const BASE = webEnv.NEXT_PUBLIC_SITE_URL;
const EMAIL_PREFIX = "authtest-";
const PASSWORD = "correct-horse-battery";

function freshEmail(): string {
	return `${EMAIL_PREFIX}${crypto.randomUUID()}@example.test`;
}

const createdEmails: string[] = [];

interface AuthCallOptions {
	body?: unknown;
	cookie?: string;
}

/** POST a JSON body at the real better-auth handler, as a browser would. */
async function authPost(
	path: string,
	{ body, cookie }: AuthCallOptions = {},
): Promise<Response> {
	const request = new Request(`${BASE}/api/auth${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			// better-auth checks the Origin of state-changing requests against
			// trustedOrigins — send the same origin a real browser would.
			origin: BASE,
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body ?? {}),
	});
	return auth.handler(request);
}

async function authGet(path: string, cookie?: string): Promise<Response> {
	const request = new Request(`${BASE}/api/auth${path}`, {
		method: "GET",
		headers: cookie ? { cookie } : {},
	});
	return auth.handler(request);
}

/** Collapse a response's Set-Cookie headers into a Cookie request header. */
function cookieFrom(res: Response): string {
	const setCookies = res.headers.getSetCookie();
	return setCookies
		.map((c) => c.split(";")[0])
		.filter(Boolean)
		.join("; ");
}

/** Sign up a fresh throwaway user; returns its email and session cookie. */
async function signUp(): Promise<{ email: string; cookie: string }> {
	const email = freshEmail();
	createdEmails.push(email);
	const res = await authPost("/sign-up/email", {
		body: { name: "Auth Test", email, password: PASSWORD },
	});
	expect(res.status).toBe(200);
	const cookie = cookieFrom(res);
	expect(cookie).toContain("session_token");
	return { email, cookie };
}

async function sessionUser(cookie: string): Promise<{ email: string } | null> {
	const res = await authGet("/get-session", cookie);
	expect(res.status).toBe(200);
	const data = (await res.json()) as { user?: { email: string } } | null;
	return data?.user ?? null;
}

async function findUser(email: string) {
	const rows = await db
		.select({ id: users.id, email: users.email })
		.from(users)
		.where(eq(users.email, email));
	return rows[0] ?? null;
}

async function cleanupEmails(emails: string[]) {
	if (emails.length === 0) return;
	const rows = await db
		.select({ id: users.id })
		.from(users)
		.where(inArray(users.email, emails));
	const ids = rows.map((r) => r.id);
	if (ids.length > 0) {
		await db.delete(sessions).where(inArray(sessions.userId, ids));
		await db.delete(accounts).where(inArray(accounts.userId, ids));
		// Reset tokens store the user id in `value`; verification emails embed
		// the email address. Cover both.
		await db
			.delete(verifications)
			.where(
				or(
					inArray(verifications.value, ids),
					like(verifications.value, `%${EMAIL_PREFIX}%`),
				),
			);
		await db.delete(users).where(inArray(users.id, ids));
	}
}

afterEach(async () => {
	const emails = [...createdEmails];
	createdEmails.length = 0;
	await cleanupEmails(emails);
});

// Belt-and-suspenders: sweep stragglers from a previously crashed run.
afterAll(async () => {
	const rows = await db
		.select({ id: users.id, email: users.email })
		.from(users)
		.where(like(users.email, `${EMAIL_PREFIX}%`));
	await cleanupEmails(rows.map((r) => r.email));
});

describe("sign-up — mints a user and a working session", () => {
	it("creates the user row and returns a session cookie that resolves to the user", async () => {
		const { email, cookie } = await signUp();

		const row = await findUser(email);
		expect(row).not.toBeNull();
		expect(row?.email).toBe(email);

		const user = await sessionUser(cookie);
		expect(user?.email).toBe(email);
	});

	it("is not blocked by email verification (requireEmailVerification is OFF by design)", async () => {
		const { email, cookie } = await signUp();
		// The session works immediately, before any verification link is clicked.
		expect((await sessionUser(cookie))?.email).toBe(email);
	});
});

describe("sign-in — mints a session; bad credentials reveal nothing", () => {
	it("signs an existing user in with the correct password", async () => {
		const { email } = await signUp();

		const res = await authPost("/sign-in/email", {
			body: { email, password: PASSWORD },
		});
		expect(res.status).toBe(200);
		const cookie = cookieFrom(res);
		expect((await sessionUser(cookie))?.email).toBe(email);
	});

	it("rejects a wrong password and an unknown email IDENTICALLY (no account-existence oracle)", async () => {
		const { email } = await signUp();

		const wrongPassword = await authPost("/sign-in/email", {
			body: { email, password: "not-the-password" },
		});
		const unknownEmail = await authPost("/sign-in/email", {
			body: { email: freshEmail(), password: "not-the-password" },
		});

		expect(wrongPassword.status).toBe(401);
		expect(unknownEmail.status).toBe(wrongPassword.status);
		// Byte-identical bodies: a caller cannot distinguish "user exists, wrong
		// password" from "no such user".
		expect(await unknownEmail.text()).toBe(await wrongPassword.text());
	});
});

describe("sign-out — revokes the session server-side", () => {
	it("a signed-out session cookie no longer resolves to a user", async () => {
		const { email, cookie } = await signUp();
		expect((await sessionUser(cookie))?.email).toBe(email);

		const res = await authPost("/sign-out", { cookie, body: {} });
		expect(res.status).toBe(200);

		// Replaying the OLD cookie must not work — the session row is gone, not
		// merely the browser cookie.
		expect(await sessionUser(cookie)).toBeNull();
	});
});

describe("delete-user — session + password required; the row actually goes away", () => {
	it("401s without a session", async () => {
		const res = await authPost("/delete-user", {
			body: { password: PASSWORD },
		});
		expect(res.status).toBe(401);
	});

	it("rejects a wrong password and leaves the user intact", async () => {
		const { email, cookie } = await signUp();

		const res = await authPost("/delete-user", {
			cookie,
			body: { password: "not-the-password" },
		});
		expect(res.status).toBe(400);

		expect(await findUser(email)).not.toBeNull();
		// The session survives a failed attempt.
		expect((await sessionUser(cookie))?.email).toBe(email);
	});

	it("deletes the user row, credential account, and sessions with the correct password", async () => {
		const { email, cookie } = await signUp();
		const row = await findUser(email);
		expect(row).not.toBeNull();
		const userId = (row as { id: string }).id;

		const res = await authPost("/delete-user", {
			cookie,
			body: { password: PASSWORD },
		});
		expect(res.status).toBe(200);

		// User row gone.
		expect(await findUser(email)).toBeNull();
		// Credential account + session rows gone (cascade / explicit revoke).
		const accountRows = await db
			.select({ id: accounts.id })
			.from(accounts)
			.where(eq(accounts.userId, userId));
		expect(accountRows).toEqual([]);
		const sessionRows = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.userId, userId));
		expect(sessionRows).toEqual([]);
		// The old cookie is dead.
		expect(await sessionUser(cookie)).toBeNull();
	});

	it("leaves OTHER users completely untouched (no cross-user blast radius)", async () => {
		const bystander = await signUp();
		const doomed = await signUp();

		const bystanderRow = await findUser(bystander.email);
		expect(bystanderRow).not.toBeNull();
		const bystanderId = (bystanderRow as { id: string }).id;

		const res = await authPost("/delete-user", {
			cookie: doomed.cookie,
			body: { password: PASSWORD },
		});
		expect(res.status).toBe(200);
		expect(await findUser(doomed.email)).toBeNull();

		// The bystander's user row, credential account, and live session all
		// survive — deletion is scoped to exactly one user.
		expect(await findUser(bystander.email)).not.toBeNull();
		const bystanderAccounts = await db
			.select({ id: accounts.id })
			.from(accounts)
			.where(eq(accounts.userId, bystanderId));
		expect(bystanderAccounts.length).toBeGreaterThan(0);
		expect((await sessionUser(bystander.cookie))?.email).toBe(bystander.email);
	});

	it("cascades the user's OWN version-control data — no orphaned repo/commit rows", async () => {
		const { email, cookie } = await signUp();
		const row = await findUser(email);
		const userId = (row as { id: string }).id;

		// Seed a repo owned by the user — the shape the vc sync layer writes
		// (project_repositories.user_id has onDelete: "cascade").
		//
		// Deliberately NO vc_commits row here — see the KNOWN PRODUCT DEFECT
		// note below: a commit authored by the user (even in their OWN repo)
		// makes /delete-user 500 today, so the commit-cascade half of this
		// scenario cannot be asserted without a product fix.
		const repoId = `authtest-repo-${crypto.randomUUID()}`;
		try {
			await db.insert(projectRepositories).values({
				id: repoId,
				projectId: `authtest-project-${crypto.randomUUID()}`,
				userId,
				name: "delete-cascade probe repo",
			});

			const res = await authPost("/delete-user", {
				cookie,
				body: { password: PASSWORD },
			});
			expect(res.status).toBe(200);
			expect(await findUser(email)).toBeNull();

			// The repo does not survive as an orphan.
			const repoRows = await db
				.select({ id: projectRepositories.id })
				.from(projectRepositories)
				.where(eq(projectRepositories.id, repoId));
			expect(repoRows).toEqual([]);
		} finally {
			// If the deletion failed midway, do not leave seeded rows behind for
			// other suites sharing this Postgres.
			await db
				.delete(projectRepositories)
				.where(eq(projectRepositories.id, repoId));
		}
	});

	// DELETION FLOOR (migration 0009) — was a KNOWN PRODUCT DEFECT until fixed:
	// a user who authored ANY vc_commit could not delete their account, because
	// vc_commits.author_id had no onDelete action, so Postgres rejected the
	// users-row delete with FK violation 23503 (vc_commits_author_id_fkey) and
	// /delete-user returned 500 with the row intact. Same hazard on
	// vc_tags.created_by, vc_media_objects.uploaded_by, project_members.invited_by,
	// project_invitations.invited_by. Migration 0009 flips all five to
	// ON DELETE SET NULL (authorName/authorAvatar stay denormalized on the commit
	// for display). This test proves the fix; it self-skips LOUDLY on a DB that
	// has not yet applied 0009 (see the probe near the top of this file).
	it.skipIf(!deleteFloorActive)(
		"lets a user who authored a commit in someone else's repo delete their account; the commit survives with author_id nulled and the denormalized name kept",
		async () => {
			// owner keeps the repo; doomed is a collaborator who authors a commit in it.
			const owner = await signUp();
			const doomed = await signUp();

			const ownerRow = await findUser(owner.email);
			const doomedRow = await findUser(doomed.email);
			const ownerId = (ownerRow as { id: string }).id;
			const doomedId = (doomedRow as { id: string }).id;

			const repoId = `authtest-repo-${crypto.randomUUID()}`;
			const commitId = `authtest-commit-${crypto.randomUUID()}`;
			try {
				await db.insert(projectRepositories).values({
					id: repoId,
					projectId: `authtest-project-${crypto.randomUUID()}`,
					userId: ownerId,
					name: "deletion-floor probe repo",
				});
				await db.insert(commits).values({
					id: commitId,
					repoId,
					hash: crypto.randomUUID().replace(/-/g, ""),
					message: "authored by the soon-to-be-deleted user",
					authorId: doomedId,
					authorName: "Doomed Author",
					authorAvatar: "https://example.test/avatar.png",
				});

				// Before 0009 this returned 500 (FK 23503). After 0009: 200.
				const res = await authPost("/delete-user", {
					cookie: doomed.cookie,
					body: { password: PASSWORD },
				});
				expect(res.status).toBe(200);
				expect(await findUser(doomed.email)).toBeNull();

				// The commit is NOT deleted (it lives in the owner's repo) — its
				// author_id is nulled, but the denormalized author_name/avatar the UI
				// renders are untouched.
				const commitRows = await db
					.select({
						authorId: commits.authorId,
						authorName: commits.authorName,
						authorAvatar: commits.authorAvatar,
					})
					.from(commits)
					.where(eq(commits.id, commitId));
				expect(commitRows).toHaveLength(1);
				expect(commitRows[0]?.authorId).toBeNull();
				expect(commitRows[0]?.authorName).toBe("Doomed Author");
				expect(commitRows[0]?.authorAvatar).toBe(
					"https://example.test/avatar.png",
				);
			} finally {
				// The commit survives the user delete by design — clean it (and the
				// owner's repo) up so this shared Postgres is left pristine.
				await db.delete(commits).where(eq(commits.id, commitId));
				await db
					.delete(projectRepositories)
					.where(eq(projectRepositories.id, repoId));
			}
		},
	);
});

describe("request-password-reset — no account-existence oracle", () => {
	it("responds identically for a known and an unknown email", async () => {
		const { email } = await signUp();

		const known = await authPost("/request-password-reset", {
			body: { email, redirectTo: "/reset-password" },
		});
		const unknown = await authPost("/request-password-reset", {
			body: { email: freshEmail(), redirectTo: "/reset-password" },
		});

		expect(known.status).toBe(200);
		expect(unknown.status).toBe(known.status);
		// Byte-identical bodies — the response leaks nothing about whether the
		// account exists. (better-auth also equalizes the timing by simulating
		// the token lookup on the unknown path.)
		expect(await unknown.text()).toBe(await known.text());
	});

	it("a reset request for a known email records a reset verification token", async () => {
		const { email } = await signUp();
		const row = await findUser(email);
		const userId = (row as { id: string }).id;

		const res = await authPost("/request-password-reset", {
			body: { email, redirectTo: "/reset-password" },
		});
		expect(res.status).toBe(200);

		// The reset token row exists, tied to the user (identifier is
		// `reset-password:<token>`, value is the user id).
		const tokens = await db
			.select({ identifier: verifications.identifier })
			.from(verifications)
			.where(eq(verifications.value, userId));
		expect(tokens.some((t) => t.identifier.startsWith("reset-password:"))).toBe(
			true,
		);
	});
});

describe("route wiring — /api/auth/[...all] exposes exactly this auth instance", () => {
	it("the catch-all route wraps `auth` with toNextJsHandler and exports GET+POST", () => {
		// The flows above dispatch at `auth.handler` (see the header comment for
		// why the route's exports can't be invoked under a full mocked run). This
		// pins the one line of glue between that handler and the public URL.
		const source = readFileSync(
			path.join(import.meta.dir, "../../../app/api/auth/[...all]/route.ts"),
			"utf8",
		);
		expect(source).toContain('import { auth } from "@/lib/auth/server"');
		expect(source).toContain("toNextJsHandler(auth)");
		expect(source).toMatch(/export const \{\s*POST,\s*GET\s*\}/);
	});
});
