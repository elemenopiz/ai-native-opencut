import { describe, expect, it } from "bun:test";
import {
	MAX_BODY_BYTES,
	clientErrorSchema,
	redactPayload,
	redactSecrets,
} from "../intake";

/**
 * The client-error intake endpoint is unauthenticated, so these tests pin its
 * two abuse-safety layers: the strict payload schema and the secret redaction
 * that runs before anything reaches the logs.
 */

describe("redactSecrets — key/value patterns", () => {
	it("redacts token= and key= values but keeps the key name", () => {
		expect(redactSecrets("fetch failed: /api?token=abc123&x=1")).toBe(
			"fetch failed: /api?token=[redacted]&x=1",
		);
		expect(redactSecrets("bad key=sk-live-XYZ in config")).toBe(
			"bad key=[redacted] in config",
		);
	});

	it("redacts colon-style assignments and bearer headers", () => {
		expect(redactSecrets("Authorization: Bearer eyAbc.def")).toBe(
			"Authorization: [redacted]",
		);
		expect(redactSecrets('{"password": "hunter2"}')).toBe(
			'{"password": [redacted]"}',
		);
		expect(redactSecrets("api_key: 12345")).toBe("api_key: [redacted]");
	});

	it("is case-insensitive and handles secret/credential variants", () => {
		expect(redactSecrets("SECRET=shhh")).toBe("SECRET=[redacted]");
		expect(redactSecrets("credential = topsecretvalue")).toBe(
			"credential = [redacted]",
		);
	});
});

describe("redactSecrets — long opaque runs", () => {
	it("redacts long base64/url-safe runs (raw API keys, JWT segments)", () => {
		const b64 = "A".repeat(20) + "b1+_-".repeat(5); // 45 chars, no slashes
		expect(redactSecrets(`oops ${b64} oops`)).toBe("oops [redacted] oops");
	});

	it("redacts each segment of a JWT independently", () => {
		const seg = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef"; // 43 chars
		const jwt = `${seg}.${seg}.${seg}`;
		expect(redactSecrets(jwt)).toBe("[redacted].[redacted].[redacted]");
	});

	it("redacts long hex runs (session ids, digests)", () => {
		const hex = "deadbeef".repeat(8); // 64 hex chars
		expect(redactSecrets(`sid ${hex}!`)).toBe("sid [redacted]!");
	});

	it("leaves ordinary stack traces alone (paths contain slashes)", () => {
		const stack = [
			"TypeError: Cannot read properties of undefined (reading 'id')",
			"    at TimelineTrack (/Users/dev/apps/web/src/components/editor/timeline-track/index.tsx:42:13)",
			"    at renderWithHooks (webpack-internal:///node_modules/react-dom/cjs/react-dom.development.js:16305:18)",
		].join("\n");
		expect(redactSecrets(stack)).toBe(stack);
	});

	it("leaves short identifiers and normal prose alone", () => {
		const msg =
			"Failed to load clip 4f3a2b1c after 3 retries (monkey business)";
		expect(redactSecrets(msg)).toBe(msg);
	});
});

describe("redactPayload", () => {
	it("scrubs every string field, not just message", () => {
		const clean = redactPayload({
			message: "boom token=abc",
			stack: "at fn (/x.ts:1:1) key=sk-123",
			route: "/editor/p1?token=zzz",
			userAgent: "Mozilla/5.0",
		});
		expect(clean.message).toBe("boom token=[redacted]");
		expect(clean.stack).toBe("at fn (/x.ts:1:1) key=[redacted]");
		expect(clean.route).toBe("/editor/p1?token=[redacted]");
		expect(clean.userAgent).toBe("Mozilla/5.0");
	});
});

describe("clientErrorSchema", () => {
	it("accepts a minimal payload (message only)", () => {
		expect(clientErrorSchema.safeParse({ message: "boom" }).success).toBe(true);
	});

	it("accepts the full shape the client reporter sends", () => {
		const result = clientErrorSchema.safeParse({
			message: "boom",
			name: "TypeError",
			stack: "at x",
			componentStack: "in Timeline",
			digest: "12345",
			route: "/editor/p1",
			userAgent: "Mozilla/5.0",
			source: "window.onerror",
		});
		expect(result.success).toBe(true);
	});

	it("rejects a missing or empty message", () => {
		expect(clientErrorSchema.safeParse({}).success).toBe(false);
		expect(clientErrorSchema.safeParse({ message: "" }).success).toBe(false);
	});

	it("rejects oversized fields (belt to the body-size cap)", () => {
		expect(
			clientErrorSchema.safeParse({ message: "x".repeat(5_000) }).success,
		).toBe(false);
		expect(
			clientErrorSchema.safeParse({ message: "ok", stack: "x".repeat(20_000) })
				.success,
		).toBe(false);
	});

	it("rejects unknown source values and wrong types", () => {
		expect(
			clientErrorSchema.safeParse({ message: "ok", source: "evil" }).success,
		).toBe(false);
		expect(
			clientErrorSchema.safeParse({ message: "ok", stack: 42 }).success,
		).toBe(false);
	});

	it("body cap fits a fully maxed legitimate payload", () => {
		// Every string field at its schema max, plus generous headroom for the
		// remaining fields and JSON syntax, must still fit under the raw body
		// cap — otherwise a legitimate worst-case report would be 413'd.
		const maxFields = 4_000 + 12_000 + 8_000; // message + stack + componentStack
		const headroom = 4_000; // name/digest/route/userAgent/source + JSON overhead
		expect(maxFields + headroom < MAX_BODY_BYTES).toBe(true);
	});
});
