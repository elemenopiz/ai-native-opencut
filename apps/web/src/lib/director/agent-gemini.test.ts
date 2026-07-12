/**
 * Integration coverage for the NATIVE Gemini Director brain.
 *
 * These drive the REAL `runDirectorAgentGemini` loop (native contents history,
 * functionCall execution, functionResponse-by-NAME, thoughtSignature echo,
 * event emission) and the brain-selection seam in `runDirectorAgent`, mocking
 * only `global.fetch` so the relay returns synthetic Gemini `alt=sse` bodies —
 * the same shape `/api/llm/gemini` passes through with `stream: true`. The
 * sibling of `agent-streaming.test.ts`, in Gemini's dialect.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { runDirectorAgent, type DirectorEvent } from "./agent";
import {
	GeminiKeyMissingError,
	runDirectorAgentGemini,
	type GeminiContent,
} from "./agent-gemini";
import type { DirectorApi } from "./director-api";
import { activeToolNamesForPhase } from "./phase-scope";
import { toGeminiDeclarations } from "./tool-catalog";

// `global.fetch` is replaced by direct assignment; `mock.restore()` does NOT
// revert property assignment, so restore it by hand (see agent-streaming.test.ts
// for the order-dependence story).
const originalFetch = globalThis.fetch;

/** One native Gemini SSE frame (`data:` only — no `event:` field). */
function frame(chunk: unknown): string {
	return `data: ${JSON.stringify(chunk)}\r\n\r\n`;
}

/** A 200 `text/event-stream` Response whose body streams `frames`, optionally chunked. */
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

/** Wrap model parts + finishReason into one streamed GenerateContentResponse chunk. */
function candidateFrame(parts: unknown[], finishReason?: string): string {
	return frame({
		candidates: [
			{ content: { parts }, ...(finishReason ? { finishReason } : {}) },
		],
	});
}

/** Minimal DirectorApi stub — only the reads the loop needs to build its prompt. */
function fakeDirector(): DirectorApi {
	return {
		getReel: () => ({ slots: [], totalDuration: 0 }),
		getProjectInfo: () => ({ data: null }),
		briefPromptBlock: () => "DIRECTOR BRIEF: (empty)",
		recordFinalSpend: () => ({
			ok: true,
			message: "",
			data: { spend: { spentUsd: 0 } },
		}),
	} as unknown as DirectorApi;
}

/** The JSON bodies the loop POSTed to the relay, in call order. */
function capturedBodies(fetchMock: unknown): Array<Record<string, unknown>> {
	return (fetchMock as { mock: { calls: unknown[][] } }).mock.calls.map(
		(call) =>
			JSON.parse(String((call[1] as RequestInit).body)) as Record<
				string,
				unknown
			>,
	);
}

const noopChat = async () => "";

afterEach(() => {
	mock.restore();
	globalThis.fetch = originalFetch;
});

test("native tool round-trip: functionResponse keyed by NAME, history grows user/model/user, signature echoed", async () => {
	// Turn 1: a signed reasoning part + text + one functionCall. Turn 2: close.
	const turn1 = sseResponse(
		[
			candidateFrame([
				{ text: "planning…", thought: true, thoughtSignature: "sig-1" },
				{ text: "Checking the reel." },
				{ functionCall: { name: "getReel", args: {} } },
			]),
			candidateFrame([], "STOP"),
		],
		// Small chunks so the SSE parser must reassemble frames across reads.
		9,
	);
	const turn2 = sseResponse([candidateFrame([{ text: "All done." }], "STOP")]);

	let call = 0;
	const fetchMock = mock(async () => (call++ === 0 ? turn1 : turn2));
	global.fetch = fetchMock as unknown as typeof fetch;

	const events: DirectorEvent[] = [];
	const result = await runDirectorAgentGemini({
		director: fakeDirector(),
		userMessage: "what's in the reel?",
		onEvent: (e) => events.push(e),
	});

	expect(result.finalMessage).toBe("All done.");
	expect(result.steps).toHaveLength(1);
	expect(result.steps[0]).toMatchObject({ action: "getReel", ok: true });
	expect(fetchMock).toHaveBeenCalledTimes(2);

	// The panel saw the reasoning live, then the tool chip, then the close.
	expect(events.map((e) => e.type)).toEqual([
		"thinking_delta",
		"text_delta",
		"tool_start",
		"tool_finish",
		"text_delta",
	]);

	const [first, second] = capturedBodies(fetchMock);
	// Native envelope: contents + systemInstruction + functionDeclarations.
	expect(first.systemInstruction).toBeDefined();
	expect(Array.isArray(first.tools)).toBe(true);
	const history = second.contents as GeminiContent[];
	// user → model → user(tool results): the whole exchange, natively shaped.
	expect(history.map((c) => c.role)).toEqual(["user", "model", "user"]);
	// The SIGNED thought part survives into history verbatim (Gemini 3-class
	// models require signatures to be echoed back across function-calling turns).
	expect(history[1].parts[0]).toEqual({
		text: "planning…",
		thought: true,
		thoughtSignature: "sig-1",
	});
	expect(history[1].parts[2]).toEqual({
		functionCall: { name: "getReel", args: {} },
	});
	// functionResponse is keyed by function NAME (Gemini has no call ids).
	const responsePart = history[2].parts[0] as {
		functionResponse: { name: string; response: { result?: string } };
	};
	expect(responsePart.functionResponse.name).toBe("getReel");
	expect(responsePart.functionResponse.response.result).toContain("REEL");
});

test("parallel functionCalls in one turn → one user turn with functionResponse parts in call order", async () => {
	const turn1 = sseResponse([
		candidateFrame([
			{ functionCall: { name: "getReel", args: {} } },
			{ functionCall: { name: "definitelyNotAVerb", args: { x: 1 } } },
		]),
		candidateFrame([], "STOP"),
	]);
	const turn2 = sseResponse([candidateFrame([{ text: "Done." }], "STOP")]);

	let call = 0;
	const fetchMock = mock(async () => (call++ === 0 ? turn1 : turn2));
	global.fetch = fetchMock as unknown as typeof fetch;

	const result = await runDirectorAgentGemini({
		director: fakeDirector(),
		userMessage: "do two things",
	});

	// Both calls executed (the unknown verb fails as a step, not a crash)...
	expect(result.steps).toHaveLength(2);
	expect(result.steps[0].ok).toBe(true);
	expect(result.steps[1].ok).toBe(false);

	// ...and both were answered in ONE user turn, in call order, by name.
	const history = capturedBodies(fetchMock)[1].contents as GeminiContent[];
	const responses = history[2].parts.map(
		(p) =>
			(p as { functionResponse: { name: string; response: object } })
				.functionResponse,
	);
	expect(responses.map((r) => r.name)).toEqual([
		"getReel",
		"definitelyNotAVerb",
	]);
	// The failed step reports through the error key, not result.
	expect(responses[1].response).toHaveProperty("error");
});

test("unsigned thought summaries stream as thinking_deltas but stay OUT of the history", async () => {
	const turn1 = sseResponse([
		candidateFrame([{ text: "let me think… ", thought: true }]),
		candidateFrame([{ text: "more thinking…", thought: true }]),
		candidateFrame([{ text: "Here's the answer." }], "STOP"),
	]);
	const fetchMock = mock(async () => turn1);
	global.fetch = fetchMock as unknown as typeof fetch;

	const events: DirectorEvent[] = [];
	const result = await runDirectorAgentGemini({
		director: fakeDirector(),
		userMessage: "just answer",
		onEvent: (e) => events.push(e),
	});

	expect(result.finalMessage).toBe("Here's the answer.");
	expect(
		events.filter((e) => e.type === "thinking_delta").map((e) => e.text),
	).toEqual(["let me think… ", "more thinking…"]);
	// One model call only — nothing echoed back — but the assembled turn the
	// loop closed on contained no unsigned thought parts (they're display-only).
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("brain seam: explicit gemini brain surfaces GeminiKeyMissingError when unconfigured", async () => {
	global.fetch = mock(
		async () =>
			new Response(
				JSON.stringify({
					error: "gemini_not_configured",
					message: "no key",
				}),
				{ status: 503, headers: { "content-type": "application/json" } },
			),
	) as unknown as typeof fetch;

	expect(
		runDirectorAgent({
			director: fakeDirector(),
			chat: noopChat,
			userMessage: "hi",
			brain: "gemini",
		}),
	).rejects.toBeInstanceOf(GeminiKeyMissingError);
});

test("brain seam: auto falls frontier → gemini, then fails loud with a config error (local fallback retired)", async () => {
	const relaysHit: string[] = [];
	global.fetch = mock(async (input: string | URL | Request) => {
		const url = String(input);
		relaysHit.push(url);
		if (url.includes("/api/llm/agent")) {
			return new Response(
				JSON.stringify({ error: "anthropic_not_configured", message: "" }),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}
		return new Response(
			JSON.stringify({ error: "gemini_not_configured", message: "" }),
			{ status: 503, headers: { "content-type": "application/json" } },
		);
	}) as unknown as typeof fetch;

	let chatInvoked = false;
	await expect(
		runDirectorAgent({
			director: fakeDirector(),
			chat: async () => {
				chatInvoked = true;
				return '{"final":"local brain speaking"}';
			},
			userMessage: "hi",
			brain: "auto",
		}),
	).rejects.toThrow(/No Director brain is configured/);

	// Both relays were consulted (in order); the retired local text loop never ran.
	expect(relaysHit[0]).toContain("/api/llm/agent");
	expect(relaysHit[1]).toContain("/api/llm/gemini");
	expect(chatInvoked).toBe(false);
});

test("cooperative cancel stops the run but keeps completed steps", async () => {
	const turn1 = sseResponse([
		candidateFrame([{ functionCall: { name: "getReel", args: {} } }]),
		candidateFrame([], "STOP"),
	]);
	let call = 0;
	global.fetch = mock(async () => {
		call++;
		return turn1;
	}) as unknown as typeof fetch;

	const controller = new AbortController();
	const events: DirectorEvent[] = [];
	const result = await runDirectorAgentGemini({
		director: fakeDirector(),
		userMessage: "start a long job",
		signal: controller.signal,
		onEvent: (e) => {
			events.push(e);
			if (e.type === "tool_finish") controller.abort();
		},
	});

	expect(result.cancelled).toBe(true);
	expect(result.steps).toHaveLength(1);
	expect(events.some((e) => e.type === "cancelled")).toBe(true);
	// The loop stopped before requesting another model turn.
	expect(call).toBe(1);
});

test("phase scoping: an empty reel sends ONLY the briefing bucket's declarations", async () => {
	global.fetch = mock(async () =>
		sseResponse([candidateFrame([{ text: "ok" }], "STOP")]),
	) as unknown as typeof fetch;

	const fetchMock = global.fetch;
	await runDirectorAgentGemini({
		director: fakeDirector(), // empty reel, no proposal → "briefing"
		userMessage: "let's plan a reel",
	});

	const body = capturedBodies(fetchMock)[0];
	const tools = body.tools as Array<{
		functionDeclarations: Array<{ name: string }>;
	}>;
	const sent = tools[0].functionDeclarations.map((d) => d.name);

	// Exactly the briefing bucket — nothing more, nothing less.
	expect(sent).toEqual(activeToolNamesForPhase("briefing"));
	// The request is genuinely scoped below the full catalog...
	expect(sent.length).toBeLessThan(toGeminiDeclarations().length);
	// ...planning verbs are in, deep-polish verbs are out.
	expect(sent).toContain("storyboard");
	expect(sent).toContain("proposeReel");
	expect(sent).toContain("getReel"); // core rides every phase
	expect(sent).not.toContain("trim");
	expect(sent).not.toContain("export");
});

test("phase scoping: a reel with unfilled slots sends the production bucket", async () => {
	global.fetch = mock(async () =>
		sseResponse([candidateFrame([{ text: "ok" }], "STOP")]),
	) as unknown as typeof fetch;

	const fetchMock = global.fetch;
	const director = {
		...fakeDirector(),
		getReel: () => ({
			slots: [
				{
					id: "s1",
					prompt: "a shot",
					status: "generating",
					takeCount: 1,
					takes: [{ id: "t0", status: "generating", createdAt: Date.now() }],
					start: 0,
					duration: 4,
				},
			],
			totalDuration: 4,
		}),
	} as unknown as DirectorApi;

	await runDirectorAgentGemini({ director, userMessage: "how's shot 1?" });

	const body = capturedBodies(fetchMock)[0];
	const sent = (
		body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>
	)[0].functionDeclarations.map((d) => d.name);

	expect(sent).toEqual(activeToolNamesForPhase("production"));
	expect(sent).toContain("reroll");
	expect(sent).toContain("chainFrom");
	expect(sent).toContain("reviewTake");
	expect(sent).not.toContain("storyboard"); // briefing-only
	expect(sent).not.toContain("export"); // polish-only
});

test("safety refusal → decline message, nothing appended or executed", async () => {
	global.fetch = mock(async () =>
		sseResponse([candidateFrame([], "SAFETY")]),
	) as unknown as typeof fetch;

	const result = await runDirectorAgentGemini({
		director: fakeDirector(),
		userMessage: "do something disallowed",
	});
	expect(result.finalMessage).toContain("declined");
	expect(result.steps).toHaveLength(0);
});
