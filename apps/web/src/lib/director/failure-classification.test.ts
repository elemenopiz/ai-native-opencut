import { describe, expect, it } from "bun:test";
import { classifyFailure } from "./failure-classification";

describe("classifyFailure", () => {
	it("flags an empty result as retryable 'empty'", () => {
		const f = classifyFailure({ empty: true });
		expect(f.class).toBe("empty");
		expect(f.retryable).toBe(true);
	});

	it("classifies content-moderation rejections as non-retryable 'safety'", () => {
		for (const msg of [
			"Request blocked by our content moderation policy",
			"prompt flagged as NSFW",
			"This request was rejected by safety filters",
			"policy violation: sexual content",
		]) {
			const f = classifyFailure({ error: msg });
			expect(f.class).toBe("safety");
			expect(f.retryable).toBe(false);
		}
	});

	it("treats a safety signal as safety even under a 400 status", () => {
		const f = classifyFailure({
			status: 400,
			error: "content policy violation",
		});
		expect(f.class).toBe("safety");
		expect(f.retryable).toBe(false);
	});

	it("maps timeout statuses/messages to retryable 'timeout'", () => {
		expect(classifyFailure({ status: 504 }).class).toBe("timeout");
		expect(classifyFailure({ status: 408 }).class).toBe("timeout");
		const f = classifyFailure({ error: "the request timed out" });
		expect(f.class).toBe("timeout");
		expect(f.retryable).toBe(true);
	});

	it("maps 5xx / 429 / network errors to retryable 'provider'", () => {
		expect(classifyFailure({ status: 503 })).toMatchObject({
			class: "provider",
			retryable: true,
		});
		expect(classifyFailure({ status: 429 })).toMatchObject({
			class: "provider",
			retryable: true,
		});
		expect(
			classifyFailure({ error: "fetch failed: ECONNRESET" }),
		).toMatchObject({ class: "provider", retryable: true });
		expect(
			classifyFailure({ error: "provider overloaded, try again" }),
		).toMatchObject({ class: "provider", retryable: true });
	});

	it("maps a non-safety 4xx / invalid request to NON-retryable 'provider'", () => {
		expect(classifyFailure({ status: 400 })).toMatchObject({
			class: "provider",
			retryable: false,
		});
		expect(
			classifyFailure({ error: "invalid parameter: unsupported resolution" }),
		).toMatchObject({ class: "provider", retryable: false });
	});

	it("falls back to a cautiously-retryable 'unknown' when nothing matches", () => {
		const f = classifyFailure({ error: "kaboom" });
		expect(f.class).toBe("unknown");
		expect(f.retryable).toBe(true);
	});

	it("preserves status and raw detail for logs", () => {
		const f = classifyFailure({
			status: 503,
			error: new Error("upstream down"),
		});
		expect(f.status).toBe(503);
		expect(f.detail).toBe("upstream down");
		// The user-facing message is NOT the raw provider text.
		expect(f.message).not.toBe("upstream down");
	});
});
