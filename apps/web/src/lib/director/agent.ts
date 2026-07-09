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
import type { ConsistencyCharacter } from "./consistency-prompt";
import { PLAYBOOKS } from "@/lib/studio/playbooks";
import { createShortIdMap, type ShortIdMap } from "./short-id";

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

// ── helpers ──────────────────────────────────────────────────────────────────

const numOr = (v: unknown, fallback: number): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Optional numeric arg: `undefined` when unset/non-finite, otherwise the
 * number as-is — unlike `numOr`, 0 and negative values pass through untouched
 * (needed for time fields where 0 is a legitimate SECONDS value, e.g.
 * `trimStart: 0` or `startTime: 0`).
 */
const numOrUndefined = (v: unknown): number | undefined => {
	if (v == null) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
};

/** Required numeric time arg (SECONDS) that may legitimately be 0; falls back to 0 if unparsable. */
const numOrZeroTime = (v: unknown): number => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string => (v == null ? "" : String(v));

/** Optional string arg: `undefined` when unset (vs. `str`, which coerces to `""`). */
const strOrUndefined = (v: unknown): string | undefined =>
	v == null ? undefined : String(v);

/** Validate a loose `textAlign` arg against the literal union the API accepts; drops anything else. */
const textAlignOf = (v: unknown): "left" | "center" | "right" | undefined => {
	const s = v == null ? undefined : String(v);
	return s === "left" || s === "center" || s === "right" ? s : undefined;
};

/** Coerce a loose `shots` arg into the storyboard shape. */
function asShots(
	args: Record<string, unknown>,
): { prompt: string; duration: number }[] {
	const raw = Array.isArray(args.shots) ? args.shots : [];
	return raw.map((s) => {
		if (typeof s === "string") return { prompt: s, duration: 6 };
		const obj = (s ?? {}) as Record<string, unknown>;
		return { prompt: str(obj.prompt), duration: numOr(obj.duration, 6) };
	});
}

/** Coerce a loose `extraCharacters` arg for setConsistencyContext. */
function asExtraCharacters(args: Record<string, unknown>): ConsistencyCharacter[] {
	const raw = Array.isArray(args.extraCharacters) ? args.extraCharacters : [];
	return raw.map((c) => {
		const obj = (c ?? {}) as Record<string, unknown>;
		return { name: str(obj.name), descriptor: str(obj.descriptor) };
	});
}

/**
 * The verb registry the agent is allowed to call. A focused subset of the
 * DirectorApi — the orchestration-relevant verbs, not the low-level edit ops.
 */
const TOOLS: Record<
	string,
	(d: DirectorApi, a: Record<string, unknown>) => DirectorResultLike | Promise<DirectorResultLike>
> = {
	getReel: (d) => ({ ok: true, message: "Current reel returned.", data: d.getReel() }),
	reserveSlot: (d, a) =>
		d.reserveSlot({ prompt: str(a.prompt), duration: numOr(a.duration, 6) }),
	storyboard: (d, a) => d.storyboard({ shots: asShots(a) }),
	setPrompt: (d, a) => d.setPrompt({ slotId: str(a.slotId), prompt: str(a.prompt) }),
	generate: (d, a) =>
		d.generate({
			slotIds: Array.isArray(a.slotIds) ? a.slotIds.map(str) : "all",
			alternatives: numOr(a.alternatives, 1),
		}),
	reroll: (d, a) =>
		d.reroll({ slotId: str(a.slotId), alternatives: numOr(a.alternatives, 1) }),
	remix: (d, a) => d.remix({ slotId: str(a.slotId), remixPrompt: str(a.remixPrompt) }),
	setConsistencyContext: (d, a) =>
		d.setConsistencyContext({
			style: a.style != null ? str(a.style) : undefined,
			setting: a.setting != null ? str(a.setting) : undefined,
			extraCharacters: asExtraCharacters(a),
		}),
	getConsistencyContext: (d) => d.getConsistencyContext(),
	chooseTake: (d, a) =>
		a.index != null
			? d.chooseTake({ slotId: str(a.slotId), index: Number(a.index) })
			: d.chooseTake({ slotId: str(a.slotId), takeId: str(a.takeId) }),
	remove: (d, a) => d.remove({ slotId: str(a.slotId) }),
	reorder: (d, a) =>
		d.reorder({ slotIds: Array.isArray(a.slotIds) ? a.slotIds.map(str) : [] }),
	trim: (d, a) =>
		d.trim({
			slotId: str(a.slotId),
			trimStart: numOrUndefined(a.trimStart),
			trimEnd: numOrUndefined(a.trimEnd),
			startTime: numOrUndefined(a.startTime),
			duration: numOrUndefined(a.duration),
		}),
	move: (d, a) =>
		d.move({
			slotId: str(a.slotId),
			newStartTime: numOrZeroTime(a.newStartTime),
			targetTrackId: strOrUndefined(a.targetTrackId),
		}),
	split: (d, a) => d.split({ slotId: str(a.slotId), atTime: numOrZeroTime(a.atTime) }),
	searchMedia: (d, a) =>
		d.searchMedia({ query: str(a.query), limit: numOrUndefined(a.limit) }),
	addText: (d, a) =>
		d.addText({
			content: str(a.content),
			startTime: numOrZeroTime(a.startTime),
			duration: numOrUndefined(a.duration),
			trackId: strOrUndefined(a.trackId),
			fontSize: numOrUndefined(a.fontSize),
			fontFamily: strOrUndefined(a.fontFamily),
			color: strOrUndefined(a.color),
			textAlign: textAlignOf(a.textAlign),
		}),
	updateText: (d, a) =>
		d.updateText({
			elementId: str(a.elementId),
			content: strOrUndefined(a.content),
			startTime: numOrUndefined(a.startTime),
			duration: numOrUndefined(a.duration),
			fontSize: numOrUndefined(a.fontSize),
			fontFamily: strOrUndefined(a.fontFamily),
			color: strOrUndefined(a.color),
			textAlign: textAlignOf(a.textAlign),
		}),
	undo: (d) => d.undo(),
	redo: (d) => d.redo(),
};

const TOOL_DOCS = `Tools (call ONE per turn):
- getReel — inspect current slots/takes. args: {}
- reserveSlot — append ONE empty slot (optionally with a prompt). args: { "prompt": string, "duration": seconds }
- storyboard — append SEVERAL slots from a shot list. args: { "shots": [ { "prompt": string, "duration": seconds }, ... ] }
- setPrompt — change a slot's prompt. args: { "slotId": string, "prompt": string }
- generate — render takes. args: { "slotIds": ["id",...] | "all", "alternatives": 1-4 }
- reroll — add fresh alternate take(s) to one slot. args: { "slotId": string, "alternatives": 1-4 }
- remix — edit a slot's current take with a short delta prompt (e.g. "add a sunset"), keeping its seed/identity anchored. args: { "slotId": string, "remixPrompt": string }
- setConsistencyContext — pin STYLE/SETTING text for the whole reel so every shot's prompt stays visually consistent; characters are pulled from active personas automatically. args: { "style": string, "setting": string, "extraCharacters": [{ "name": string, "descriptor": string }] }
- getConsistencyContext — inspect the current reel-level style/character/setting block. args: {}
- chooseTake — pick the active take. args: { "slotId": string, "index": number } (or "takeId")
- remove — delete a slot. args: { "slotId": string }
- reorder — set slot order. args: { "slotIds": ["id", ...] }
- trim — adjust a slot's in/out points. ALL fields SECONDS. args: { "slotId": string, "trimStart": seconds, "trimEnd": seconds, "startTime": seconds, "duration": seconds } (all but slotId optional)
- move — reposition a slot. args: { "slotId": string, "newStartTime": seconds, "targetTrackId": string } (targetTrackId optional, defaults to the slot's current track; it is a TRACK id, not a slot id — do not use a short slot id here)
- split — cut a slot into two at a point in time. args: { "slotId": string, "atTime": seconds }
- searchMedia — semantic search over indexed footage (CLIP embeddings). args: { "query": string, "limit": number } (limit optional, default 5). Returns FULL mediaIds (not reel slot ids).
- addText — add a text overlay. args: { "content": string, "startTime": seconds, "duration": seconds, "trackId": string, "fontSize": number, "fontFamily": string, "color": string, "textAlign": "left"|"center"|"right" } (only content+startTime required). Returns a FULL elementId — text overlays are NOT reel slots, so this id never appears in the REEL listing below and is never shortened; pass it back verbatim to updateText.
- updateText — edit an existing text overlay by its FULL elementId (from addText's result, never a short slot id). args: { "elementId": string, "content": string, "startTime": seconds, "duration": seconds, "fontSize": number, "fontFamily": string, "color": string, "textAlign": "left"|"center"|"right" } (elementId required, all else optional)
- undo / redo — args: {}`;

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
