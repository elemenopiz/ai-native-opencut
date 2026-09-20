/**
 * `read({ at, fields?, depth? })` — the kernel's perception primitive.
 *
 * WHY THIS IS THE FIRST THING BUILT. §7 of the clean-slate design doc puts the
 * id space + self-describing read first because, on its own, it already kills
 * the failure mode that cancelled the 2026-09-20 prod session: the model read
 * `clip.start`, silently got `undefined` (an unknown-key read returns
 * `undefined` rather than erroring — `program/interpreter.ts:455`), and failed
 * two frames later doing arithmetic on it. `read` never lets that happen,
 * because every result carries `_writable` (schema.ts) alongside `data` — the
 * exact field names, types and units `update` will accept, read from the same
 * declaration `update`'s validator will eventually enforce. The model never has
 * to remember a field name; it re-reads the thing and the answer is right
 * there.
 *
 * THE INVARIANT THIS FILE PROTECTS: `read` must never silently return
 * `undefined` for a field its own `_writable` promises. `kernel/schemas/
 * element.ts` (and `track.ts`) are deliberately FLAT — one field list per
 * KIND, not branched per concrete sub-type — because that is the right shape
 * for the schema itself. But it means `_writable.fields` on its own cannot
 * tell a caller that a video clip has no `content`, or that a text track has
 * no `volume`. Left unhandled, THAT reintroduces the exact prod bug one layer
 * down: the model would see `content` promised, read `undefined`, and act on
 * it two turns later. The fix is `_unavailable` (see {@link ReadResult}): for
 * every field a schema declares writable that genuinely does not apply to
 * THIS concrete instance, `read` removes it from `_writable.fields` and
 * names it in `_unavailable` with a reason instead of leaving it silently
 * absent from `data`. `kernel/read.contract.test.ts` enforces this against
 * the REAL schema registry for every registered kind — not a fixture.
 *
 * ONE ID SPACE, ONE ENTRY POINT. `at` is a kernel id (`ids.ts`): `kind:raw`,
 * or — for the handful of things the app only ever has ONE of — the bare kind
 * name alone (`"project"`, `"selection"`, `"playhead"`, `"history"`,
 * `"budget"`, `"brief"`, `"bible"`). Every other addressable kind (`track`,
 * `element`, `asset`, `take`, `effect`, `keyframe`, `marker`, `scene`,
 * `branch`) needs a raw id after the colon. Getting this wrong teaches rather
 * than fails silently: a malformed id explains the grammar (`ids.ts`), a
 * well-formed id naming nothing that exists lists what DOES exist (this file,
 * mirroring the pattern already proven in
 * `program/derived-data.ts`'s `scopedTracks` — "no track with id X. Live
 * track ids: …").
 *
 * NOT A VALIDATOR. `read` resolves and describes; it never mutates. `fields?`
 * only NARROWS the returned `data`/`_unavailable` (and validates the request
 * against the same field registry `_writable` is built from, via
 * `schema.ts`'s `unknownFieldError` — so an unknown `fields` entry teaches
 * exactly like an unknown `update` patch key eventually will). `depth?`
 * controls whether a kind with child collections (a track's elements, a
 * scene's tracks/markers) returns those children as bare ids (`"ids"`, the
 * default — cheap, keeps the payload small) or fully expanded (`"expanded"`).
 *
 * DEPENDENCY ON `./schemas` IS INTENTIONAL. Agent A owns `KIND_SCHEMAS`; this
 * file is written against `schemaFor`'s interface, never against its content.
 * `deps.schemaFor` exists so tests (and, later, any caller with a reason to)
 * can inject a fixture registry instead of depending on the real one.
 */

import type { EditorCore } from "@/core";
import type {
	Marker,
	TextElement,
	Take,
	TimelineElement,
	TimelineTrack,
	TScene,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { getReelSpend, remainingBudgetUsd } from "../budget";
import {
	coerceId,
	formatId,
	isKernelKind,
	parseId,
	KernelIdError,
	type KernelId,
	type KernelKind,
} from "./ids";
import {
	nearestField,
	resolveField,
	unknownFieldError,
	writableFor,
	type KindSchema,
	type WritableDescriptor,
} from "./schema";
import { schemaFor as defaultSchemaFor } from "./schemas";

/** How much of a kind's child collections to return. See file header. */
export type ReadDepth = "ids" | "expanded";

export interface ReadInput {
	/** A kernel id (`"element:9f1c…"`), or a bare singleton kind name — see {@link SINGLETON_KINDS}. */
	at: string;
	/** Narrow `data`/`_unavailable` to these field names (schema names or their aliases). Omit for everything the kind declares. */
	fields?: string[];
	/** `"ids"` (default): child collections come back as id arrays. `"expanded"`: full nested objects. */
	depth?: ReadDepth;
}

export interface ReadResult {
	kind: KernelKind;
	/** Always fully qualified (`kind:raw`) — see `ids.ts`'s "tolerant in, strict out" rule. Round-trips straight into `update({ at })`. */
	id: KernelId;
	/** One line describing the resolved object — the head of every read. */
	summary: string;
	/** The live field values, narrowed by `fields?` when given. Every key here is a schema-declared field name — nothing appears in `data` that `_writable`/`_unavailable` doesn't also know about. */
	data: Record<string, unknown>;
	/** What `update` will accept on THIS object, right now — with any field named in `_unavailable` already removed from `.fields`, so the two never overlap. */
	_writable: WritableDescriptor;
	/**
	 * Schema-writable fields that do not apply to THIS concrete instance (e.g.
	 * `content` on a video element, `pan` on a video track), each with a
	 * one-line reason. Present only when non-empty. This is what keeps
	 * `_writable` honest against a flat per-kind schema: see the file header.
	 */
	_unavailable?: Record<string, string>;
}

export interface ReadDeps {
	/** Defaults to the real per-kind registry (`./schemas`). Inject a fixture in tests instead of depending on Agent A's in-progress content. */
	schemaFor?: (kind: KernelKind) => KindSchema;
}

/** Thrown when `at` is well-formed (a legal kind, a non-empty raw id) but names something that does not exist, or a kind `read` does not (yet) address. ALWAYS names what does exist — rule 4 of the design doc: errors teach. */
export class KernelReadError extends Error {
	readonly name = "KernelReadError";
}

/** The kind names addressable with no raw id at all — the app only ever has one of each. Every other {@link KernelKind} requires `kind:rawId`. */
const SINGLETON_KINDS: ReadonlySet<KernelKind> = new Set([
	"project",
	"selection",
	"playhead",
	"history",
	"budget",
	"brief",
	"bible",
]);

/** The synthetic raw id singleton kinds resolve to, e.g. `"selection:current"`. Stable across project switches — nothing to look up. */
const SINGLETON_RAW = "current";

/**
 * `at` → `{ kind, raw }`, TOLERANT the one way `read`'s single-argument shape
 * makes unambiguous: a bare singleton kind name (no colon, because it has no
 * raw id to qualify) resolves directly. Anything else goes through
 * `parseId`'s full teaching grammar unchanged — including a bare id for an
 * id-requiring kind, which `read` has no "context" to disambiguate (unlike a
 * verb that also takes an explicit `kind` argument) and so correctly refuses.
 */
function resolveAt(at: string): { kind: KernelKind; raw: string } {
	const trimmed = at.trim();
	if (isKernelKind(trimmed)) {
		if (!SINGLETON_KINDS.has(trimmed)) {
			const singletons = [...SINGLETON_KINDS].sort().join(", ");
			throw new KernelIdError(
				`"${trimmed}" needs an id — e.g. "${trimmed}:<id>". Only these kinds are addressable bare (no id): ${singletons}.`,
			);
		}
		// The bare kind name IS the "bare id" `coerceId` exists to qualify — the
		// hint (`trimmed`, already proven a legal `KernelKind` above) is known
		// from context because a singleton kind has exactly one instance, so
		// there is nothing else `SINGLETON_RAW` could mean. Round-tripped back
		// through `parseId` rather than hand-built, so this stays the ONE place
		// that assembles a qualified id from parts — everywhere else either
		// already has one or rejects.
		return parseId(coerceId(SINGLETON_RAW, trimmed));
	}
	return parseId(trimmed);
}

/** One resolved object, pre-schema: everything `read` knows before it asks `schema.ts` what's writable. */
interface Located {
	/** The raw id to report back (usually `raw` unchanged; lets a locator normalize, e.g. trimming). */
	raw: string;
	summary: string;
	/** Every key here MUST be a name that kind's schema declares (readOnly or writable) — `read.contract.test.ts` checks this against the real registry. */
	data: Record<string, unknown>;
	/**
	 * Writable field names that do not apply to THIS instance, each with a
	 * reason — e.g. `{ content: '"content" only applies to text elements —
	 * this is "video".' }`. Computed against the FULL real field set
	 * regardless of which schema a caller injected; `read()` intersects it
	 * with the resolved schema's actual writable fields before returning, so
	 * a small fixture schema in a test never sees spurious entries for fields
	 * it never declared.
	 */
	unavailable?: Record<string, string>;
}

type Locator = (
	editor: EditorCore,
	raw: string,
	depth: ReadDepth,
) => Promise<Located> | Located;

// ── shared lookups (mirrors director-api.ts's own accessor pattern — see
// `findElement`/`findSlotOrElement` there. Duplicated rather than imported:
// director-api.ts's copies are closures over its own `editor` capture and are
// not exported, and this module must stay independently testable against a
// fake `EditorCore`.) ──────────────────────────────────────────────────────

interface LocatedElement {
	track: TimelineTrack;
	element: TimelineElement;
}

function findElement(
	editor: EditorCore,
	elementId: string,
): LocatedElement | null {
	for (const track of editor.timeline.getTracks()) {
		const element = track.elements.find((e) => e.id === elementId);
		if (element) return { track, element: element as TimelineElement };
	}
	return null;
}

function allElementIds(editor: EditorCore): string[] {
	return editor.timeline
		.getTracks()
		.flatMap((track) => track.elements.map((e) => e.id));
}

/** Loose field access across the `TimelineElement` union without a per-type switch — every read below checks applicability first (element) or `key in track` (track). */
function field<T = unknown>(
	element: TimelineElement,
	key: string,
): T | undefined {
	return (element as unknown as Record<string, T | undefined>)[key];
}

/** Bag of dictionaries per-property-path keyframes live in, e.g. `element.animations.channels["opacity"].keyframes`. */
function findKeyframe(
	editor: EditorCore,
	keyframeId: string,
): {
	track: TimelineTrack;
	element: TimelineElement;
	propertyPath: string;
	keyframe: Record<string, unknown>;
} | null {
	for (const track of editor.timeline.getTracks()) {
		for (const element of track.elements) {
			const animations = field<{
				channels: Record<
					string,
					{ keyframes: Array<Record<string, unknown>> } | undefined
				>;
			}>(element as TimelineElement, "animations");
			if (!animations) continue;
			for (const [propertyPath, channel] of Object.entries(
				animations.channels,
			)) {
				if (!channel) continue;
				const keyframe = channel.keyframes.find((k) => k.id === keyframeId);
				if (keyframe) {
					return {
						track,
						element: element as TimelineElement,
						propertyPath,
						keyframe,
					};
				}
			}
		}
	}
	return null;
}

function allKeyframeIds(editor: EditorCore): string[] {
	const ids: string[] = [];
	for (const track of editor.timeline.getTracks()) {
		for (const element of track.elements) {
			const animations = field<{
				channels: Record<
					string,
					{ keyframes: Array<{ id: string }> } | undefined
				>;
			}>(element as TimelineElement, "animations");
			if (!animations) continue;
			for (const channel of Object.values(animations.channels)) {
				if (!channel) continue;
				ids.push(...channel.keyframes.map((k) => k.id));
			}
		}
	}
	return ids;
}

function findEffect(
	editor: EditorCore,
	effectId: string,
): {
	track: TimelineTrack;
	element: TimelineElement;
	effect: Record<string, unknown>;
} | null {
	for (const track of editor.timeline.getTracks()) {
		for (const element of track.elements) {
			const effects = field<Array<Record<string, unknown>>>(
				element as TimelineElement,
				"effects",
			);
			const effect = effects?.find((e) => e.id === effectId);
			if (effect) return { track, element: element as TimelineElement, effect };
		}
	}
	return null;
}

function allEffectIds(editor: EditorCore): string[] {
	const ids: string[] = [];
	for (const track of editor.timeline.getTracks()) {
		for (const element of track.elements) {
			const effects = field<Array<{ id: string }>>(
				element as TimelineElement,
				"effects",
			);
			if (effects) ids.push(...effects.map((e) => e.id));
		}
	}
	return ids;
}

function findTake(
	editor: EditorCore,
	takeId: string,
): { track: TimelineTrack; element: TimelineElement; take: Take } | null {
	for (const track of editor.timeline.getTracks()) {
		for (const element of track.elements) {
			const takes = field<Take[]>(element as TimelineElement, "takes");
			const take = takes?.find((t) => t.id === takeId);
			if (take) return { track, element: element as TimelineElement, take };
		}
	}
	return null;
}

function allTakeIds(editor: EditorCore): string[] {
	const ids: string[] = [];
	for (const track of editor.timeline.getTracks()) {
		for (const element of track.elements) {
			const takes = field<Take[]>(element as TimelineElement, "takes");
			if (takes) ids.push(...takes.map((t) => t.id));
		}
	}
	return ids;
}

function listOrNone(ids: string[]): string {
	return ids.length > 0 ? ids.join(", ") : "(none)";
}

/** `n:ss`, matching `director-api.ts`'s `formatMinSec` — kept local since that copy is an unexported closure. */
function formatMinSec(totalSeconds: number): string {
	const whole = Math.max(0, Math.round(totalSeconds));
	const minutes = Math.floor(whole / 60);
	const seconds = whole % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ── element field applicability ─────────────────────────────────────────────
//
// `kernel/schemas/element.ts` is FLAT — one field list for all seven element
// kinds (video/image/text/sticker/shape/audio/effect) — because that's the
// right shape for a SCHEMA. It is the wrong shape for a live READ: a video
// clip genuinely has no `content`, a shape has no `mediaId`. Below is the
// per-field applicability table that turns "declared writable" into "writable
// on THIS instance, else why not" — see the file header for why this exists.
//
// Grounded in `types/timeline.ts`'s actual per-variant field lists, not
// `element.ts`'s prose "X elements only" notes, which are occasionally
// imprecise (e.g. `hidden`'s note claims "effect" elements too, but
// `EffectElement` carries no `hidden` field at all — verified against the
// type, not assumed from the comment).

type ElementKindName =
	| "video"
	| "image"
	| "text"
	| "sticker"
	| "shape"
	| "audio"
	| "effect";

/** `null` = applies to this element; a string = the reason it doesn't. */
type ElementApplicability = (
	kind: ElementKindName,
	element: TimelineElement,
) => string | null;

const VISUAL5: ElementKindName[] = [
	"video",
	"image",
	"text",
	"sticker",
	"shape",
];
const GENERATIVE3: ElementKindName[] = ["video", "image", "audio"];

function onlyFor(
	allowed: ElementKindName[],
	label: string,
): ElementApplicability {
	return (kind) =>
		allowed.includes(kind)
			? null
			: `"${label}" only applies to ${allowed.join("/")} elements — this is "${kind}".`;
}

const ELEMENT_FIELD_APPLICABILITY: Record<string, ElementApplicability> = {
	// video/image always carry `mediaId`; for `audio` it depends on
	// `sourceType` (`UploadAudioElement.mediaId` vs `LibraryAudioElement.
	// sourceUrl` — see `types/timeline.ts`), so this is the one field whose
	// applicability isn't decidable from `kind` alone.
	mediaId: (kind, element) => {
		if (kind === "video" || kind === "image") return null;
		if (kind === "audio") {
			return "mediaId" in element
				? null
				: '"mediaId" does not apply to this audio element — it is a library clip, addressed by sourceUrl instead.';
		}
		return `"mediaId" only applies to video/image/audio elements — this is "${kind}".`;
	},
	generation: onlyFor(GENERATIVE3, "generation"),
	activeTakeId: onlyFor(GENERATIVE3, "activeTakeId"),
	volume: onlyFor(["audio"], "volume"),
	muted: onlyFor(["video", "audio"], "muted"),
	playbackRate: onlyFor(["video", "audio"], "playbackRate"),
	reversed: onlyFor(["video"], "reversed"),
	isSourceAudioEnabled: onlyFor(["video"], "isSourceAudioEnabled"),
	transform: onlyFor(VISUAL5, "transform"),
	opacity: onlyFor(VISUAL5, "opacity"),
	blendMode: onlyFor(VISUAL5, "blendMode"),
	crop: onlyFor(VISUAL5, "crop"),
	mask: onlyFor(VISUAL5, "mask"),
	transitionOut: onlyFor(VISUAL5, "transitionOut"),
	hidden: onlyFor(VISUAL5, "hidden"),
	content: onlyFor(["text"], "content"),
	fontSize: onlyFor(["text"], "fontSize"),
	fontFamily: onlyFor(["text"], "fontFamily"),
	color: onlyFor(["text"], "color"),
	highlightColor: onlyFor(["text"], "highlightColor"),
	wordActiveColor: onlyFor(["text"], "wordActiveColor"),
	wordActiveBackground: onlyFor(["text"], "wordActiveBackground"),
	wordPopScale: onlyFor(["text"], "wordPopScale"),
	strokeColor: onlyFor(["text"], "strokeColor"),
	strokeWidth: onlyFor(["text"], "strokeWidth"),
	background: onlyFor(["text"], "background"),
	textAlign: onlyFor(["text"], "textAlign"),
	fontWeight: onlyFor(["text"], "fontWeight"),
	fontStyle: onlyFor(["text"], "fontStyle"),
	textDecoration: onlyFor(["text"], "textDecoration"),
	letterSpacing: onlyFor(["text"], "letterSpacing"),
	lineHeight: onlyFor(["text"], "lineHeight"),
	stickerId: onlyFor(["sticker"], "stickerId"),
	shapeKind: onlyFor(["shape"], "shapeKind"),
	width: onlyFor(["shape"], "width"),
	height: onlyFor(["shape"], "height"),
	fill: onlyFor(["shape"], "fill"),
	stroke: onlyFor(["shape"], "stroke"),
	cornerRadius: onlyFor(["shape"], "cornerRadius"),
	params: onlyFor(["effect"], "params"),
};

/**
 * Common projection of any `TimelineElement` onto the field set `read`
 * reports. Field names are read straight off `kernel/schemas/element.ts`
 * (Agent A's registry) — `kind` (not `type`), `trimStart`/`trimEnd`/
 * `sourceDuration` (no "Sec" suffix, unlike `startSec`/`durationSec`), and
 * `effects`/`takes` (the ids-or-expanded LIST itself, not a separate `*Ids`
 * field) all come from there, verified against a real `schemaFor` — see the
 * final report for exactly how.
 *
 * Every WRITABLE field the schema declares is resolved through
 * {@link ELEMENT_FIELD_APPLICABILITY}: applicable ⇒ a real value lands in
 * `data` (even `undefined`, when the concrete instance legitimately has none
 * set — that's an honest answer, not a contract gap); inapplicable ⇒ the
 * field is named in `unavailable` instead of silently missing from `data`.
 * READ-ONLY fields (`effects`/`takes`/`isSlot`/`isVoiceover`/`isMusic`/
 * `effectType`/`wordTimings`) have no such obligation (nothing promises them
 * writable) but are projected anyway, where cheap, in the spirit of rule 2.
 */
function projectElement(
	track: TimelineTrack,
	element: TimelineElement,
	depth: ReadDepth,
): { data: Record<string, unknown>; unavailable: Record<string, string> } {
	const kind = field<ElementKindName>(element, "type") as ElementKindName;
	const startSec = element.startTime;
	const durationSec = element.duration;
	const data: Record<string, unknown> = {
		id: element.id,
		trackId: track.id,
		trackKind: track.type,
		kind,
		name: element.name,
		startSec,
		durationSec,
		endSec: startSec + durationSec,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
	};
	if (element.sourceDuration != null)
		data.sourceDuration = element.sourceDuration;

	const unavailable: Record<string, string> = {};
	for (const [name, applicability] of Object.entries(
		ELEMENT_FIELD_APPLICABILITY,
	)) {
		const reason = applicability(kind, element);
		if (reason) {
			unavailable[name] = reason;
		} else {
			data[name] = field(element, name);
		}
	}

	// Read-only extras, projected where cheap — not required by the
	// writable/`_unavailable` contract (see the doc comment above), but
	// leaving them silently off `data` when they're this easy to compute
	// would repeat the same mistake in spirit if not in the letter of it.
	const effects = field<Array<{ id: string }>>(element, "effects");
	if (effects) {
		data.effects = depth === "expanded" ? effects : effects.map((e) => e.id);
	}
	const takes = field<Take[]>(element, "takes");
	if (takes) {
		data.takes = depth === "expanded" ? takes : takes.map((t) => t.id);
	}
	if (GENERATIVE3.includes(kind)) {
		data.isSlot = Boolean(field(element, "generation"));
	}
	if (kind === "audio") {
		const isVoiceover =
			field<{ kind?: string }>(element, "generation")?.kind === "voiceover";
		data.isVoiceover = isVoiceover;
		data.isMusic = !isVoiceover;
	}
	if (kind === "effect") {
		data.effectType = field(element, "effectType");
	}
	if (kind === "text") {
		data.wordTimings = field(element, "wordTimings");
	}

	return { data, unavailable };
}

function summarizeElement(
	track: TimelineTrack,
	element: TimelineElement,
): string {
	const kind = String(field(element, "type") ?? "element");
	const label =
		element.name ||
		(kind === "text" ? (element as TextElement).content : "") ||
		"(untitled)";
	return `${kind} "${label}" on track "${track.name}" — ${element.startTime.toFixed(2)}s–${(
		element.startTime + element.duration
	).toFixed(2)}s.`;
}

// ── track field applicability ───────────────────────────────────────────────
//
// Same shape of problem as `element`, one layer up: `kernel/schemas/track.ts`
// is flat too, and `TimelineTrack`'s six concrete variants (`VideoTrack`/
// `TextTrack`/`AudioTrack`/`StickerTrack`/`ShapeTrack`/`EffectTrack`) do not
// all carry `muted`/`hidden`/`volume`/`pan`/`solo` — ground truth is each
// variant's own field list in `types/timeline.ts`, e.g. `AudioTrack` has no
// `hidden` at all (only video/text/sticker/shape/effect tracks do).

type TrackKindName =
	| "video"
	| "text"
	| "audio"
	| "sticker"
	| "shape"
	| "effect";

function trackOnlyFor(
	allowed: TrackKindName[],
	label: string,
): (kind: TrackKindName) => string | null {
	return (kind) =>
		allowed.includes(kind)
			? null
			: `"${label}" only applies to ${allowed.join("/")} tracks — this is "${kind}".`;
}

const TRACK_FIELD_APPLICABILITY: Record<
	string,
	(kind: TrackKindName) => string | null
> = {
	muted: trackOnlyFor(["video", "audio"], "muted"),
	hidden: trackOnlyFor(
		["video", "text", "sticker", "shape", "effect"],
		"hidden",
	),
	volume: trackOnlyFor(["video", "audio"], "volume"),
	pan: trackOnlyFor(["audio"], "pan"),
	solo: trackOnlyFor(["video", "audio"], "solo"),
};

// ── locators, one per addressable kind ──────────────────────────────────────

const locateProject: Locator = (editor) => {
	const project = editor.project.getActiveOrNull();
	if (!project) {
		throw new KernelReadError('read({ at: "project" }): no project is loaded.');
	}
	// Field names match `kernel/schemas/project.ts` — `duration` keeps ITS raw
	// name too (an alias, `durationSec`, exists only for the vocabulary a model
	// already learned on `element`); `canvasSize` stays a nested object as the
	// schema declares it. Every field here applies unconditionally (one
	// project shape, no sub-kinds) — no `unavailable` needed.
	const width = project.settings.canvasSize.width;
	const height = project.settings.canvasSize.height;
	const data: Record<string, unknown> = {
		id: project.metadata.id,
		name: project.metadata.name,
		duration: project.metadata.duration,
		thumbnail: project.metadata.thumbnail,
		fps: project.settings.fps,
		canvasSize: project.settings.canvasSize,
		background: project.settings.background,
		proxyEditing: project.settings.proxyEditing,
		proxyResolution: project.settings.proxyResolution,
		currentSceneId: project.currentSceneId,
		directorBrief: project.directorBrief,
		createdAt:
			project.metadata.createdAt?.toISOString?.() ?? project.metadata.createdAt,
		updatedAt:
			project.metadata.updatedAt?.toISOString?.() ?? project.metadata.updatedAt,
	};
	return {
		raw: SINGLETON_RAW,
		summary: `Project "${project.metadata.name}" — ${width}x${height}@${project.settings.fps}fps, ${formatMinSec(
			project.metadata.duration,
		)}.`,
		data,
	};
};

const locateTrack: Locator = (editor, raw, depth) => {
	const tracks = editor.timeline.getTracks();
	const track = tracks.find((t) => t.id === raw);
	if (!track) {
		throw new KernelReadError(
			`read({ at: "track:${raw}" }): no track with id "${raw}". Live track ids: ${listOrNone(
				tracks.map((t) => t.id),
			)}.`,
		);
	}
	const kind = track.type as TrackKindName;
	// Field names match `kernel/schemas/track.ts`: the track's own discriminator
	// is canonically `type` there (an element's is `kind` — see `projectElement`
	// — the two kinds deliberately don't share a name, since an element also
	// reports its TRACK's type as `trackKind`).
	const data: Record<string, unknown> = {
		id: track.id,
		type: track.type,
		name: track.name,
		color: track.color,
		locked: Boolean(track.locked),
		elements:
			depth === "expanded"
				? track.elements.map(
						(e) => projectElement(track, e as TimelineElement, "ids").data,
					)
				: track.elements.map((e) => e.id),
	};
	const unavailable: Record<string, string> = {};
	for (const [name, applicability] of Object.entries(
		TRACK_FIELD_APPLICABILITY,
	)) {
		const reason = applicability(kind);
		if (reason) {
			unavailable[name] = reason;
		} else {
			data[name] = (track as unknown as Record<string, unknown>)[name];
		}
	}
	if ("isMain" in track) data.isMain = (track as { isMain?: boolean }).isMain;
	return {
		raw: track.id,
		summary: `${track.type} track "${track.name}" — ${track.elements.length} element(s).`,
		data,
		unavailable,
	};
};

const locateElement: Locator = (editor, raw, depth) => {
	const found = findElement(editor, raw);
	if (!found) {
		throw new KernelReadError(
			`read({ at: "element:${raw}" }): no element with id "${raw}". Live element ids: ${listOrNone(
				allElementIds(editor),
			)}.`,
		);
	}
	const { data, unavailable } = projectElement(
		found.track,
		found.element,
		depth,
	);
	return {
		raw: found.element.id,
		summary: summarizeElement(found.track, found.element),
		data,
		unavailable,
	};
};

const locateAsset: Locator = (editor, raw) => {
	const asset = editor.media.getAssetById(raw);
	if (!asset) {
		const ids = editor.media.getAssets().map((a) => a.id);
		throw new KernelReadError(
			`read({ at: "asset:${raw}" }): no asset with id "${raw}". Live asset ids: ${listOrNone(ids)}.`,
		);
	}
	// Field names match `kernel/schemas/asset.ts` — `duration` keeps its RAW
	// name (unlike `element`'s renamed `startSec`/`durationSec`): nothing else
	// in the codebase renames an asset's duration, so `durationSec` survives
	// only as that schema's alias, not the canonical key `data` must use.
	// Every declared field applies to every asset kind uniformly (image/video/
	// audio all share one `MediaAssetData` shape) — no `unavailable` needed.
	const a: MediaAsset = asset;
	const data: Record<string, unknown> = {
		id: a.id,
		name: a.name,
		label: a.label,
		folderId: a.folderId,
		type: a.type,
		// `size` is on `MediaAssetData` (storage layer) but deliberately
		// omitted from the runtime `MediaAsset` type `media.getAssetById`
		// returns (`Omit<MediaAssetData, "size" | "lastModified">`) — not
		// reachable through this manager. `size` is READ-ONLY in the schema,
		// so leaving it off `data` here is not a `_writable` promise-break
		// (see the file header); it just means a full read never shows it.
		width: a.width,
		height: a.height,
		duration: a.duration,
		fps: a.fps,
		thumbnailUrl: a.thumbnailUrl,
		source: a.source,
		ephemeral: a.ephemeral,
		needsProxy: a.needsProxy,
		proxy: a.proxy,
		decodeUnsupported: a.decodeUnsupported,
	};
	return { raw: a.id, summary: `${a.type} asset "${a.name}".`, data };
};

const locateTake: Locator = (editor, raw) => {
	const found = findTake(editor, raw);
	if (!found) {
		throw new KernelReadError(
			`read({ at: "take:${raw}" }): no take with id "${raw}". Live take ids: ${listOrNone(
				allTakeIds(editor),
			)}.`,
		);
	}
	const { element, take } = found;
	// Field names match `kernel/schemas/take.ts` — every field there is
	// read-only by design (a take is a provenance record; picking one is a
	// WRITE ON THE ELEMENT's `activeTakeId`, not on the take itself), so
	// there is no `_writable`/`unavailable` obligation here at all.
	const data: Record<string, unknown> = {
		id: take.id,
		elementId: element.id,
		status: take.status,
		mediaId: take.mediaId,
		thumbnailUrl: take.thumbnailUrl,
		seed: take.spec?.seed,
		spec: take.spec,
		jobId: take.jobId,
		provenance: take.provenance,
		cost: take.cost,
		createdAt: take.createdAt,
		error: take.error,
	};
	const activeTakeId = field<string>(element, "activeTakeId");
	const isActive = activeTakeId === take.id;
	return {
		raw: take.id,
		summary: `Take "${take.id}" on element "${element.id}" — ${take.status}${
			isActive ? " (active)" : ""
		}.`,
		data,
	};
};

const locateEffect: Locator = (editor, raw) => {
	const found = findEffect(editor, raw);
	if (!found) {
		throw new KernelReadError(
			`read({ at: "effect:${raw}" }): no effect with id "${raw}". Live effect ids: ${listOrNone(
				allEffectIds(editor),
			)}.`,
		);
	}
	const { element, effect } = found;
	const data: Record<string, unknown> = {
		id: effect.id,
		elementId: element.id,
		type: effect.type,
		enabled: effect.enabled,
		params: effect.params,
	};
	return {
		raw: String(effect.id),
		summary: `"${effect.type}" effect on element "${element.id}"${effect.enabled === false ? " (disabled)" : ""}.`,
		data,
	};
};

const locateKeyframe: Locator = (editor, raw) => {
	const found = findKeyframe(editor, raw);
	if (!found) {
		throw new KernelReadError(
			`read({ at: "keyframe:${raw}" }): no keyframe with id "${raw}". Live keyframe ids: ${listOrNone(
				allKeyframeIds(editor),
			)}.`,
		);
	}
	const { element, propertyPath, keyframe } = found;
	const data: Record<string, unknown> = {
		id: keyframe.id,
		elementId: element.id,
		propertyPath,
		time: keyframe.time,
		value: keyframe.value,
		interpolation: keyframe.interpolation,
		easing: keyframe.easing,
	};
	return {
		raw: String(keyframe.id),
		summary: `Keyframe on "${propertyPath}" @ ${keyframe.time}s, element "${element.id}".`,
		data,
	};
};

const locateMarker: Locator = (editor, raw) => {
	const markers: Marker[] = editor.scenes.getMarkers();
	const marker = markers.find((m) => m.id === raw);
	if (!marker) {
		throw new KernelReadError(
			`read({ at: "marker:${raw}" }): no marker with id "${raw}". Live marker ids: ${listOrNone(
				markers.map((m) => m.id),
			)}.`,
		);
	}
	const data: Record<string, unknown> = {
		id: marker.id,
		time: marker.time,
		color: marker.color,
		note: marker.note,
		createdAt: marker.createdAt,
	};
	return {
		raw: marker.id,
		summary: `${marker.color} marker @ ${marker.time.toFixed(2)}s${marker.note ? `: "${marker.note}"` : ""}.`,
		data,
	};
};

const locateScene: Locator = (editor, raw, depth) => {
	const scenes: TScene[] = editor.scenes.getScenes();
	const scene = scenes.find((s) => s.id === raw);
	if (!scene) {
		throw new KernelReadError(
			`read({ at: "scene:${raw}" }): no scene with id "${raw}". Live scene ids: ${listOrNone(
				scenes.map((s) => s.id),
			)}.`,
		);
	}
	// Field names match `kernel/schemas/scene.ts`: `tracks`/`markers` are the
	// ids-or-expanded LIST itself (mirroring `track`'s own `elements` field),
	// not a separate `*Count`/`*Ids` pair. `bookmarks` has no stable id
	// (legacy, time-keyed) so it is never id-narrowed — always the full array.
	// Every scene shares one shape — no `unavailable` needed.
	const data: Record<string, unknown> = {
		id: scene.id,
		name: scene.name,
		isMain: scene.isMain,
		tracks:
			depth === "expanded"
				? scene.tracks.map((t) => ({
						id: t.id,
						name: t.name,
						type: t.type,
						elements: t.elements.map((e) => e.id),
					}))
				: scene.tracks.map((t) => t.id),
		markers:
			depth === "expanded" ? scene.markers : scene.markers.map((m) => m.id),
		bookmarks: scene.bookmarks,
		createdAt: scene.createdAt?.toISOString?.() ?? scene.createdAt,
		updatedAt: scene.updatedAt?.toISOString?.() ?? scene.updatedAt,
	};
	return {
		raw: scene.id,
		summary: `Scene "${scene.name}"${scene.isMain ? " (main)" : ""} — ${scene.tracks.length} track(s).`,
		data,
	};
};

// Field names below match `kernel/schemas/selection.ts` / `schemas/playhead.ts`
// exactly — both singletons, one shape, no `unavailable` needed.

const locateSelection: Locator = (editor) => {
	const elements = editor.selection.getSelectedElements();
	const keyframes = editor.selection.getSelectedKeyframes();
	const data: Record<string, unknown> = {
		elements,
		keyframes,
		keyframeAnchor: editor.selection.getKeyframeSelectionAnchor(),
	};
	return {
		raw: SINGLETON_RAW,
		summary:
			elements.length === 0 && keyframes.length === 0
				? "Nothing selected."
				: `${elements.length} element(s), ${keyframes.length} keyframe(s) selected.`,
		data,
	};
};

const locatePlayhead: Locator = (editor) => {
	const data: Record<string, unknown> = {
		time: editor.playback.getCurrentTime(),
		playing: editor.playback.getIsPlaying(),
		volume: editor.playback.getVolume(),
		muted: editor.playback.isMuted(),
		scrubbing: editor.playback.getIsScrubbing(),
		shuttleSpeed: editor.playback.getShuttleSpeed(),
		shuttleDirection: editor.playback.getShuttleDirection(),
	};
	return {
		raw: SINGLETON_RAW,
		summary: `Playhead @ ${(data.time as number).toFixed(2)}s${data.playing ? " (playing)" : ""}.`,
		data,
	};
};

const locateHistory: Locator = (editor) => {
	const data: Record<string, unknown> = {
		canUndo: editor.command.canUndo(),
		canRedo: editor.command.canRedo(),
		undoLength: editor.command.getHistoryLength(),
		redoLength: editor.command.getRedoLength(),
		lastUndoName: editor.command.peekUndoName(),
	};
	return {
		raw: SINGLETON_RAW,
		summary: `${data.undoLength} undoable, ${data.redoLength} redoable.`,
		data,
	};
};

const locateBudget: Locator = (editor) => {
	const spend = getReelSpend(editor);
	const remaining = remainingBudgetUsd(spend);
	const data: Record<string, unknown> = {
		spentUsd: spend.spentUsd,
		budgetUsd: spend.budgetUsd,
		remainingUsd: remaining,
	};
	return {
		raw: SINGLETON_RAW,
		summary:
			spend.budgetUsd == null
				? "No budget set for this reel."
				: `$${spend.spentUsd.toFixed(2)} spent of $${spend.budgetUsd.toFixed(2)} ($${(remaining ?? 0).toFixed(2)} remaining).`,
		data,
	};
};

const locateBrief: Locator = (editor) => {
	const brief = editor.project.getDirectorBrief();
	const data: Record<string, unknown> = { ...brief };
	const parts = [brief.goal, brief.audience, brief.tone].filter(Boolean);
	return {
		raw: SINGLETON_RAW,
		summary:
			parts.length > 0 ? `Brief: ${parts.join(" · ")}.` : "No brief set yet.",
		data,
	};
};

const locateBible: Locator = (editor) => {
	const bible = editor.project.getProjectBible();
	if (!bible) {
		throw new KernelReadError(
			'read({ at: "bible" }): no project bible has been created for this project yet.',
		);
	}
	const data: Record<string, unknown> = { ...bible };
	return {
		raw: SINGLETON_RAW,
		summary: `Project bible, version ${bible.version}.`,
		data,
	};
};

const LOCATORS: Partial<Record<KernelKind, Locator>> = {
	project: locateProject,
	track: locateTrack,
	element: locateElement,
	asset: locateAsset,
	take: locateTake,
	effect: locateEffect,
	keyframe: locateKeyframe,
	marker: locateMarker,
	scene: locateScene,
	selection: locateSelection,
	playhead: locatePlayhead,
	history: locateHistory,
	budget: locateBudget,
	brief: locateBrief,
	bible: locateBible,
	// `branch` and `commit` wrap `version-manager` (49 methods, ZERO reachable
	// today — the largest dark manager in the §1 measurement) and `consent`
	// wraps a zustand store the editor doesn't own. Deliberately left
	// unaddressed by THIS pass rather than stubbed with a fake shape: build
	// order item 6 ("version + focus — the two dark unlocks") is where
	// `version-manager`'s async surface gets its first caller, and consent
	// stays UI-only by design (§4 "What stays out of reach on purpose").
};

/** A `KernelKind` `read` recognizes (per `ids.ts`) but does not yet resolve — distinct from an unknown kind, which `resolveAt`/`parseId` already reject with the nearest-match teaching error. */
function unsupportedKindError(kind: KernelKind): KernelReadError {
	const supported = Object.keys(LOCATORS).sort().join(", ");
	return new KernelReadError(
		`read() does not address "${kind}" yet. Currently addressable kinds: ${supported}.`,
	);
}

/**
 * Narrow `data`/`unavailable` to just the requested field names, resolved
 * through the schema's aliases exactly like `update`'s validator eventually
 * will. A requested field that resolves to something legitimately
 * unavailable for this instance is NOT a naming error — it moves to the
 * narrowed `unavailable` map instead of either throwing or silently
 * returning `undefined` in `data`. Only a name the schema does not recognize
 * AT ALL throws (`unknownFieldError` — the near-miss teaching message).
 */
function narrowFields(
	schema: KindSchema,
	data: Record<string, unknown>,
	unavailable: Record<string, string>,
	fields: string[],
): { data: Record<string, unknown>; unavailable: Record<string, string> } {
	const outData: Record<string, unknown> = {};
	const outUnavailable: Record<string, string> = {};
	for (const requested of fields) {
		const canonical = resolveField(schema, requested);
		if (!canonical) {
			throw new KernelReadError(unknownFieldError(schema, requested));
		}
		if (canonical in unavailable) {
			outUnavailable[canonical] = unavailable[canonical];
			continue;
		}
		outData[canonical] = data[canonical];
	}
	return { data: outData, unavailable: outUnavailable };
}

/**
 * Resolve `input.at` and return everything the model needs to act on it
 * without guessing: the live `data`, `_writable` — the exact patch shape
 * `update` will accept, read from `schema.ts`'s registry — and `_unavailable`
 * for any writable field that doesn't apply to THIS instance (see the file
 * header). Throws {@link KernelIdError} for a malformed/unknown id,
 * {@link KernelReadError} for a well-formed id naming nothing (or a kind not
 * yet wired here), and whatever `schemaFor` throws when no schema is
 * registered for the kind.
 *
 * Async because one addressable kind (`branch`, once wired) reaches
 * `version-manager`'s async surface; every locator implemented today is
 * synchronous under the hood, so this never actually suspends for them.
 */
export async function read(
	editor: EditorCore,
	input: ReadInput,
	deps: ReadDeps = {},
): Promise<ReadResult> {
	const resolveSchema = deps.schemaFor ?? defaultSchemaFor;
	const { kind, raw } = resolveAt(input.at);
	const locator = LOCATORS[kind];
	if (!locator) throw unsupportedKindError(kind);

	const depth = input.depth ?? "ids";
	const located = await locator(editor, raw, depth);
	const schema = resolveSchema(kind);
	const writable = writableFor(schema);

	// A locator's `unavailable` map is written against the FULL real field
	// set, independent of which schema resolved (a test may inject a small
	// fixture schema that never declared these fields as writable in the
	// first place). Only report — and only remove from `_writable.fields` —
	// entries the RESOLVED schema actually promised, so `_writable` and
	// `_unavailable` can never overlap and a fixture-based caller never sees
	// a spurious entry for a field its own schema doesn't know about.
	const unavailable: Record<string, string> = {};
	for (const [name, reason] of Object.entries(located.unavailable ?? {})) {
		if (name in writable.fields) {
			unavailable[name] = reason;
			delete writable.fields[name];
		}
	}

	let data = located.data;
	let finalUnavailable = unavailable;
	if (input.fields && input.fields.length > 0) {
		const narrowed = narrowFields(
			schema,
			located.data,
			unavailable,
			input.fields,
		);
		data = narrowed.data;
		finalUnavailable = narrowed.unavailable;
	}

	return {
		kind,
		id: formatId(kind, located.raw),
		summary: located.summary,
		data,
		_writable: writable,
		...(Object.keys(finalUnavailable).length > 0
			? { _unavailable: finalUnavailable }
			: {}),
	};
}

// Exposed for `read.test.ts`/`read.contract.test.ts` and any future caller
// that wants the raw near-miss suggestion without a full read (e.g. a future
// `update`'s error path composing the same message shape).
export { nearestField as nearestReadableField };
