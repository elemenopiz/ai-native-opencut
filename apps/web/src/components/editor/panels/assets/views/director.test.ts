import { describe, expect, it } from "bun:test";
import { classifyAgentError, isTransientAgentError } from "./director";

// Pure-logic coverage for the friendly-error / bounded-silent-retry pass:
// no internal error string may ever leak into a chat bubble's primary copy,
// and only genuinely TRANSIENT failures (network blip, timeout, 429/5xx) get
// the one silent retry — never auth or config failures, which can't ever
// succeed on retry.

describe("classifyAgentError — friendly primary-copy line", () => {
	it("never echoes the raw detail string", () => {
		const detail = "Claude relay error (503): upstream unavailable";
		const friendly = classifyAgentError(detail);
		expect(friendly).not.toContain("503");
		expect(friendly).not.toContain("Claude relay");
	});

	it("maps no-brain-configured to a deployment-setup line", () => {
		expect(
			classifyAgentError(
				"No Director brain is configured. Set ANTHROPIC_API_KEY in apps/web/.env.local.",
			),
		).toBe("AI isn't set up on this deployment yet.");
	});

	it("maps an auth-flavored relay error (401/403) to a sign-in line", () => {
		expect(classifyAgentError("Claude relay error (401): Unauthorized")).toBe(
			"I couldn't sign in to the AI service.",
		);
		expect(classifyAgentError("Claude relay error (403): Forbidden")).toBe(
			"I couldn't sign in to the AI service.",
		);
	});

	it("maps a non-auth relay error to a generic reachability line", () => {
		expect(
			classifyAgentError("Claude relay error (503): upstream unavailable"),
		).toBe("I couldn't reach the AI service — try again in a moment.");
	});

	it("falls back to a generic line for anything unrecognized", () => {
		expect(
			classifyAgentError("TypeError: something.exploded is not a function"),
		).toBe("Something went wrong. Try again in a moment.");
		expect(classifyAgentError("")).toBe(
			"Something went wrong. Try again in a moment.",
		);
	});
});

describe("isTransientAgentError — bounded silent-retry classifier", () => {
	it("never retries auth failures (401/403), even inside a relay error", () => {
		expect(
			isTransientAgentError("Claude relay error (401): Unauthorized"),
		).toBe(false);
		expect(isTransientAgentError("Claude relay error (403): Forbidden")).toBe(
			false,
		);
	});

	it("never retries the no-brain-configured error", () => {
		expect(
			isTransientAgentError(
				"No Director brain is configured. Set ANTHROPIC_API_KEY ...",
			),
		).toBe(false);
	});

	it("retries HTTP 429 and 5xx", () => {
		expect(
			isTransientAgentError("Claude relay error (429): rate limited"),
		).toBe(true);
		expect(
			isTransientAgentError("Claude relay error (500): server error"),
		).toBe(true);
		expect(isTransientAgentError("Claude relay error (503): unavailable")).toBe(
			true,
		);
	});

	it("retries common network-failure phrasings", () => {
		expect(isTransientAgentError("Failed to fetch")).toBe(true);
		expect(isTransientAgentError("NetworkError when attempting to fetch")).toBe(
			true,
		);
		expect(isTransientAgentError("request timed out")).toBe(true);
		expect(isTransientAgentError("connect ECONNRESET")).toBe(true);
	});

	it("does not retry an unrecognized/unclassified error (safe default)", () => {
		expect(
			isTransientAgentError("TypeError: something.exploded is not a function"),
		).toBe(false);
		expect(isTransientAgentError("")).toBe(false);
	});

	it("does not retry an arbitrary other 4xx", () => {
		expect(isTransientAgentError("Claude relay error (400): bad request")).toBe(
			false,
		);
		expect(isTransientAgentError("Claude relay error (404): not found")).toBe(
			false,
		);
	});
});
