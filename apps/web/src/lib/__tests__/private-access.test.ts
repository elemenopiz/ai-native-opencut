/**
 * Coverage for the private-testing lock.
 *
 * The property that matters most is the DEFAULT: with `PRIVATE_ACCESS_ALLOWLIST`
 * unset, nothing about the app changes. A regression there would lock everyone
 * out of a public product, which is a worse failure than the lock not working.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	hasPrivateAccess,
	isPrivateAccessEnabled,
	isPrivateAccessPublicPath,
	privateAccessAllowlist,
} from "@/lib/private-access";

const saved = process.env.PRIVATE_ACCESS_ALLOWLIST;

beforeEach(() => {
	process.env.PRIVATE_ACCESS_ALLOWLIST = undefined;
	// biome-ignore lint/performance/noDelete: restoring "unset", not "empty".
	delete process.env.PRIVATE_ACCESS_ALLOWLIST;
});

afterEach(() => {
	if (saved === undefined) {
		// biome-ignore lint/performance/noDelete: restoring "unset", not "empty".
		delete process.env.PRIVATE_ACCESS_ALLOWLIST;
	} else {
		process.env.PRIVATE_ACCESS_ALLOWLIST = saved;
	}
});

describe("off by default", () => {
	test("unset → lock disabled and everyone passes", () => {
		expect(isPrivateAccessEnabled()).toBe(false);
		expect(hasPrivateAccess("anyone@example.com")).toBe(true);
		// Even a missing email, because in public mode there is nothing to check.
		expect(hasPrivateAccess(null)).toBe(true);
		expect(hasPrivateAccess(undefined)).toBe(true);
	});

	test("empty or whitespace-only → still public, not a lock nobody can open", () => {
		process.env.PRIVATE_ACCESS_ALLOWLIST = "";
		expect(isPrivateAccessEnabled()).toBe(false);
		expect(hasPrivateAccess("anyone@example.com")).toBe(true);

		process.env.PRIVATE_ACCESS_ALLOWLIST = " , ,  ";
		expect(privateAccessAllowlist()).toEqual([]);
		expect(isPrivateAccessEnabled()).toBe(false);
		expect(hasPrivateAccess("anyone@example.com")).toBe(true);
	});
});

describe("locked", () => {
	beforeEach(() => {
		process.env.PRIVATE_ACCESS_ALLOWLIST = "owner@example.com";
	});

	test("the listed email gets in", () => {
		expect(isPrivateAccessEnabled()).toBe(true);
		expect(hasPrivateAccess("owner@example.com")).toBe(true);
	});

	test("case and surrounding whitespace do not decide access", () => {
		expect(hasPrivateAccess("  OWNER@Example.COM  ")).toBe(true);
		process.env.PRIVATE_ACCESS_ALLOWLIST = "  Owner@Example.com  ";
		expect(hasPrivateAccess("owner@example.com")).toBe(true);
	});

	test("anyone else is denied, including a missing email", () => {
		expect(hasPrivateAccess("someone@example.com")).toBe(false);
		expect(hasPrivateAccess("")).toBe(false);
		expect(hasPrivateAccess("   ")).toBe(false);
		expect(hasPrivateAccess(null)).toBe(false);
		expect(hasPrivateAccess(undefined)).toBe(false);
	});

	test("a substring of an allowed address is not allowed", () => {
		expect(hasPrivateAccess("owner@example.com.attacker.test")).toBe(false);
		expect(hasPrivateAccess("notowner@example.com")).toBe(false);
	});

	test("several emails can be listed", () => {
		process.env.PRIVATE_ACCESS_ALLOWLIST = "a@x.com, b@y.com ,c@z.com";
		expect(privateAccessAllowlist()).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
		expect(hasPrivateAccess("b@y.com")).toBe(true);
		expect(hasPrivateAccess("d@w.com")).toBe(false);
	});
});

describe("auth screens stay reachable", () => {
	test("otherwise a locked-out visitor could never sign in as someone allowed", () => {
		for (const p of [
			"/login",
			"/signup",
			"/forgot-password",
			"/reset-password",
			"/reset-password/abc123",
		]) {
			expect(isPrivateAccessPublicPath(p)).toBe(true);
		}
	});

	test("the product itself is not exempt", () => {
		for (const p of ["/", "/editor/abc", "/projects", "/account", "/blog"]) {
			expect(isPrivateAccessPublicPath(p)).toBe(false);
		}
	});

	test("a lookalike prefix is not exempt", () => {
		expect(isPrivateAccessPublicPath("/login-as-admin")).toBe(false);
		expect(isPrivateAccessPublicPath("/signups")).toBe(false);
	});
});
