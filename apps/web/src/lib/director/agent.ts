/**
 * The Director agent loop — turns a natural-language chat turn into a sequence
 * of `director-api` verb calls.
 *
 * ARCHITECTURE — client loop, server relay:
 * The Director's tools mutate CLIENT-SIDE editor state (Zustand stores, the
 * timeline) through `DirectorApi`, so the agentic loop and all tool execution
 * MUST run in the browser. The Anthropic API key, however, must stay
 * server-side. The split:
 *
 *   browser (this file)                      server
 *   ┌─────────────────────────────┐          ┌────────────────────────────┐
 *   │ runDirectorAgent            │  POST    │ /api/llm/agent (route.ts)  │
 *   │  · messages[] history       │ ───────► │  · pure stateless relay    │
 *   │  · native tool-use loop     │ ◄─────── │  · one messages.create per │
 *   │  · executes tool_use blocks │  JSON    │    call, key from env      │
 *   │    against DirectorApi      │          │  · runs NO loop, NO tools  │
 *   └─────────────────────────────┘          └────────────────────────────┘
 *
 * Two brains behind one seam:
 *  - FRONTIER (default): Claude with NATIVE tool-calling via the relay above.
 *    Multiple tool_use blocks per assistant turn are executed and answered
 *    with tool_result blocks in a single user message; the loop runs until
 *    `stop_reason === "end_turn"` (or a hard ceiling).
 *  - LOCAL (privacy mode / fallback): the original plain-text ReAct loop over
 *    the Ollama backend (`aiClient.chat` injected as `AgentChatFn`), one JSON
 *    action per turn. Kept intact as `runDirectorAgentLocal`; `runDirectorAgent`
 *    falls back to it automatically when the relay reports no ANTHROPIC_API_KEY
 *    (or when the caller passes `brain: "local"`).
 *
 * Both brains drive the SAME verb registry ({@link DIRECTOR_TOOLS}) and the
 * SAME `DirectorApi`, expand SHORT ids at the same choke point
 * ({@link expandIdArgs}), and feed the Sprint-0 mutation-`delta` back as the
 * observation, so behavior differs only in transport quality.
 *
 * No React, no provider wiring here: it depends only on an injected `chat`
 * function (local brain), `fetch` to the relay (frontier brain), and a
 * `DirectorApi`. Generation actually runs because the injected DirectorApi
 * already carries the studio executor (see `use-director`).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { DirectorApi } from "./director-api";
import type { ConsistencyCharacter } from "./consistency-prompt";
import { PLAYBOOKS } from "@/lib/studio/playbooks";
import { createShortIdMap, type ShortIdMap } from "./short-id";
import { getAllTransitions } from "@/lib/transitions";
import { getAllEffects } from "@/lib/effects";

/** Single-shot, non-streaming chat call: (message, system) → assistant text. Local (Ollama) transport. */
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

/** Hard ceiling on tool calls per user turn for the LOCAL text loop. */
const MAX_STEPS = 6;

/**
 * Frontier ceilings. Native tool-calling is far more reliable than the
 * one-JSON-per-turn local loop, so the budget is higher — but still hard-capped
 * to bound a runaway model. When {@link MAX_TOOL_CALLS} is reached the loop
 * forces a final text summary via `tool_choice: {type: "none"}`.
 */
const MAX_TOOL_CALLS = 24;
/** Bound on model round-trips (also covers pause_turn re-sends). */
const MAX_MODEL_CALLS = 30;

/** The browser-side endpoint of the stateless server relay. */
const AGENT_RELAY_URL = "/api/llm/agent";

// ── arg coercion helpers ─────────────────────────────────────────────────────

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
function asExtraCharacters(
	args: Record<string, unknown>,
): ConsistencyCharacter[] {
	const raw = Array.isArray(args.extraCharacters) ? args.extraCharacters : [];
	return raw.map((c) => {
		const obj = (c ?? {}) as Record<string, unknown>;
		return { name: str(obj.name), descriptor: str(obj.descriptor) };
	});
}

/**
 * Coerce a loose `params` arg for applyEffect: a bag of primitive (number/
 * string/boolean) overrides keyed by effect-specific param names. Non-object
 * input or non-primitive values are dropped rather than rejected — the agent
 * doesn't know each effect's exact param shape, so this is lenient by design.
 */
function asEffectParams(
	v: unknown,
): Record<string, number | string | boolean> | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const out: Record<string, number | string | boolean> = {};
	for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
		if (
			typeof val === "number" ||
			typeof val === "string" ||
			typeof val === "boolean"
		) {
			out[key] = val;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

// ── tool registry ────────────────────────────────────────────────────────────

/**
 * JSON schema for a tool's input — strict-mode compatible
 * (`additionalProperties: false` + `required`). The index signature keeps it
 * structurally assignable to the SDK's `Tool["input_schema"]`.
 */
interface ToolInputSchema {
	type: "object";
	properties: Record<string, Record<string, unknown>>;
	required: string[];
	additionalProperties: false;
	[k: string]: unknown;
}

/**
 * One registered Director verb: the model-facing contract (description +
 * strict JSON schema) and the executor that drives `DirectorApi`.
 */
interface DirectorToolDef {
	description: string;
	input_schema: ToolInputSchema;
	run: (
		d: DirectorApi,
		a: Record<string, unknown>,
	) => DirectorResultLike | Promise<DirectorResultLike>;
}

/** Schema shorthands, so registry entries stay one-screen readable. */
const objectSchema = (
	properties: Record<string, Record<string, unknown>>,
	required: string[] = [],
): ToolInputSchema => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});
const stringProp = (description: string) => ({ type: "string", description });
const numberProp = (description: string) => ({ type: "number", description });
const secondsProp = (description: string) =>
	numberProp(`${description} In SECONDS.`);

/**
 * The verb registry the agent is allowed to call — a focused subset of the
 * DirectorApi (the orchestration-relevant verbs, not the low-level edit ops).
 *
 * SINGLE SOURCE OF TRUTH for both brains: the frontier loop derives its native
 * Anthropic tool definitions from `description` + `input_schema` (with
 * `strict: true`), and the local text loop derives its prose tool catalog from
 * the same fields. `run` is the shared name→executor mapping.
 *
 * ── REGISTRATION SEAM (for the addClip / verb fan-out follow-ups) ────────────
 * To add a new verb (e.g. `addClip`, `applyTransition`, `applyEffect`):
 *   1. Add the verb to `director-api.ts` (returning a `DirectorResult` with a
 *      mutation `delta`, like `reserveSlot` does).
 *   2. Add ONE entry to this record: `description` + strict `input_schema`
 *      (time fields in SECONDS via `secondsProp`) + a `run` executor that
 *      coerces args with the helpers above. Mirror the `reserveSlot` entry.
 * Nothing else: schemas, docs, and both agent loops pick the verb up from here.
 * Short slot/take ids in args are expanded automatically (see
 * {@link expandIdArgs}); id-shaped fields that are NOT slot/take ids (track
 * ids, text element ids, media ids) must stay FULL ids — say so in the field
 * description.
 */
const DIRECTOR_TOOLS: Record<string, DirectorToolDef> = {
	getReel: {
		description:
			"Inspect the current reel: every slot in timeline order with its short id, status, take count, and prompt. Call this to refresh your view of the reel mid-task.",
		input_schema: objectSchema({}),
		run: (d) => ({
			ok: true,
			message: "Current reel returned.",
			data: d.getReel(),
		}),
	},
	getSlot: {
		description:
			"Inspect one slot in detail: prompt, status, timing, all takes, and the active take.",
		input_schema: objectSchema(
			{ slotId: stringProp("Short slot id from the reel listing.") },
			["slotId"],
		),
		run: (d, a) => d.getSlot(str(a.slotId)),
	},
	getProjectInfo: {
		description:
			"Inspect project settings (fps, canvas size/orientation), the persona roster, and a media-library summary. The same context is already in your system prompt — call this only to re-check it mid-task after it may have changed.",
		input_schema: objectSchema({}),
		run: (d) => d.getProjectInfo(),
	},
	reserveSlot: {
		description:
			"Append ONE empty generative slot to the reel, optionally with a prompt. Use storyboard to add several shots at once.",
		input_schema: objectSchema({
			prompt: stringProp("Generation prompt for the slot (optional)."),
			duration: secondsProp("Slot duration (default 6)."),
		}),
		run: (d, a) =>
			d.reserveSlot({ prompt: str(a.prompt), duration: numOr(a.duration, 6) }),
	},
	storyboard: {
		description:
			"Append SEVERAL generative slots from a shot list, back-to-back after existing content. One undoable operation.",
		input_schema: objectSchema(
			{
				shots: {
					type: "array",
					description: "Ordered shot list; each shot becomes one slot.",
					items: {
						type: "object",
						properties: {
							prompt: stringProp("Generation prompt for this shot."),
							duration: secondsProp("Shot duration (default 6)."),
						},
						required: ["prompt"],
						additionalProperties: false,
					},
				},
			},
			["shots"],
		),
		run: (d, a) => d.storyboard({ shots: asShots(a) }),
	},
	setPrompt: {
		description: "Change a slot's generation prompt.",
		input_schema: objectSchema(
			{
				slotId: stringProp("Short slot id."),
				prompt: stringProp("The new prompt."),
			},
			["slotId", "prompt"],
		),
		run: (d, a) =>
			d.setPrompt({ slotId: str(a.slotId), prompt: str(a.prompt) }),
	},
	generate: {
		description:
			"Render takes for slots (runs the actual video generation). Omit slotIds to generate EVERY slot in the reel.",
		input_schema: objectSchema({
			slotIds: {
				type: "array",
				items: { type: "string" },
				description:
					"Short slot ids to generate. Omit entirely to target ALL slots.",
			},
			alternatives: numberProp("Takes to produce per slot, 1-4 (default 1)."),
		}),
		run: (d, a) =>
			d.generate({
				slotIds: Array.isArray(a.slotIds) ? a.slotIds.map(str) : "all",
				alternatives: numOr(a.alternatives, 1),
			}),
	},
	reroll: {
		description:
			"Add fresh alternate take(s) to one slot, keeping existing takes.",
		input_schema: objectSchema(
			{
				slotId: stringProp("Short slot id."),
				alternatives: numberProp("How many fresh takes, 1-4 (default 1)."),
			},
			["slotId"],
		),
		run: (d, a) =>
			d.reroll({
				slotId: str(a.slotId),
				alternatives: numOr(a.alternatives, 1),
			}),
	},
	remix: {
		description:
			'Edit a slot\'s current take with a short delta prompt (e.g. "add a sunset"), keeping its seed/identity anchored.',
		input_schema: objectSchema(
			{
				slotId: stringProp("Short slot id."),
				remixPrompt: stringProp("Short delta describing the edit to apply."),
			},
			["slotId", "remixPrompt"],
		),
		run: (d, a) =>
			d.remix({ slotId: str(a.slotId), remixPrompt: str(a.remixPrompt) }),
	},
	setConsistencyContext: {
		description:
			"Pin reel-level STYLE/SETTING text so every shot's prompt stays visually consistent; characters are pulled from active personas automatically.",
		input_schema: objectSchema({
			style: stringProp("Visual style description shared by every shot."),
			setting: stringProp("Setting/location description shared by every shot."),
			extraCharacters: {
				type: "array",
				description: "Additional recurring characters beyond active personas.",
				items: {
					type: "object",
					properties: {
						name: stringProp("Character name."),
						descriptor: stringProp(
							"Stable visual descriptor for the character.",
						),
					},
					required: ["name", "descriptor"],
					additionalProperties: false,
				},
			},
		}),
		run: (d, a) =>
			d.setConsistencyContext({
				style: a.style != null ? str(a.style) : undefined,
				setting: a.setting != null ? str(a.setting) : undefined,
				extraCharacters: asExtraCharacters(a),
			}),
	},
	getConsistencyContext: {
		description:
			"Inspect the current reel-level style/character/setting block.",
		input_schema: objectSchema({}),
		run: (d) => d.getConsistencyContext(),
	},
	chooseTake: {
		description:
			"Pick the active take for a slot. Provide EITHER index (0-based, creation order) OR takeId (short take id) — exactly one.",
		input_schema: objectSchema(
			{
				slotId: stringProp("Short slot id."),
				index: { type: "integer", description: "0-based take index." },
				takeId: stringProp("Short take id (alternative to index)."),
			},
			["slotId"],
		),
		run: (d, a) =>
			a.index != null
				? d.chooseTake({ slotId: str(a.slotId), index: Number(a.index) })
				: d.chooseTake({ slotId: str(a.slotId), takeId: str(a.takeId) }),
	},
	remove: {
		description: "Delete a slot from the reel.",
		input_schema: objectSchema({ slotId: stringProp("Short slot id.") }, [
			"slotId",
		]),
		run: (d, a) => d.remove({ slotId: str(a.slotId) }),
	},
	reorder: {
		description:
			"Set slot order; slots are repacked back-to-back in the given order. Unmentioned slots keep their relative order at the end.",
		input_schema: objectSchema(
			{
				slotIds: {
					type: "array",
					items: { type: "string" },
					description: "Short slot ids in the desired order.",
				},
			},
			["slotIds"],
		),
		run: (d, a) =>
			d.reorder({
				slotIds: Array.isArray(a.slotIds) ? a.slotIds.map(str) : [],
			}),
	},
	trim: {
		description:
			"Adjust a slot's in/out points and timing. All time fields are SECONDS; all but slotId are optional.",
		input_schema: objectSchema(
			{
				slotId: stringProp("Short slot id."),
				trimStart: secondsProp("Amount trimmed off the head."),
				trimEnd: secondsProp("Amount trimmed off the tail."),
				startTime: secondsProp("New timeline start."),
				duration: secondsProp("New visible duration."),
			},
			["slotId"],
		),
		run: (d, a) =>
			d.trim({
				slotId: str(a.slotId),
				trimStart: numOrUndefined(a.trimStart),
				trimEnd: numOrUndefined(a.trimEnd),
				startTime: numOrUndefined(a.startTime),
				duration: numOrUndefined(a.duration),
			}),
	},
	move: {
		description: "Reposition a slot on the timeline.",
		input_schema: objectSchema(
			{
				slotId: stringProp("Short slot id."),
				newStartTime: secondsProp("New timeline start."),
				targetTrackId: stringProp(
					"FULL TRACK id (not a slot id — never a short reel id). Omit to stay on the slot's current track.",
				),
			},
			["slotId", "newStartTime"],
		),
		run: (d, a) =>
			d.move({
				slotId: str(a.slotId),
				newStartTime: numOrZeroTime(a.newStartTime),
				targetTrackId: strOrUndefined(a.targetTrackId),
			}),
	},
	split: {
		description: "Cut a slot into two at a point in time.",
		input_schema: objectSchema(
			{
				slotId: stringProp("Short slot id."),
				atTime: secondsProp("Timeline position of the cut."),
			},
			["slotId", "atTime"],
		),
		run: (d, a) =>
			d.split({ slotId: str(a.slotId), atTime: numOrZeroTime(a.atTime) }),
	},
	applyTransition: {
		description:
			"Apply a transition (dissolve, wipe, slide, zoom, etc.) to a slot's outgoing edge. This is a differentiator competing reel tools don't have — reach for it to polish cuts between shots once they're generated.",
		input_schema: objectSchema(
			{
				slotId: stringProp("Short slot id."),
				transitionType: {
					type: "string",
					enum: getAllTransitions().map((t) => t.type),
					description: "Transition type to apply to the slot's outgoing edge.",
				},
				duration: secondsProp(
					"Transition duration. Omit to use the transition's own default.",
				),
			},
			["slotId", "transitionType"],
		),
		run: (d, a) =>
			d.applyTransition({
				slotId: str(a.slotId),
				transitionType: str(a.transitionType),
				duration: numOrUndefined(a.duration),
			}),
	},
	applyEffect: {
		description:
			"Apply a visual effect (blur, color grade, film grain, glitch, chroma key, etc.) to a slot. This is a differentiator competing reel tools don't have — reach for it to polish shots once they're generated.",
		input_schema: objectSchema(
			{
				slotId: stringProp("Short slot id."),
				effectType: {
					type: "string",
					enum: getAllEffects().map((e) => e.type),
					description: "Effect type to apply to the slot.",
				},
				params: {
					type: "object",
					description:
						"Optional effect parameter overrides (keys vary by effectType, e.g. blur: {radius}, color-adjust: {brightness, contrast, saturation}). Omit to use defaults.",
				},
			},
			["slotId", "effectType"],
		),
		run: (d, a) =>
			d.applyEffect({
				slotId: str(a.slotId),
				effectType: str(a.effectType),
				params: asEffectParams(a.params),
			}),
	},
	searchMedia: {
		description:
			"Semantic search over indexed footage (CLIP embeddings). Returns FULL mediaIds (media-library asset ids) — these are NOT reel slot ids. Follow up with addClip to place a hit on the timeline.",
		input_schema: objectSchema(
			{
				query: stringProp(
					"Natural-language description of the footage wanted.",
				),
				limit: numberProp("Max results (default 5)."),
			},
			["query"],
		),
		run: (d, a) =>
			d.searchMedia({ query: str(a.query), limit: numOrUndefined(a.limit) }),
	},
	addClip: {
		description:
			"Place EXISTING footage found via searchMedia onto the timeline as a real clip — not a generative slot. Pass the FULL mediaId from a searchMedia hit.",
		input_schema: objectSchema(
			{
				mediaId: stringProp(
					"FULL media-library asset id from a searchMedia hit — NOT a short reel id.",
				),
				startTime: secondsProp(
					"Timeline start for the clip. Defaults to the end of the current timeline.",
				),
				duration: secondsProp(
					"Clip duration. Defaults to the asset's own duration (video) or a standard image duration.",
				),
				trackId: stringProp(
					"FULL track id (not a slot id); omit to auto-place on a suitable track.",
				),
			},
			["mediaId"],
		),
		run: (d, a) =>
			d.addClip({
				mediaId: str(a.mediaId),
				startTime: numOrUndefined(a.startTime),
				duration: numOrUndefined(a.duration),
				trackId: strOrUndefined(a.trackId),
			}),
	},
	addText: {
		description:
			"Add a text overlay. Returns a FULL elementId — text overlays are NOT reel slots, so this id never appears in the REEL listing and is never shortened; pass it back verbatim to updateText.",
		input_schema: objectSchema(
			{
				content: stringProp("The text to display."),
				startTime: secondsProp("Timeline start of the overlay."),
				duration: secondsProp("How long the overlay stays on screen."),
				trackId: stringProp(
					"FULL track id; omit to auto-place on a text track.",
				),
				fontSize: numberProp("Font size in pixels."),
				fontFamily: stringProp("Font family name."),
				color: stringProp("CSS color for the text."),
				textAlign: {
					type: "string",
					enum: ["left", "center", "right"],
					description: "Horizontal alignment.",
				},
			},
			["content", "startTime"],
		),
		run: (d, a) =>
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
	},
	updateText: {
		description:
			"Edit an existing text overlay by its FULL elementId (from addText's result — never a short slot id). All fields but elementId are optional.",
		input_schema: objectSchema(
			{
				elementId: stringProp("FULL text-element id returned by addText."),
				content: stringProp("New text content."),
				startTime: secondsProp("New timeline start."),
				duration: secondsProp("New on-screen duration."),
				fontSize: numberProp("New font size in pixels."),
				fontFamily: stringProp("New font family."),
				color: stringProp("New CSS color."),
				textAlign: {
					type: "string",
					enum: ["left", "center", "right"],
					description: "New horizontal alignment.",
				},
			},
			["elementId"],
		),
		run: (d, a) =>
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
	},
	undo: {
		description: "Undo the last reel action.",
		input_schema: objectSchema({}),
		run: (d) => d.undo(),
	},
	redo: {
		description: "Redo the last undone reel action.",
		input_schema: objectSchema({}),
		run: (d) => d.redo(),
	},
};

/**
 * Native Anthropic tool definitions derived from the registry.
 *
 * NOTE: `strict: true` is intentionally NOT set. Anthropic strict mode requires
 * every object schema to be fully closed — all properties listed in `required`
 * (optionals expressed as nullable), and every nested object closed too. Several
 * verbs here carry optional fields (`duration?`, `alternatives?`, `trimStart?`, …)
 * and `applyEffect.params` is an open bag (its keys vary by effect type), so the
 * schemas are not strict-compliant as written and strict use would 400. Standard
 * (non-strict) tool use is robust here because every `run` executor already
 * coerces its inputs (`str`/`numOr`/`asEffectParams`/`expandIdArgs`). Re-enable
 * `strict` only after making the schemas fully compliant and verifying against a
 * live model call.
 */
function anthropicToolDefs(): Anthropic.Tool[] {
	return Object.entries(DIRECTOR_TOOLS).map(([name, def]) => ({
		name,
		description: def.description,
		input_schema: def.input_schema,
	}));
}

/** Render one schema as a compact `{ "key"?: type, ... }` doc line for the local text loop. */
function schemaArgsDoc(schema: ToolInputSchema): string {
	const entries = Object.entries(schema.properties).map(([key, prop]) => {
		const p = prop as {
			type?: string;
			enum?: unknown[];
			items?: { type?: string };
		};
		let type: string = p.enum
			? p.enum.map((v) => JSON.stringify(v)).join("|")
			: (p.type ?? "any");
		if (type === "array") type = `[${p.items?.type ?? "any"}, ...]`;
		const optional = schema.required.includes(key) ? "" : "?";
		return `"${key}"${optional}: ${type}`;
	});
	return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}

/** Prose tool catalog for the LOCAL text loop, derived from the same registry. `?` marks optional args. */
const TOOL_DOCS = `Tools (call ONE per turn; args marked ? are optional):\n${Object.entries(
	DIRECTOR_TOOLS,
)
	.map(
		([name, def]) =>
			`- ${name} — ${def.description} args: ${schemaArgsDoc(def.input_schema)}`,
	)
	.join("\n")}`;

/** Concise pointer to the UGC prompt playbooks — titles/descriptions only, not the full content. */
const PLAYBOOK_POINTER = Object.values(PLAYBOOKS)
	.map((p) => `- ${p.title}: ${p.description}`)
	.join("\n");

// ── short ids ────────────────────────────────────────────────────────────────

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
 * Deliberately EXCLUDES id-shaped fields introduced alongside trim/move/
 * split/addText/updateText/addClip:
 *  - `targetTrackId` (move), `trackId` (addClip/addText) — TRACK ids.
 *    `reelShortIdMap` only indexes slot and take ids, so a track id was never
 *    part of the short-id universe; routing it through `expand` would throw
 *    "unknown id". Callers must pass the full track id (or omit it).
 *  - `elementId` (updateText) — a text-overlay element id. Text elements
 *    aren't generative slots (see `director-api.ts`'s "TEXT" section), so
 *    they never appear in `reelShortIdMap` either; `addText` returns (and
 *    `updateText` expects) the FULL id, never shortened.
 *  - `mediaId` (addClip) — a media-library asset id from `searchMedia`. Media
 *    assets are a separate id space entirely (not timeline elements at all
 *    until placed), so they're never in `reelShortIdMap`; always the FULL id.
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

/**
 * Compact PROJECT/PERSONAS/MEDIA grounding block, built from
 * `DirectorApi.getProjectInfo` — cheap enough to rebuild every turn and small
 * enough to ride in the once-per-turn system prompt (summarized, not dumped:
 * personas and recent assets are pre-capped by `getProjectInfo`).
 */
function buildContextBlock(director: DirectorApi): string {
	const info = director.getProjectInfo().data;
	if (!info) return "";

	const lines: string[] = [
		info.fps != null && info.canvasWidth != null && info.canvasHeight != null
			? `PROJECT: ${info.canvasWidth}x${info.canvasHeight} (${info.orientation}), ${info.fps}fps.`
			: "PROJECT: no active project.",
	];

	if (info.personaCount > 0) {
		const names = info.personas
			.map((p) => `${p.name} (${p.descriptor})`)
			.join(", ");
		const more = info.personaCount > info.personas.length ? ", ..." : "";
		lines.push(`PERSONAS (${info.personaCount}): ${names}${more}.`);
	} else {
		lines.push("PERSONAS: none created yet.");
	}

	const recent = info.recentAssets.length
		? ` Recent: ${info.recentAssets.map((a) => a.name).join(", ")}.`
		: "";
	lines.push(
		`MEDIA LIBRARY: ${info.assetCount} asset(s) indexed. searchMedia finds footage semantically; addClip places a hit on the timeline.${recent}`,
	);

	return lines.join("\n");
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

// ── shared tool execution ────────────────────────────────────────────────────

/**
 * Execute one named tool call against the DirectorApi: expand short ids at the
 * single choke point, run the registry executor, and build the compact
 * observation the model sees. Shared by both brains so the observation
 * language (short ids, `CHANGES:` deltas) is identical.
 */
async function executeTool(
	director: DirectorApi,
	action: string,
	rawArgs: Record<string, unknown>,
): Promise<{ step: AgentToolStep; observation: string }> {
	const tool = DIRECTOR_TOOLS[action];
	if (!tool) {
		const message = `Unknown action "${action}". Valid tools: ${Object.keys(DIRECTOR_TOOLS).join(", ")}.`;
		return {
			step: { action, args: rawArgs, ok: false, message },
			observation: message,
		};
	}

	// Ambiguous/unknown ids surface as a failed step (message from the thrown
	// error) rather than crashing the loop.
	let result: DirectorResultLike;
	try {
		const args = expandIdArgs(rawArgs, reelShortIdMap(director));
		result = await tool.run(director, args);
	} catch (err) {
		result = {
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}

	const step: AgentToolStep = {
		action,
		args: rawArgs,
		ok: result.ok,
		message: result.message,
	};

	// Feed the compact delta (short ids) back as the observation for mutating
	// verbs; getReel echoes the short-id reel listing; read-only verbs with a
	// payload (getSlot/searchMedia/getConsistencyContext) include their data;
	// everything else falls back to the plain message.
	const delta = (result as { delta?: unknown }).delta;
	let observation: string;
	if (action === "getReel") {
		observation = reelSummary(director);
	} else if (delta) {
		observation = `${result.message} CHANGES:${JSON.stringify(delta)}`;
	} else if (
		result.ok &&
		result.data !== undefined &&
		(action === "getSlot" ||
			action === "searchMedia" ||
			action === "getConsistencyContext" ||
			action === "getProjectInfo")
	) {
		observation = `${result.message} DATA:${JSON.stringify(result.data)}`;
	} else {
		observation = result.message;
	}
	return { step, observation };
}

// ── frontier brain (Claude native tool-calling via the server relay) ─────────

/** Thrown when the relay reports that ANTHROPIC_API_KEY is not configured — the signal to fall back to local mode. */
export class AnthropicKeyMissingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnthropicKeyMissingError";
	}
}

/** The assistant-message slice the relay returns from one `messages.create` call. */
interface AgentModelTurn {
	content: Anthropic.ContentBlock[];
	stop_reason: Anthropic.StopReason | null;
	model: string;
	usage?: unknown;
}

/**
 * One model round-trip through the stateless server relay. The relay holds the
 * API key and forwards exactly one `messages.create` — no loop, no tools run
 * server-side.
 */
async function callAgentRelay(request: {
	messages: Anthropic.MessageParam[];
	system: string;
	tools: Anthropic.Tool[];
	tool_choice?: Anthropic.ToolChoice;
}): Promise<AgentModelTurn> {
	const res = await fetch(AGENT_RELAY_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
	const body = (await res.json().catch(() => null)) as
		| (Partial<AgentModelTurn> & { error?: string; message?: string })
		| null;

	if (!res.ok) {
		if (body?.error === "anthropic_not_configured") {
			throw new AnthropicKeyMissingError(
				body.message ?? "ANTHROPIC_API_KEY is not configured on the server.",
			);
		}
		throw new Error(
			`Claude relay error (${res.status}): ${body?.message ?? body?.error ?? "unknown error"}`,
		);
	}
	if (!body || !Array.isArray(body.content)) {
		throw new Error("Claude relay error: malformed response (no content).");
	}
	return body as AgentModelTurn;
}

/** Join a turn's text blocks into the user-facing message. */
function textOf(content: Anthropic.ContentBlock[]): string {
	return content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/**
 * System prompt for the frontier brain. Built ONCE per user turn (not per
 * model call) so the prefix stays byte-stable across the loop for prompt
 * caching; the reel listing inside it is therefore a snapshot — live state
 * flows through tool-result deltas and `getReel`.
 */
function buildFrontierSystemPrompt(director: DirectorApi): string {
	return [
		"You are the Director — an AI that builds and edits a short video reel by calling tools.",
		"A reel is an ordered list of generative SLOTS; each slot holds a prompt and one or more generated TAKES.",
		"",
		"UNITS: all durations and times are in SECONDS unless a field name ends in `Frames`.",
		"IDS: every id shown to you (in the REEL below and in tool-result CHANGES reports) is a SHORT id. Pass short ids back verbatim in tool args — do not lengthen or invent them. Exceptions (always FULL ids, never shortened): `targetTrackId` (a track id), `elementId` (a text-overlay id from addText), and mediaIds from searchMedia.",
		"",
		"Use tools ONLY when the user wants to build or change the reel. For questions, ideas, scripts, or advice, reply with plain text and no tool calls.",
		"You may request several independent tool calls in one turn; dependent steps (e.g. storyboard, then generate the new slots) belong in separate turns so you can read the ids from the results. Each tool result is a compact observation — mutating verbs report a CHANGES diff in short ids. The REEL listing below is a snapshot from the start of this turn; call getReel when you need a fresh view.",
		"Think through multi-step edits as much as needed, then act decisively. When the task is done, reply with a short plain-text summary of what you did.",
		"",
		'If the user wants UGC/influencer-style, "looks like a real phone photo" imagery or video, follow these playbook conventions when writing prompts:',
		PLAYBOOK_POINTER,
		"",
		buildContextBlock(director),
		"",
		reelSummary(director),
	].join("\n");
}

/**
 * The frontier agent loop: browser-held `messages` history, one relay call per
 * model turn, ALL tool_use blocks of a turn executed here and answered with
 * tool_result blocks in ONE user message, until `end_turn` or a ceiling.
 */
async function runDirectorAgentFrontier(opts: {
	director: DirectorApi;
	userMessage: string;
	onStep?: (step: AgentToolStep) => void;
}): Promise<AgentRunResult> {
	const { director, userMessage, onStep } = opts;
	const steps: AgentToolStep[] = [];
	const system = buildFrontierSystemPrompt(director);
	const tools = anthropicToolDefs();
	const messages: Anthropic.MessageParam[] = [
		{ role: "user", content: userMessage },
	];

	let toolCalls = 0;
	let wrapUp = false; // set when the tool budget is spent → force a text-only close
	let lastText = "";

	for (let call = 0; call < MAX_MODEL_CALLS; call++) {
		const turn = await callAgentRelay({
			messages,
			system,
			tools,
			...(wrapUp
				? { tool_choice: { type: "none" } as Anthropic.ToolChoice }
				: {}),
		});

		// Check stop_reason BEFORE reading content: a refusal can carry an empty
		// content array.
		if (turn.stop_reason === "refusal") {
			return {
				finalMessage:
					"The model declined this request. Try rephrasing what you want the Director to do.",
				steps,
			};
		}

		// Append the assistant turn verbatim (including thinking blocks — they
		// must be echoed back unchanged on subsequent calls).
		messages.push({ role: "assistant", content: turn.content });
		lastText = textOf(turn.content) || lastText;

		// pause_turn: the server-side turn was interrupted — re-send as-is to
		// let it resume (no user message in between).
		if (turn.stop_reason === "pause_turn") continue;

		const toolUses = turn.content.filter(
			(b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
		);
		if (toolUses.length === 0) {
			// end_turn (or max_tokens) with no tool calls — we're done.
			return { finalMessage: textOf(turn.content), steps };
		}

		// Execute EVERY tool_use block in this assistant message, then return
		// ALL results in ONE user message. `input` is already a structured
		// object — never string-parse it.
		const resultBlocks: Anthropic.ContentBlockParam[] = [];
		for (const use of toolUses) {
			const { step, observation } = await executeTool(
				director,
				use.name,
				(use.input ?? {}) as Record<string, unknown>,
			);
			steps.push(step);
			onStep?.(step);
			toolCalls++;
			resultBlocks.push({
				type: "tool_result",
				tool_use_id: use.id,
				content: observation,
				...(step.ok ? {} : { is_error: true }),
			});
		}

		if (toolCalls >= MAX_TOOL_CALLS && !wrapUp) {
			// Ceiling hit: deliver the results, then ask for a final text summary
			// (the next call carries tool_choice: none so the model must close).
			wrapUp = true;
			resultBlocks.push({
				type: "text",
				text: "You have used the tool budget for this turn. Reply with a final plain-text summary of what you did and what (if anything) is left.",
			});
		}
		messages.push({ role: "user", content: resultBlocks });
	}

	// Model-call ceiling hit without a clean close — surface the best text we saw.
	return {
		finalMessage:
			lastText ||
			`Stopped after ${MAX_MODEL_CALLS} model turns (${steps.length} tool call(s) executed).`,
		steps,
	};
}

// ── local brain (plain-text ReAct over Ollama — privacy mode / fallback) ─────

function buildLocalSystemPrompt(director: DirectorApi): string {
	return [
		"You are the Director — an AI that builds and edits a short video reel by calling tools.",
		"A reel is an ordered list of generative SLOTS; each slot holds a prompt and one or more generated TAKES.",
		"",
		"UNITS: all durations and times are in SECONDS unless a field name ends in `Frames`.",
		"IDS: every id shown to you (in the REEL below and in change reports) is a SHORT id. Pass short ids back verbatim in tool args — do not lengthen or invent them.",
		"",
		TOOL_DOCS,
		"",
		'If the user wants UGC/influencer-style, "looks like a real phone photo" imagery or video, follow these playbook conventions when writing prompts:',
		PLAYBOOK_POINTER,
		"",
		"PROTOCOL — reply with a SINGLE minified JSON object and NOTHING else:",
		'  to act:   {"action":"<tool>","args":{...}}',
		'  to reply: {"final":"<message to the user>"}',
		"Use actions ONLY when the user wants to build or change the reel. For questions, ideas, scripts, or advice, answer with a final message.",
		"After each action you receive an OBSERVATION. When the task is done, send a final message summarizing what you did.",
		"",
		buildContextBlock(director),
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
 * Parse the local model's reply. Lenient: prose with no JSON is treated as a
 * final answer (graceful fallback for weak local models).
 */
function parseReply(text: string): ParsedAction | ParsedFinal {
	const json = firstJsonObject(text);
	if (json) {
		try {
			const obj = JSON.parse(json) as Record<string, unknown>;
			if (typeof obj.final === "string")
				return { kind: "final", text: obj.final };
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
 * PRIVACY MODE / FALLBACK: the original plain-text ReAct loop over the local
 * Ollama backend. One JSON action per turn, whole system prompt + scratchpad
 * re-sent each step, capped at {@link MAX_STEPS}. Kept as a first-class export
 * so callers can force local inference; `runDirectorAgent` also routes here
 * automatically when the frontier relay reports no API key.
 */
export async function runDirectorAgentLocal(opts: {
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
			buildLocalSystemPrompt(director),
		);
		const parsed = parseReply(reply);

		if (parsed.kind === "final") {
			return { finalMessage: parsed.text, steps };
		}

		const { step, observation } = await executeTool(
			director,
			parsed.action,
			parsed.args,
		);
		// Unknown actions aren't real steps — feed the correction back without
		// recording/streaming a step (mirrors the original loop's behavior).
		if (!DIRECTOR_TOOLS[parsed.action]) {
			scratchpad +=
				`ASSISTANT: ${JSON.stringify({ action: parsed.action, args: parsed.args })}\n` +
				`OBSERVATION: ${observation}\n`;
			continue;
		}
		steps.push(step);
		onStep?.(step);

		scratchpad +=
			`ASSISTANT: ${JSON.stringify({ action: parsed.action, args: parsed.args })}\n` +
			`OBSERVATION: ${observation}\n`;
	}

	// Hit the step ceiling — ask for a closing summary.
	const closing = await chat(
		`${scratchpad}\nYou have taken enough steps. Reply ONLY with {"final":"..."} summarizing the result for the user.`,
		buildLocalSystemPrompt(director),
	);
	const parsed = parseReply(closing);
	return {
		finalMessage: parsed.kind === "final" ? parsed.text : closing.trim(),
		steps,
	};
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Run one user turn through the agent. `onStep` fires after each executed tool
 * so the UI can stream progress.
 *
 * Brain selection:
 *  - `"auto"` (default): frontier Claude via `/api/llm/agent`; if the relay
 *    reports no `ANTHROPIC_API_KEY`, transparently falls back to the local
 *    Ollama text loop (`chat`). The fallback decision happens on the FIRST
 *    relay call, before any tool has run, so no work is repeated.
 *  - `"frontier"`: Claude only — a missing key surfaces as an error.
 *  - `"local"`: privacy mode — never leaves the machine (uses `chat` only).
 */
export async function runDirectorAgent(opts: {
	director: DirectorApi;
	chat: AgentChatFn;
	userMessage: string;
	onStep?: (step: AgentToolStep) => void;
	brain?: "auto" | "frontier" | "local";
}): Promise<AgentRunResult> {
	const brain = opts.brain ?? "auto";
	if (brain === "local") return runDirectorAgentLocal(opts);
	try {
		return await runDirectorAgentFrontier(opts);
	} catch (error) {
		if (brain === "auto" && error instanceof AnthropicKeyMissingError) {
			return runDirectorAgentLocal(opts);
		}
		throw error;
	}
}
