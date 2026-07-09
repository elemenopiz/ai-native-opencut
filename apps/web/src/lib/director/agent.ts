/**
 * The Director agent loop — turns a natural-language chat turn into a sequence
 * of `director-api` verb calls.
 *
 * The local AI backend (`/api/llm/chat`, Ollama) has no native function-calling,
 * so this is a deterministic CLIENT-SIDE ReAct loop over a plain text LLM:
 * we hand the model a tool catalog + a live reel snapshot and ask it to emit ONE
 * JSON action per turn; we parse it, execute the verb through the SAME
 * `DirectorApi` the manual UI uses, feed the result back as an observation, and
 * repeat until the model returns a `{ "final": "..." }` answer (or we hit
 * `MAX_STEPS`). Pure brainstorming questions resolve in a single `final` turn —
 * the agent only touches the reel when the user asks it to build/change shots.
 *
 * No React, no provider wiring here: it depends only on an injected `chat`
 * function and a `DirectorApi`. Generation actually runs because the injected
 * DirectorApi already carries the studio executor (see `use-director`).
 */

import type { DirectorApi } from "./director-api";
import { PLAYBOOKS } from "@/lib/studio/playbooks";
import { createShortIdMap, type ShortIdMap } from "./short-id";
import { toolCatalog, type JSONSchema, type ToolHandler } from "./tool-catalog";

/** Single-shot, non-streaming chat call: (message, system) → assistant text. */
export type AgentChatFn = (message: string, system: string) => Promise<string>;

export interface AgentToolStep {
	action: string;
	args: Record<string, unknown>;
	ok: boolean;
	message: string;
}

export interface AgentRunResult {
	finalMessage: string;
	steps: AgentToolStep[];
}

interface DirectorResultLike {
	ok: boolean;
	message: string;
	data?: unknown;
}

/** Hard ceiling on tool calls per user turn — keeps a runaway model bounded. */
const MAX_STEPS = 6;

// ── tool registry + docs (built from the shared catalog) ─────────────────────
//
// The executor registry and the agent-facing docs string are BOTH derived from
// `toolCatalog()` — the SAME catalog the future MCP server consumes — so there
// is a single source of truth for verbs, arg shapes, arg-coercion, and the
// SECONDS convention. (The arg-coercion helpers that used to live here now live
// in `tool-catalog.ts`, alongside the handlers that use them.)

/** The verb registry the agent may call — every catalog handler, keyed by name. */
const TOOLS: Record<string, ToolHandler> = Object.fromEntries(
	toolCatalog().map((t) => [t.name, t.handler]),
);

/** Render one arg's type for the docs string (SECONDS fields show as `seconds`). */
function argType(node: JSONSchema): string {
	if (node.enum) return node.enum.map((e) => JSON.stringify(e)).join("|");
	if (node["x-seconds"]) return "seconds";
	if (node.oneOf) return node.oneOf.map(argType).join(" | ");
	if (node.type === "array")
		return `[${node.items ? argType(node.items) : "any"}, ...]`;
	if (node.type === "object" && node.properties) {
		return `{ ${Object.entries(node.properties)
			.map(([k, v]) => `"${k}": ${argType(v)}`)
			.join(", ")} }`;
	}
	return node.type ?? "any";
}

/** Render a verb's args object for the docs string; optional keys get a `?`. */
function renderArgs(schema: JSONSchema): string {
	const props = schema.properties;
	if (!props || Object.keys(props).length === 0) return "{}";
	const required = new Set(schema.required ?? []);
	const parts = Object.entries(props).map(
		([k, v]) => `"${k}"${required.has(k) ? "" : "?"}: ${argType(v)}`,
	);
	return `{ ${parts.join(", ")} }`;
}

/** Agent-facing tool docs, one line per verb, built from `toolCatalog()`. */
const TOOL_DOCS = [
	"Tools (call ONE per turn):",
	...toolCatalog().map(
		(t) => `- ${t.name} — ${t.description} args: ${renderArgs(t.inputSchema)}`,
	),
].join("\n");

/** Concise pointer to the UGC prompt playbooks — titles/descriptions only, not the full content (keeps the system prompt small for a local model). */
const PLAYBOOK_POINTER = Object.values(PLAYBOOKS)
	.map((p) => `- ${p.title}: ${p.description}`)
	.join("\n");

/**
 * Short-id map over the current reel's slot + take ids. Rebuilt each turn (ids
 * are stable, but a prefix may need to lengthen as slots come and go). This is
 * the SINGLE expansion choke point: the agent speaks short ids to the model and
 * expands them back to full ids here, at the args→DirectorApi boundary, keeping
 * `DirectorApi` itself full-id and unaware of the abbreviation scheme.
 */
function reelShortIdMap(director: DirectorApi): ShortIdMap {
	const ids: string[] = [];
	for (const s of director.getReel().slots) {
		ids.push(s.id);
		for (const t of s.takes) ids.push(t.id);
	}
	return createShortIdMap(ids);
}

/**
 * Id-bearing arg fields the model may send as SHORT ids.
 *
 * Deliberately EXCLUDES two id-shaped fields introduced alongside trim/move/
 * split/addText/updateText:
 *  - `targetTrackId` (move) — a TRACK id. `reelShortIdMap` only indexes slot
 *    and take ids, so a track id was never part of the short-id universe;
 *    routing it through `expand` would throw "unknown id". Callers must pass
 *    the full track id (or omit it to stay on the slot's current track).
 *  - `elementId` (updateText) — a text-overlay element id. Text elements
 *    aren't generative slots (see `director-api.ts`'s "TEXT" section), so
 *    they never appear in `reelShortIdMap` either; `addText` returns (and
 *    `updateText` expects) the FULL id, never shortened.
 */
const ID_ARG_FIELDS = ["slotId", "takeId"] as const;

/**
 * Expand any short ids the model passed back into full ids. Non-id args pass
 * through untouched; `"all"` (not an array) is left alone. Throws (ambiguous /
 * unknown id) — the caller surfaces that as a failed step.
 */
function expandIdArgs(
	args: Record<string, unknown>,
	map: ShortIdMap,
): Record<string, unknown> {
	const out = { ...args };
	for (const field of ID_ARG_FIELDS) {
		const v = out[field];
		if (typeof v === "string" && v) out[field] = map.expand(v);
	}
	if (Array.isArray(out.slotIds)) {
		out.slotIds = out.slotIds.map((v) =>
			typeof v === "string" && v ? map.expand(v) : v,
		);
	}
	return out;
}

/** Compact, current reel state for the model to target slots by id (SHORT ids). */
function reelSummary(director: DirectorApi): string {
	const reel = director.getReel();
	if (reel.slots.length === 0) return "REEL: empty (no slots yet).";
	const map = reelShortIdMap(director);
	const lines = reel.slots.map(
		(s, i) =>
			`  #${i + 1} id=${map.shorten(s.id)} status=${s.status} takes=${s.takeCount} prompt=${JSON.stringify(
				s.prompt,
			)}`,
	);
	return `REEL (${reel.slots.length} slots, ${reel.totalDuration.toFixed(1)}s):\n${lines.join("\n")}`;
}

function buildSystemPrompt(director: DirectorApi): string {
	return [
		"You are the Director — an AI that builds and edits a short video reel by calling tools.",
		"A reel is an ordered list of generative SLOTS; each slot holds a prompt and one or more generated TAKES.",
		"",
		"UNITS: all durations and times are in SECONDS unless a field name ends in `Frames`.",
		"IDS: every id shown to you (in the REEL below and in change reports) is a SHORT id. Pass short ids back verbatim in tool args — do not lengthen or invent them.",
		"",
		TOOL_DOCS,
		"",
		"If the user wants UGC/influencer-style, \"looks like a real phone photo\" imagery or video, follow these playbook conventions when writing prompts:",
		PLAYBOOK_POINTER,
		"",
		"PROTOCOL — reply with a SINGLE minified JSON object and NOTHING else:",
		'  to act:   {"action":"<tool>","args":{...}}',
		'  to reply: {"final":"<message to the user>"}',
		"Use actions ONLY when the user wants to build or change the reel. For questions, ideas, scripts, or advice, answer with a final message.",
		"After each action you receive an OBSERVATION. When the task is done, send a final message summarizing what you did.",
		"",
		reelSummary(director),
	].join("\n");
}

interface ParsedAction {
	kind: "action";
	action: string;
	args: Record<string, unknown>;
}
interface ParsedFinal {
	kind: "final";
	text: string;
}

/** Extract the first balanced top-level JSON object from arbitrary text. */
function firstJsonObject(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const haystack = fenced ? fenced[1] : text;
	const start = haystack.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < haystack.length; i++) {
		const ch = haystack[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
		} else if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return haystack.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * Parse the model's reply. Lenient: prose with no JSON is treated as a final
 * answer (graceful fallback for weak local models).
 */
function parseReply(text: string): ParsedAction | ParsedFinal {
	const json = firstJsonObject(text);
	if (json) {
		try {
			const obj = JSON.parse(json) as Record<string, unknown>;
			if (typeof obj.final === "string") return { kind: "final", text: obj.final };
			if (typeof obj.action === "string") {
				const args =
					obj.args && typeof obj.args === "object"
						? (obj.args as Record<string, unknown>)
						: {};
				return { kind: "action", action: obj.action, args };
			}
		} catch {
			/* fall through to prose */
		}
	}
	return { kind: "final", text: text.trim() };
}

/**
 * Run one user turn through the agent loop. `onStep` fires after each executed
 * tool so the UI can stream progress.
 */
export async function runDirectorAgent(opts: {
	director: DirectorApi;
	chat: AgentChatFn;
	userMessage: string;
	onStep?: (step: AgentToolStep) => void;
}): Promise<AgentRunResult> {
	const { director, chat, userMessage, onStep } = opts;
	const steps: AgentToolStep[] = [];
	let scratchpad = `USER: ${userMessage}\n`;

	for (let i = 0; i < MAX_STEPS; i++) {
		const reply = await chat(
			`${scratchpad}\nRespond with the next JSON object now.`,
			buildSystemPrompt(director),
		);
		const parsed = parseReply(reply);

		if (parsed.kind === "final") {
			return { finalMessage: parsed.text, steps };
		}

		const tool = TOOLS[parsed.action];
		if (!tool) {
			scratchpad +=
				`ASSISTANT: ${JSON.stringify({ action: parsed.action, args: parsed.args })}\n` +
				`OBSERVATION: unknown action "${parsed.action}". Valid tools: ${Object.keys(
					TOOLS,
				).join(", ")}.\n`;
			continue;
		}

		// Expand short ids the model echoed back into full ids at this single
		// choke point. Ambiguous/unknown ids surface as a failed step (message
		// from the thrown error) rather than crashing the loop.
		let result: DirectorResultLike;
		try {
			const args = expandIdArgs(parsed.args, reelShortIdMap(director));
			result = await tool(director, args);
		} catch (err) {
			result = { ok: false, message: err instanceof Error ? err.message : String(err) };
		}

		const step: AgentToolStep = {
			action: parsed.action,
			args: parsed.args,
			ok: result.ok,
			message: result.message,
		};
		steps.push(step);
		onStep?.(step);

		// Feed the compact delta (short ids) back as the observation for mutating
		// verbs; getReel echoes the short-id reel listing; everything else falls
		// back to the plain message.
		const delta = (result as { delta?: unknown }).delta;
		const observation =
			parsed.action === "getReel"
				? reelSummary(director)
				: delta
					? `${result.message} CHANGES:${JSON.stringify(delta)}`
					: result.message;
		scratchpad +=
			`ASSISTANT: ${JSON.stringify({ action: parsed.action, args: parsed.args })}\n` +
			`OBSERVATION: ${observation}\n`;
	}

	// Hit the step ceiling — ask for a closing summary.
	const closing = await chat(
		`${scratchpad}\nYou have taken enough steps. Reply ONLY with {"final":"..."} summarizing the result for the user.`,
		buildSystemPrompt(director),
	);
	const parsed = parseReply(closing);
	return {
		finalMessage: parsed.kind === "final" ? parsed.text : closing.trim(),
		steps,
	};
}
