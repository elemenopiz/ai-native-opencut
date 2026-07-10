/**
 * Director API — a single, coarse, agent-friendly façade over the editor managers.
 *
 * The human UI, a future in-app agent, and an eventual external MCP all call
 * THIS layer (not the managers directly). It exposes a small set of high-level
 * verbs with compact, self-describing returns (docs §8 "Director command API").
 *
 * Design rules:
 *  - Few high-level verbs; stable ids (a slot id IS its element id).
 *  - Idempotent where reasonable.
 *  - Compact, readable state snapshots.
 *  - Guarded, self-describing returns: validate inputs, return
 *    `{ ok, message, data? }` rather than throwing.
 *
 * This is a PURE LOGIC MODULE: no React, no JSX, no direct LLM/provider wiring.
 *
 * It does NOT reimplement timeline bookkeeping. The generative model is
 * canonical (`@/types/timeline`: a clip is a slot iff `element.generation` is
 * set; takes live at `element.takes`, active at `element.activeTakeId`) and all
 * slot/take mutations DELEGATE to the canonical timeline-manager methods
 * (`addGenerativeSlot`, `setSlotSpec`, `addTakeToElement`, `updateTake`,
 * `selectTake`, `removeTake`). Multi-step verbs are grouped into a single
 * undoable history entry via the command manager's transaction buffer.
 *
 * The actual generation network calls are delegated to an injectable
 * `GenerateExecutor` boundary (see `createDirectorApi` options) — marked with
 * `// TODO(generation-pipeline)` below.
 */

import type { EditorCore } from "@/core";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { generateUUID } from "@/utils/id";
import { usePersonaStore } from "@/stores/persona-store";
import type {
	GenerationSpec,
	Take,
	TextElement,
	TimelineElement,
	TimelineTrack,
} from "@/types/timeline";
import {
	buildConsistencyContext,
	getStoredConsistencyContext,
	storeConsistencyContext,
	type ConsistencyCharacter,
	type ConsistencyContext,
} from "./consistency-prompt";
import { buildRemixSpec } from "@/lib/studio/remix";
import {
	extractTakeLastFrame,
	extractTakeFrames,
} from "@/lib/media/last-frame";
import {
	estimateBatchCost,
	formatCostRange,
	type CostRange,
} from "@/lib/studio/cost";
import { createShortIdMap } from "./short-id";
import { aiClient } from "@/lib/ai-client";
import { getAllEmbeddings } from "@/services/search/embedding-store";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import { AddTransitionCommand } from "@/lib/commands/timeline/element/transitions/add-transition";
import { getAllTransitions } from "@/lib/transitions";
import { getAllEffects } from "@/lib/effects";
import type { EffectParamValues } from "@/types/effects";
import { DEFAULT_EXPORT_OPTIONS } from "@/constants/export-constants";
import {
	downloadBuffer,
	getExportFileExtension,
	getExportMimeType,
} from "@/lib/export";
import type {
	ExportFormat,
	ExportOptions,
	ExportQuality,
} from "@/types/export";
import type {
	DirectorResult,
	MediaSearchHit,
	MutationDelta,
	ProjectInfo,
	ReelSnapshot,
	ReviewTakeData,
	SlotChange,
	SlotSnapshot,
	GenerateExecutor,
	UniformShift,
} from "./types";

export type {
	DirectorResult,
	GenerateExecutor,
	GenerationSpec,
	GenerativeFields,
	MediaSearchHit,
	ProjectInfo,
	ReelSnapshot,
	SlotSnapshot,
	Take,
	TakeStatus,
} from "./types";

/**
 * A timeline element that is a generative slot — i.e. it carries a
 * `generation` recipe. Takes live alongside on `takes`/`activeTakeId`.
 */
type SlotElement = TimelineElement & {
	generation: GenerationSpec;
	takes?: Take[];
	activeTakeId?: string;
};

/** Located slot together with the track that holds it. */
interface LocatedSlot {
	track: TimelineTrack;
	element: SlotElement;
}

export interface CreateDirectorApiOptions {
	/**
	 * Injectable boundary for real provider/network generation. If omitted,
	 * generate/reroll enqueue `queued` takes and report that no executor is
	 * configured. See `// TODO(generation-pipeline)`.
	 */
	executor?: GenerateExecutor;
}

const ok = <T>(message: string, data?: T): DirectorResult<T> => ({
	ok: true,
	message,
	data,
});

const fail = <T = undefined>(message: string): DirectorResult<T> => ({
	ok: false,
	message,
});

/**
 * Sensible defaults for the REQUIRED fields of a `GenerationSpec`. The canonical
 * spec requires `mode`/`resolution`/`orientation`/`duration`; storyboard and
 * reserveSlot supply these. The resolved `prompt`/`duration` (already merged
 * from caller input by the verb) are authoritative; `overrides` fills in the
 * optional fields and may bump the defaults for mode/resolution/orientation.
 */
function buildSpec(
	prompt: string,
	duration: number,
	overrides?: Partial<GenerationSpec>,
): GenerationSpec {
	return {
		mode: "text-to-video",
		resolution: "480p",
		orientation: "portrait",
		...overrides,
		prompt,
		duration,
	};
}

/**
 * A spec override as the agent supplies it: the canonical `GenerationSpec`
 * fields PLUS a transient `referenceMediaId` — a media-library asset id the
 * agent uses to point a shot's first frame / reference at an UPLOADED still
 * (e.g. `@Image1`). `referenceMediaId` is resolved to `referenceImageUrl` by
 * `createDirectorApi` (the only layer that can reach the media store) and never
 * reaches `GenerationSpec`, which carries URLs only.
 */
export type SpecOverride = Partial<GenerationSpec> & {
	referenceMediaId?: string;
};

/** Type guard: is this element a generative slot (carries a `generation` recipe)? */
function isSlotElement(element: TimelineElement): element is SlotElement {
	return (
		(element.type === "image" || element.type === "video") &&
		typeof (element as { generation?: unknown }).generation === "object" &&
		(element as { generation?: unknown }).generation !== null
	);
}

/** Read an element's takes defensively (the field is optional). */
function takesOf(element: SlotElement): Take[] {
	return Array.isArray(element.takes) ? element.takes : [];
}

/** Derive a compact slot status from its active/most-recent take. */
function slotStatus(element: SlotElement): SlotSnapshot["status"] {
	const takes = takesOf(element);
	if (takes.length === 0) return "empty";
	const active = element.activeTakeId
		? takes.find((take) => take.id === element.activeTakeId)
		: undefined;
	const reference = active ?? takes[takes.length - 1];
	return reference.status;
}

export function createDirectorApi(
	editor: EditorCore,
	options: CreateDirectorApiOptions = {},
) {
	const { executor } = options;

	// ---- internal helpers -------------------------------------------------

	/** All generative slots in timeline order (by start time). */
	function locateSlots(): LocatedSlot[] {
		const located: LocatedSlot[] = [];
		for (const track of editor.timeline.getTracks()) {
			for (const element of track.elements) {
				if (isSlotElement(element)) {
					located.push({ track, element });
				}
			}
		}
		located.sort((a, b) => a.element.startTime - b.element.startTime);
		return located;
	}

	function findSlot(slotId: string): LocatedSlot | null {
		return locateSlots().find((s) => s.element.id === slotId) ?? null;
	}

	function toSnapshot(element: SlotElement): SlotSnapshot {
		const takes = takesOf(element);
		return {
			id: element.id,
			prompt: element.generation.prompt,
			status: slotStatus(element),
			takeCount: takes.length,
			takes,
			activeTakeId: element.activeTakeId,
			start: element.startTime,
			duration: element.duration,
		};
	}

	// ---- DELTA (before/after diff for mutating verbs) ---------------------

	/** Per-slot fields we diff to build a {@link MutationDelta}. */
	interface SlotCapture {
		id: string;
		trackId: string;
		prompt: string;
		status: SlotSnapshot["status"];
		takeCount: number;
		start: number;
		duration: number;
		activeTakeId?: string;
	}

	/** A whole-reel snapshot plus every id in it (for the short-id map). */
	interface ReelCapture {
		slots: Map<string, SlotCapture>;
		/** All slot/take/track ids present — the short-id map's universe. */
		ids: string[];
	}

	/** Freeze the current reel into a diff-able capture. */
	function captureReel(): ReelCapture {
		const slots = new Map<string, SlotCapture>();
		const ids: string[] = [];
		for (const { track, element } of locateSlots()) {
			const takes = takesOf(element);
			slots.set(element.id, {
				id: element.id,
				trackId: track.id,
				prompt: element.generation.prompt,
				status: slotStatus(element),
				takeCount: takes.length,
				start: element.startTime,
				duration: element.duration,
				activeTakeId: element.activeTakeId,
			});
			ids.push(element.id, track.id);
			for (const take of takes) ids.push(take.id);
		}
		return { slots, ids };
	}

	/** Times are seconds (floats); compare with a small tolerance. */
	const EPSILON = 1e-4;
	const changed = (a: number, b: number) => Math.abs(a - b) > EPSILON;

	/**
	 * Diff two reel captures into a compact {@link MutationDelta}: added/removed
	 * slots, per-field changes, uniform start-time shifts (>= 3 clips on one
	 * track by the same amount) folded into rules, all spoken in SHORT ids and
	 * capped at 30 individual changes.
	 */
	function diffReel(before: ReelCapture, after: ReelCapture): MutationDelta {
		const idMap = createShortIdMap([...before.ids, ...after.ids]);
		const short = (id: string) => idMap.shorten(id);

		const added: SlotChange[] = [];
		const removed: string[] = [];
		// Raw start-time shifts, before uniform-run compression.
		const shifted: { trackId: string; from: number; by: number }[] = [];
		// Per-slot non-shift changes, keyed by full id so a shift can strip the
		// `start` field back out later.
		const changes = new Map<string, SlotChange>();

		for (const [id] of before.slots) {
			if (!after.slots.has(id)) removed.push(short(id));
		}
		for (const [id, a] of after.slots) {
			const b = before.slots.get(id);
			if (!b) {
				added.push({
					id: short(id),
					prompt: a.prompt || undefined,
					status: a.status,
					takes: a.takeCount || undefined,
					start: a.start,
					duration: a.duration,
				});
				continue;
			}
			const change: SlotChange = { id: short(id) };
			let touched = false;
			if (a.prompt !== b.prompt) {
				change.prompt = a.prompt;
				touched = true;
			}
			if (a.status !== b.status) {
				change.status = a.status;
				touched = true;
			}
			if (a.takeCount !== b.takeCount) {
				change.takes = a.takeCount;
				touched = true;
			}
			if (changed(a.duration, b.duration)) {
				change.duration = a.duration;
				touched = true;
			}
			if (a.activeTakeId && a.activeTakeId !== b.activeTakeId) {
				change.activeTake = short(a.activeTakeId);
				touched = true;
			}
			if (changed(a.start, b.start)) {
				change.start = a.start;
				shifted.push({
					trackId: a.trackId,
					from: b.start,
					by: a.start - b.start,
				});
				touched = true;
			}
			if (touched) changes.set(id, change);
		}

		// Compress uniform runs: group start-shifts by (track, rounded amount);
		// any group of >= 3 becomes one rule and its slots drop the `start` field.
		const shifts: UniformShift[] = [];
		const groups = new Map<
			string,
			{ trackId: string; by: number; froms: number[] }
		>();
		for (const s of shifted) {
			const key = `${s.trackId}|${s.by.toFixed(4)}`;
			const g = groups.get(key);
			if (g) g.froms.push(s.from);
			else groups.set(key, { trackId: s.trackId, by: s.by, froms: [s.from] });
		}
		for (const g of groups.values()) {
			if (g.froms.length < 3) continue;
			shifts.push({
				track: short(g.trackId),
				fromSeconds: Math.min(...g.froms),
				bySeconds: g.by,
				count: g.froms.length,
			});
			// These start moves are now described by the rule — strip them and
			// drop any change entry that held nothing else.
			for (const [id, c] of changes) {
				const a = after.slots.get(id);
				const b = before.slots.get(id);
				if (!a || !b) continue;
				if (a.trackId !== g.trackId) continue;
				if (Math.abs(a.start - b.start - g.by) > EPSILON) continue;
				delete c.start;
				if (Object.keys(c).length === 1) changes.delete(id); // only `id` left
			}
		}

		let changedList = [...changes.values()];
		let truncated: number | undefined;
		if (changedList.length > 30) {
			truncated = changedList.length - 30;
			changedList = changedList.slice(0, 30);
		}

		const delta: MutationDelta = {};
		if (added.length) delta.added = added;
		if (removed.length) delta.removed = removed;
		if (changedList.length) delta.changed = changedList;
		if (shifts.length) delta.shifts = shifts;
		if (truncated) delta.truncated = truncated;
		return delta;
	}

	/**
	 * Attach a before/after {@link MutationDelta} to a successful result. Failures
	 * pass through untouched (no mutation happened). Capture `before` at the top
	 * of a verb, then wrap each terminal `ok(...)` with this.
	 */
	function withDelta<T>(
		before: ReelCapture,
		result: DirectorResult<T>,
	): DirectorResult<T> {
		if (!result.ok) return result;
		result.delta = diffReel(before, captureReel());
		return result;
	}

	// ---- READ -------------------------------------------------------------

	function getReel(): ReelSnapshot {
		return {
			slots: locateSlots().map((s) => toSnapshot(s.element)),
			totalDuration: editor.timeline.getTotalDuration(),
			canUndo: editor.command.canUndo(),
			canRedo: editor.command.canRedo(),
			consistency: getStoredConsistencyContext(editor),
		};
	}

	/** Cap on personas/assets surfaced in {@link getProjectInfo} — keep the once-per-turn system prompt cheap. */
	const CONTEXT_LIST_CAP = 5;

	/**
	 * Compact project-level grounding: canvas/fps settings, the persona roster
	 * (reusable characters for consistency), and a media-library summary. Read-
	 * only — no `withDelta`, nothing mutates. Cheap enough to call every turn;
	 * also folded into the agent's system prompt (see `agent.ts`'s context block)
	 * so this exists both as prompt grounding AND as a re-queryable verb.
	 */
	function getProjectInfo(): DirectorResult<ProjectInfo> {
		const project = editor.project.getActiveOrNull();
		const settings = project?.settings;
		const orientation: ProjectInfo["orientation"] = settings
			? settings.canvasSize.width === settings.canvasSize.height
				? "square"
				: settings.canvasSize.width > settings.canvasSize.height
					? "landscape"
					: "portrait"
			: undefined;

		const personas = usePersonaStore.getState().personas;
		const assets = editor.media.getAssets();

		return ok("Project info.", {
			fps: settings?.fps,
			canvasWidth: settings?.canvasSize.width,
			canvasHeight: settings?.canvasSize.height,
			orientation,
			personas: personas
				.slice(0, CONTEXT_LIST_CAP)
				.map((p) => ({ name: p.name, descriptor: p.descriptor })),
			personaCount: personas.length,
			assetCount: assets.length,
			// Assets are stored in insertion order, so the tail is the most recent.
			recentAssets: assets
				.slice(-CONTEXT_LIST_CAP)
				.map((a) => ({ id: a.id, name: a.name })),
		});
	}

	// ---- CONSISTENCY --------------------------------------------------------

	/** Read the reel-level STYLE/CHARACTERS/SETTING context, if one is set. */
	function getConsistencyContext(): DirectorResult<
		ConsistencyContext | undefined
	> {
		return ok(
			"Current consistency context.",
			getStoredConsistencyContext(editor),
		);
	}

	/**
	 * Set (or update) the reel-level consistency context, applied to every
	 * shot's prompt at generation time (see `studio-executor.ts`). Personas are
	 * pulled from `usePersonaStore` by descriptor, not re-authored, unless the
	 * caller opts out with `includeAllPersonas: false`.
	 */
	function setConsistencyContext(input: {
		style?: string;
		setting?: string;
		extraCharacters?: ConsistencyCharacter[];
		includeAllPersonas?: boolean;
	}): DirectorResult<ConsistencyContext> {
		const before = captureReel();
		const personas =
			input.includeAllPersonas === false
				? []
				: usePersonaStore.getState().personas.map((p) => ({
						id: p.id,
						name: p.name,
						descriptor: p.descriptor,
					}));

		const context = buildConsistencyContext({
			style: input.style,
			setting: input.setting,
			personas,
			extraCharacters: input.extraCharacters,
		});
		storeConsistencyContext(editor, context);
		return withDelta(before, ok("Consistency context updated.", context));
	}

	function getSlot(slotId: string): DirectorResult<SlotSnapshot> {
		const located = findSlot(slotId);
		if (!located) return fail(`No slot with id "${slotId}".`);
		return ok("Slot found.", toSnapshot(located.element));
	}

	// ---- MEDIA SEARCH -------------------------------------------------------

	/**
	 * Cosine similarity for two L2-normalized vectors == dot product. Mirrors
	 * `use-visual-search.ts`'s `dotProduct` exactly; duplicated (not imported)
	 * because this module is React-free and that helper lives in a hook file —
	 * `searchMedia` below calls the same embedding store / `aiClient` directly
	 * instead of going through the hook.
	 */
	function dotProduct(a: Float32Array, b: Float32Array): number {
		let sum = 0;
		const n = Math.min(a.length, b.length);
		for (let i = 0; i < n; i++) sum += a[i] * b[i];
		return sum;
	}

	/**
	 * Semantic footage search over the on-device CLIP embedding index (see
	 * `use-visual-search.ts` for the UI equivalent of this ranking). Read-only —
	 * no `withDelta`, nothing mutates.
	 *
	 * Id decision: results are keyed by FULL `mediaId` (media-library asset ids),
	 * not reel slot ids, so they are never routed through the reel's short-id map
	 * (`agent.ts`'s `expandIdArgs` only shortens/expands slot/take ids). Nothing
	 * downstream consumes a `mediaId` as verb input yet, so full ids cost a few
	 * extra tokens but need no expansion seam.
	 */
	async function searchMedia(input: {
		query: string;
		limit?: number;
	}): Promise<DirectorResult<MediaSearchHit[]>> {
		const query = input.query.trim();
		if (!query) return fail("searchMedia requires a non-empty query.");

		const embeddings = await getAllEmbeddings();
		if (embeddings.length === 0) {
			return ok(
				"No media indexed yet — import footage and let it index before searching.",
				[],
			);
		}

		const queryVec = Float32Array.from(
			(await aiClient.embedText(query)).vector,
		);
		const assets = editor.media.getAssets();
		const byId = new Map(assets.map((a) => [a.id, a]));
		const limit = Math.max(1, input.limit ?? 5);

		const hits: MediaSearchHit[] = [];
		for (const media of embeddings) {
			let bestScore = -Infinity;
			let bestTs = 0;
			for (const frame of media.frames) {
				const score = dotProduct(queryVec, frame.vector);
				if (score > bestScore) {
					bestScore = score;
					bestTs = frame.timestampSec;
				}
			}
			if (!Number.isFinite(bestScore)) continue; // media had zero sampled frames
			hits.push({
				mediaId: media.mediaId,
				score: bestScore,
				timestampSec: bestTs,
				mediaName: byId.get(media.mediaId)?.name,
			});
		}

		hits.sort((a, b) => b.score - a.score);
		const top = hits.slice(0, limit);
		if (top.length === 0) return ok(`No footage matched "${query}".`, []);
		return ok(`Found ${top.length} match(es) for "${query}".`, top);
	}

	/**
	 * Place an EXISTING media-library asset (e.g. a `searchMedia` hit) onto the
	 * timeline as a plain clip — closes the search→place loop. This is NOT a
	 * generative slot: it carries no `generation` recipe, so it never appears in
	 * `getReel()`/`captureReel()` and won't show up in a mutation `delta` (same
	 * reasoning as `addText` below). `startTime`/`duration` are SECONDS.
	 *
	 * Mirrors the canonical media→timeline insertion in `addClipsToEditor`
	 * (`lib/studio/add-to-editor.ts`), which builds the element via
	 * `buildElementFromMedia` (`lib/timeline/element-utils.ts`) and inserts it
	 * with `editor.timeline.insertElement`.
	 */
	function addClip(input: {
		mediaId: string;
		startTime?: number;
		duration?: number;
		trackId?: string;
	}): DirectorResult<{ elementId: string }> {
		const asset = editor.media.getAssetById(input.mediaId);
		if (!asset) return fail(`No media asset with id "${input.mediaId}".`);

		if (asset.type === "audio") {
			return fail(
				`Asset "${input.mediaId}" ("${asset.name}") is audio — addClip only places video/image assets onto the timeline. Audio placement isn't wired yet.`,
			);
		}

		const duration =
			input.duration ??
			asset.duration ??
			TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
		if (duration <= 0) return fail("addClip requires a positive duration.");

		const startTime = input.startTime ?? editor.timeline.getTotalDuration();
		if (startTime < 0) return fail("addClip requires startTime >= 0.");

		const element = buildElementFromMedia({
			mediaId: input.mediaId,
			mediaType: asset.type,
			name: asset.name,
			duration,
			startTime,
		});

		const elementId = editor.timeline.insertElement({
			element,
			placement: input.trackId
				? { mode: "explicit", trackId: input.trackId }
				: { mode: "auto" },
		});

		return ok(
			`Placed "${asset.name}" on the timeline as element "${elementId}" ` +
				`(${duration.toFixed(1)}s starting at ${startTime.toFixed(1)}s). Not a reel slot — ` +
				`this id won't appear in REEL listings or mutation deltas; it's returned here so you can reference it.`,
			{ elementId },
		);
	}

	// ---- STORYBOARD -------------------------------------------------------

	/**
	 * Fold a transient `referenceMediaId` into a spec override by resolving it to
	 * the uploaded asset's URL as `referenceImageUrl` — the agent references
	 * stills (e.g. `@Image1`) by id, but generation needs a fetchable URL. An
	 * explicit `referenceImageUrl` already on the override always wins; an id
	 * that doesn't resolve (or an asset with no URL yet) is dropped, so the shot
	 * still generates, just without the reference frame.
	 */
	function applyReferenceMediaId(
		spec?: SpecOverride,
	): Partial<GenerationSpec> | undefined {
		if (!spec) return undefined;
		const { referenceMediaId, ...rest } = spec;
		if (!referenceMediaId || rest.referenceImageUrl) return rest;
		const asset = editor.media.getAssetById(referenceMediaId);
		return asset?.url ? { ...rest, referenceImageUrl: asset.url } : rest;
	}

	/**
	 * Create a single empty generative slot. Delegates to the canonical
	 * `addGenerativeSlot`. Returns the new slot id (== element id).
	 */
	function reserveSlot(input: {
		prompt?: string;
		duration?: number;
		startTime?: number;
		trackId?: string;
		spec?: SpecOverride;
	}): DirectorResult<{ slotId: string }> {
		const before = captureReel();
		const duration =
			input.duration ??
			input.spec?.duration ??
			TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;
		if (duration <= 0) return fail("Slot duration must be greater than 0.");

		const prompt = input.prompt ?? input.spec?.prompt ?? "";
		const spec = buildSpec(prompt, duration, applyReferenceMediaId(input.spec));

		const slotId = editor.timeline.addGenerativeSlot({
			spec,
			duration,
			startTime: input.startTime,
			trackId: input.trackId,
		});
		return withDelta(before, ok(`Reserved slot "${slotId}".`, { slotId }));
	}

	/**
	 * Create a sequence of empty slots from a shot list. Slots are appended in
	 * order, back-to-back, after existing content. Grouped into one undoable
	 * history entry. Returns the new slot ids.
	 */
	function storyboard(input: {
		shots: {
			prompt: string;
			duration: number;
			spec?: SpecOverride;
		}[];
	}): DirectorResult<string[]> {
		if (!input.shots || input.shots.length === 0) {
			return fail("storyboard requires at least one shot.");
		}

		const before = captureReel();
		const ids: string[] = [];
		let cursor = editor.timeline.getTotalDuration();

		editor.command.beginTransaction();
		try {
			for (const shot of input.shots) {
				if (shot.duration <= 0) {
					editor.command.rollbackTransaction();
					return fail(
						`Shot "${shot.prompt}" has a non-positive duration (${shot.duration}).`,
					);
				}
				const spec = buildSpec(
					shot.prompt,
					shot.duration,
					applyReferenceMediaId(shot.spec),
				);
				const slotId = editor.timeline.addGenerativeSlot({
					spec,
					duration: shot.duration,
					startTime: cursor,
				});
				cursor += shot.duration;
				ids.push(slotId);
			}
		} catch (error) {
			editor.command.rollbackTransaction();
			return fail(
				`storyboard failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		editor.command.commitTransaction();
		return withDelta(before, ok(`Created ${ids.length} slot(s).`, ids));
	}

	/** Update the prompt (and optionally other spec fields) of a slot. */
	function setPrompt(input: {
		slotId: string;
		prompt: string;
		spec?: SpecOverride;
	}): DirectorResult<SlotSnapshot> {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);

		const nextSpec: GenerationSpec = {
			...located.element.generation,
			...applyReferenceMediaId(input.spec),
			prompt: input.prompt,
		};
		editor.timeline.setSlotSpec({ elementId: input.slotId, spec: nextSpec });

		const updated = findSlot(input.slotId);
		return withDelta(
			before,
			ok(
				`Prompt updated for slot "${input.slotId}".`,
				updated ? toSnapshot(updated.element) : undefined,
			),
		);
	}

	// ---- GENERATE ---------------------------------------------------------

	/**
	 * Append `count` queued takes to a slot and run them through the executor.
	 * Bookkeeping (appending takes via `addTakeToElement`, patching status via
	 * `updateTake`, selecting the first ready take via `selectTake`) is done
	 * here; the network/provider work is delegated to `executor`.
	 */
	async function runTakesForSlot(
		slotId: string,
		count: number,
	): Promise<DirectorResult<{ slotId: string; takeIds: string[] }>> {
		const located = findSlot(slotId);
		if (!located) return fail(`No slot with id "${slotId}".`);

		const baseSpec = located.element.generation;
		if (!baseSpec.prompt) {
			return fail(`Slot "${slotId}" has no prompt; set one before generating.`);
		}

		const newTakes: Take[] = Array.from({ length: count }, () => ({
			id: generateUUID(),
			status: "queued" as const,
			spec: { ...baseSpec },
			seed: baseSpec.seed,
			createdAt: Date.now(),
		}));

		// Record queued takes immediately so the UI/agent can observe them.
		for (const take of newTakes) {
			editor.timeline.addTakeToElement({ elementId: slotId, take });
		}

		const takeIds = newTakes.map((t) => t.id);

		// TODO(generation-pipeline): the real provider/network call lives behind
		// this injectable boundary. Wire a concrete `GenerateExecutor` (e.g. the
		// studio generate route / provider adapter) when constructing the API.
		if (!executor) {
			return ok(
				`Queued ${count} take(s) for slot "${slotId}" (no generation executor configured — takes remain queued).`,
				{ slotId, takeIds },
			);
		}

		for (const take of newTakes) {
			editor.timeline.updateTake({
				elementId: slotId,
				takeId: take.id,
				patch: { status: "generating" },
			});

			let result: Pick<
				Take,
				"status" | "mediaId" | "thumbnailUrl" | "seed" | "jobId" | "error"
			>;
			try {
				result = await executor.run({
					slotId,
					takeId: take.id,
					spec: take.spec,
				});
			} catch (error) {
				result = {
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			editor.timeline.updateTake({
				elementId: slotId,
				takeId: take.id,
				patch: result,
			});
		}

		// Select the first ready take if none chosen yet.
		const after = findSlot(slotId);
		if (after && !after.element.activeTakeId) {
			const firstReady = takesOf(after.element).find(
				(t) => t.status === "ready",
			);
			if (firstReady) {
				editor.timeline.selectTake({
					elementId: slotId,
					takeId: firstReady.id,
				});
			}
		}

		return ok(`Generated ${count} take(s) for slot "${slotId}".`, {
			slotId,
			takeIds,
		});
	}

	/** Resolve a `generate`-style target selector into the located slots it hits. */
	function resolveTargets(slotIds?: string[] | "all"): LocatedSlot[] {
		const all = locateSlots();
		if (!slotIds || slotIds === "all") return all;
		const wanted = new Set(slotIds);
		return all.filter((s) => wanted.has(s.element.id));
	}

	/**
	 * Estimate the cost of a `generate` call WITHOUT running it — the read-only
	 * half of the cost-preview approval gate (concept: cost-preview gate). Same
	 * target/alternatives resolution as `generate`, so a caller can preview the
	 * exact spend of the action it's about to take. Read-only (no `withDelta`).
	 */
	function estimateGenerateCost(input: {
		slotIds?: string[] | "all";
		alternatives?: number;
	}): DirectorResult<CostRange & { clips: number }> {
		const count = Math.max(1, input.alternatives ?? 1);
		const targets = resolveTargets(input.slotIds).filter((s) =>
			s.element.generation.prompt?.trim(),
		);
		const estimate = estimateBatchCost(
			targets.map((s) => s.element.generation),
			count,
		);
		return ok(
			`~${formatCostRange(estimate)} for ${estimate.clips} clip(s).`,
			estimate,
		);
	}

	/**
	 * Generate takes for one or more slots. `slotIds: "all"` targets every slot.
	 * `alternatives` is how many takes to produce per slot (default 1).
	 */
	async function generate(input: {
		slotIds?: string[] | "all";
		alternatives?: number;
	}): Promise<DirectorResult<{ slotIds: string[] }>> {
		const before = captureReel();
		const count = Math.max(1, input.alternatives ?? 1);
		const targets =
			!input.slotIds || input.slotIds === "all"
				? locateSlots().map((s) => s.element.id)
				: input.slotIds;

		if (targets.length === 0) {
			return fail("No slots to generate (storyboard some shots first).");
		}

		const done: string[] = [];
		const errors: string[] = [];
		for (const slotId of targets) {
			const result = await runTakesForSlot(slotId, count);
			if (result.ok) done.push(slotId);
			else errors.push(`${slotId}: ${result.message}`);
		}

		if (done.length === 0) {
			return fail(`Generation failed for all slots. ${errors.join("; ")}`);
		}
		return withDelta(
			before,
			ok(
				`Generated ${count} take(s) for ${done.length} slot(s)` +
					(errors.length
						? ` (${errors.length} failed: ${errors.join("; ")}).`
						: "."),
				{ slotIds: done },
			),
		);
	}

	/** Regenerate: append fresh alternative take(s) to a single slot. */
	async function reroll(input: {
		slotId: string;
		alternatives?: number;
	}): Promise<DirectorResult<{ slotId: string; takeIds: string[] }>> {
		const before = captureReel();
		const count = Math.max(1, input.alternatives ?? 1);
		return withDelta(before, await runTakesForSlot(input.slotId, count));
	}

	/**
	 * Remix: append one take that's the slot's current take, edited by a short
	 * delta prompt (see `buildRemixSpec` for how the delta is composed and the
	 * seed locked). Anchors on the active take, falling back to the most recent.
	 */
	async function remix(input: {
		slotId: string;
		remixPrompt: string;
	}): Promise<DirectorResult<{ slotId: string; takeId: string }>> {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);
		if (!input.remixPrompt.trim())
			return fail("remix requires a non-empty remixPrompt.");

		const takes = takesOf(located.element);
		const source = located.element.activeTakeId
			? takes.find((t) => t.id === located.element.activeTakeId)
			: takes[takes.length - 1];
		if (!source) {
			return fail(
				`Slot "${input.slotId}" has no take to remix yet — generate one first.`,
			);
		}

		// Anchor the remix on the source take's REAL last frame when it's a
		// finished, imported take — true img2img re-conditioning. Falls back
		// (inside buildRemixSpec) to the prior spec's referenceImageUrl when the
		// take isn't imported yet or the frame can't be decoded.
		const anchorImageUrl = source.mediaId
			? await extractTakeLastFrame(
					editor.media.getAssetById(source.mediaId),
					source.id,
				)
			: undefined;

		const spec = buildRemixSpec({
			priorTake: source,
			remixPrompt: input.remixPrompt,
			anchorImageUrl,
		});
		const newTake: Take = {
			id: generateUUID(),
			status: "queued",
			spec,
			seed: spec.seed,
			createdAt: Date.now(),
		};
		editor.timeline.addTakeToElement({
			elementId: input.slotId,
			take: newTake,
		});

		if (!executor) {
			return withDelta(
				before,
				ok(
					`Queued remix take for slot "${input.slotId}" (no generation executor configured — take remains queued).`,
					{ slotId: input.slotId, takeId: newTake.id },
				),
			);
		}

		editor.timeline.updateTake({
			elementId: input.slotId,
			takeId: newTake.id,
			patch: { status: "generating" },
		});

		let result: Pick<
			Take,
			"status" | "mediaId" | "thumbnailUrl" | "seed" | "jobId" | "error"
		>;
		try {
			result = await executor.run({
				slotId: input.slotId,
				takeId: newTake.id,
				spec,
			});
		} catch (error) {
			result = {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		editor.timeline.updateTake({
			elementId: input.slotId,
			takeId: newTake.id,
			patch: result,
		});

		if (result.status === "ready" && !located.element.activeTakeId) {
			editor.timeline.selectTake({
				elementId: input.slotId,
				takeId: newTake.id,
			});
		}

		return withDelta(
			before,
			ok(`Remixed slot "${input.slotId}".`, {
				slotId: input.slotId,
				takeId: newTake.id,
			}),
		);
	}

	/** Pick the active take for a slot, by take id or by index. */
	function chooseTake(
		input:
			| { slotId: string; takeId: string }
			| { slotId: string; index: number },
	): DirectorResult<SlotSnapshot> {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);

		const takes = takesOf(located.element);
		let takeId: string | undefined;
		if ("takeId" in input) {
			takeId = takes.find((t) => t.id === input.takeId)?.id;
			if (!takeId) {
				return fail(`Slot "${input.slotId}" has no take "${input.takeId}".`);
			}
		} else {
			const take = takes[input.index];
			if (!take) {
				return fail(
					`Slot "${input.slotId}" has no take at index ${input.index} (has ${takes.length}).`,
				);
			}
			takeId = take.id;
		}

		editor.timeline.selectTake({ elementId: input.slotId, takeId });
		const updated = findSlot(input.slotId);
		return withDelta(
			before,
			ok(
				`Selected take "${takeId}" for slot "${input.slotId}".`,
				updated ? toSnapshot(updated.element) : undefined,
			),
		);
	}

	// ---- REVIEW (vision self-review) --------------------------------------
	//
	// Closes the "generate but can't SEE" gap: no other verb feeds a generated
	// result back to the model, so it can't tell a good take from a broken one.
	// `reviewTake` decodes a take's frames (first/mid/last) to `data:` image URLs
	// — the agent layer turns those into image content blocks that ride back to
	// the model through the stateless relay untouched. Read-only (no `withDelta`):
	// nothing on the reel changes; the observation IS the pixels.

	/**
	 * Pick the take to review: an explicit `takeId`, else the active take, else the
	 * most recent READY take, else the most recent take (so a caller always gets a
	 * defined target to explain, even if it isn't ready).
	 */
	function pickReviewTake(
		element: SlotElement,
		takeId?: string,
	): Take | undefined {
		const takes = takesOf(element);
		if (takeId) return takes.find((t) => t.id === takeId);
		if (element.activeTakeId) {
			const active = takes.find((t) => t.id === element.activeTakeId);
			if (active) return active;
		}
		for (let i = takes.length - 1; i >= 0; i--) {
			if (takes[i].status === "ready") return takes[i];
		}
		return takes[takes.length - 1];
	}

	/**
	 * Decode a slot take's frames so the model can SEE the generated clip and judge
	 * it against the slot's prompt. Defaults to a 3-frame first/mid/last triptych
	 * (override with `frames`, clamped 1–3). Fails (never throws) with actionable
	 * copy when there's nothing decodable yet — no takes, the target isn't `ready`,
	 * the take hasn't been imported (`mediaId`), or no frame could be decoded.
	 */
	async function reviewTake(input: {
		slotId: string;
		takeId?: string;
		frames?: number;
	}): Promise<DirectorResult<ReviewTakeData>> {
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);

		const take = pickReviewTake(located.element, input.takeId);
		if (!take) {
			return fail(
				input.takeId
					? `Slot "${input.slotId}" has no take "${input.takeId}".`
					: `Slot "${input.slotId}" has no takes yet — generate one before reviewing.`,
			);
		}
		if (take.status !== "ready") {
			return fail(
				`Take "${take.id}" is ${take.status}, not ready to review yet — wait for it to finish generating.`,
			);
		}
		if (!take.mediaId) {
			return fail(
				`Take "${take.id}" has no imported media to review yet — its frames aren't available.`,
			);
		}

		const count = Math.max(1, Math.min(3, input.frames ?? 3));
		const frames = await extractTakeFrames(
			editor.media.getAssetById(take.mediaId),
			{ count, name: take.id },
		);
		if (frames.length === 0) {
			return fail(
				`Couldn't decode any frames from take "${take.id}" to review.`,
			);
		}

		const prompt = located.element.generation.prompt;
		return ok(
			`Reviewing take "${take.id}" of slot "${input.slotId}" against its prompt (${JSON.stringify(
				prompt,
			)}). ${frames.length} frame(s) attached (first → last) — judge whether the clip realizes that prompt.`,
			{
				slotId: located.element.id,
				takeId: take.id,
				prompt,
				status: take.status,
				frameCount: frames.length,
				frames,
			},
		);
	}

	// ---- EDIT (delegate to timeline-manager) ------------------------------
	//
	// UNIT CONVENTION: every numeric time/duration field on this API surface is
	// in SECONDS (matching the canonical timeline + `GenerationSpec.duration`).
	// The agent-facing layer (agent.ts) states this explicitly; no field here is
	// ever in frames. The only seconds→frames conversion site lives in
	// `studio-executor.ts` (see the helper there).

	/** All of `trimStart`/`trimEnd`/`startTime`/`duration` are in SECONDS. */
	function trim(input: {
		slotId: string;
		trimStart?: number;
		trimEnd?: number;
		startTime?: number;
		duration?: number;
	}): DirectorResult {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);
		const el = located.element;
		editor.timeline.updateElementTrim({
			elementId: el.id,
			trimStart: input.trimStart ?? el.trimStart,
			trimEnd: input.trimEnd ?? el.trimEnd,
			startTime: input.startTime,
			duration: input.duration,
		});
		return withDelta(before, ok(`Trimmed slot "${input.slotId}".`));
	}

	/** `newStartTime` is in SECONDS. */
	function move(input: {
		slotId: string;
		newStartTime: number;
		targetTrackId?: string;
	}): DirectorResult {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);
		editor.timeline.moveElement({
			sourceTrackId: located.track.id,
			targetTrackId: input.targetTrackId ?? located.track.id,
			elementId: located.element.id,
			newStartTime: input.newStartTime,
		});
		return withDelta(
			before,
			ok(`Moved slot "${input.slotId}" to ${input.newStartTime}s.`),
		);
	}

	/** `atTime` is in SECONDS. */
	function split(input: {
		slotId: string;
		atTime: number;
	}): DirectorResult<{ newSlotIds: string[] }> {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);
		const right = editor.timeline.splitElements({
			elements: [{ trackId: located.track.id, elementId: located.element.id }],
			splitTime: input.atTime,
		});
		return withDelta(
			before,
			ok(`Split slot "${input.slotId}" at ${input.atTime}s.`, {
				newSlotIds: right.map((r) => r.elementId),
			}),
		);
	}

	/**
	 * Reorder slots to match the given id order. Slots are repacked back-to-back
	 * in the requested order on their current track, starting at the earliest
	 * current start time. Ids not provided keep their relative order at the end.
	 * Grouped into one undoable history entry.
	 */
	function reorder(input: { slotIds: string[] }): DirectorResult {
		const before = captureReel();
		const slots = locateSlots();
		if (slots.length === 0) return fail("No slots to reorder.");

		const byId = new Map(slots.map((s) => [s.element.id, s]));
		const ordered: LocatedSlot[] = [];
		for (const id of input.slotIds) {
			const found = byId.get(id);
			if (found) {
				ordered.push(found);
				byId.delete(id);
			}
		}
		// Append any unmentioned slots in their existing order.
		for (const remaining of slots) {
			if (byId.has(remaining.element.id)) ordered.push(remaining);
		}

		const startBase = Math.min(...slots.map((s) => s.element.startTime));
		let cursor = startBase;
		const updates = ordered.map((s) => {
			const startTime = cursor;
			cursor += s.element.duration;
			return {
				elements: [{ trackId: s.track.id, elementId: s.element.id }],
				startTime,
			};
		});

		editor.command.beginTransaction();
		for (const u of updates) {
			editor.timeline.updateElementStartTime(u);
		}
		editor.command.commitTransaction();
		return withDelta(before, ok(`Reordered ${ordered.length} slot(s).`));
	}

	function remove(input: { slotId: string }): DirectorResult {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);
		editor.timeline.deleteElements({
			elements: [{ trackId: located.track.id, elementId: located.element.id }],
		});
		return withDelta(before, ok(`Removed slot "${input.slotId}".`));
	}

	// ---- TRANSITIONS & EFFECTS ---------------------------------------------
	//
	// The uncopyable wedge: competitor AI reel tools can generate clips but
	// can't polish them. `duration` (applyTransition) is SECONDS, matching the
	// rest of this API's unit convention. Neither `transitionOut` nor an
	// element's effect list is part of `SlotCapture`'s tracked fields, so
	// `withDelta` may report an EMPTY delta here even on success — that's
	// expected; the result `message` (and `effectId` for applyEffect) carries
	// the outcome.

	/**
	 * Apply a transition to a slot's outgoing edge. Delegates to
	 * `AddTransitionCommand` (mirrors the Transitions panel UI). `duration` is
	 * SECONDS; omit it to use the transition's own default duration.
	 */
	function applyTransition(input: {
		slotId: string;
		transitionType: string;
		duration?: number;
	}): DirectorResult {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);

		const validTypes = getAllTransitions().map((t) => t.type);
		if (!validTypes.includes(input.transitionType)) {
			return fail(
				`Unknown transition type "${input.transitionType}". Valid types: ${validTypes.join(", ")}.`,
			);
		}

		editor.command.execute({
			command: new AddTransitionCommand({
				trackId: located.track.id,
				elementId: located.element.id,
				transitionType: input.transitionType,
				duration: input.duration,
			}),
		});

		return withDelta(
			before,
			ok(
				`Applied "${input.transitionType}" transition to slot "${input.slotId}".`,
			),
		);
	}

	/**
	 * Apply a visual effect to a slot. Delegates to
	 * `editor.timeline.addClipEffect`, then optionally overrides params via
	 * `updateClipEffectParams`. Generative slots are always video/image
	 * elements, which are within `EFFECT_TARGET_ELEMENT_TYPES` — no extra
	 * target-type check needed here.
	 */
	function applyEffect(input: {
		slotId: string;
		effectType: string;
		params?: Partial<EffectParamValues>;
	}): DirectorResult<{ effectId: string }> {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);

		const validTypes = getAllEffects().map((e) => e.type);
		if (!validTypes.includes(input.effectType)) {
			return fail(
				`Unknown effect type "${input.effectType}". Valid types: ${validTypes.join(", ")}.`,
			);
		}

		const effectId = editor.timeline.addClipEffect({
			trackId: located.track.id,
			elementId: located.element.id,
			effectType: input.effectType,
		});

		if (input.params && Object.keys(input.params).length > 0) {
			editor.timeline.updateClipEffectParams({
				trackId: located.track.id,
				elementId: located.element.id,
				effectId,
				params: input.params,
			});
		}

		return withDelta(
			before,
			ok(`Applied "${input.effectType}" effect to slot "${input.slotId}".`, {
				effectId,
			}),
		);
	}

	// ---- TEXT ---------------------------------------------------------------
	//
	// Text overlays are plain (non-generative) timeline elements — they never
	// carry a `generation` recipe, so `isSlotElement`/`locateSlots`/`captureReel`
	// never see them and they never appear in `getReel()` or a `MutationDelta`.
	// Their ids are therefore NOT reel slot ids: `addText`/`updateText` return and
	// accept FULL element ids, and `agent.ts`'s short-id expansion leaves
	// `elementId` untouched for this reason.

	/** Locate ANY timeline element (not just generative slots) by id, with its track. */
	function findElement(
		elementId: string,
	): { track: TimelineTrack; element: TimelineElement } | null {
		for (const track of editor.timeline.getTracks()) {
			const element = track.elements.find((e) => e.id === elementId);
			if (element) return { track, element };
		}
		return null;
	}

	/**
	 * Add a text overlay. `startTime`/`duration` are SECONDS; unset optional
	 * style fields fall back to `DEFAULT_TEXT_ELEMENT`. Auto-places onto (or
	 * creates) a text track unless `trackId` is given.
	 *
	 * Not wrapped in `withDelta`: text elements aren't generative slots, so
	 * `captureReel()` can't see this insert either way — the returned FULL
	 * `elementId` (not a short id) is the whole observation here.
	 */
	function addText(input: {
		content: string;
		startTime: number;
		duration?: number;
		trackId?: string;
		fontSize?: number;
		fontFamily?: string;
		color?: string;
		textAlign?: TextElement["textAlign"];
	}): DirectorResult<{ elementId: string }> {
		if (!input.content.trim())
			return fail("addText requires non-empty content.");
		if (input.startTime < 0) return fail("addText requires startTime >= 0.");

		const element = {
			...DEFAULT_TEXT_ELEMENT,
			content: input.content,
			startTime: input.startTime,
			duration: input.duration ?? DEFAULT_TEXT_ELEMENT.duration,
			...(input.fontSize != null ? { fontSize: input.fontSize } : {}),
			...(input.fontFamily != null ? { fontFamily: input.fontFamily } : {}),
			...(input.color != null ? { color: input.color } : {}),
			...(input.textAlign != null ? { textAlign: input.textAlign } : {}),
		};

		const elementId = editor.timeline.insertElement({
			element,
			placement: input.trackId
				? { mode: "explicit", trackId: input.trackId }
				: { mode: "auto", trackType: "text" },
		});

		return ok(
			`Added text element "${elementId}" ("${input.content}"). Not a reel slot — ` +
				`pass this full id back to updateText, not the reel's short ids.`,
			{ elementId },
		);
	}

	/**
	 * Update an existing text element's content/timing/style. `elementId` must be
	 * the FULL id returned by `addText` (never a reel short id — text elements
	 * aren't in the short-id map). Not wrapped in `withDelta` for the same reason
	 * as `addText`: text elements are invisible to `captureReel()`.
	 */
	function updateText(input: {
		elementId: string;
		content?: string;
		startTime?: number;
		duration?: number;
		fontSize?: number;
		fontFamily?: string;
		color?: string;
		textAlign?: TextElement["textAlign"];
	}): DirectorResult {
		const located = findElement(input.elementId);
		if (!located) return fail(`No element with id "${input.elementId}".`);
		if (located.element.type !== "text") {
			return fail(
				`Element "${input.elementId}" is a "${located.element.type}", not a text element.`,
			);
		}

		const updates: Partial<TextElement> = {};
		if (input.content != null) updates.content = input.content;
		if (input.startTime != null) updates.startTime = input.startTime;
		if (input.duration != null) updates.duration = input.duration;
		if (input.fontSize != null) updates.fontSize = input.fontSize;
		if (input.fontFamily != null) updates.fontFamily = input.fontFamily;
		if (input.color != null) updates.color = input.color;
		if (input.textAlign != null) updates.textAlign = input.textAlign;

		if (Object.keys(updates).length === 0) {
			return fail("updateText requires at least one field to change.");
		}

		editor.timeline.updateElements({
			updates: [
				{ trackId: located.track.id, elementId: input.elementId, updates },
			],
		});
		return ok(`Updated text element "${input.elementId}".`);
	}

	// ---- LIFECYCLE --------------------------------------------------------

	function undo(): DirectorResult {
		const before = captureReel();
		if (!editor.command.canUndo()) return fail("Nothing to undo.");
		editor.command.undo();
		return withDelta(before, ok("Undid last action."));
	}

	function redo(): DirectorResult {
		const before = captureReel();
		if (!editor.command.canRedo()) return fail("Nothing to redo.");
		editor.command.redo();
		return withDelta(before, ok("Redid last action."));
	}

	/**
	 * Render the reel to a video file. Delegates to the SAME path the Export
	 * button drives — `editor.project.export` → `RendererManager.exportProject`
	 * (canvas/WebCodecs render + optional audio mux) — so there is one render
	 * pipeline, not a duplicate. Read-only w.r.t. the reel (no `withDelta`): the
	 * timeline isn't mutated; the observable output is the produced file.
	 *
	 * BROWSER-BOUND: the underlying pipeline uses canvas/WebCodecs/AudioContext
	 * and (when `download` is on) `document`, so this verb only runs where the
	 * Director API is driven in a browser — which is exactly where the in-app
	 * agent and the MCP editor-bridge live. In a headless/Node unit test pass
	 * `download: false` and stub `editor.project.export`. This is NOT a fake: it
	 * calls the real export path, which simply requires a browser to execute.
	 */
	async function exportReel(input?: {
		format?: ExportFormat;
		quality?: ExportQuality;
		includeAudio?: boolean;
		includeWatermark?: boolean;
		/** Trigger a browser file download of the rendered buffer (default true). */
		download?: boolean;
	}): Promise<
		DirectorResult<{
			format: ExportFormat;
			bytes: number;
			durationSeconds: number;
			downloaded: boolean;
		}>
	> {
		const project = editor.project.getActiveOrNull();
		if (!project) return fail("No active project to export.");

		const durationSeconds = editor.timeline.getTotalDuration();
		if (durationSeconds === 0) {
			return fail(
				"Nothing to export — the timeline is empty. Storyboard and generate some shots first.",
			);
		}

		const options: ExportOptions = {
			format: input?.format ?? DEFAULT_EXPORT_OPTIONS.format,
			quality: input?.quality ?? DEFAULT_EXPORT_OPTIONS.quality,
			fps: project.settings.fps,
			includeAudio: input?.includeAudio ?? DEFAULT_EXPORT_OPTIONS.includeAudio,
			includeWatermark: input?.includeWatermark ?? true,
		};

		const result = await editor.project.export({ options });

		if (result.cancelled) return fail("Export was cancelled.");
		if (!result.success || !result.buffer) {
			return fail(`Export failed: ${result.error ?? "unknown error"}.`);
		}

		const shouldDownload = input?.download ?? true;
		let downloaded = false;
		if (shouldDownload) {
			downloadBuffer({
				buffer: result.buffer,
				filename: `${project.metadata.name}${getExportFileExtension({ format: options.format })}`,
				mimeType: getExportMimeType({ format: options.format }),
			});
			downloaded = true;
		}

		const megabytes = result.buffer.byteLength / (1024 * 1024);
		return ok(
			`Exported "${project.metadata.name}" — ${options.format.toUpperCase()}, ` +
				`${megabytes.toFixed(1)} MB, ${durationSeconds.toFixed(1)}s` +
				(downloaded ? " (downloaded)." : "."),
			{
				format: options.format,
				bytes: result.buffer.byteLength,
				durationSeconds,
				downloaded,
			},
		);
	}

	return {
		// read
		getReel,
		getSlot,
		getProjectInfo,
		// media search / placement
		searchMedia,
		addClip,
		// storyboard
		storyboard,
		reserveSlot,
		setPrompt,
		// generate
		estimateGenerateCost,
		generate,
		reroll,
		remix,
		chooseTake,
		reviewTake,
		// consistency
		getConsistencyContext,
		setConsistencyContext,
		// edit
		trim,
		move,
		split,
		reorder,
		remove,
		// transitions & effects
		applyTransition,
		applyEffect,
		// text
		addText,
		updateText,
		// lifecycle
		undo,
		redo,
		export: exportReel,
	};
}

export type DirectorApi = ReturnType<typeof createDirectorApi>;
