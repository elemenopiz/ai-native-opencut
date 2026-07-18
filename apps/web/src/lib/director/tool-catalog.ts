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
import { PLAYBOOKS, type PlaybookId } from "@/lib/studio/playbooks";
import type { DirectorApi, SpecOverride } from "./director-api";
import type { DirectorResult } from "./types";
import type { ConsistencyCharacter } from "./consistency-prompt";
import type { StyleBible } from "./storyboard-plan";
import type { ShotImportance } from "./budget";
import type { BriefPatch } from "./director-brief";
import type {
	AssetCitation,
	ProposedShotInput,
	ShotSource,
} from "./reel-proposal";

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
	importance?: ShotImportance;
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
		const importance = asImportance(obj.importance);
		return {
			prompt: str(obj.prompt),
			duration: numOr(obj.duration, 6),
			...(intent ? { intent } : {}),
			...(camera ? { camera } : {}),
			...(subject ? { subject } : {}),
			...(importance ? { importance } : {}),
			...(spec ? { spec } : {}),
		};
	});
}

/** Coerce a loose `importance` arg to a {@link ShotImportance}, else undefined. */
function asImportance(raw: unknown): ShotImportance | undefined {
	return raw === "hero" || raw === "support" || raw === "broll"
		? raw
		: undefined;
}

/** Coerce a loose `source` arg to a {@link ShotSource}, else undefined. */
function asShotSource(raw: unknown): ShotSource | undefined {
	return raw === "library" || raw === "generate" || raw === "generate-to-match"
		? raw
		: undefined;
}

/**
 * Coerce a loose `citation` arg into an {@link AssetCitation}. Only `mediaId` is
 * load-bearing (validated against the real index server-side); the rest are author
 * hints. Returns `undefined` when there's no usable mediaId so a citation-less shot
 * stays that way (and the validator repairs a library/generate-to-match shot).
 */
export function asCitation(v: unknown): AssetCitation | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const o = v as Record<string, unknown>;
	const mediaId = strOrUndefined(o.mediaId);
	if (!mediaId) return undefined;
	const matchScore = numOrUndefined(o.matchScore ?? o.score);
	const sourceShotIndex = numOrUndefined(o.sourceShotIndex);
	const range =
		o.timeRange &&
		typeof o.timeRange === "object" &&
		!Array.isArray(o.timeRange)
			? (o.timeRange as Record<string, unknown>)
			: undefined;
	const start = range ? numOrUndefined(range.start) : undefined;
	const end = range ? numOrUndefined(range.end) : undefined;
	return {
		mediaId,
		...(matchScore != null ? { matchScore } : {}),
		...(sourceShotIndex != null ? { sourceShotIndex } : {}),
		...(start != null && end != null ? { timeRange: { start, end } } : {}),
	};
}

/**
 * Coerce a loose `shots` arg into {@link ProposedShotInput}s for `proposeReel`: the
 * storyboard fields (prompt/intent/camera/subject/importance/duration) PLUS the
 * retrieve-vs-generate `source` and the grounded `citation`. Bare strings become a
 * generate shot. `source` is optional — omit it and the allocator classifies the
 * shot from importance + whether a citation is present.
 */
export function asProposedShots(
	args: Record<string, unknown>,
): ProposedShotInput[] {
	const raw = Array.isArray(args.shots) ? args.shots : [];
	return raw.map((s) => {
		if (typeof s === "string") return { prompt: s, duration: 6 };
		const obj = (s ?? {}) as Record<string, unknown>;
		const source = asShotSource(obj.source);
		const citation = asCitation(obj.citation);
		const intent = strOrUndefined(obj.intent);
		const camera = strOrUndefined(obj.camera);
		const subject = strOrUndefined(obj.subject);
		const importance = asImportance(obj.importance);
		return {
			prompt: str(obj.prompt),
			duration: numOr(obj.duration, 6),
			...(source ? { source } : {}),
			...(citation ? { citation } : {}),
			...(intent ? { intent } : {}),
			...(camera ? { camera } : {}),
			...(subject ? { subject } : {}),
			...(importance ? { importance } : {}),
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

/** Coerce a loose array into a trimmed, non-empty string list; `undefined` if none. */
function asStringList(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.map((x) => (x == null ? "" : String(x)).trim()).filter(Boolean);
	return out.length ? out : undefined;
}

/**
 * Coerce a loose `updateBrief` arg bag into a {@link BriefPatch}. Scalars pass
 * through as strings (present-but-empty clears the field); `dos`/`donts`/`notes`
 * are trimmed string lists. Accepts a singular `note` as a convenience alias for
 * a one-element `notes`. `durationSec` passes through as a number (0 or below
 * clears the target — see {@link applyBriefPatch}).
 */
export function asBriefPatch(args: Record<string, unknown>): BriefPatch {
	const patch: BriefPatch = {};
	if (args.goal != null) patch.goal = str(args.goal);
	if (args.audience != null) patch.audience = str(args.audience);
	if (args.tone != null) patch.tone = str(args.tone);
	if (args.styleNote != null) {
		patch.styleNote = str(args.styleNote);
	} else if (args.styleBible != null) {
		// Legacy alias: pre-rename agents (and stored MCP clients) still send
		// `styleBible` for the one-line style string — accept it as `styleNote`.
		patch.styleNote = str(args.styleBible);
	}
	const dos = asStringList(args.dos);
	if (dos) patch.dos = dos;
	const donts = asStringList(args.donts);
	if (donts) patch.donts = donts;
	const notes =
		asStringList(args.notes) ??
		(args.note != null ? asStringList([args.note]) : undefined);
	if (notes) patch.notes = notes;
	const durationSec = numOrUndefined(args.durationSec);
	if (durationSec != null) patch.durationSec = durationSec;
	return patch;
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
 * `director-api.ts`'s `exportReel`), the model-routing surface (`getBackends`
 * to read the catalog, `backendId` on generate/reroll, `compareTake` to A/B two
 * backends), the durable-brief pair (`getBrief`/`updateBrief`), `reviewTake`
 * (decode a take's frames so the model can SEE and judge it), and the audio pair
 * (`addVoiceover`/`addMusicBed`).
 */
export function toolCatalog(): ToolDescriptor[] {
	return [
		// ── read ────────────────────────────────────────────────────────────
		{
			name: "getReel",
			description:
				"inspect current slots/takes. totalDuration is the reel's live built length; targetDurationSec (when the brief has one) is the user's stated target — compare them to pace toward it.",
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
			name: "findDuplicateAssets",
			description:
				"detect near-duplicate media-library assets via CLIP visual-similarity — e.g. multiple takes of the same shot, or a burst of near-identical uploads. 'Duplicate' means visually near-identical CONTENT (embedding similarity above a fixed threshold), NOT exact file/byte duplicates. Returns FULL mediaIds (not reel slot ids) + a similarity score per pair. Pass mediaId to check only that asset against the rest of the library; omit to scan the whole library for every near-duplicate pair. Call before finalizing a sequence of shots (avoid placing two visually-identical clips back-to-back) or when the library has many similar-looking uploads (offer the user a choice between near-identical takes instead of guessing).",
			mutating: false,
			inputSchema: {
				type: "object",
				properties: {
					mediaId: {
						type: "string",
						description:
							"Optional FULL media id (not a reel slot id) to check for near-duplicates against the rest of the library. Omit to scan the whole library for all near-duplicate pairs.",
					},
				},
				additionalProperties: false,
			},
			handler: (d, a) =>
				d.findDuplicateAssets({ mediaId: strOrUndefined(a.mediaId) }),
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
			name: "getLibraryManifest",
			description:
				"re-read the faceted MEDIA-LIBRARY manifest: counts by role (hero/product/logo/face-anchor/b-roll), a few named heroes with captions + their FULL media ids, face-anchor personas, and a searchable-tail pointer. The one-line digest is already in your system prompt (the LIBRARY line) — call this only to re-check the library mid-task (e.g. after uploads) or to get a hero's exact mediaId for addClip. Use searchMedia to find any specific untitled shot.",
			mutating: false,
			inputSchema: EMPTY,
			handler: (d) => d.getLibraryManifest(),
		},
		{
			name: "getTranscript",
			description:
				"read the SPEECH TRANSCRIPT of a media asset: timestamped sentence segments in ASSET-RELATIVE seconds — the same timebase as trim's trimStart/trimEnd, so segment boundaries ARE valid cut points. Call this BEFORE trimming or splitting footage that contains speech, and align cuts to segment boundaries so a sentence is never cut mid-word. Takes a FULL mediaId (from searchMedia, the library manifest, or a slot's take). Optional startSec/endSec window the read for long sources.",
			mutating: false,
			inputSchema: {
				type: "object",
				properties: {
					mediaId: {
						type: "string",
						description: "FULL media id (not a reel slot id).",
					},
					startSec: {
						type: "number",
						minimum: 0,
						description: "Window start, asset-relative seconds.",
					},
					endSec: {
						type: "number",
						minimum: 0,
						description: "Window end, asset-relative seconds.",
					},
				},
				required: ["mediaId"],
			},
			handler: (d, a) =>
				d.getTranscript({
					mediaId: str(a.mediaId),
					startSec: numOrUndefined(a.startSec),
					endSec: numOrUndefined(a.endSec),
				}),
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
		{
			name: "readPlaybook",
			description:
				"read the full body of a named UGC prompt playbook (title/description already ride the system-prompt pointer).",
			mutating: false,
			// Self-contained lookup against the static PLAYBOOKS registry; ignores
			// the director arg entirely (no reel/timeline state involved).
			inputSchema: {
				type: "object",
				properties: {
					id: {
						type: "string",
						enum: ["ugc-photo-prompts", "ugc-video-prompts"],
						description: "Playbook id.",
					},
				},
				required: ["id"],
				additionalProperties: false,
			},
			handler: (_d, a) => {
				const id = str(a.id);
				const playbook = PLAYBOOKS[id as PlaybookId];
				if (!playbook) {
					return {
						ok: false,
						message: `Unknown playbook "${id}". Valid ids: ${Object.keys(
							PLAYBOOKS,
						).join(", ")}.`,
					};
				}
				return {
					ok: true,
					message: `Playbook "${id}" returned.`,
					data: {
						id: playbook.id,
						title: playbook.title,
						description: playbook.description,
						content: playbook.content,
					},
				};
			},
		},
		{
			name: "reportLimitation",
			description:
				"report a capability gap you hit (a verb/param you needed and lacked) so we can prioritize; paraphrase, don't paste user content.",
			mutating: false,
			// Pure logic — no network/MCP call here. The actual telemetry recording
			// rides the existing MCP-boundary recordMcpEvent + in-app verb-telemetry.
			inputSchema: {
				type: "object",
				properties: {
					category: {
						type: "string",
						description:
							"short bucket, e.g. 'missing-verb', 'missing-param', 'unsupported-media'.",
					},
					summary: {
						type: "string",
						description:
							"one-line paraphrase of what you needed and couldn't do.",
					},
				},
				required: ["category", "summary"],
				additionalProperties: false,
			},
			handler: (_d, a) => ({
				ok: true,
				message: "Limitation recorded — thanks, this helps us prioritize.",
				data: { category: str(a.category), summary: str(a.summary) },
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
								importance: {
									type: "string",
									enum: ["hero", "support", "broll"],
									description:
										"How important this shot is to the reel — drives its budget tier when budgetUsd is set: hero → premium backend, support → standard, broll → cheap. Default support.",
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
					budgetUsd: {
						type: "number",
						description:
							"Total USD the WHOLE reel may spend. When set, allocates the cap across shots by importance (hero premium, b-roll cheap), down-tiering the least-important shots to fit, and gates every later generate against the remaining budget. Use for a 'make an N-shot reel for $X' brief.",
					},
				},
				required: ["shots"],
			},
			handler: (d, a) => {
				const budgetUsd = numOr(a.budgetUsd, 0);
				return d.storyboard({
					shots: asShots(a),
					bible: asStyleBible(a),
					...(budgetUsd > 0 ? { budgetUsd } : {}),
				});
			},
		},
		// ── propose-first drafting (Flow B) ─────────────────────────────────
		{
			name: "proposeReel",
			description:
				"PROPOSE-FIRST: draft the WHOLE reel as an editable plan the user reacts to, citing specific LIBRARY assets per shot instead of hand-placing clips. For each shot choose a source: 'library' (RETRIEVE — cite a real asset's mediaId; free, instant; prefer for b-roll), 'generate' (no matching asset — render from a prompt), or 'generate-to-match' (GENERATE conditioned on a cited asset's look — prefer for hero shots that justify the spend). GROUND every citation FIRST via searchMedia / getLibraryManifest and cite only mediaIds you actually found — NEVER invent a mediaId: a fabricated citation is rejected and its shot is downgraded to generate, and a hallucinated asset costs more trust than the feature earns. Nothing is placed yet; the user accepts (acceptProposal) or edits a line (reviseProposal). Use this for a 'build me a reel from my footage' brief.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					shots: {
						type: "array",
						description:
							"Ordered shots. Give each a source + (for library/generate-to-match) a grounded citation, plus intent/camera/subject so the sequence is coherent.",
						items: {
							type: "object",
							properties: {
								source: {
									type: "string",
									enum: ["library", "generate", "generate-to-match"],
									description:
										"library = place the cited asset; generate = render from prompt; generate-to-match = generate in the cited asset's look. Omit to let importance + citation decide (hero→generate-to-match, b-roll→library).",
								},
								citation: {
									type: "object",
									description:
										"The cited library asset (required for library/generate-to-match). Cite ONLY a mediaId you found via searchMedia/getLibraryManifest.",
									properties: {
										mediaId: {
											type: "string",
											description:
												"FULL media-library asset id you grounded via searchMedia/getLibraryManifest. Validated against the real index; a fabricated id is rejected.",
										},
										matchScore: {
											type: "number",
											description:
												"The searchMedia score you saw for this candidate, if any (helps the allocator judge retrieve-vs-generate).",
										},
										sourceShotIndex: {
											type: "integer",
											description:
												"For a multi-shot source asset, which 0-based sub-shot to use.",
										},
									},
									required: ["mediaId"],
								},
								prompt: {
									type: "string",
									description:
										"Generation prompt for generate/generate-to-match; a short description for a library shot.",
								},
								intent: {
									type: "string",
									description:
										"What this shot accomplishes (e.g. 'cold-open establishing shot').",
								},
								camera: {
									type: "string",
									description: "Framing / camera movement / lens.",
								},
								subject: {
									type: "string",
									description: "Who/what is on screen.",
								},
								importance: {
									type: "string",
									enum: ["hero", "support", "broll"],
									description:
										"Drives retrieve-vs-generate AND the budget tier: hero justifies generation spend, b-roll prefers retrieval. Default support.",
								},
								duration: secs("shot length in seconds (default 6)"),
							},
						},
					},
					bible: {
						type: "object",
						description:
							"Shared style bible for the whole reel — seeds the consistency context on accept so every generated shot inherits it.",
						properties: {
							palette: { type: "string" },
							lensMood: { type: "string" },
							setting: { type: "string" },
							characters: {
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
					budgetUsd: {
						type: "number",
						description:
							"Total USD the whole reel may spend (allocated across the GENERATE shots — library shots are $0). Use for 'make an N-shot reel for $X'.",
					},
				},
				required: ["shots"],
			},
			handler: (d, a) => {
				const budgetUsd = numOr(a.budgetUsd, 0);
				return d.proposeReel({
					shots: asProposedShots(a),
					bible: asStyleBible(a),
					...(budgetUsd > 0 ? { budgetUsd } : {}),
				});
			},
		},
		{
			name: "reviseProposal",
			description:
				"revise ONE line of the pending draft and leave the rest stable — 'swap shot 2 for the drone pass' re-plans only shot 2. Pass the 1-based shot index plus the fields to change (source/citation/prompt/importance/etc). A new citation is re-validated against the real index (a fabricated swap-in is rejected). Use to steer a proposeReel draft before acceptProposal.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					index: {
						type: "integer",
						description: "1-based index of the shot to revise.",
					},
					source: {
						type: "string",
						enum: ["library", "generate", "generate-to-match"],
						description: "New source for this shot.",
					},
					citation: {
						type: "object",
						description:
							"New cited asset (grounded mediaId). Omit to keep the existing citation; set clearCitation to drop it.",
						properties: {
							mediaId: { type: "string" },
							matchScore: { type: "number" },
							sourceShotIndex: { type: "integer" },
						},
						required: ["mediaId"],
					},
					clearCitation: {
						type: "boolean",
						description:
							"Set true to remove this shot's citation (falls back to generate).",
					},
					prompt: { type: "string" },
					intent: { type: "string" },
					camera: { type: "string" },
					subject: { type: "string" },
					importance: {
						type: "string",
						enum: ["hero", "support", "broll"],
					},
					duration: secs("new shot length in seconds"),
				},
				required: ["index"],
			},
			handler: (d, a) =>
				d.reviseProposal({
					index: numOr(a.index, 0),
					source: asShotSource(a.source),
					citation: asCitation(a.citation),
					clearCitation: boolOrUndefined(a.clearCitation),
					prompt: strOrUndefined(a.prompt),
					intent: strOrUndefined(a.intent),
					camera: strOrUndefined(a.camera),
					subject: strOrUndefined(a.subject),
					importance: asImportance(a.importance),
					duration: numOrUndefined(a.duration),
				}),
		},
		{
			name: "acceptProposal",
			description:
				"ACCEPT the pending draft and materialize every shot IN ORDER — library shots place their cited asset as a clip, generate/generate-to-match shots become generative slots (then call generate). Persists the plan to the durable Project Bible and seeds the consistency context from the bible. Call after the user approves a proposeReel draft.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					seedConsistency: {
						type: "boolean",
						description:
							"Set false to skip seeding the reel consistency context from the bible. Default true.",
					},
				},
				additionalProperties: false,
			},
			handler: (d, a) =>
				d.acceptProposal({
					seedConsistency: boolOrUndefined(a.seedConsistency),
				}),
		},
		{
			name: "getProposal",
			description:
				"read the pending Flow-B draft (the current proposeReel plan) without changing it. The message is the rendered draft.",
			mutating: false,
			inputSchema: EMPTY,
			handler: (d) => d.getProposal(),
		},
		{
			name: "intakeReferences",
			description:
				"SEE the user's reference images and build the plan from them. Pass the uploaded/attached reference mediaIds (FULL media ids, e.g. from getProjectInfo recentAssets — style refs like a moodboard/film still, and/or a character photo). The model looks at the pixels and derives a StyleBible (palette/lens-mood/setting) that SEEDS the reel's consistency context, and — when the refs center on a person — locks & activates a PERSONA (descriptor + anchor image, seed-lock path) so that character recurs. The derived look is recorded on the brief. Call this FIRST when the user attaches references; then pass the returned bible into storyboard.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					mediaIds: {
						type: "array",
						items: { type: "string" },
						description:
							"FULL media-library asset ids of the reference image(s)/video(s) to read. Not reel slot ids.",
					},
					hint: {
						type: "string",
						description:
							"Optional: what the user wants the references to steer (intent), e.g. 'match this grade' or 'keep this character'.",
					},
					createPersona: {
						type: "boolean",
						description:
							"Set false to derive STYLE only and skip locking a persona even if a character is detected. Default true.",
					},
					personaName: {
						type: "string",
						description:
							"Optional name for the locked persona (overrides the model-derived name).",
					},
					seed: {
						type: "number",
						description:
							"Optional seed to lock the derived persona's identity (seed-lock).",
					},
					record: {
						type: "boolean",
						description:
							"Set false to skip recording the derived look on the durable brief. Default true.",
					},
				},
				required: ["mediaIds"],
			},
			handler: (d, a) =>
				d.intakeReferences({
					mediaIds: asStringList(a.mediaIds) ?? [],
					hint: strOrUndefined(a.hint),
					createPersona:
						typeof a.createPersona === "boolean" ? a.createPersona : undefined,
					personaName: strOrUndefined(a.personaName),
					seed: numOrUndefined(a.seed),
					record: typeof a.record === "boolean" ? a.record : undefined,
				}),
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
			name: "extractFrame",
			description:
				'extract a full-resolution still from a slot\'s current take (or a library video by mediaId) and add it to the media library WITH provenance. position: "first" | "last" | a number of SECONDS into the source. Returns { mediaId, url } — a hosted, generation-usable image URL you can feed as a first frame (see chainFrom / generate).',
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					mediaId: {
						type: "string",
						description:
							"Library media id to extract from (alternative to slotId).",
					},
					position: {
						oneOf: [
							{ type: "string", enum: ["first", "last"] },
							{ type: "number", "x-seconds": true },
						],
						description:
							'"first", "last", or a SECONDS offset into the source video.',
					},
				},
				required: ["position"],
			},
			handler: (d, a) => {
				const atTime = numOrUndefined(
					typeof a.position === "object" && a.position !== null
						? (a.position as { atTimeSec?: unknown }).atTimeSec
						: a.position,
				);
				const position =
					atTime !== undefined
						? { atTimeSec: atTime }
						: a.position === "first"
							? "first"
							: "last";
				return d.extractFrame({
					slotId: strOrUndefined(a.slotId),
					mediaId: strOrUndefined(a.mediaId),
					position,
				});
			},
		},
		{
			name: "chainFrom",
			description:
				"seed slot toSlotId's next generation on the LAST frame of slot fromSlotId, so the two shots mesh seamlessly. Extracts fromSlot's last frame, adds it to the library, and stamps it onto toSlot's spec as a first frame (image-to-video). Does NOT generate — call generate/reroll on toSlotId after.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					fromSlotId: slotIdProp,
					toSlotId: slotIdProp,
				},
				required: ["fromSlotId", "toSlotId"],
			},
			handler: (d, a) =>
				d.chainFrom({
					fromSlotId: str(a.fromSlotId),
					toSlotId: str(a.toSlotId),
				}),
		},
		{
			name: "chooseTake",
			description:
				"pick the active take (by index or takeId). Pass `rationale` to record WHY (e.g. 'user prefers the warmer, handheld take') — it's appended to the durable brief so future shots inherit the preference.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					index: { type: "integer", description: "0-based take index." },
					takeId: { type: "string", description: "short take id." },
					rationale: {
						type: "string",
						description:
							"Optional one-line reason for the choice, learned into the brief.",
					},
				},
				required: ["slotId"],
			},
			handler: (d, a) => {
				const rationale = strOrUndefined(a.rationale);
				return a.index != null
					? d.chooseTake({
							slotId: str(a.slotId),
							index: Number(a.index),
							rationale,
						})
					: d.chooseTake({
							slotId: str(a.slotId),
							takeId: str(a.takeId),
							rationale,
						});
			},
		},
		// ── budget (whole-reel spend planning) ──────────────────────────────
		{
			name: "getBudgetStatus",
			description:
				"read the reel's BUDGET: the total cap, how much has been spent so far, what's left, and the per-shot tier allocation. Call to check remaining budget before proposing more generation.",
			mutating: false,
			inputSchema: EMPTY,
			handler: (d) => d.getBudgetStatus(),
		},
		{
			name: "setBudget",
			description:
				"set (or change) the WHOLE reel's total USD budget and reset the running spend. Re-allocates an existing storyboard across the new cap (hero shots premium, b-roll cheap; down-tiered to fit). Use when the user names a budget after shots exist, e.g. 'keep it under $2'.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					budgetUsd: {
						type: "number",
						description: "Total USD the whole reel may spend.",
					},
				},
				required: ["budgetUsd"],
			},
			handler: (d, a) => d.setBudget({ budgetUsd: numOr(a.budgetUsd, 0) }),
		},
		// ── brief (durable creative intent) ─────────────────────────────────
		{
			name: "getBrief",
			description:
				"read the persistent DIRECTOR BRIEF (goal, audience, tone, style note, target duration, do/don't, learned notes). It's already summarized in your system prompt — call this only to re-check the full brief mid-task.",
			mutating: false,
			inputSchema: EMPTY,
			handler: (d) => d.getBrief(),
		},
		{
			name: "updateBrief",
			description:
				"record the user's creative intent in the durable brief whenever they state a preference or you learn one (e.g. after chooseTake). Scalars (goal/audience/tone/styleNote/durationSec) REPLACE; dos/donts APPEND; note/notes APPEND learned one-liners. Persisted per project so future turns and sessions inherit it.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					goal: { type: "string", description: "What the reel is for." },
					audience: { type: "string", description: "Target viewer." },
					tone: {
						type: "string",
						description: "Desired mood/voice (e.g. 'warm, playful, handheld').",
					},
					styleNote: {
						type: "string",
						description:
							"One-line reusable visual/edit rules (color grade, pacing, framing). (Formerly `styleBible`, still accepted as a legacy alias.)",
					},
					durationSec: {
						type: "number",
						description:
							"Target running length of the whole reel, in seconds (e.g. the user says 'make this a 60-second reel' → 60). REPLACES any existing target; 0 or below clears it. Compare against getReel's totalDuration/targetDurationSec to check pacing.",
					},
					dos: {
						type: "array",
						items: { type: "string" },
						description: "Constraints to ADD — things every shot should do.",
					},
					donts: {
						type: "array",
						items: { type: "string" },
						description: "Constraints to ADD — things to avoid.",
					},
					note: {
						type: "string",
						description: "A single learned one-line preference to append.",
					},
					notes: {
						type: "array",
						items: { type: "string" },
						description: "Several learned one-line preferences to append.",
					},
				},
			},
			handler: (d, a) => d.updateBrief(asBriefPatch(a)),
		},
		{
			name: "reviewTake",
			description:
				"SEE a take — decode first/mid/last frames of a slot's take as images so you can judge whether the generated clip actually realizes the slot's prompt. Use before keeping a shot when quality matters; act on what you see (chooseTake to keep, setPrompt+reroll to redo, or remix for a small fix).",
			// Read-only: decodes frames, changes nothing on the reel → reel:read.
			mutating: false,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					takeId: {
						type: "string",
						description:
							"Short take id to review; omit to review the active (or most recent ready) take.",
					},
					frames: {
						type: "integer",
						default: 3,
						minimum: 1,
						maximum: 3,
						description:
							"How many frames to sample (1–3, spread first→mid→last). Default 3.",
					},
				},
				required: ["slotId"],
			},
			handler: (d, a) =>
				d.reviewTake({
					slotId: str(a.slotId),
					takeId: strOrUndefined(a.takeId),
					frames: numOrUndefined(a.frames),
				}),
		},
		// ── audio (VO + music bed) ──────────────────────────────────────────
		{
			name: "addVoiceover",
			description:
				"speak a script as a voiceover clip, TIMED to a shot. Pass slotId to place it at that shot's start and match its length; else pass startTime/duration. Returns a FULL audio element id (not a reel slot id).",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					script: {
						type: "string",
						description: "The spoken narration text.",
					},
					slotId: {
						type: "string",
						description:
							"Short id of the shot to narrate — the VO is timed to it. Omit to place by startTime/duration instead.",
					},
					startTime: secs(
						"VO start (seconds); defaults to the narrated shot's start, else end of timeline",
					),
					duration: secs(
						"VO duration (seconds); defaults to the shot's duration, else estimated from the script",
					),
					voice: {
						type: "string",
						description:
							"Built-in cloud TTS voice: alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer or verse. Other values are ignored (the default voice applies).",
					},
					voiceRef: {
						type: "string",
						description:
							"Cloned-voice reference path. Voice cloning is unavailable in beta — a voiceRef-backed take fails.",
					},
					personaId: {
						type: "string",
						description: "Bind the VO's vocal identity to a persona.",
					},
					language: {
						type: "string",
						description: "TTS language code (default en).",
					},
				},
				required: ["script"],
			},
			handler: (d, a) =>
				d.addVoiceover({
					script: str(a.script),
					slotId: strOrUndefined(a.slotId),
					startTime: numOrUndefined(a.startTime),
					duration: numOrUndefined(a.duration),
					voice: strOrUndefined(a.voice),
					voiceRef: strOrUndefined(a.voiceRef),
					personaId: strOrUndefined(a.personaId),
					language: strOrUndefined(a.language),
				}),
		},
		{
			name: "addMusicBed",
			description:
				"search the sounds library and lay the top match under the reel as a quiet music bed (spans the whole timeline by default). Plain audio clip, not a reel slot.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"What music/ambience to search for (e.g. 'upbeat lofi').",
					},
					startTime: secs("bed start (seconds); defaults to 0"),
					duration: secs(
						"bed duration (seconds); defaults to the whole timeline",
					),
					volume: {
						type: "number",
						minimum: 0,
						maximum: 1,
						description:
							"Bed level 0-1 (default 0.3 — sits under dialogue/VO).",
					},
					commercialOnly: {
						type: "boolean",
						description:
							"Restrict to commercially-licensable results (default true).",
					},
				},
				required: ["query"],
			},
			handler: (d, a) =>
				d.addMusicBed({
					query: str(a.query),
					startTime: numOrUndefined(a.startTime),
					duration: numOrUndefined(a.duration),
					volume: numOrUndefined(a.volume),
					commercialOnly: boolOrUndefined(a.commercialOnly),
				}),
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
		// ── project bible (durable creative memory) ─────────────────────────
		{
			name: "getProjectBible",
			description:
				"read the persisted Project Bible — the durable style/cast/setting + brief + plan that survives across sessions, plus its checkpoint history.",
			mutating: false,
			inputSchema: EMPTY,
			handler: (d) => d.getProjectBible(),
		},
		{
			name: "revertBibleCheckpoint",
			description:
				"revert the Project Bible to an earlier checkpoint (a specific toVersion, else the last change) and re-hydrate the reel's consistency/plan/brief from it.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					toVersion: { type: "number" },
				},
			},
			handler: (d, a) => {
				const toVersion = numOrUndefined(a.toVersion);
				return d.revertBibleCheckpoint(
					toVersion != null ? { toVersion } : undefined,
				);
			},
		},
		// ── Flow D: human approval gates ────────────────────────────────────
		{
			name: "approveHeroShot",
			description:
				"HERO-SHOT APPROVAL GATE (Flow D): record the human's approval of a shot's take as THE hero. Selects that take active and writes the decision + rationale into the durable Project Bible (approvals ledger + brief note) so future shots inherit the choice and downstream treats it as the approved hero. Pass the shot's slotId, optionally a takeId or 0-based index (else the active/most-recent-ready take), and a one-line rationale (WHY it earned approval). Only call when the human has actually approved — rejection means NOT calling this (nothing is recorded).",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					takeId: { type: "string", description: "Short take id to approve." },
					index: { type: "integer", description: "0-based take index." },
					rationale: {
						type: "string",
						description:
							"One-line reason this shot earned hero approval — recorded into the Bible.",
					},
				},
				required: ["slotId"],
			},
			handler: (d, a) =>
				d.approveHeroShot({
					slotId: str(a.slotId),
					takeId: strOrUndefined(a.takeId),
					index: numOrUndefined(a.index),
					rationale: strOrUndefined(a.rationale),
				}),
		},
		{
			name: "approveFinalCut",
			description:
				"FINAL-CUT APPROVAL GATE (Flow D): record the human's sign-off on the whole reel before export/render finalization. Writes the approval + a summary of what shipped into the Project Bible (approvals ledger + brief note). A SOFT gate — call it before `export` when the human approves the cut. (A manual UI Export is itself the human's approval and is never blocked.)",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					summary: {
						type: "string",
						description:
							"Optional short summary of what's approved (defaults to shot count + duration).",
					},
					rationale: {
						type: "string",
						description: "Optional one-line reason, recorded into the Bible.",
					},
				},
				additionalProperties: false,
			},
			handler: (d, a) =>
				d.approveFinalCut({
					summary: strOrUndefined(a.summary),
					rationale: strOrUndefined(a.rationale),
				}),
		},
		{
			name: "getVoiceProfiles",
			description:
				"read the cloned-voice CONSENT registry: each cloned voice and its consent status (pending / consented / revoked). A cloned voice is UNUSABLE for TTS until consented. Use to tell the user why a clone can't be used yet — consent is captured by the human in the Voiceover panel (you cannot grant it).",
			mutating: false,
			inputSchema: EMPTY,
			handler: (d) => d.getVoiceProfiles(),
		},
		{
			name: "revokeVoiceConsent",
			description:
				"revoke consent for a cloned voice (by its profileId from getVoiceProfiles) — immediately disables it for all TTS/voice-lock. Use when the user asks to stop using their cloned voice.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					profileId: {
						type: "string",
						description: "The voice profile id from getVoiceProfiles.",
					},
					reason: {
						type: "string",
						description: "Optional revocation reason.",
					},
				},
				required: ["profileId"],
			},
			handler: (d, a) =>
				d.revokeVoiceConsent({
					profileId: str(a.profileId),
					reason: strOrUndefined(a.reason),
				}),
		},
		{
			name: "seedStyleFromUnderstanding",
			description:
				"adopt an asset's understood LOOK (palette / lens-mood / setting) as the Project Bible's styleBible. Additive + checkpointed, and it NEVER clobbers a human-set styleBible (an existing look is preserved and the read is logged as a note unless force is set). Pass the FULL mediaId of the asset whose look to adopt. Use when the user says 'match my footage's look'.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					mediaId: {
						type: "string",
						description:
							"FULL media-library asset id whose style read to adopt.",
					},
					force: {
						type: "boolean",
						description:
							"Set true to overwrite an existing styleBible (default false — preserve a human-set look).",
					},
				},
				required: ["mediaId"],
			},
			handler: (d, a) =>
				d.seedStyleFromUnderstanding({
					mediaId: str(a.mediaId),
					force: boolOrUndefined(a.force),
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
		{
			name: "removeSilence",
			description:
				"auto-cut dead air out of a slot's clip: analyze its audio for silence and hard-cut the silent stretches, closing the gaps (downstream slots ripple left). All time fields SECONDS; threshold is a 0–1 loudness level. Omit the knobs for sensible defaults.",
			mutating: true,
			inputSchema: {
				type: "object",
				properties: {
					slotId: slotIdProp,
					threshold: {
						type: "number",
						description:
							"loudness threshold in 0–1; audio below this counts as silence (default 0.04).",
					},
					marginBefore: secs(
						"kept padding before each loud region — protects speech onsets (default 0.2).",
					),
					marginAfter: secs(
						"kept padding after each loud region — protects trailing speech (default 0.3).",
					),
					minKeep: secs(
						"drop kept runs shorter than this many seconds (default 0.26).",
					),
					minCut: secs(
						"leave silent runs shorter than this many seconds uncut (default 0.4).",
					),
				},
				required: ["slotId"],
			},
			handler: (d, a) =>
				d.removeSilence({
					slotId: str(a.slotId),
					threshold: numOrUndefined(a.threshold),
					marginBefore: numOrUndefined(a.marginBefore),
					marginAfter: numOrUndefined(a.marginAfter),
					minKeep: numOrUndefined(a.minKeep),
					minCut: numOrUndefined(a.minCut),
				}),
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

// ── Gemini function declarations (native authoring, not a mechanical strip) ──
//
// Gemini's `functionDeclarations` speak an OpenAPI-3.0 SUBSET, not JSON Schema
// draft-07: types are UPPERCASE enums, and `oneOf` / `additionalProperties` /
// `default` / vendor keywords (`x-seconds`) don't exist. Rather than stripping
// the Anthropic-facing schemas and hoping, `toGeminiDeclarations()` AUTHORS the
// Gemini contract from the same catalog: unsupported constructs are restructured
// into shapes the handlers already coerce (the handlers are lenient by design),
// units/defaults are folded into descriptions, and the highest-traffic verbs get
// descriptions tuned for Gemini's triggering behavior (explicit "call this
// when..." phrasing), which its function-calling responds to markedly better
// than terse noun phrases.

/** A schema node in Gemini's OpenAPI-subset dialect (v1beta `Schema`). */
export interface GeminiSchema {
	type?: "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN" | "ARRAY" | "OBJECT";
	description?: string;
	enum?: string[];
	items?: GeminiSchema;
	properties?: Record<string, GeminiSchema>;
	required?: string[];
	nullable?: boolean;
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
}

/** One entry in a Gemini `tools[].functionDeclarations` array. */
export interface GeminiFunctionDeclaration {
	name: string;
	description: string;
	parameters?: GeminiSchema;
}

/** Map a draft-07 `type` to Gemini's uppercase enum. */
const GEMINI_TYPE: Record<string, GeminiSchema["type"]> = {
	object: "OBJECT",
	array: "ARRAY",
	string: "STRING",
	number: "NUMBER",
	integer: "INTEGER",
	boolean: "BOOLEAN",
};

/**
 * Translate one catalog {@link JSONSchema} node into the Gemini dialect.
 * Restructuring rules (all verified against the handlers' coercion):
 *  - `oneOf` collapses to the FIRST branch, with every alternative described in
 *    prose — the two catalog uses (generate.slotIds, extractFrame.position) are
 *    ADDITIONALLY hand-authored in {@link GEMINI_PROPERTY_OVERRIDES}, so this
 *    generic collapse is only the safety net for future schema additions.
 *  - `default` folds into the description (Gemini has no default keyword).
 *  - `x-seconds` folds a "Value is in SECONDS." note into the description.
 *  - `additionalProperties` is dropped (unsupported; handlers ignore extras).
 */
function geminiSchemaOf(node: JSONSchema): GeminiSchema {
	// oneOf: collapse to the first branch, describing the alternatives.
	if (node.oneOf?.length) {
		const first = geminiSchemaOf(node.oneOf[0]);
		const alts = node.oneOf.map((b) => b.type ?? "value").join(" | ");
		return {
			...first,
			description: [node.description, `Accepts: ${alts}.`]
				.filter(Boolean)
				.join(" "),
		};
	}

	const out: GeminiSchema = {};
	if (node.type && GEMINI_TYPE[node.type]) out.type = GEMINI_TYPE[node.type];

	const descParts: string[] = [];
	if (node.description) descParts.push(node.description);
	if (node["x-seconds"] && !/second/i.test(node.description ?? ""))
		descParts.push("Value is in SECONDS.");
	if (node.default !== undefined)
		descParts.push(`Default: ${JSON.stringify(node.default)}.`);
	if (descParts.length) out.description = descParts.join(" ");

	if (node.enum) {
		// Gemini enums are string-typed; the catalog's are already strings.
		out.type = "STRING";
		out.enum = node.enum.map((e) => String(e));
	}
	if (node.items) out.items = geminiSchemaOf(node.items);
	if (node.properties) {
		out.properties = Object.fromEntries(
			Object.entries(node.properties).map(([k, v]) => [k, geminiSchemaOf(v)]),
		);
	}
	if (node.required?.length) out.required = [...node.required];
	if (typeof node.minimum === "number") out.minimum = node.minimum;
	if (typeof node.maximum === "number") out.maximum = node.maximum;
	if (typeof node.minItems === "number") out.minItems = node.minItems;
	if (typeof node.maxItems === "number") out.maxItems = node.maxItems;
	return out;
}

/**
 * Hand-authored property replacements for the schema shapes Gemini's dialect
 * can't express (the catalog's two `oneOf` unions). Each replacement targets a
 * shape the verb's handler already coerces:
 *  - `generate.slotIds` — draft-07 says `array | "all"`; the handler treats any
 *    NON-array (including omitted) as "all", so the Gemini contract is simply
 *    "an array; omit for all slots".
 *  - `extractFrame.position` — draft-07 says `"first" | "last" | number`; the
 *    handler runs the value through `numOrUndefined` first, so a STRING that
 *    parses as a number ("2.5") lands on the seconds path and "first"/"last"
 *    fall through to the named positions.
 */
const GEMINI_PROPERTY_OVERRIDES: Record<
	string,
	Record<string, GeminiSchema>
> = {
	generate: {
		slotIds: {
			type: "ARRAY",
			items: { type: "STRING" },
			description:
				"Short slot ids (from the REEL listing) to render. OMIT this field entirely to render every slot in the reel.",
		},
	},
	extractFrame: {
		position: {
			type: "STRING",
			description:
				'Where to grab the frame: "first", "last", or a number of SECONDS into the source as a string (e.g. "2.5").',
		},
	},
};

/**
 * Description overrides for the highest-traffic verbs, tuned for Gemini's
 * function-calling trigger behavior: lead with an explicit "Call this when...",
 * then the catalog's own contract text. Verbs not listed keep their catalog
 * description verbatim — the contract content is identical either way.
 *
 * CONTRAST TUNING: the members of the two clusters Gemini most often confuses
 * additionally carry explicit "Do NOT use this for X — use <sibling>" lines:
 *  - generation: generate (first render) / reroll (same prompt, fresh
 *    sampling) / remix (directed change to an existing take) / chainFrom
 *    (continuity — anchor the NEXT shot on a previous shot's frame);
 *  - timeline: trim (in/out points) / move (position in time) / split (one
 *    clip into two);
 * plus one contrast line each across compareTake (rank, no commit) /
 * chooseTake (commit) / reviewTake (paid vision critique, looks only).
 * These lines live HERE — the shared Anthropic-facing catalog descriptions
 * are deliberately untouched.
 */
const GEMINI_DESCRIPTION_OVERRIDES: Record<string, string> = {
	storyboard:
		"Call this FIRST whenever the brief implies MORE THAN ONE shot (a sequence, story, ad, or montage): it decomposes the brief into ordered shots under one shared style bible and persists the plan.",
	reserveSlot:
		"Call this for a single quick clip (no storyboard needed): it adds one empty generative slot with a prompt, ready to generate.",
	generate:
		"Call this to actually render takes for planned slots — nothing is generated until you do. Renders one or more takes per listed slot (or every slot when slotIds is omitted). Use for the FIRST render of a slot. Do NOT use this to retry a bad take — use reroll — or to adjust an existing take — use remix; to continue from a previous shot's frame, set up chainFrom first, then generate.",
	reroll:
		"Call this when a slot's current take is fundamentally wrong (wrong subject/scene): it renders fresh alternate take(s) for that one slot from its current prompt — same prompt, fresh sampling. Do NOT use this for a small directed fix to a mostly-good take — use remix instead — and do NOT use it for a slot that was never rendered — use generate.",
	remix:
		"Call this when a take is MOSTLY right but has one flaw: it edits the slot's current take in place from a short delta prompt, keeping seed/identity anchored. Do NOT use this when the take is fundamentally wrong — use reroll for a clean resample — and do NOT use it to make consecutive shots flow together — use chainFrom.",
	chainFrom:
		"Call this for shot-to-shot CONTINUITY: it seeds slot toSlotId's next generation on the LAST frame of slot fromSlotId (extracts that frame, adds it to the library, and stamps it onto toSlot's spec as an image-to-video first frame), so the two shots mesh seamlessly. Does NOT render — call generate/reroll on toSlotId after. Do NOT use this to retry or tweak a single take — use reroll (fresh sampling) or remix (directed change) instead.",
	reviewTake:
		"Call this to SEE a generated take before judging it — you cannot evaluate a clip from its prompt alone. Returns the take's actual frames (first→mid→last) as images. This is a paid vision critique that only LOOKS — it does NOT commit anything; to make a reviewed take active, use chooseTake.",
	chooseTake:
		"Call this to make a specific take the slot's active take (e.g. after reviewing alternates). This COMMITS the choice. Do NOT use it to evaluate or rank takes you have not seen — use reviewTake (paid vision critique) or compareTake (A/B rank) first.",
	compareTake:
		"A/B one slot across TWO backends: render the same shot on each and auto-pick the better take if a vision critic is available, else add both as takes for you to choose. Costs 2x a single generate — subject to the cost gate. Use for hero/final shots worth the extra spend. This RANKS candidates — it does NOT commit your final choice; use chooseTake to commit.",
	trim: "Use for changing how much of a clip's SOURCE plays — its in/out points and duration (all time fields in SECONDS). Do NOT use this to reposition the clip on the timeline — use move — and do NOT use it to cut a clip into two pieces — use split.",
	move: "Use for repositioning a clip in TIME on the timeline (and optionally onto another track — targetTrackId is a full TRACK id, not a short slot id; omit to stay on the current track). Do NOT use this to change which part of the source plays — use trim — and do NOT use it to cut the clip — use split.",
	split:
		"Use for cutting ONE clip into TWO separate clips at a point in time (SECONDS). Do NOT use this to shorten a clip — use trim — and do NOT use it to change when a clip plays — use move.",
	setPrompt:
		"Call this to rewrite a slot's generation prompt (and optionally its per-shot spec) BEFORE rerolling it.",
	getReel:
		"Call this whenever you need the CURRENT reel state (slots, takes, ids, plan) — the listing in the system prompt is a snapshot from the start of the turn.",
	addVoiceover:
		"Call this when the brief mentions narration/voiceover: it renders TTS timed to the narrated shot (pass that shot's slotId). One voiceover per shot/beat it narrates.",
	addMusicBed:
		"Call this to lay background music/ambience under the whole reel. A reel is not silent — add audio as part of building it, not as an afterthought.",
	intakeReferences:
		"Call this FIRST when the user attaches reference images (style refs or a character photo): it looks at the pixels and derives a style bible (and optionally a persona) that seeds every later shot.",
};

/**
 * The Director verbs as native Gemini `functionDeclarations` — same names, same
 * arg contracts, authored for Gemini's schema dialect and triggering behavior
 * (see the section comment above). The Gemini Director brain
 * (`agent-gemini.ts`) sends these; the verbs execute through the SAME handlers,
 * so behavior differs only in how the model is addressed.
 */
export function toGeminiDeclarations(): GeminiFunctionDeclaration[] {
	return toolCatalog().map((t) => {
		const parameters = geminiSchemaOf(t.inputSchema);
		const propOverrides = GEMINI_PROPERTY_OVERRIDES[t.name];
		if (propOverrides && parameters.properties) {
			parameters.properties = { ...parameters.properties, ...propOverrides };
		}
		return {
			name: t.name,
			description: GEMINI_DESCRIPTION_OVERRIDES[t.name] ?? t.description,
			// Gemini rejects an OBJECT parameters node with no properties — omit
			// `parameters` for zero-arg verbs instead.
			...(parameters.properties && Object.keys(parameters.properties).length
				? { parameters }
				: {}),
		};
	});
}
