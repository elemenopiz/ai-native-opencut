import { afterEach, describe, expect, test } from "bun:test";
import { OWNER_EMAILS } from "@/lib/credits/signup-grant";
import {
	AI_ACCESS_DENIED_CODE,
	aiAccessCutoff,
	aiAccessDeniedResponse,
	hasAiAccess,
} from "../ai-access";

// Save/restore every env var this file mutates — mirrors the save-once/
// restore-in-afterEach idiom in `__tests__/rate-limit.test.ts`.
const savedCutoff = process.env.AI_ACCESS_CUTOFF;
const savedAllowlist = process.env.AI_ACCESS_ALLOWLIST;
afterEach(() => {
	if (savedCutoff === undefined) {
		delete process.env.AI_ACCESS_CUTOFF;
	} else {
		process.env.AI_ACCESS_CUTOFF = savedCutoff;
	}
	if (savedAllowlist === undefined) {
		delete process.env.AI_ACCESS_ALLOWLIST;
	} else {
		process.env.AI_ACCESS_ALLOWLIST = savedAllowlist;
	}
});

// A fixed cutoff so createdAt-relative assertions never depend on the real
// system date (or on the shipped default drifting in the future).
const CUTOFF = "2026-07-23T00:00:00.000Z";

describe("hasAiAccess", () => {
	test("an owner email has access even when created after the cutoff", () => {
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		expect(
			hasAiAccess({
				email: OWNER_EMAILS[0],
				createdAt: new Date("2099-01-01T00:00:00.000Z"),
			}),
		).toBe(true);
	});

	test("owner email match is case-insensitive", () => {
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		expect(
			hasAiAccess({
				email: OWNER_EMAILS[0].toUpperCase(),
				createdAt: new Date("2099-01-01T00:00:00.000Z"),
			}),
		).toBe(true);
	});

	test("an account created well before the cutoff has access", () => {
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		expect(
			hasAiAccess({
				email: "early-user@example.com",
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
			}),
		).toBe(true);
	});

	test("an account created after the cutoff does not have access", () => {
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		expect(
			hasAiAccess({
				email: "new-user@example.com",
				createdAt: new Date("2026-08-01T00:00:00.000Z"),
			}),
		).toBe(false);
	});

	test("createdAt exactly at the cutoff does not have access (strict less-than)", () => {
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		expect(
			hasAiAccess({
				email: "on-the-dot@example.com",
				createdAt: new Date(CUTOFF),
			}),
		).toBe(false);
	});

	test("a createdAt string parses the same as a createdAt Date", () => {
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		expect(
			hasAiAccess({
				email: "string-date@example.com",
				createdAt: "2026-01-01T00:00:00.000Z",
			}),
		).toBe(true);
	});

	test("null user has no access", () => {
		expect(hasAiAccess(null)).toBe(false);
	});

	test("undefined user has no access", () => {
		expect(hasAiAccess(undefined)).toBe(false);
	});

	test("a user with no email and no createdAt has no access", () => {
		expect(hasAiAccess({})).toBe(false);
	});

	test("an allowlisted email has access even when created after the cutoff", () => {
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		process.env.AI_ACCESS_ALLOWLIST = "Invited@Example.com, other@example.com";
		expect(
			hasAiAccess({
				email: "invited@example.com",
				createdAt: new Date("2099-01-01T00:00:00.000Z"),
			}),
		).toBe(true);
	});

	test("an email NOT on the allowlist, created after the cutoff, has no access", () => {
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		process.env.AI_ACCESS_ALLOWLIST = "invited@example.com";
		expect(
			hasAiAccess({
				email: "stranger@example.com",
				createdAt: new Date("2099-01-01T00:00:00.000Z"),
			}),
		).toBe(false);
	});

	test("an unset allowlist grants nobody access via that path", () => {
		delete process.env.AI_ACCESS_ALLOWLIST;
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		expect(
			hasAiAccess({
				email: "nobody@example.com",
				createdAt: new Date("2099-01-01T00:00:00.000Z"),
			}),
		).toBe(false);
	});

	test("garbage createdAt does not throw and resolves to no access", () => {
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		expect(
			hasAiAccess({
				email: "garbage-date@example.com",
				createdAt: "not-a-real-date",
			}),
		).toBe(false);
	});

	test("missing createdAt with a non-owner/non-allowlisted email has no access", () => {
		process.env.AI_ACCESS_CUTOFF = CUTOFF;
		expect(
			hasAiAccess({ email: "no-createdat@example.com", createdAt: undefined }),
		).toBe(false);
	});
});

describe("aiAccessCutoff", () => {
	test("falls back to the shipped default when AI_ACCESS_CUTOFF is unset", () => {
		delete process.env.AI_ACCESS_CUTOFF;
		expect(aiAccessCutoff().toISOString()).toBe("2026-07-23T00:00:00.000Z");
	});

	test("falls back to the shipped default when AI_ACCESS_CUTOFF is unparsable", () => {
		process.env.AI_ACCESS_CUTOFF = "not-a-date";
		expect(aiAccessCutoff().toISOString()).toBe("2026-07-23T00:00:00.000Z");
	});

	test("honors a valid AI_ACCESS_CUTOFF override", () => {
		process.env.AI_ACCESS_CUTOFF = "2020-01-01T00:00:00.000Z";
		expect(aiAccessCutoff().toISOString()).toBe("2020-01-01T00:00:00.000Z");
	});
});

describe("aiAccessDeniedResponse", () => {
	test("returns a 403 carrying the machine-readable denial code", async () => {
		const res = aiAccessDeniedResponse();
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string; code: string };
		expect(body.code).toBe(AI_ACCESS_DENIED_CODE);
		expect(typeof body.error).toBe("string");
	});
});
