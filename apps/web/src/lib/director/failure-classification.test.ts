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

	// The core of the F1 fix: when the boundary threads a real HTTP status,
	// classification must run on that status (not message regex-guessing).
	describe("when an HTTP status is supplied (threaded from the fetch boundary)", () => {
		it("classifies a 503 as retryable even with an unhelpful message", () => {
			expect(
				classifyFailure({ status: 503, error: "Submission failed" }),
			).toMatchObject({ class: "provider", retryable: true, status: 503 });
		});

		it("classifies a 429 as retryable even with an unhelpful message", () => {
			expect(
				classifyFailure({ status: 429, error: "Submission failed" }),
			).toMatchObject({ class: "provider", retryable: true, status: 429 });
		});

		it("classifies a 400 as NON-retryable even with an unhelpful message", () => {
			expect(
				classifyFailure({ status: 400, error: "Submission failed" }),
			).toMatchObject({ class: "provider", retryable: false, status: 400 });
		});

		it("classifies a 422 as NON-retryable even with an unhelpful message", () => {
			expect(
				classifyFailure({ status: 422, error: "Submission failed" }),
			).toMatchObject({ class: "provider", retryable: false, status: 422 });
		});

		it("lets a genuine safety message still win over a 4xx status", () => {
			expect(
				classifyFailure({ status: 422, error: "content policy violation" }),
			).toMatchObject({ class: "safety", retryable: false });
		});
	});

	// Backward-compat: with no status, the regex fallback must still classify.
	describe("regex fallback when status is absent", () => {
		it("still marks overload/rate-limit text retryable", () => {
			expect(
				classifyFailure({ error: "service unavailable, please retry" }),
			).toMatchObject({ class: "provider", retryable: true });
		});

		it("still marks invalid-request text non-retryable", () => {
			expect(
				classifyFailure({ error: "malformed request: unknown field" }),
			).toMatchObject({ class: "provider", retryable: false });
			expect(
				classifyFailure({ error: "Submission failed" }).status,
			).toBeUndefined();
		});
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
