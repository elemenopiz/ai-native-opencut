import { describe, expect, it } from "bun:test";
import { createDirectorApi } from "./director-api";
import { classifyFailure } from "./failure-classification";
import { makeFakeEditor, type FakeElement } from "./fake-editor";
import type { GenerateExecutor } from "./types";

/**
 * Self-correcting-generation behavior (Part A): the Director classifies a take
 * failure at the executor boundary and RESPONDS — retrying transient errors,
 * rephrasing safety rejections, and escalating only when it genuinely can't
 * recover — surfacing structured reasons (not opaque strings) in the result.
 */

// Instant backoff so retries don't actually wait.
const fastRecovery = { sleep: async () => {} };

function reserve(
	d: ReturnType<typeof createDirectorApi>,
	prompt: string,
): string {
	const r = d.reserveSlot({ prompt, duration: 5 });
	if (!r.data) throw new Error(`reserveSlot failed: ${r.message}`);
	return r.data.slotId;
}

const elementById = (
	tracks: { elements: FakeElement[] }[],
	id: string,
): FakeElement | undefined =>
	tracks.flatMap((t) => t.elements).find((e) => e.id === id);

describe("Director self-correcting generation", () => {
	it("retries a transient provider error with backoff, then succeeds", async () => {
		let calls = 0;
		const executor: GenerateExecutor = {
			run: async () => {
				calls++;
				// First call fails transiently (no structured failure → Director classifies
				// the raw string); second call lands.
				if (calls < 2) {
					return { status: "failed", error: "503 service unavailable" };
				}
				return { status: "ready", mediaId: "m1" };
			},
		};
		const { editor, tracks } = makeFakeEditor();
		const d = createDirectorApi(editor, { executor, recovery: fastRecovery });
		const slotId = reserve(d, "a calm cat");

		const res = await d.generate({ slotIds: [slotId] });

		expect(res.ok).toBe(true);
		expect(calls).toBe(2); // one retry
		expect(res.data?.recovered).toBe(true);
		expect(res.data?.failures).toBeUndefined();

		const el = elementById(tracks, slotId);
		expect(el?.takes?.[0]?.status).toBe("ready");
		// Auto-selected the ready take.
		expect(el?.activeTakeId).toBe(el?.takes?.[0]?.id);
	});

	it("auto-rephrases a safety rejection and re-submits the cleaned prompt", async () => {
		const seenPrompts: string[] = [];
		const executor: GenerateExecutor = {
			run: async ({ spec }) => {
				seenPrompts.push(spec.prompt);
				if (spec.prompt.startsWith("Tasteful, safe-for-work")) {
					return { status: "ready", mediaId: "m1" };
				}
				return {
					status: "failed",
					error: "blocked by content policy",
					failure: classifyFailure({ error: "blocked by content policy" }),
				};
			},
		};
		const { editor, tracks } = makeFakeEditor();
		const d = createDirectorApi(editor, { executor, recovery: fastRecovery });
		const slotId = reserve(d, "a violent bloody duel");

		const res = await d.generate({ slotIds: [slotId] });

		expect(res.ok).toBe(true);
		expect(seenPrompts).toHaveLength(2);
		// The retry carried a rephrased, safe-for-work prompt.
		expect(seenPrompts[1]).toContain("Tasteful, safe-for-work");
		expect(res.data?.recovered).toBe(true);

		const el = elementById(tracks, slotId);
		expect(el?.takes?.[0]?.status).toBe("ready");
	});

	it("does NOT retry a non-retryable invalid request — it escalates", async () => {
		let calls = 0;
		const executor: GenerateExecutor = {
			run: async () => {
				calls++;
				return { status: "failed", error: "invalid request: bad resolution" };
			},
		};
		const { editor, tracks } = makeFakeEditor();
		const d = createDirectorApi(editor, { executor, recovery: fastRecovery });
		const slotId = reserve(d, "a shot");

		const res = await d.generate({ slotIds: [slotId] });

		expect(res.ok).toBe(false); // nothing rendered → hard failure
		expect(res.message).toMatch(/needs your input/i);
		expect(calls).toBe(1); // no wasted retries

		const el = elementById(tracks, slotId);
		expect(el?.takes?.[0]?.status).toBe("failed");
	});

	it("gives up after exhausting safety rephrases and reports the reason", async () => {
		let calls = 0;
		const executor: GenerateExecutor = {
			run: async () => {
				calls++;
				return { status: "failed", error: "safety filter blocked this prompt" };
			},
		};
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, {
			executor,
			recovery: { ...fastRecovery, maxRephrases: 1 },
		});
		const slotId = reserve(d, "disallowed content");

		const res = await d.generate({ slotIds: [slotId] });

		expect(res.ok).toBe(false);
		expect(calls).toBe(2); // initial + one rephrase, then give up
		expect(res.message).toMatch(/content-safety/i);
	});

	it("surfaces per-slot structured failures while still landing the good slots", async () => {
		const executor: GenerateExecutor = {
			run: async ({ spec }) => {
				if (spec.prompt.includes("good")) {
					return { status: "ready", mediaId: "m1" };
				}
				return { status: "failed", error: "invalid request" };
			},
		};
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, { executor, recovery: fastRecovery });
		const good = reserve(d, "a good shot");
		const bad = reserve(d, "a bad shot");

		const res = await d.generate({ slotIds: [good, bad] });

		expect(res.ok).toBe(true); // at least one slot landed
		expect(res.data?.slotIds).toEqual([good]);
		expect(res.data?.failures).toHaveLength(1);
		expect(res.data?.failures?.[0]?.slotId).toBe(bad);
		expect(res.data?.failures?.[0]?.failure.class).toBe("provider");
		expect(res.data?.failures?.[0]?.failure.retryable).toBe(false);
		expect(res.message).toMatch(/still failed/i);
	});

	it("treats a ready result with no media as an empty failure and retries", async () => {
		let calls = 0;
		const executor: GenerateExecutor = {
			run: async () => {
				calls++;
				if (calls < 2) return { status: "ready", mediaId: "" }; // empty
				return { status: "ready", mediaId: "m1" };
			},
		};
		const { editor, tracks } = makeFakeEditor();
		const d = createDirectorApi(editor, { executor, recovery: fastRecovery });
		const slotId = reserve(d, "a shot");

		const res = await d.generate({ slotIds: [slotId] });

		expect(res.ok).toBe(true);
		expect(calls).toBe(2);
		expect(elementById(tracks, slotId)?.takes?.[0]?.status).toBe("ready");
	});
});
