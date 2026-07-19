/**
 * Coverage for the Director-revamp Item 9 payoff: a reopened/ongoing
 * conversation's prior turns must actually ride the model's context, not
 * just replay visually in the chat panel.
 *
 * `getConversationHistoryForAgent` (`stores/ai-store.ts`) is the producer
 * seam; `priorMessages` on `runDirectorAgent`/`runDirectorAgentFrontier`/
 * `runDirectorAgentGemini` (this module + `agent-gemini.ts`) is the consumer
 * seam that prepends it to the outgoing history, capped by
 * `capHistoryMessages`. These tests drive the REAL loops and mock only
 * `global.fetch`, asserting on the captured POST body — the same
 * fetch-seam-capture convention as `agent-streaming.test.ts` /
 * `agent-gemini.test.ts`.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	capHistoryMessages,
	MAX_HISTORY_CHARS,
	MAX_HISTORY_MESSAGES,
	runDirectorAgent,
	type DirectorHistoryMessage,
} from "./agent";
import { runDirectorAgentGemini, type GeminiContent } from "./agent-gemini";
import type { DirectorApi } from "./director-api";

const originalFetch = globalThis.fetch;

/** Build one Claude-relay SSE frame (`event:` + `data:` + blank line). */
function claudeFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Build one native Gemini SSE frame (`data:` only — no `event:` field). */
function geminiFrame(chunk: unknown): string {
	return `data: ${JSON.stringify(chunk)}\r\n\r\n`;
}

function sseResponse(frames: string[]): Response {
	const bytes = new TextEncoder().encode(frames.join(""));
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

/** A one-shot Claude relay response that closes immediately with plain text. */
function claudeCloseResponse(text: string): Response {
	return sseResponse([
		claudeFrame("delta", { kind: "text", text }),
		claudeFrame("final", {
			content: [{ type: "text", text }],
			stop_reason: "end_turn",
			model: "test",
		}),
		claudeFrame("done", {}),
	]);
}

/** A one-shot native-Gemini relay response that closes immediately with plain text. */
function geminiCloseResponse(text: string): Response {
	return sseResponse([
		geminiFrame({
			candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		}),
	]);
}

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

const noopChat = async () => "";

/** The JSON bodies POSTed to the relay, in call order. */
function capturedBodies(fetchMock: unknown): Array<Record<string, unknown>> {
	return (fetchMock as { mock: { calls: unknown[][] } }).mock.calls.map(
		(call) =>
			JSON.parse(String((call[1] as RequestInit).body)) as Record<
				string,
				unknown
			>,
	);
}

afterEach(() => {
	mock.restore();
	globalThis.fetch = originalFetch;
});

describe("capHistoryMessages — the shared cap (Item 9)", () => {
	test("returns empty for undefined/empty input", () => {
		expect(capHistoryMessages(undefined)).toEqual([]);
		expect(capHistoryMessages([])).toEqual([]);
	});

	test("caps by message count, keeping the MOST RECENT messages", () => {
		const messages: DirectorHistoryMessage[] = Array.from(
			{ length: MAX_HISTORY_MESSAGES + 10 },
			(_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `turn ${i}`,
			}),
		);
		const capped = capHistoryMessages(messages);
		expect(capped).toHaveLength(MAX_HISTORY_MESSAGES);
		// The tail of the input survives verbatim, in order.
		expect(capped).toEqual(messages.slice(-MAX_HISTORY_MESSAGES));
		expect(capped[capped.length - 1].content).toBe(
			`turn ${messages.length - 1}`,
		);
	});

	test("caps by total content chars, trimming the OLDEST messages first", () => {
		// 5 messages, each half the char budget — count cap (20) doesn't kick in,
		// but only ~2 of these fit inside MAX_HISTORY_CHARS.
		const chunk = "x".repeat(Math.floor(MAX_HISTORY_CHARS / 2));
		const messages: DirectorHistoryMessage[] = Array.from(
			{ length: 5 },
			(_, i) => ({
				role: "user",
				content: `${chunk}-${i}`,
			}),
		);
		const capped = capHistoryMessages(messages);
		expect(capped.length).toBeLessThan(messages.length);
		// The most recent message always survives, even alone.
		expect(capped[capped.length - 1].content).toBe(
			messages[messages.length - 1].content,
		);
		// Whatever remains is a contiguous SUFFIX of the input, in order.
		expect(capped).toEqual(messages.slice(-capped.length));
	});

	test("never drops the single most recent message, even if it alone exceeds the char budget", () => {
		const huge = "x".repeat(MAX_HISTORY_CHARS * 2);
		const capped = capHistoryMessages([
			{ role: "user", content: "small" },
			{ role: "assistant", content: huge },
		]);
		expect(capped).toEqual([{ role: "assistant", content: huge }]);
	});
});

describe("frontier loop — priorMessages ride the outgoing POST body", () => {
	test("reopened conversation: prior turns precede the current user message", async () => {
		const fetchMock = mock(async () => claudeCloseResponse("got it"));
		global.fetch = fetchMock as unknown as typeof fetch;

		const priorMessages: DirectorHistoryMessage[] = [
			{ role: "user", content: "first message" },
			{ role: "assistant", content: "first reply" },
		];

		const result = await runDirectorAgent({
			director: fakeDirector(),
			chat: noopChat,
			userMessage: "second message",
			priorMessages,
			brain: "frontier",
		});

		expect(result.finalMessage).toBe("got it");
		const bodies = capturedBodies(fetchMock);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].messages).toEqual([
			{ role: "user", content: "first message" },
			{ role: "assistant", content: "first reply" },
			{ role: "user", content: "second message" },
		]);
	});

	test("fresh conversation: no priorMessages means no prior turns sent", async () => {
		const fetchMock = mock(async () => claudeCloseResponse("hi there"));
		global.fetch = fetchMock as unknown as typeof fetch;

		await runDirectorAgent({
			director: fakeDirector(),
			chat: noopChat,
			userMessage: "hello",
			brain: "frontier",
		});

		const bodies = capturedBodies(fetchMock);
		expect(bodies[0].messages).toEqual([{ role: "user", content: "hello" }]);
	});

	test("the outgoing history is capped even when priorMessages exceeds the limit", async () => {
		const fetchMock = mock(async () => claudeCloseResponse("ok"));
		global.fetch = fetchMock as unknown as typeof fetch;

		const priorMessages: DirectorHistoryMessage[] = Array.from(
			{ length: MAX_HISTORY_MESSAGES + 15 },
			(_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `turn ${i}`,
			}),
		);

		await runDirectorAgent({
			director: fakeDirector(),
			chat: noopChat,
			userMessage: "latest",
			priorMessages,
			brain: "frontier",
		});

		const bodies = capturedBodies(fetchMock);
		const sent = bodies[0].messages as Array<{
			role: string;
			content: string;
		}>;
		// Capped prior turns + the current turn.
		expect(sent).toHaveLength(MAX_HISTORY_MESSAGES + 1);
		expect(sent[sent.length - 1]).toEqual({
			role: "user",
			content: "latest",
		});
		// The oldest surviving prior turn is the tail of the (capped) input.
		expect(sent[0].content).toBe(
			`turn ${priorMessages.length - MAX_HISTORY_MESSAGES}`,
		);
	});
});

describe("Gemini loop — priorMessages ride the outgoing contents, mapped to model/user roles", () => {
	test("reopened conversation: prior turns precede the current turn, assistant -> model", async () => {
		const fetchMock = mock(async () => geminiCloseResponse("got it"));
		global.fetch = fetchMock as unknown as typeof fetch;

		const priorMessages: DirectorHistoryMessage[] = [
			{ role: "user", content: "first message" },
			{ role: "assistant", content: "first reply" },
		];

		const result = await runDirectorAgentGemini({
			director: fakeDirector(),
			userMessage: "second message",
			priorMessages,
		});

		expect(result.finalMessage).toBe("got it");
		const bodies = capturedBodies(fetchMock);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].contents).toEqual([
			{ role: "user", parts: [{ text: "first message" }] },
			{ role: "model", parts: [{ text: "first reply" }] },
			{ role: "user", parts: [{ text: "second message" }] },
		] satisfies GeminiContent[]);
	});

	test("fresh conversation: no priorMessages means no prior turns sent", async () => {
		const fetchMock = mock(async () => geminiCloseResponse("hi there"));
		global.fetch = fetchMock as unknown as typeof fetch;

		await runDirectorAgentGemini({
			director: fakeDirector(),
			userMessage: "hello",
		});

		const bodies = capturedBodies(fetchMock);
		expect(bodies[0].contents).toEqual([
			{ role: "user", parts: [{ text: "hello" }] },
		] satisfies GeminiContent[]);
	});
});
