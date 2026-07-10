/**
 * The shared Director tool catalog — the SINGLE source of truth for the verb
 * surface the two callers consume:
 *
 *   1. the in-app agent loop (`agent.ts`), which renders `TOOL_DOCS` + the
 *      `TOOLS` executor registry from this catalog, and
 *   2. the external MCP server (Fable's transport), which exposes each
 *      descriptor's `inputSchema` to MCP clients and dispatches through the
 *      SAME `handler`.
 *
 * One descriptor per `DirectorApi` verb. Each descriptor owns:
 *  - the agent/MCP-facing `description` (one line; the reel-wide SECONDS + SHORT
 *    id conventions are stated once in the system prompt / this header),
 *  - a draft-07 `inputSchema` that is the authoritative arg contract,
 *  - a `mutating` flag (true => the verb returns a `delta`; also drives
 *    `scopeForTool` for MCP scope enforcement), and
 *  - a `handler` that performs the SAME arg-coercion the manual agent did and
 *    calls exactly one `DirectorApi` verb.
 *
 * This module is PURE LOGIC: no React, no network, no MCP imports. Handlers only
 * call `director-api` verbs. UNIT CONVENTION: every numeric time/duration field
 * is in SECONDS (matching `director-api.ts`); `x-seconds` marks those fields.
 */

import { getAllTransitions } from "@/lib/transitions";
import { getAllEffects } from "@/lib/effects";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportQuality,
} from "@/types/export";
import type { DirectorApi, SpecOverride } from "./director-api";
import type { DirectorResult } from "./types";
import type { ConsistencyCharacter } from "./consistency-prompt";
import type { StyleBible } from "./storyboard-plan";

// ── coercion helpers (moved here from agent.ts; the single arg-coercion site) ──

/** Required positive numeric arg; falls back to `fallback` for 0/negative/NaN. */
export const numOr = (v: unknown, fallback: number): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Optional numeric arg: `undefined` when unset/non-finite, otherwise the number
 * as-is — unlike `numOr`, 0 and negative values pass through untouched (needed
 * for time fields where 0 is a legitimate SECONDS value, e.g. `trimStart: 0`).
 */
export const numOrUndefined = (v: unknown): number | undefined => {
	if (v == null) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
};

/** Required numeric time arg (SECONDS) that may legitimately be 0; falls back to 0 if unparsable. */
export const numOrZeroTime = (v: unknown): number => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};

/** Coerce to string; `null`/`undefined` become `""`. */
export const str = (v: unknown): string => (v == null ? "" : String(v));

/** Optional string arg: `undefined` when unset (vs. `str`, which coerces to `""`). */
export const strOrUndefined = (v: unknown): string | undefined =>
	v == null ? undefined : String(v);

/** Optional boolean arg: only a REAL boolean survives; anything else → `undefined`. */
export const boolOrUndefined = (v: unknown): boolean | undefined =>
	typeof v === "boolean" ? v : undefined;

/** Validate a loose `format` arg against the export-format enum; drops anything else. */
export const asExportFormat = (v: unknown): ExportFormat | undefined => {
	const s = v == null ? undefined : String(v);
	return EXPORT_FORMAT_VALUES.find((f) => f === s);
};

/** Validate a loose `quality` arg against the export-quality enum; drops anything else. */
export const asExportQuality = (v: unknown): ExportQuality | undefined => {
	const s = v == null ? undefined : String(v);
	return EXPORT_QUALITY_VALUES.find((q) => q === s);
};

/** Validate a loose `textAlign` arg against the literal union the API accepts; drops anything else. */
export const textAlignOf = (
	v: unknown,
): "left" | "center" | "right" | undefined => {
	const s = v == null ? undefined : String(v);
	return s === "left" || s === "center" || s === "right" ? s : undefined;
};

/**
 * Coerce a loose per-shot generation override into a {@link SpecOverride} — the
 * fields that turn a slot from plain text-to-video into a CONDITIONED shot:
 * I2V/R2V `mode`, a first-frame/reference image (by URL or by uploaded-asset
 * id via `referenceMediaId`), extra omni-reference images, and identity knobs.
 * Unknown/ill-typed fields are dropped (lenient, mirroring `asEffectParams`);
 * returns `undefined` when nothing usable is present so callers omit `spec`.
 */
export function asSpecOverride(v: unknown): SpecOverride | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const o = v as Record<string, unknown>;
	const out: SpecOverride = {};
	if (o.mode === "image-to-video" || o.mode === "text-to-video")
		out.mode = o.mode;
	if (o.referenceImageUrl != null)
		out.referenceImageUrl = String(o.referenceImageUrl);
	if (o.referenceMediaId != null)
		out.referenceMediaId = String(o.referenceMediaId);
	if (Array.isArray(o.referenceImages))
		out.referenceImages = o.referenceImages.map(String);
	if (typeof o.generateAudio === "boolean") out.generateAudio = o.generateAudio;
	if (o.seed != null && Number.isFinite(Number(o.seed)))
		out.seed = Number(o.seed);
	if (typeof o.seedLocked === "boolean") out.seedLocked = o.seedLocked;
	if (o.cameraPreset != null) out.cameraPreset = String(o.cameraPreset);
	if (o.consistencyMode === "high" || o.consistencyMode === "fast")
		out.consistencyMode = o.consistencyMode;
	if (o.personaId != null) out.personaId = String(o.personaId);
	// Per-shot model pin → `spec.model` (the router's `preferredBackendId`).
	// Agent-facing key is `backendId`; a raw `model` is also accepted.
	if (o.backendId != null) out.model = String(o.backendId);
	else if (o.model != null) out.model = String(o.model);
	return Object.keys(out).length ? out : undefined;
}

/**
 * Coerce a loose `shots` arg into the storyboard shape: the generation `prompt`
 * + `duration` + optional per-shot `spec`, PLUS the planning notes
 * (`intent`/`camera`/`subject`) that make the shot list a real storyboard rather
 * than N independent prompts. Bare strings and note-less shots still work.
 */
export function asShots(args: Record<string, unknown>): {
	prompt: string;
	duration: number;
	intent?: string;
	camera?: string;
	subject?: string;
	spec?: SpecOverride;
}[] {
	const raw = Array.isArray(args.shots) ? args.shots : [];
	return raw.map((s) => {
		if (typeof s === "string") return { prompt: s, duration: 6 };
		const obj = (s ?? {}) as Record<string, unknown>;
		const spec = asSpecOverride(obj.spec);
		const intent = strOrUndefined(obj.intent);
		const camera = strOrUndefined(obj.camera);
		const subject = strOrUndefined(obj.subject);
		return {
			prompt: str(obj.prompt),
			duration: numOr(obj.duration, 6),
			...(intent ? { intent } : {}),
			...(camera ? { camera } : {}),
			...(subject ? { subject } : {}),
			...(spec ? { spec } : {}),
		};
	});
}

/**
 * Coerce a loose `bible` arg for `storyboard` into a {@link StyleBible} — the
 * shared palette/lens-mood/setting/cast the whole reel inherits. Returns
 * `undefined` when nothing usable is present so the verb skips consistency
 * seeding and leaves any prior context untouched.
 */
export function asStyleBible(
	args: Record<string, unknown>,
): StyleBible | undefined {
	const raw = args.bible;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const palette = strOrUndefined(obj.palette);
	const lensMood = strOrUndefined(obj.lensMood);
	const setting = strOrUndefined(obj.setting);
	const characters = Array.isArray(obj.characters)
		? obj.characters.map((c) => {
				const co = (c ?? {}) as Record<string, unknown>;
				return { name: str(co.name), descriptor: str(co.descriptor) };
			})
		: [];
	if (!palette && !lensMood && !setting && characters.length === 0)
		return undefined;
	return {
		...(palette ? { palette } : {}),
		...(lensMood ? { lensMood } : {}),
		...(setting ? { setting } : {}),
		...(characters.length ? { characters } : {}),
	};
}

/** Coerce a loose `extraCharacters` arg for setConsistencyContext. */
export function asExtraCharacters(
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
export function asEffectParams(
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

// ── types ─────────────────────────────────────────────────────────────────────

/**
 * A minimal JSON Schema (draft-07 subset) node. `x-seconds` is a non-standard
 * annotation that marks a numeric field as SECONDS so doc renderers / MCP
 * clients can surface the unit; standard validators ignore it.
 */
export interface JSONSchema {
	type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
	description?: string;
	properties?: Record<string, JSONSchema>;
	items?: JSONSchema;
	required?: string[];
	enum?: readonly (string | number)[];
	oneOf?: JSONSchema[];
	default?: unknown;
	minimum?: number;
	maximum?: number;
	additionalProperties?: boolean;
	/** Non-standard: this numeric field is measured in SECONDS. */
	"x-seconds"?: boolean;
	[key: string]: unknown;
}

/**
 * A verb handler shared by the agent loop and the MCP server. Reuses the same
 * arg-coercion the manual agent did, then calls exactly one `DirectorApi` verb.
 * Returns are widened to `DirectorResult<unknown>` so every verb's payload type
 * is assignable; both callers read only `ok`/`message`/`data`/`delta`.
 */
export type ToolHandler = (
	director: DirectorApi,
	args: Record<string, unknown>,
) => DirectorResult<unknown> | Promise<DirectorResult<unknown>>;

/** One entry in the shared tool catalog. */
export interface ToolDescriptor {
	/** Stable verb name; matches a `DirectorApi` method, e.g. "storyboard". */
	name: string;
	/** One-line, agent/MCP-facing description. */
	description: string;
	/** Authoritative draft-07 arg contract (single source of truth for args). */
	inputSchema: JSONSchema;
	/** True => mutating verb (returns a `delta`; requires the `reel:write` scope). */
	mutating: boolean;
	/** Executor: coerces args then calls exactly one `DirectorApi` verb. */
	handler: ToolHandler;
}

// ── schema fragments ────────────────────────────────────────────────────────

const EMPTY: JSONSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
};
const secs = (description: string): JSONSchema => ({
	type: "number",
	"x-seconds": true,
	description,
});
const slotIdProp: JSONSchema = {
	type: "string",
	description: "Short slot id from the REEL listing.",
};

/**
 * Optional model pin — a backend id from `getBackends` (the router's
 * `preferredBackendId`). Shared by `generate`/`reroll` and the per-shot spec.
 * Omit to let the router auto-select by intent.
 */
const backendIdProp: JSONSchema = {
	type: "string",
	description:
		"Optional backend id from getBackends to pin this generation to a specific model. POLICY: drafts/iteration on a cheap-tier backend, final/hero shots on premium, persona/identity-critical shots on a seed-lock-capable backend. Omit to auto-route by intent.",
};

/**
 * Per-shot generation override — the fields that turn a plain text-to-video
 * slot into a CONDITIONED shot. Attach to `storyboard` shots, `reserveSlot`, or
 * `setPrompt`. Every field is optional; omit for a default text-to-video slot.
 */
const slotSpecSchema: JSONSchema = {
	type: "object",
	description:
		"Optional per-shot generation override (I2V/R2V mode + reference images + identity).",
	properties: {
		mode: {
			type: "string",
			enum: ["text-to-video", "image-to-video"],
			description:
				"text-to-video (default) or image-to-video — I2V/R2V; requires a reference image (referenceMediaId or referenceImageUrl).",
		},
		referenceMediaId: {
			type: "string",
			description:
				"Media-library asset id (e.g. an uploaded @Image1) to use as the first-frame/reference image; resolved to its URL. FULL media id, not a reel slot id. Prefer this over referenceImageUrl for uploaded/generated assets.",
		},
		referenceImageUrl: {
			type: "string",
			description:
				"First-frame / reference image URL (I2V anchor). Use referenceMediaId instead when the image is a media-library asset.",
		},
		referenceImages: {
			type: "array",
			items: { type: "string" },
			description:
				"Extra omni-reference image URLs (subject/style/scene) for reference-to-video.",
		},
		generateAudio: {
			type: "boolean",
			description:
				"Set false to render the shot SILENT (no model audio) — e.g. Seedance clips whose audio is a separate VO/music track. Omit for the provider default.",
		},
		personaId: {
			type: "string",
			description: "Bind this shot to a persona for identity consistency.",
		},
		seed: {
			type: "number",
			description: "Generation seed — reuse the same value to anchor identity.",
		},
		seedLocked: {
			type: "boolean",
			description: "Reproduce identity from `seed` (seed-lock).",
		},
		cameraPreset: {
			type: "string",
			description: "Camera-motion preset id woven into the prompt.",
		},
		consistencyMode: {
			type: "string",
			enum: ["high", "fast"],
			description:
				"Persona consistency tier: high = per-shot reference still (default), fast = anchor image directly.",
		},
		backendId: backendIdProp,
	},
	additionalProperties: false,
};

// ── the catalog ───────────────────────────────────────────────────────────────

/**
 * The Director verbs, one descriptor each — including `export` (maps to
 * `director-api.ts`'s `exportReel`) and the model-routing surface: `getBackends`
 * to read the catalog, `backendId` on generate/reroll, and `compareTake` to A/B
 * two backends.
 */
export function toolCatalog(): ToolDescriptor[] {
	return [
		// ── read ────────────────────────────────────────────────────────────
		{
			name: "getReel",
			description: "inspect current slots/takes.",
			mutating: false,
			inputSchema: EMPTY,
			handler: (d) => ({
				ok: true,
				message: "Current reel returned.",
				data: d.getReel(),
			}),
		},
		{
			name: "getSlot",
			description: "inspect ONE slot (prompt, status, takes) by id.",
			mutating: false,
			inputSchema: {
				type: "object",
				properties: { slotId: slotIdProp },
				required: ["slotId"],
			},
			handler: (d, a) => d.getSlot(str(a.slotId)),
		},
		{
			name: "searchMedia",
			description:
				"semantic search over indexed footage (CLIP embeddings). Returns FULL mediaIds (not reel slot ids).",
			mutating: false,
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string" },
					limit: { type: "number", default: 5, minimum: 1 },
				},
				required: ["query"],
			},
			handler: (d, a) =>
				d.searchMedia({ query: str(a.query), limit: numOrUndefined(a.limit) }),
		},
		{
			name: "getProjectInfo",
			description:
				"inspect project settings (fps, canvas size/orientation), the persona roster, and a media-library summary. The same context is already in your system prompt — call this only to re-check it mid-task after it may have changed.",
			mutating: false,
			inputSchema: EMPTY,
			handler: (d) => d.getProjectInfo(),
		},
		{
			name: "getBackends",
			description:
				"list the generation models available now — each with modality, safety tier, seed-lock/reference-edit support, and a RELATIVE cost tier (cheap/standard/premium). Use to pick a backendId: drafts on cheap, final/hero on premium, persona-critical on a seed-lock-capable model.",
			mutating: false,
			inputSchema: {
				type: "object",
				properties: {
					modality: {
						type: "string",
						enum: ["video", "image"],
						description: "Filter to one modality; omit for all.",
					},
				},
				additionalProperties: false,
			},
			handler: (d, a) =>
				d.getBackends({
					modality:
						a.modality === "video" || a.modality === "image"
							? a.modality
							: undefined,
				}),
		},
		// ── storyboard ──────────────────────────────────────────────────────
		{
			name: "storyboard",
			description:
				"PLAN a multi-shot sequence: decompose a brief into shots (prompt + creative intent/camera/subject notes + duration) under a shared style bible, then materialize them as slots. Persists the plan and auto-seeds the reel's consistency context from the bible, so every later generate stays coherent. Use this before generating anything for a >1-shot brief.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					shots: {
						type: "array",
						description:
							"Ordered shots. Author per-shot INTENT/CAMERA/SUBJECT notes so the sequence is coherent, not N independent prompts.",
						items: {
							type: "object",
							properties: {
								prompt: {
									type: "string",
									description: "What actually gets rendered for this shot.",
								},
								intent: {
									type: "string",
									description:
										"What this shot accomplishes narratively (e.g. 'cold-open establishing shot').",
								},
								camera: {
									type: "string",
									description:
										"Framing / camera movement / lens (e.g. 'slow push-in, 35mm, eye-level').",
								},
								subject: {
									type: "string",
									description:
										"Who/what is on screen and what they're doing (keep the cast consistent across shots).",
								},
								duration: secs("shot length in seconds (default 6)"),
								spec: slotSpecSchema,
							},
							required: ["prompt"],
						},
					},
					bible: {
						type: "object",
						description:
							"Shared style bible for the whole reel — also seeds the consistency context so every shot inherits it.",
						properties: {
							palette: {
								type: "string",
								description:
									"Color grade / palette held constant across shots.",
							},
							lensMood: {
								type: "string",
								description:
									"Lens + mood (e.g. 'anamorphic, dreamy, shallow DoF').",
							},
							setting: {
								type: "string",
								description:
									"Primary location: environment, time of day, lighting.",
							},
							characters: {
								type: "array",
								description:
									"Secondary/background cast with no persona of their own (personas are pulled in automatically).",
								items: {
									type: "object",
									properties: {
										name: { type: "string" },
										descriptor: { type: "string" },
									},
									required: ["name", "descriptor"],
								},
							},
						},
					},
				},
				required: ["shots"],
			},
			handler: (d, a) =>
				d.storyboard({ shots: asShots(a), bible: asStyleBible(a) }),
		},
		{
			name: "reserveSlot",
			description: "append ONE empty slot (optionally with a prompt).",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					prompt: { type: "string" },
					duration: secs("slot length in seconds (default 6)"),
					spec: slotSpecSchema,
				},
			},
			handler: (d, a) =>
				d.reserveSlot({
					prompt: str(a.prompt),
					duration: numOr(a.duration, 6),
					spec: asSpecOverride(a.spec),
				}),
		},
		{
			name: "setPrompt",
			description:
				"change a slot's prompt (and optionally its per-shot generation spec).",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					prompt: { type: "string" },
					spec: slotSpecSchema,
				},
				required: ["slotId", "prompt"],
			},
			handler: (d, a) =>
				d.setPrompt({
					slotId: str(a.slotId),
					prompt: str(a.prompt),
					spec: asSpecOverride(a.spec),
				}),
		},
		// ── generate ────────────────────────────────────────────────────────
		{
			name: "generate",
			description: "render takes for one/many slots.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotIds: {
						oneOf: [
							{ type: "array", items: slotIdProp },
							{ type: "string", enum: ["all"] },
						],
						description: 'slot ids to render, or "all".',
					},
					alternatives: {
						type: "integer",
						default: 1,
						minimum: 1,
						maximum: 4,
						description: "takes to produce per slot (1-4).",
					},
					backendId: backendIdProp,
				},
			},
			handler: (d, a) =>
				d.generate({
					slotIds: Array.isArray(a.slotIds) ? a.slotIds.map(str) : "all",
					alternatives: numOr(a.alternatives, 1),
					backendId: strOrUndefined(a.backendId),
				}),
		},
		{
			name: "reroll",
			description: "add fresh alternate take(s) to one slot.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					alternatives: {
						type: "integer",
						default: 1,
						minimum: 1,
						maximum: 4,
					},
					backendId: backendIdProp,
				},
				required: ["slotId"],
			},
			handler: (d, a) =>
				d.reroll({
					slotId: str(a.slotId),
					alternatives: numOr(a.alternatives, 1),
					backendId: strOrUndefined(a.backendId),
				}),
		},
		{
			name: "compareTake",
			description:
				"A/B one slot across TWO backends: render the same shot on each and auto-pick the better take if a vision critic is available, else add both as takes for you to choose. Costs 2x a single generate — subject to the cost gate. Use for hero/final shots worth the extra spend.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					backendIds: {
						type: "array",
						items: { type: "string" },
						minItems: 2,
						maxItems: 2,
						description:
							"Exactly two distinct backend ids (from getBackends) to compare.",
					},
				},
				required: ["slotId", "backendIds"],
			},
			handler: (d, a) =>
				d.compareTake({
					slotId: str(a.slotId),
					backendIds: Array.isArray(a.backendIds) ? a.backendIds.map(str) : [],
				}),
		},
		{
			name: "remix",
			description:
				'edit a slot\'s current take with a short delta prompt (e.g. "add a sunset"), keeping its seed/identity anchored.',
			mutating: true,
			inputSchema: {
				type: "object",
				properties: { slotId: slotIdProp, remixPrompt: { type: "string" } },
				required: ["slotId", "remixPrompt"],
			},
			handler: (d, a) =>
				d.remix({ slotId: str(a.slotId), remixPrompt: str(a.remixPrompt) }),
		},
		{
			name: "chooseTake",
			description: "pick the active take (by index or takeId).",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					index: { type: "integer", description: "0-based take index." },
					takeId: { type: "string", description: "short take id." },
				},
				required: ["slotId"],
			},
			handler: (d, a) =>
				a.index != null
					? d.chooseTake({ slotId: str(a.slotId), index: Number(a.index) })
					: d.chooseTake({ slotId: str(a.slotId), takeId: str(a.takeId) }),
		},
		// ── consistency ─────────────────────────────────────────────────────
		{
			name: "getConsistencyContext",
			description:
				"inspect the current reel-level style/character/setting block.",
			mutating: false,
			inputSchema: EMPTY,
			handler: (d) => d.getConsistencyContext(),
		},
		{
			name: "setConsistencyContext",
			description:
				"pin STYLE/SETTING text for the whole reel so every shot stays visually consistent; characters are pulled from active personas automatically.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					style: { type: "string" },
					setting: { type: "string" },
					extraCharacters: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								descriptor: { type: "string" },
							},
							required: ["name", "descriptor"],
						},
					},
				},
			},
			handler: (d, a) =>
				d.setConsistencyContext({
					style: a.style != null ? str(a.style) : undefined,
					setting: a.setting != null ? str(a.setting) : undefined,
					extraCharacters: asExtraCharacters(a),
				}),
		},
		// ── edit (all time fields SECONDS) ──────────────────────────────────
		{
			name: "trim",
			description: "adjust a slot's in/out points. All time fields SECONDS.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					trimStart: secs("in-point offset (seconds)"),
					trimEnd: secs("out-point offset (seconds)"),
					startTime: secs("new timeline start (seconds)"),
					duration: secs("new duration (seconds)"),
				},
				required: ["slotId"],
			},
			handler: (d, a) =>
				d.trim({
					slotId: str(a.slotId),
					trimStart: numOrUndefined(a.trimStart),
					trimEnd: numOrUndefined(a.trimEnd),
					startTime: numOrUndefined(a.startTime),
					duration: numOrUndefined(a.duration),
				}),
		},
		{
			name: "move",
			description:
				"reposition a slot. targetTrackId is a full TRACK id (not a short slot id); omit to stay on the current track.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					newStartTime: secs("new start time (seconds)"),
					targetTrackId: {
						type: "string",
						description: "full track id (optional).",
					},
				},
				required: ["slotId", "newStartTime"],
			},
			handler: (d, a) =>
				d.move({
					slotId: str(a.slotId),
					newStartTime: numOrZeroTime(a.newStartTime),
					targetTrackId: strOrUndefined(a.targetTrackId),
				}),
		},
		{
			name: "split",
			description: "cut a slot into two at a point in time (SECONDS).",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					atTime: secs("split point (seconds)"),
				},
				required: ["slotId", "atTime"],
			},
			handler: (d, a) =>
				d.split({ slotId: str(a.slotId), atTime: numOrZeroTime(a.atTime) }),
		},
		{
			name: "reorder",
			description: "set slot order.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: { slotIds: { type: "array", items: slotIdProp } },
				required: ["slotIds"],
			},
			handler: (d, a) =>
				d.reorder({
					slotIds: Array.isArray(a.slotIds) ? a.slotIds.map(str) : [],
				}),
		},
		{
			name: "remove",
			description: "delete a slot.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: { slotId: slotIdProp },
				required: ["slotId"],
			},
			handler: (d, a) => d.remove({ slotId: str(a.slotId) }),
		},
		// ── text (elementId is a FULL id, never a reel short id) ─────────────
		{
			name: "addText",
			description:
				"add a text overlay. Returns a FULL elementId (not a reel slot id) — pass it back verbatim to updateText.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					content: { type: "string" },
					startTime: secs("overlay start (seconds)"),
					duration: secs("overlay duration (seconds)"),
					trackId: { type: "string", description: "full track id (optional)." },
					fontSize: { type: "number" },
					fontFamily: { type: "string" },
					color: { type: "string" },
					textAlign: { type: "string", enum: ["left", "center", "right"] },
				},
				required: ["content", "startTime"],
			},
			handler: (d, a) =>
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
		{
			name: "updateText",
			description:
				"edit an existing text overlay by its FULL elementId (from addText, never a short slot id).",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					elementId: {
						type: "string",
						description: "full element id from addText.",
					},
					content: { type: "string" },
					startTime: secs("overlay start (seconds)"),
					duration: secs("overlay duration (seconds)"),
					fontSize: { type: "number" },
					fontFamily: { type: "string" },
					color: { type: "string" },
					textAlign: { type: "string", enum: ["left", "center", "right"] },
				},
				required: ["elementId"],
			},
			handler: (d, a) =>
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
		// ── polish (transitions / effects) ──────────────────────────────────
		{
			name: "applyTransition",
			description:
				"apply a transition (dissolve, wipe, slide, zoom, etc.) to a slot's outgoing edge — polish cuts between generated shots.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					transitionType: {
						type: "string",
						enum: getAllTransitions().map((t) => t.type),
						description:
							"Transition type to apply to the slot's outgoing edge.",
					},
					duration: secs(
						"transition duration; omit for the transition's own default",
					),
				},
				required: ["slotId", "transitionType"],
			},
			handler: (d, a) =>
				d.applyTransition({
					slotId: str(a.slotId),
					transitionType: str(a.transitionType),
					duration: numOrUndefined(a.duration),
				}),
		},
		{
			name: "applyEffect",
			description:
				"apply a visual effect (blur, color grade, film grain, glitch, chroma key, etc.) to a slot — polish generated shots.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					effectType: {
						type: "string",
						enum: getAllEffects().map((e) => e.type),
						description: "Effect type to apply to the slot.",
					},
					params: {
						type: "object",
						description:
							"Optional effect parameter overrides (keys vary by effectType, e.g. blur: {radius}, color-adjust: {brightness, contrast, saturation}). Omit for defaults.",
					},
				},
				required: ["slotId", "effectType"],
			},
			handler: (d, a) =>
				d.applyEffect({
					slotId: str(a.slotId),
					effectType: str(a.effectType),
					params: asEffectParams(a.params),
				}),
		},
		{
			name: "addClip",
			description:
				"place EXISTING footage found via searchMedia onto the timeline as a real clip (not a generative slot). Pass the FULL mediaId from a searchMedia hit.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					mediaId: {
						type: "string",
						description:
							"FULL media-library asset id from a searchMedia hit — NOT a short reel id.",
					},
					startTime: secs(
						"timeline start for the clip; defaults to the end of the current timeline",
					),
					duration: secs("clip duration; defaults to the asset's own duration"),
					trackId: {
						type: "string",
						description:
							"FULL track id (not a slot id); omit to auto-place on a suitable track.",
					},
				},
				required: ["mediaId"],
			},
			handler: (d, a) =>
				d.addClip({
					mediaId: str(a.mediaId),
					startTime: numOrUndefined(a.startTime),
					duration: numOrUndefined(a.duration),
					trackId: strOrUndefined(a.trackId),
				}),
		},
		// ── lifecycle ───────────────────────────────────────────────────────
		{
			name: "undo",
			description: "undo the last action.",
			mutating: true,
			inputSchema: EMPTY,
			handler: (d) => d.undo(),
		},
		{
			name: "redo",
			description: "redo the last undone action.",
			mutating: true,
			inputSchema: EMPTY,
			handler: (d) => d.redo(),
		},
		{
			name: "export",
			description:
				"render the reel to a video file and download it. Delegates to the same export pipeline as the Export button (fps follows the project).",
			// Renders output but does not change the reel/timeline → reel:read scope.
			mutating: false,
			inputSchema: {
				type: "object",
				properties: {
					format: {
						type: "string",
						enum: EXPORT_FORMAT_VALUES,
						description: "Container/codec. Defaults to mp4 (H.264).",
					},
					quality: {
						type: "string",
						enum: EXPORT_QUALITY_VALUES,
						description: "Encode quality. Defaults to high.",
					},
					includeAudio: {
						type: "boolean",
						description: "Mux the timeline audio. Defaults to true.",
					},
					includeWatermark: {
						type: "boolean",
						description: "Burn in the Byorn watermark. Defaults to true.",
					},
					download: {
						type: "boolean",
						description:
							"Trigger a browser download of the rendered file. Defaults to true.",
					},
				},
				additionalProperties: false,
			},
			handler: (d, a) =>
				d.export({
					format: asExportFormat(a.format),
					quality: asExportQuality(a.quality),
					includeAudio: boolOrUndefined(a.includeAudio),
					includeWatermark: boolOrUndefined(a.includeWatermark),
					download: boolOrUndefined(a.download),
				}),
		},
	];
}

/**
 * The reel scope a verb requires, derived from its `mutating` flag: read-only
 * verbs need `reel:read`, mutating verbs need `reel:write`. Unknown/unlisted
 * names fail safe to `reel:write` (the stricter scope). Fable enforces this
 * per-tool before dispatching.
 */
export function scopeForTool(name: string): "reel:read" | "reel:write" {
	const tool = toolCatalog().find((t) => t.name === name);
	if (!tool) return "reel:write";
	return tool.mutating ? "reel:write" : "reel:read";
}
