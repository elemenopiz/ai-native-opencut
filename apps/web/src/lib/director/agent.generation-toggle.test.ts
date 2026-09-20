/**
 * Coverage for the generation kill switch (studio-settings store's
 * `generationEnabled`, the composer toggle beside EnhancePromptButton).
 *
 * These drive the REAL frontier (`runDirectorAgent`) and native-Gemini
 * (`runDirectorAgentGemini`) loops, mocking only `global.fetch`, and inspect
 * the actual request body each loop POSTs to its relay — the same technique
 * `agent-streaming.test.ts`/`agent-gemini.test.ts` use. This is the only way
 * to see what the MODEL actually receives: `anthropicToolDefs` isn't exported,
 * so the tool array must be observed on the wire, not called directly.
 *
 * What matters here, per the task brief:
 *  - default (flag omitted) is ON — unchanged behavior for every existing
 *    caller that doesn't pass the flag yet.
 *  - OFF removes EXACTLY generate/reroll/remix/compareTake and leaves every
 *    other verb (reads, edits, planning) untouched.
 *  - ON (default OR explicit true) is byte-identical to what shipped before
 *    this toggle existed — the regression that actually matters.
 *  - the system prompt tells the model plainly when generation is off.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { GENERATION_VERB_NAMES, runDirectorAgent } from "./agent";
import { runDirectorAgentGemini } from "./agent-gemini";
import type { DirectorApi } from "./director-api";
import { toolCatalog } from "./tool-catalog";

const originalFetch = globalThis.fetch;

afterEach(() => {
	mock.restore();
	globalThis.fetch = originalFetch;
});

// ── Anthropic (frontier) relay plumbing ──────────────────────────────────────

function anthropicFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A single-turn SSE response that closes immediately with plain text — no
 *  tool call needed, since these tests only inspect the OUTGOING request. */
function anthropicCloseResponse(): Response {
	const bytes = new TextEncoder().encode(
		[
			anthropicFrame("final", {
				content: [{ type: "text", text: "ok" }],
				stop_reason: "end_turn",
				model: "test",
			}),
			anthropicFrame("done", {}),
		].join(""),
	);
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(bytes);
			c.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

// ── Gemini relay plumbing ────────────────────────────────────────────────────

function geminiFrame(chunk: unknown): string {
	return `data: ${JSON.stringify(chunk)}\r\n\r\n`;
}

function geminiCloseResponse(): Response {
	const bytes = new TextEncoder().encode(
		geminiFrame({
			candidates: [
				{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
			],
		}),
	);
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(bytes);
			c.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

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

/** Empty-reel DirectorApi stub — puts the Gemini loop in "briefing" phase
 *  (generate is briefing-active) and gives the frontier loop everything its
 *  prompt-builders read. */
function fakeEmptyDirector(): DirectorApi {
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

/** One unfilled-slot DirectorApi stub — puts the Gemini loop in "production"
 *  phase, where ALL FOUR gated verbs (generate/reroll/remix/compareTake) are
 *  active, so the toggle's effect on that phase's bucket is observable. */
function fakeProductionDirector(): DirectorApi {
	return {
		...fakeEmptyDirector(),
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
}

const noopChat = async () => "";

// ── the four gated verbs ─────────────────────────────────────────────────────

test("GENERATION_VERB_NAMES is exactly generate/reroll/remix/compareTake", () => {
	// Pinned so a future edit to the gated set is a deliberate, visible diff —
	// not a silent drift discovered by a support ticket about a phantom charge.
	expect([...GENERATION_VERB_NAMES].sort()).toEqual(
		["compareTake", "generate", "remix", "reroll"].sort(),
	);
});

// ── frontier (Anthropic) tool array ──────────────────────────────────────────

test("frontier: default (flag omitted) sends the full, unfiltered catalog", async () => {
	global.fetch = mock(async () =>
		anthropicCloseResponse(),
	) as unknown as typeof fetch;
	const fetchMock = global.fetch;

	await runDirectorAgent({
		director: fakeEmptyDirector(),
		chat: noopChat,
		userMessage: "hi",
	});

	const body = capturedBodies(fetchMock)[0];
	const sent = (body.tools as Array<{ name: string }>).map((t) => t.name);
	const catalogNames = toolCatalog().map((t) => t.name);

	expect(sent.sort()).toEqual(catalogNames.sort());
	for (const verb of GENERATION_VERB_NAMES) expect(sent).toContain(verb);
});

test("frontier: generationEnabled true is byte-identical to the default (omitted) case", async () => {
	global.fetch = mock(async () =>
		anthropicCloseResponse(),
	) as unknown as typeof fetch;
	const fetchMockA = global.fetch;
	await runDirectorAgent({
		director: fakeEmptyDirector(),
		chat: noopChat,
		userMessage: "hi",
	});
	const toolsA = capturedBodies(fetchMockA)[0].tools;

	global.fetch = mock(async () =>
		anthropicCloseResponse(),
	) as unknown as typeof fetch;
	const fetchMockB = global.fetch;
	await runDirectorAgent({
		director: fakeEmptyDirector(),
		chat: noopChat,
		userMessage: "hi",
		generationEnabled: true,
	});
	const toolsB = capturedBodies(fetchMockB)[0].tools;

	// This is the regression that matters: an explicit "on" must render the
	// EXACT SAME tool definitions (name, description, schema) as before this
	// toggle existed — not just the same names.
	expect(toolsB).toEqual(toolsA);
});

test("frontier: generationEnabled false removes exactly the 4 gated verbs, keeps everything else", async () => {
	global.fetch = mock(async () =>
		anthropicCloseResponse(),
	) as unknown as typeof fetch;
	const fetchMock = global.fetch;

	await runDirectorAgent({
		director: fakeEmptyDirector(),
		chat: noopChat,
		userMessage: "hi",
		generationEnabled: false,
	});

	const body = capturedBodies(fetchMock)[0];
	const sent = (body.tools as Array<{ name: string }>).map((t) => t.name);
	const catalogNames = toolCatalog().map((t) => t.name);
	const expectedRemaining = catalogNames.filter(
		(n) => !GENERATION_VERB_NAMES.has(n),
	);

	for (const verb of GENERATION_VERB_NAMES) expect(sent).not.toContain(verb);
	expect(sent.sort()).toEqual(expectedRemaining.sort());
	// Free planning verbs stay — they never call the generation backend
	// themselves (see GENERATION_VERB_NAMES' doc comment / director-api.ts).
	for (const freeVerb of [
		"storyboard",
		"proposeReel",
		"reviseProposal",
		"acceptProposal",
		"chainFrom",
		"extractFrame",
		"trim",
		"getReel",
	]) {
		expect(sent).toContain(freeVerb);
	}
});

test("frontier: system prompt states generation is off only when the flag is false", async () => {
	global.fetch = mock(async () =>
		anthropicCloseResponse(),
	) as unknown as typeof fetch;
	await runDirectorAgent({
		director: fakeEmptyDirector(),
		chat: noopChat,
		userMessage: "hi",
		generationEnabled: false,
	});
	const offSystem = capturedBodies(global.fetch)[0].system as string;
	expect(offSystem).toContain("GENERATION IS OFF");
	// Plain and user-safe: no provider/internal names leak into the line the
	// model is told to relay in spirit to the user.
	expect(offSystem).not.toMatch(/anthropic|claude|byteplus|seedance/i);

	global.fetch = mock(async () =>
		anthropicCloseResponse(),
	) as unknown as typeof fetch;
	await runDirectorAgent({
		director: fakeEmptyDirector(),
		chat: noopChat,
		userMessage: "hi",
	});
	const onSystem = capturedBodies(global.fetch)[0].system as string;
	expect(onSystem).not.toContain("GENERATION IS OFF");
});

// ── Gemini native declarations ───────────────────────────────────────────────

test("gemini: default (flag omitted) production phase includes all 4 gated verbs", async () => {
	global.fetch = mock(async () =>
		geminiCloseResponse(),
	) as unknown as typeof fetch;
	const fetchMock = global.fetch;

	await runDirectorAgentGemini({
		director: fakeProductionDirector(),
		userMessage: "how's shot 1?",
	});

	const body = capturedBodies(fetchMock)[0];
	const sent = (
		body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>
	)[0].functionDeclarations.map((d) => d.name);

	for (const verb of GENERATION_VERB_NAMES) expect(sent).toContain(verb);
});

test("gemini: generationEnabled false removes the gated verbs from the phase bucket, keeps the rest", async () => {
	global.fetch = mock(async () =>
		geminiCloseResponse(),
	) as unknown as typeof fetch;
	const fetchMockOn = global.fetch;
	await runDirectorAgentGemini({
		director: fakeProductionDirector(),
		userMessage: "how's shot 1?",
	});
	const onSent = (
		capturedBodies(fetchMockOn)[0].tools as Array<{
			functionDeclarations: Array<{ name: string }>;
		}>
	)[0].functionDeclarations.map((d) => d.name);

	global.fetch = mock(async () =>
		geminiCloseResponse(),
	) as unknown as typeof fetch;
	const fetchMockOff = global.fetch;
	await runDirectorAgentGemini({
		director: fakeProductionDirector(),
		userMessage: "how's shot 1?",
		generationEnabled: false,
	});
	const offSent = (
		capturedBodies(fetchMockOff)[0].tools as Array<{
			functionDeclarations: Array<{ name: string }>;
		}>
	)[0].functionDeclarations.map((d) => d.name);

	for (const verb of GENERATION_VERB_NAMES) {
		expect(onSent).toContain(verb);
		expect(offSent).not.toContain(verb);
	}
	// Everything that was active in the "on" bucket minus the 4 gated verbs
	// is still active "off" — the phase filter and the generation filter
	// compose (intersect), neither one silently swallows the other's verbs.
	const expectedOff = onSent.filter((n) => !GENERATION_VERB_NAMES.has(n));
	expect(offSent.sort()).toEqual(expectedOff.sort());
});

test("gemini: system prompt (shared with the frontier prompt) states generation is off", async () => {
	global.fetch = mock(async () =>
		geminiCloseResponse(),
	) as unknown as typeof fetch;
	await runDirectorAgentGemini({
		director: fakeProductionDirector(),
		userMessage: "how's shot 1?",
		generationEnabled: false,
	});
	const systemInstruction = capturedBodies(global.fetch)[0]
		.systemInstruction as { parts?: Array<{ text?: string }> };
	const text =
		systemInstruction?.parts?.map((p) => p.text ?? "").join("\n") ?? "";
	expect(text).toContain("GENERATION IS OFF");
});
