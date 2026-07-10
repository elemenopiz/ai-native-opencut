/**
 * The cost-preview approval gate must cover the AUDIO verbs, not just visual
 * generation: `addVoiceover`/`addMusicBed` hit a paid TTS / sounds backend, so an
 * over-threshold audio spend has to PAUSE for the user the same way a `generate`
 * does — never auto-spend.
 *
 * These drive the REAL `runDirectorAgent` frontier loop (the same path the panel
 * uses) and mock only `global.fetch` so the relay returns a synthetic SSE turn
 * whose assistant message calls an audio tool. The DirectorApi is a minimal fake
 * that RECORDS whether the paid verb actually ran, so "returned an approval,
 * didn't spend" is verified by the absence of that call.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { runDirectorAgent } from "./agent";
import type { DirectorApi } from "./director-api";

/** Build one SSE frame (`event:` + `data:` + blank line). */
function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A 200 `text/event-stream` Response streaming `frames` as one chunk. */
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

/** One assistant turn that calls a single tool. */
function toolUseTurn(name: string, input: Record<string, unknown>): Response {
	return sseResponse([
		frame("final", {
			content: [{ type: "tool_use", id: "t1", name, input }],
			stop_reason: "tool_use",
			model: "test",
		}),
		frame("done", {}),
	]);
}

/** One assistant turn that closes with plain text (end_turn). */
function textTurn(text: string): Response {
	return sseResponse([
		frame("final", {
			content: [{ type: "text", text }],
			stop_reason: "end_turn",
			model: "test",
		}),
		frame("done", {}),
	]);
}

/** Minimal DirectorApi stub: the reads the loop needs to build its prompt, plus a
 *  spy-backed `addVoiceover` so we can prove whether the paid verb ran. */
function fakeDirector(): { director: DirectorApi; voiceoverCalls: unknown[] } {
	const voiceoverCalls: unknown[] = [];
	const director = {
		getReel: () => ({ slots: [], totalDuration: 0 }),
		getProjectInfo: () => ({ data: null }),
		briefPromptBlock: () => "DIRECTOR BRIEF: (empty)",
		addVoiceover: async (input: unknown) => {
			voiceoverCalls.push(input);
			return { ok: true, message: "Added voiceover.", data: { slotId: "vo1" } };
		},
	} as unknown as DirectorApi;
	return { director, voiceoverCalls };
}

const noopChat = async () => "";

// A script long enough that premium-TTS pricing clears the $0.50 default
// threshold with wide margin (~3.8k chars → high end well over $1).
const LONG_SCRIPT = "narrate this scene vividly ".repeat(150);

afterEach(() => {
	mock.restore();
});

test("an over-threshold addVoiceover returns an approval instead of spending", async () => {
	// The model tries to spend on TTS immediately. If the gate is wired the loop
	// pauses BEFORE running the tool, so fetch is only ever called once.
	global.fetch = mock(async () =>
		toolUseTurn("addVoiceover", { script: LONG_SCRIPT }),
	) as unknown as typeof fetch;

	const { director, voiceoverCalls } = fakeDirector();
	const result = await runDirectorAgent({
		director,
		chat: noopChat,
		userMessage: "narrate the whole reel",
		brain: "frontier",
	});

	// Paused for approval — nothing spent.
	expect(result.awaitingApproval).toBeDefined();
	expect(result.awaitingApproval?.action).toBe("addVoiceover");
	expect(result.awaitingApproval?.clips).toBe(1);
	expect(result.awaitingApproval?.estimate.high).toBeGreaterThanOrEqual(0.5);
	// The paid verb never ran, and the loop stopped without asking for more turns.
	expect(voiceoverCalls).toHaveLength(0);
	expect(global.fetch).toHaveBeenCalledTimes(1);
	// The paused step is surfaced (fail-closed), not silently dropped.
	expect(
		result.steps.some(
			(s) =>
				s.action === "addVoiceover" && !s.ok && /approval/i.test(s.message),
		),
	).toBe(true);
});

test("a cheap (under-threshold) addVoiceover runs without a pause", async () => {
	// Turn 1: call the tool with a short script (cost ≈ a fraction of a cent).
	// Turn 2: close with text. A pause would stop the run before turn 2.
	let call = 0;
	global.fetch = mock(async () =>
		call++ === 0
			? toolUseTurn("addVoiceover", { script: "Hi there." })
			: textTurn("Added the voiceover."),
	) as unknown as typeof fetch;

	const { director, voiceoverCalls } = fakeDirector();
	const result = await runDirectorAgent({
		director,
		chat: noopChat,
		userMessage: "add a quick voiceover saying hi",
		brain: "frontier",
	});

	expect(result.awaitingApproval).toBeUndefined();
	// The paid verb actually ran with the model's args.
	expect(voiceoverCalls).toHaveLength(1);
	expect(voiceoverCalls[0]).toMatchObject({ script: "Hi there." });
	expect(result.finalMessage).toBe("Added the voiceover.");
});
