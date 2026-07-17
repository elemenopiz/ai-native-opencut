/**
 * Integration coverage for the Director's streaming + cooperative-cancel path.
 *
 * These drive the REAL `runDirectorAgent` frontier loop (short-id expansion,
 * tool execution, event emission, abort handling) and mock only `global.fetch`
 * so the relay returns a synthetic SSE body — the same shape `/api/llm/agent`
 * emits with `stream: true`. This is the headless equivalent of watching a
 * multi-step run stream live in the Director panel and cancelling it.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { reelSummary, runDirectorAgent, type DirectorEvent } from "./agent";
import type { DirectorApi } from "./director-api";

// These tests replace `global.fetch` with a synthetic-SSE stub by direct
// assignment. `mock.restore()` only undoes mock()/spyOn — it does NOT revert a
// property assignment — so without this the stub leaks process-globally to
// every later test file (bun shares one process). A later file that relies on
// the real fetch (e.g. embedding-service's sampleImageFrame fetching a data:
// URL) would then break purely on test-file order. Capture and restore it.
const originalFetch = globalThis.fetch;

/** Build one SSE frame (`event:` + `data:` + blank line). */
function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A 200 `text/event-stream` Response whose body streams `frames`, optionally split into chunks. */
function sseResponse(frames: string[], chunkSize = 0): Response {
	const bytes = new TextEncoder().encode(frames.join(""));
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			if (chunkSize > 0) {
				for (let i = 0; i < bytes.length; i += chunkSize) {
					controller.enqueue(bytes.slice(i, i + chunkSize));
				}
			} else {
				controller.enqueue(bytes);
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

/** Minimal DirectorApi stub — only the reads the loop needs to build its prompt. */
function fakeDirector(): DirectorApi {
	return {
		getReel: () => ({ slots: [], totalDuration: 0 }),
		getProjectInfo: () => ({ data: null }),
		briefPromptBlock: () => "DIRECTOR BRIEF: (empty)",
		// finalize() records final spend on a clean close; a no-budget reel is a no-op.
		recordFinalSpend: () => ({
			ok: true,
			message: "",
			data: { spend: { spentUsd: 0 } },
		}),
	} as unknown as DirectorApi;
}

const noopChat = async () => "";

afterEach(() => {
	mock.restore();
	globalThis.fetch = originalFetch;
});

test("frontier run streams reasoning + tool progress, then a final answer (multi-step)", async () => {
	// Turn 1: think, say it will act, then call a tool. Turn 2: close with text.
	const turn1 = sseResponse(
		[
			frame("delta", { kind: "thinking", text: "Let me plan this. " }),
			frame("delta", { kind: "text", text: "I'll " }),
			frame("delta", { kind: "text", text: "run a tool." }),
			frame("final", {
				content: [
					{ type: "text", text: "I'll run a tool." },
					{ type: "tool_use", id: "t1", name: "noop", input: {} },
				],
				stop_reason: "tool_use",
				model: "test",
			}),
			frame("done", {}),
		],
		// Split into small chunks so the SSE parser must reassemble frames across reads.
		7,
	);
	const turn2 = sseResponse([
		frame("delta", { kind: "text", text: "All done." }),
		frame("final", {
			content: [{ type: "text", text: "All done." }],
			stop_reason: "end_turn",
			model: "test",
		}),
		frame("done", {}),
	]);

	let call = 0;
	global.fetch = mock(async () =>
		call++ === 0 ? turn1 : turn2,
	) as unknown as typeof fetch;

	const events: DirectorEvent[] = [];
	const result = await runDirectorAgent({
		director: fakeDirector(),
		chat: noopChat,
		userMessage: "do a thing",
		brain: "frontier",
		onEvent: (e) => events.push(e),
	});

	const types = events.map((e) => e.type);
	// Reasoning streamed before the answer, then the tool ran, then the close.
	expect(types).toEqual([
		"thinking_delta",
		"text_delta",
		"text_delta",
		"tool_start",
		"tool_finish",
		"text_delta",
	]);

	const toolStart = events.find((e) => e.type === "tool_start");
	const toolFinish = events.find((e) => e.type === "tool_finish");
	expect(toolStart).toMatchObject({ action: "noop" });
	// tool_start/tool_finish share a callId so the UI can update the chip in place.
	expect((toolStart as { callId: string }).callId).toBe(
		(toolFinish as { callId: string }).callId,
	);

	expect(result.finalMessage).toBe("All done.");
	expect(result.cancelled).toBeUndefined();
	expect(result.steps).toHaveLength(1);
	expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("cooperative cancel stops the run but keeps completed steps", async () => {
	const turn1 = sseResponse([
		frame("delta", { kind: "text", text: "Working…" }),
		frame("final", {
			content: [
				{ type: "text", text: "Working…" },
				{ type: "tool_use", id: "t1", name: "noop", input: {} },
			],
			stop_reason: "tool_use",
			model: "test",
		}),
		frame("done", {}),
	]);

	// If the loop ignored the abort it would call fetch a 2nd time; this response
	// would then be served and the test's step-count assertion would fail.
	let call = 0;
	global.fetch = mock(async () => {
		call++;
		return turn1;
	}) as unknown as typeof fetch;

	const controller = new AbortController();
	const events: DirectorEvent[] = [];
	const result = await runDirectorAgent({
		director: fakeDirector(),
		chat: noopChat,
		userMessage: "start a long job",
		brain: "frontier",
		signal: controller.signal,
		onEvent: (e) => {
			events.push(e);
			// User hits Stop right after the first tool completes.
			if (e.type === "tool_finish") controller.abort();
		},
	});

	expect(result.cancelled).toBe(true);
	// The completed tool step is preserved — cancel doesn't discard finished work.
	expect(result.steps).toHaveLength(1);
	expect(events.some((e) => e.type === "cancelled")).toBe(true);
	// The loop stopped before requesting another model turn.
	expect(call).toBe(1);
});

// ── reelSummary — per-slot timing (C8 director-intel part 2) ────────────────
//
// `reelSummary` is folded into every agent turn's prompt, so a slot's
// start/duration (already on `SlotSnapshot`) used to be dropped entirely —
// the brain couldn't tell two empty slots apart by position/length without a
// separate `getReel` round trip. This pins the compact `@Ns+Ns` clause.

test("reelSummary lists each slot's timeline start + duration compactly", () => {
	const director = {
		getReel: () => ({
			slots: [
				{
					id: "el_1",
					prompt: "wide establishing shot",
					status: "empty",
					takeCount: 0,
					takes: [],
					start: 0,
					duration: 4,
				},
				{
					id: "el_2",
					prompt: "hero close-up",
					status: "empty",
					takeCount: 0,
					takes: [],
					start: 12,
					duration: 3.5,
				},
			],
			totalDuration: 15.5,
		}),
	} as unknown as DirectorApi;

	const summary = reelSummary(director);

	expect(summary).toContain("@0.0s+4.0s");
	expect(summary).toContain("@12.0s+3.5s");
});
