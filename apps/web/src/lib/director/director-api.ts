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
import {
	bibleToConsistencyInput,
	buildStoryboardPlan,
	getStoredPlan,
	storePlan,
	type PlannedShotInput,
	type StoryboardPlan,
	type StyleBible,
} from "./storyboard-plan";
import {
	applyBriefPatch,
	summarizeBrief,
	type BriefPatch,
} from "./director-brief";
import type { DirectorBrief } from "@/types/project";
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
import {
	buildElementFromMedia,
	buildUploadAudioElement,
} from "@/lib/timeline/element-utils";
import {
	importAudioAsset,
	makeVoiceoverSpec,
} from "@/lib/studio/generate-voiceover-take";
import { getFreesoundHeaders } from "@/lib/api-keys";
import { classifyFailure } from "./failure-classification";
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
	BackendCatalogEntry,
	BackendCatalogProvider,
	DirectorResult,
	GenerationFailure,
	MediaSearchHit,
	MutationDelta,
	ProjectInfo,
	ReelSnapshot,
	ReviewTakeData,
	SlotChange,
	SlotGenerationOutcome,
	SlotSnapshot,
	GenerateExecutor,
	TakeCritic,
	UniformShift,
} from "./types";

export type {
	BackendCatalogEntry,
	BackendCatalogProvider,
	DirectorResult,
	GenerateExecutor,
	GenerationFailure,
	GenerationSpec,
	GenerativeFields,
	MediaSearchHit,
	ProjectInfo,
	ReelSnapshot,
	SlotGenerationOutcome,
	SlotSnapshot,
	Take,
	TakeCritic,
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

/**
 * A resolved music asset for {@link DirectorApi.addMusicBed}: the imported audio
 * plus provenance for the result message. Returned by the injectable music
 * resolver; `{ error }` reports a resolution failure the verb surfaces as a
 * failed result.
 */
export type ResolvedMusic =
	| {
			mediaId: string;
			name: string;
			duration?: number;
			license?: string;
			sourceUrl?: string;
	  }
	| { error: string };

/**
 * Self-correction knobs for the generation recovery loop. All optional with
 * production-sane defaults; tests inject a no-op `sleep` (so backoff is
 * instant), a deterministic `rephrase`, and tight bounds. See
 * `runTakeWithRecovery`.
 */
export interface RecoveryOptions {
	/** Max retries for a retryable transient/timeout/empty failure (default 2). */
	maxRetries?: number;
	/** Max auto-rephrase attempts for a safety rejection (default 1). */
	maxRephrases?: number;
	/** Base backoff delay in ms; grows exponentially per retry (default 400). */
	baseDelayMs?: number;
	/** Sleep primitive (injectable so tests don't actually wait). */
	sleep?: (ms: number) => Promise<void>;
	/** Rephrase a prompt the safety filter rejected (injectable; deterministic default). */
	rephrase?: (prompt: string, failure: GenerationFailure) => string;
}

export interface CreateDirectorApiOptions {
	/**
	 * Injectable boundary for real provider/network generation. If omitted,
	 * generate/reroll enqueue `queued` takes and report that no executor is
	 * configured. See `// TODO(generation-pipeline)`.
	 */
	executor?: GenerateExecutor;
	/**
	 * Read-through to the client-safe backend catalog (see
	 * {@link BackendCatalogProvider}). Powers the `getBackends` verb so the agent
	 * can route intent-appropriately. Omitted ⇒ `getBackends` reports an empty
	 * catalog and generation uses default auto-routing.
	 */
	backends?: BackendCatalogProvider;
	/**
	 * Optional vision critic used by `compareTake` to auto-pick the better of two
	 * A/B takes (D1). Omitted ⇒ `compareTake` presents both takes for the user to
	 * choose (graceful no-op until D1 is merged).
	 */
	critic?: TakeCritic;
	/** Self-correcting-generation knobs (retry/backoff/rephrase). */
	recovery?: RecoveryOptions;
	/**
	 * Audio orchestration seam. `resolveMusic` turns a search query into an
	 * imported audio asset for `addMusicBed`; the default hits `/api/sounds/search`
	 * (Freesound) + `importAudioAsset` and is therefore BROWSER-BOUND, so headless
	 * tests inject a stub — the same pattern as `executor`/`exportReel`.
	 */
	audio?: {
		resolveMusic?: (input: {
			query: string;
			commercialOnly: boolean;
		}) => Promise<ResolvedMusic>;
	};
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

// ── self-correcting-generation defaults ─────────────────────────────────────

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_REPHRASES = 1;
const DEFAULT_BASE_DELAY_MS = 400;

const realSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff for the Nth (1-based) retry. */
const backoffMs = (base: number, retry: number): number =>
	base * 2 ** (retry - 1);

const SAFE_PREFIX = "Tasteful, safe-for-work, non-graphic.";
// Terms that commonly trip a moderation filter yet are usually incidental to
// the shot; stripped on the automatic rephrase so a false-positive can clear.
const FLAGGED_TERMS_RE =
	/\b(nude|nudity|naked|nsfw|explicit|sexual|erotic|gore|gory|blood(?:y)?|graphic|violent|violence|weapon|gun|knife|kill(?:ing)?|drugs?)\b/gi;

/**
 * Deterministic, dependency-free safety rephrase: strip commonly-flagged terms
 * and prepend a safe-for-work framing (once). Not a content model — it's a
 * conservative, reproducible transform so the recovery loop is unit-testable and
 * the executor still receives a real, cleaned prompt. Callers can inject a
 * smarter (e.g. LLM-backed) rephrase via {@link RecoveryOptions.rephrase}.
 */
export function defaultSafetyRephrase(prompt: string): string {
	const stripped = prompt
		.replace(FLAGGED_TERMS_RE, "")
		.replace(/\s{2,}/g, " ")
		.trim();
	if (stripped.toLowerCase().startsWith(SAFE_PREFIX.toLowerCase()))
		return stripped;
	return `${SAFE_PREFIX} ${stripped}`.trim();
}

/**
 * Rough spoken-duration estimate for a script, used to size a voiceover slot
 * when no explicit duration (or narrated shot) is given. ~150 words/min ≈ 2.5
 * words/sec; floored at 1s so a short line still occupies real time.
 */
export function estimateSpeechSeconds(script: string): number {
	const words = script.trim().split(/\s+/).filter(Boolean).length;
	return Math.max(1, Math.round((words / 2.5) * 10) / 10);
}

/** Short, user-facing label per failure class (for result messages). */
const FAILURE_LABEL: Record<GenerationFailure["class"], string> = {
	provider: "provider error",
	timeout: "timeout",
	safety: "content-safety rejection",
	empty: "empty result",
	unknown: "unknown error",
};

/** Group failures into a compact "2× timeout, 1× content-safety rejection" phrase. */
function summarizeFailures(failures: GenerationFailure[]): string {
	const byClass = new Map<GenerationFailure["class"], number>();
	for (const f of failures)
		byClass.set(f.class, (byClass.get(f.class) ?? 0) + 1);
	return [...byClass.entries()]
		.map(([cls, n]) => `${n}× ${FAILURE_LABEL[cls]}`)
		.join(", ");
}

/** Human-facing summary for one slot's self-correcting generation run. */
function describeSlotGeneration(
	count: number,
	readyCount: number,
	failures: GenerationFailure[],
	recovered: boolean,
): string {
	if (failures.length === 0) {
		return `Generated ${count} take(s)${recovered ? " (auto-recovered after a retry/rephrase)" : ""}.`;
	}
	const summary = summarizeFailures(failures);
	if (readyCount > 0) {
		return `Generated ${readyCount} of ${count} take(s)${recovered ? " (some auto-recovered)" : ""}; ${failures.length} could not be recovered (${summary}).`;
	}
	return `Could not generate this slot after self-correction (${summary}) — it needs your input.`;
}

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
	const { executor, backends: backendsProvider, critic } = options;

	// Resolved self-correction config (defaults + injected overrides).
	const recovery = {
		maxRetries: options.recovery?.maxRetries ?? DEFAULT_MAX_RETRIES,
		maxRephrases: options.recovery?.maxRephrases ?? DEFAULT_MAX_REPHRASES,
		baseDelayMs: options.recovery?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
		sleep: options.recovery?.sleep ?? realSleep,
		rephrase:
			options.recovery?.rephrase ??
			((prompt: string) => defaultSafetyRephrase(prompt)),
	};

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
			plan: getStoredPlan(editor),
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

	/**
	 * List the generation backends available right now — each with its modality,
	 * safety tier, identity capabilities, and a RELATIVE cost tier — so the agent
	 * can choose a `backendId` intent-appropriately (draft on cheap, hero on
	 * premium, persona-critical on seed-lock-capable). Read-only. Reads through the
	 * injected {@link BackendCatalogProvider}; with none wired it returns an empty
	 * catalog (generation then uses default auto-routing). This is the read side of
	 * model-routing; `generate`/`reroll`/`compareTake` are the write side.
	 */
	async function getBackends(input?: {
		modality?: "video" | "image";
	}): Promise<DirectorResult<BackendCatalogEntry[]>> {
		if (!backendsProvider) {
			return ok(
				"No backend catalog is wired in this context — generation uses default auto-routing.",
				[],
			);
		}
		try {
			const list = await backendsProvider(input?.modality);
			return ok(
				list.length
					? `${list.length} backend(s) available.`
					: "No backends are configured — set provider keys to enable model routing.",
				list,
			);
		} catch (error) {
			return fail(
				`Failed to load backends: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
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
	 * Build the reel-level consistency context (active personas + any extra
	 * characters + style/setting) and store it on this editor. The shared core of
	 * the `setConsistencyContext` verb AND the `storyboard` planner's auto-seed,
	 * so both pull personas identically and there is one place that authors the
	 * context. Returns the stored context.
	 */
	function applyConsistencyContext(input: {
		style?: string;
		setting?: string;
		extraCharacters?: ConsistencyCharacter[];
		includeAllPersonas?: boolean;
	}): ConsistencyContext {
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
		return context;
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
		const context = applyConsistencyContext(input);
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
	 * Author a multi-shot PLAN and materialize it into a sequence of generative
	 * slots — the Director's planning entry point (see `storyboard-plan.ts`).
	 *
	 * Beyond appending back-to-back slots (grouped into one undoable history
	 * entry), this:
	 *  1. records each shot's creative INTENT (intent/camera/subject) and the
	 *     shared STYLE BIBLE (palette, lens/mood, cast, setting) as a
	 *     {@link StoryboardPlan}, persisted per editor so later turns read it back
	 *     off `getReel().plan` instead of re-deriving it, and
	 *  2. AUTO-SEEDS the reel-level consistency context from the bible (unless
	 *     `seedConsistency: false`), so every subsequent `generate` call inherits
	 *     the style/cast without the user restating it — the plan and the
	 *     prompt-time consistency block come from the same source.
	 *
	 * A shot with a missing/non-positive duration is floored to the 6s default
	 * rather than rejected — friendlier for an agent that omits it. Returns the
	 * new slot ids (in order) plus the persisted plan.
	 */
	function storyboard(input: {
		shots: (PlannedShotInput & { spec?: SpecOverride })[];
		/** Shared style bible; also seeds the consistency context (see above). */
		bible?: StyleBible;
		/** Set false to skip auto-seeding the consistency context. Default true. */
		seedConsistency?: boolean;
	}): DirectorResult<{ slotIds: string[]; plan: StoryboardPlan }> {
		if (!input.shots || input.shots.length === 0) {
			return fail("storyboard requires at least one shot.");
		}

		// Author the plan first (pure): floors durations, assigns 1-based indices.
		// Slot ids are patched back onto each shot after materialization.
		const plan = buildStoryboardPlan({
			shots: input.shots.map(({ spec, ...rest }) => rest),
			bible: input.bible,
		});

		const before = captureReel();
		const ids: string[] = [];
		let cursor = editor.timeline.getTotalDuration();

		editor.command.beginTransaction();
		try {
			input.shots.forEach((shot, i) => {
				const planned = plan.shots[i];
				const spec = buildSpec(
					planned.prompt,
					planned.duration,
					applyReferenceMediaId(shot.spec),
				);
				const slotId = editor.timeline.addGenerativeSlot({
					spec,
					duration: planned.duration,
					startTime: cursor,
				});
				planned.slotId = slotId;
				cursor += planned.duration;
				ids.push(slotId);
			});
		} catch (error) {
			editor.command.rollbackTransaction();
			return fail(
				`storyboard failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		editor.command.commitTransaction();

		// Persist the plan so getReel/later turns read back the per-shot intent.
		storePlan(editor, plan);

		// Auto-seed the reel-level consistency context from the bible so every
		// generate call inherits style/cast. `bibleToConsistencyInput` returns
		// undefined for an empty bible → leave any prior context untouched.
		if (input.seedConsistency !== false) {
			const seed = bibleToConsistencyInput(plan.bible);
			if (seed) applyConsistencyContext(seed);
		}

		return withDelta(
			before,
			ok(`Storyboarded ${ids.length} shot(s).`, { slotIds: ids, plan }),
		);
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
	//
	// SELF-CORRECTING GENERATION: a take no longer dies silently on the first
	// provider hiccup. `runTakeWithRecovery` runs ONE take through the executor
	// and, on failure, reads the boundary's structured {@link GenerationFailure}
	// to decide what to do — retry transient/timeout/empty with backoff,
	// auto-rephrase a safety rejection and retry, or give up and report a
	// structured reason the caller can escalate. It works by `elementId` (not a
	// located visual slot) so voiceover slots reuse the exact same loop.

	/** Read any element's `activeTakeId` (generative fields live on the element). */
	function activeTakeIdOf(elementId: string): string | undefined {
		const located = findElement(elementId);
		return (located?.element as { activeTakeId?: string } | undefined)
			?.activeTakeId;
	}

	/** The recovered outcome of a single take: final status + structured reason. */
	interface TakeRecoveryResult {
		takeId: string;
		status: Take["status"];
		/** Present ⇒ the take could not be recovered; escalate. */
		failure?: GenerationFailure;
		/** True ⇒ the prompt was auto-rephrased for safety at least once. */
		rephrased: boolean;
		/** Executor invocations made (>1 ⇒ recovery kicked in). */
		attempts: number;
	}

	/**
	 * Run one take through the executor with self-correction. Records the take
	 * (`queued`→`generating`), then loops: on a retryable transient/timeout/empty
	 * failure it backs off and retries; on a safety rejection it rephrases the
	 * prompt and retries; on an unrecoverable failure (or once bounds are hit) it
	 * marks the take `failed` and returns the structured reason. Auto-selects the
	 * take when the element has no active one yet. Assumes `executor` is set.
	 */
	async function runTakeWithRecovery(input: {
		elementId: string;
		spec: GenerationSpec;
		exec: GenerateExecutor;
	}): Promise<TakeRecoveryResult> {
		const { elementId, exec } = input;
		const takeId = generateUUID();
		editor.timeline.addTakeToElement({
			elementId,
			take: {
				id: takeId,
				status: "queued",
				spec: { ...input.spec },
				seed: input.spec.seed,
				createdAt: Date.now(),
			},
		});

		let attemptSpec: GenerationSpec = { ...input.spec };
		let retries = 0;
		let rephrases = 0;
		let attempts = 0;
		let lastFailure: GenerationFailure | undefined;

		for (;;) {
			attempts++;
			editor.timeline.updateTake({
				elementId,
				takeId,
				patch: {
					status: "generating",
					spec: { ...attemptSpec },
					error: undefined,
				},
			});

			let result: Awaited<ReturnType<GenerateExecutor["run"]>>;
			try {
				result = await exec.run({
					slotId: elementId,
					takeId,
					spec: attemptSpec,
				});
			} catch (error) {
				result = {
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}

			// Success ⇒ commit the ready take and (maybe) auto-select it.
			if (result.status === "ready" && result.mediaId) {
				editor.timeline.updateTake({ elementId, takeId, patch: result });
				if (!activeTakeIdOf(elementId)) {
					editor.timeline.selectTake({ elementId, takeId });
				}
				return { takeId, status: "ready", rephrased: rephrases > 0, attempts };
			}

			// Failure (or a ready result with no media) ⇒ classify + recover.
			const failure =
				result.failure ??
				classifyFailure({
					error: result.error,
					empty: result.status === "ready" && !result.mediaId,
				});
			lastFailure = failure;

			if (failure.class === "safety" && rephrases < recovery.maxRephrases) {
				rephrases++;
				attemptSpec = {
					...attemptSpec,
					prompt: recovery.rephrase(attemptSpec.prompt, failure),
				};
				continue; // re-submit the cleaned prompt immediately
			}

			if (
				failure.class !== "safety" &&
				failure.retryable &&
				retries < recovery.maxRetries
			) {
				retries++;
				await recovery.sleep(backoffMs(recovery.baseDelayMs, retries));
				continue;
			}

			// Exhausted / unrecoverable ⇒ mark failed with the structured reason.
			editor.timeline.updateTake({
				elementId,
				takeId,
				patch: { status: "failed", error: failure.message },
			});
			return {
				takeId,
				status: "failed",
				failure: lastFailure,
				rephrased: rephrases > 0,
				attempts,
			};
		}
	}

	/**
	 * Generate `count` takes for a located visual slot, each self-correcting via
	 * {@link runTakeWithRecovery}. Returns a structured {@link SlotGenerationOutcome}
	 * (takes made, unrecovered failures, whether recovery was needed) so callers
	 * can escalate precisely instead of parsing an error string.
	 */
	async function runTakesForSlot(
		slotId: string,
		count: number,
		backendId?: string,
	): Promise<DirectorResult<SlotGenerationOutcome>> {
		const located = findSlot(slotId);
		if (!located) return fail(`No slot with id "${slotId}".`);

		const baseSpec = located.element.generation;
		if (!baseSpec.prompt) {
			return fail(`Slot "${slotId}" has no prompt; set one before generating.`);
		}

		// A per-call `backendId` pins this run to a specific model (the router's
		// `preferredBackendId`), overriding any model on the slot's own spec. It
		// rides on `spec.model` — the field the studio pipeline forwards to
		// `/api/studio/generate`, where `routeSlot` honors it.
		const takeSpec: GenerationSpec = backendId
			? { ...baseSpec, model: backendId }
			: { ...baseSpec };

		// TODO(generation-pipeline): the real provider/network call lives behind
		// this injectable boundary. Without an executor, enqueue queued takes so
		// the UI/agent can observe them, and report that nothing was rendered.
		if (!executor) {
			const takeIds: string[] = [];
			for (let i = 0; i < count; i++) {
				const take: Take = {
					id: generateUUID(),
					status: "queued",
					spec: { ...takeSpec },
					seed: takeSpec.seed,
					createdAt: Date.now(),
				};
				editor.timeline.addTakeToElement({ elementId: slotId, take });
				takeIds.push(take.id);
			}
			return ok(
				`Queued ${count} take(s) for slot "${slotId}" (no generation executor configured — takes remain queued).`,
				{ slotId, takeIds },
			);
		}

		const takeIds: string[] = [];
		const failures: GenerationFailure[] = [];
		let recovered = false;
		for (let i = 0; i < count; i++) {
			const r = await runTakeWithRecovery({
				elementId: slotId,
				spec: takeSpec,
				exec: executor,
			});
			takeIds.push(r.takeId);
			if (r.status === "failed" && r.failure) failures.push(r.failure);
			if (r.rephrased || (r.status === "ready" && r.attempts > 1)) {
				recovered = true;
			}
		}

		const readyCount = count - failures.length;
		const outcome: SlotGenerationOutcome = {
			slotId,
			takeIds,
			...(failures.length ? { failures } : {}),
			...(recovered ? { recovered: true } : {}),
		};
		return ok(
			describeSlotGeneration(count, readyCount, failures, recovered),
			outcome,
		);
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
	 * `alternatives` is how many takes to produce per slot (default 1). Each take
	 * self-corrects (retry/rephrase); slots that still can't be produced come back
	 * as structured `failures` in the result data AND are called out in the
	 * message so the caller escalates to the user only for genuine dead-ends.
	 */
	async function generate(input: {
		slotIds?: string[] | "all";
		alternatives?: number;
		/** Optional model pin for THIS run (the router's `preferredBackendId`). */
		backendId?: string;
	}): Promise<
		DirectorResult<{
			slotIds: string[];
			failures?: { slotId: string; failure: GenerationFailure }[];
			recovered?: boolean;
		}>
	> {
		const before = captureReel();
		const count = Math.max(1, input.alternatives ?? 1);
		const targets =
			!input.slotIds || input.slotIds === "all"
				? locateSlots().map((s) => s.element.id)
				: input.slotIds;

		if (targets.length === 0) {
			return fail("No slots to generate (storyboard some shots first).");
		}

		const done: string[] = []; // slots that produced ≥1 ready take
		const setupErrors: string[] = []; // slots we couldn't even start (no prompt / missing)
		const slotFailures: { slotId: string; failure: GenerationFailure }[] = [];
		let anyRecovered = false;

		for (const slotId of targets) {
			const result = await runTakesForSlot(slotId, count, input.backendId);
			if (!result.ok || !result.data) {
				setupErrors.push(`${slotId}: ${result.message}`);
				continue;
			}
			const data = result.data;
			const readyCount = data.takeIds.length - (data.failures?.length ?? 0);
			if (readyCount > 0) done.push(slotId);
			if (data.recovered) anyRecovered = true;
			for (const failure of data.failures ?? []) {
				slotFailures.push({ slotId, failure });
			}
		}

		// Nothing rendered anywhere ⇒ a hard failure the user must resolve.
		if (done.length === 0) {
			const reasons = slotFailures.length
				? summarizeFailures(slotFailures.map((f) => f.failure))
				: setupErrors.join("; ");
			return fail(
				`Generation failed for all ${targets.length} slot(s) (${reasons}). This needs your input.`,
			);
		}

		const parts = [`Generated ${count} take(s) for ${done.length} slot(s)`];
		if (anyRecovered)
			parts.push(" (some auto-recovered after a retry/rephrase)");
		if (slotFailures.length) {
			parts.push(
				`; ${slotFailures.length} slot(s) still failed (${summarizeFailures(
					slotFailures.map((f) => f.failure),
				)}) and need your input`,
			);
		}
		if (setupErrors.length) {
			parts.push(
				`; ${setupErrors.length} could not start (${setupErrors.join("; ")})`,
			);
		}
		parts.push(".");

		return withDelta(
			before,
			ok(parts.join(""), {
				slotIds: done,
				...(slotFailures.length ? { failures: slotFailures } : {}),
				...(anyRecovered ? { recovered: true } : {}),
			}),
		);
	}

	/** Regenerate: append fresh alternative take(s) to a single slot. */
	async function reroll(input: {
		slotId: string;
		alternatives?: number;
		/** Optional model pin for THIS run (the router's `preferredBackendId`). */
		backendId?: string;
	}): Promise<DirectorResult<SlotGenerationOutcome>> {
		const before = captureReel();
		const count = Math.max(1, input.alternatives ?? 1);
		return withDelta(
			before,
			await runTakesForSlot(input.slotId, count, input.backendId),
		);
	}

	/**
	 * A/B one slot across TWO backends: generate the same shot on each `backendId`,
	 * then AUTO-PICK the better take when a vision {@link TakeCritic} is wired,
	 * otherwise leave both takes for the user to choose. This is the write side of
	 * cost/quality-aware routing — spend 2x on a shot that matters and let the
	 * critic (or the human) settle it. Costs twice a single generate; the agent's
	 * cost gate accounts for that added spend before this runs.
	 *
	 * D1 GRACE: with no critic injected, auto-pick is a deliberate no-op — both
	 * takes are appended and the user picks via `chooseTake`.
	 */
	async function compareTake(input: {
		slotId: string;
		backendIds: string[];
	}): Promise<
		DirectorResult<{
			slotId: string;
			takeIds: string[];
			winner?: string;
			autoPicked: boolean;
		}>
	> {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);

		const ids = [...new Set(input.backendIds.filter((s) => s && s.trim()))];
		if (ids.length < 2) {
			return fail(
				"compareTake needs at least 2 distinct backendIds to compare (get them from getBackends).",
			);
		}

		const baseSpec = located.element.generation;
		if (!baseSpec.prompt) {
			return fail(
				`Slot "${input.slotId}" has no prompt; set one before comparing.`,
			);
		}

		// No executor: enqueue one queued take per backend so the comparison is
		// observable, but nothing renders (mirrors runTakesForSlot's no-executor path).
		if (!executor) {
			const takeIds: string[] = [];
			for (const backendId of ids) {
				const take: Take = {
					id: generateUUID(),
					status: "queued",
					spec: { ...baseSpec, model: backendId },
					seed: baseSpec.seed,
					createdAt: Date.now(),
				};
				editor.timeline.addTakeToElement({ elementId: input.slotId, take });
				takeIds.push(take.id);
			}
			return withDelta(
				before,
				ok(
					`Queued ${ids.length} comparison take(s) for slot "${input.slotId}" (no generation executor configured — takes remain queued).`,
					{ slotId: input.slotId, takeIds, autoPicked: false },
				),
			);
		}

		// Render one take per backend, each pinned via spec.model.
		const produced: {
			takeId: string;
			backendId: string;
			status: Take["status"];
			mediaId?: string;
			thumbnailUrl?: string;
		}[] = [];
		for (const backendId of ids) {
			const take: Take = {
				id: generateUUID(),
				status: "generating",
				spec: { ...baseSpec, model: backendId },
				seed: baseSpec.seed,
				createdAt: Date.now(),
			};
			editor.timeline.addTakeToElement({ elementId: input.slotId, take });

			let result: Pick<
				Take,
				"status" | "mediaId" | "thumbnailUrl" | "seed" | "jobId" | "error"
			>;
			try {
				result = await executor.run({
					slotId: input.slotId,
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
				elementId: input.slotId,
				takeId: take.id,
				patch: result,
			});
			produced.push({
				takeId: take.id,
				backendId,
				status: result.status ?? "failed",
				mediaId: result.mediaId,
				thumbnailUrl: result.thumbnailUrl,
			});
		}

		const takeIds = produced.map((p) => p.takeId);
		const ready = produced.filter((p) => p.status === "ready");
		if (ready.length === 0) {
			return withDelta(
				before,
				ok(
					`Compared ${ids.length} backend(s) for slot "${input.slotId}" but every take failed — see the takes for details.`,
					{ slotId: input.slotId, takeIds, autoPicked: false },
				),
			);
		}

		// Auto-pick with the critic when present; any failure or no-pick falls back
		// to presenting both takes (never throws the comparison away).
		let winner: string | undefined;
		let autoPicked = false;
		let winnerReason: string | undefined;
		if (critic && ready.length >= 2) {
			try {
				const pick = await critic.pickBest({
					slotId: input.slotId,
					prompt: baseSpec.prompt,
					takes: ready.map((r) => ({
						takeId: r.takeId,
						mediaId: r.mediaId,
						thumbnailUrl: r.thumbnailUrl,
					})),
				});
				if (pick && ready.some((r) => r.takeId === pick.takeId)) {
					editor.timeline.selectTake({
						elementId: input.slotId,
						takeId: pick.takeId,
					});
					winner = pick.takeId;
					autoPicked = true;
					winnerReason = pick.reason?.trim() || undefined;

					// LEARN from the auto-pick: fold WHICH backend/look won (and why) into
					// the durable brief so future shots inherit the preference — the same
					// brief-writing path `chooseTake` uses (task item 3).
					const winningBackend = produced.find(
						(p) => p.takeId === pick.takeId,
					)?.backendId;
					const snippet = briefSnippet(baseSpec.prompt);
					const note =
						"A/B auto-pick" +
						(winningBackend ? `: backend "${winningBackend}" won` : "") +
						(snippet ? ` for "${snippet}"` : "") +
						(winnerReason ? ` — ${winnerReason}` : "") +
						".";
					persistBrief(applyBriefPatch(readBrief(), { notes: [note] }));
				}
			} catch {
				/* critic unavailable/failed → present both (graceful degradation) */
			}
		}

		const message = autoPicked
			? `Compared ${ids.length} backends on slot "${input.slotId}"; the vision critic auto-picked the winning take${
					winnerReason ? ` — ${winnerReason}` : ""
				}.`
			: `Compared ${ids.length} backends on slot "${input.slotId}" — ${ready.length} take(s) ready; ${
					critic
						? "the critic returned no confident pick, so"
						: "no vision critic is wired, so"
				} choose the winner with chooseTake.`;
		return withDelta(
			before,
			ok(message, {
				slotId: input.slotId,
				takeIds,
				winner,
				autoPicked,
			}),
		);
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
	/**
	 * Pick the active take for a slot, and LEARN from the choice: a one-line note
	 * is appended to the persistent brief so future shots inherit the preference.
	 * Pass `rationale` ("user prefers the warmer, handheld take") to record the
	 * WHY; without it a compact factual note is stored instead.
	 */
	function chooseTake(
		input:
			| { slotId: string; takeId: string; rationale?: string }
			| { slotId: string; index: number; rationale?: string },
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

		// Learned-preference capture (task item 3): fold a one-line rationale into
		// the durable brief so the next shots inherit what this choice revealed.
		const chosenIndex = takes.findIndex((t) => t.id === takeId);
		const promptSnippet = briefSnippet(located.element.generation.prompt);
		const note =
			input.rationale?.trim() ||
			`Chose take ${chosenIndex + 1}/${takes.length}` +
				(promptSnippet ? ` for "${promptSnippet}"` : "") +
				".";
		persistBrief(applyBriefPatch(readBrief(), { notes: [note] }));

		const updated = findSlot(input.slotId);
		return withDelta(
			before,
			ok(
				`Selected take "${takeId}" for slot "${input.slotId}".`,
				updated ? toSnapshot(updated.element) : undefined,
			),
		);
	}

	// ---- BRIEF (durable creative intent) ----------------------------------
	//
	// The DIRECTOR BRIEF is the agent's persistent memory of the user's goal,
	// audience, tone, style bible, do/don't constraints, and learned notes. Unlike
	// the session-only consistency context above, it lives on the active `TProject`
	// (via `editor.project.getDirectorBrief`/`setDirectorBrief`) and is serialized
	// with the project, so a stated preference survives reloads and sessions. The
	// agent folds a summary into its system prompt each turn (see `agent.ts`) and
	// writes back through `updateBrief` / `chooseTake`.

	/** Read the active project's brief (empty object when unset / no project). */
	function readBrief(): DirectorBrief {
		return editor.project.getDirectorBrief();
	}

	/** Persist a fully-computed brief on the active project; returns it for chaining. */
	function persistBrief(next: DirectorBrief): DirectorBrief {
		editor.project.setDirectorBrief({ brief: next });
		return next;
	}

	/** First ~48 chars of a prompt, for compact learned notes. */
	function briefSnippet(prompt: string | undefined): string {
		const trimmed = (prompt ?? "").trim();
		return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
	}

	/** Read the current director brief (read-only). */
	function getBrief(): DirectorResult<DirectorBrief> {
		return ok("Director brief.", readBrief());
	}

	/**
	 * Update the durable brief. Scalar fields (goal/audience/tone/styleBible)
	 * REPLACE; `dos`/`donts` APPEND (deduped); `notes` append learned one-liners
	 * (capped). An empty string clears a scalar. Returns the merged brief.
	 */
	function updateBrief(patch: BriefPatch): DirectorResult<DirectorBrief> {
		const next = persistBrief(applyBriefPatch(readBrief(), patch));
		return ok("Director brief updated.", next);
	}

	/** Serialize the brief as the compact prompt block (see `summarizeBrief`). */
	function briefPromptBlock(): string {
		return summarizeBrief(readBrief());
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

	// ---- AUDIO (voiceover + music bed) ------------------------------------
	//
	// The Director owns the whole soundtrack, not just silent video: `addVoiceover`
	// turns a script into a TTS clip TIMED to the shot it narrates (reusing the
	// same self-correcting take pipeline via the executor's voiceover route), and
	// `addMusicBed` searches the sounds library and drops a quiet music track under
	// the reel. Both produce plain audio timeline elements — like `addText`/
	// `addClip`, they aren't generative *visual* slots, so they're invisible to
	// `captureReel()` and carry no mutation `delta`; the id + message are the
	// observation.

	/**
	 * Add a spoken voiceover from a script. When `slotId` is given, the VO is
	 * placed at that shot's start and matched to its duration ("time VO to the
	 * shot it narrates"); otherwise `startTime`/`duration` are used (duration
	 * estimated from the script when omitted). The VO renders through the SAME
	 * executor + recovery loop as visual takes (the executor routes
	 * `kind: "voiceover"` specs to TTS), so a transient TTS hiccup self-corrects.
	 */
	async function addVoiceover(input: {
		script: string;
		slotId?: string;
		startTime?: number;
		duration?: number;
		voice?: string;
		voiceRef?: string;
		personaId?: string;
		language?: string;
		trackId?: string;
	}): Promise<
		DirectorResult<{
			slotId: string;
			takeId?: string;
			failure?: GenerationFailure;
		}>
	> {
		const script = input.script?.trim();
		if (!script) return fail("addVoiceover requires a non-empty script.");

		// Timing: prefer syncing to a named shot; else use explicit/derived values.
		let startTime = input.startTime;
		let duration = input.duration;
		if (input.slotId) {
			const shot = findSlot(input.slotId);
			if (!shot) {
				return fail(
					`No slot with id "${input.slotId}" to time the voiceover to.`,
				);
			}
			startTime = startTime ?? shot.element.startTime;
			duration = duration ?? shot.element.duration;
		}
		startTime = startTime ?? editor.timeline.getTotalDuration();
		duration = duration ?? estimateSpeechSeconds(script);
		if (duration <= 0) {
			return fail("addVoiceover requires a positive duration.");
		}
		if (startTime < 0) return fail("addVoiceover requires startTime >= 0.");

		const spec = makeVoiceoverSpec({
			text: script,
			voice: input.voice,
			voiceRef: input.voiceRef,
			personaId: input.personaId,
			language: input.language,
		});
		const slotId = editor.timeline.addVoiceoverSlot({
			spec,
			duration,
			startTime,
			trackId: input.trackId,
		});

		if (!executor) {
			return ok(
				`Reserved voiceover slot "${slotId}" (${duration.toFixed(1)}s at ${startTime.toFixed(1)}s) — no generation executor configured, so audio was not rendered.`,
				{ slotId },
			);
		}

		const timedTo = input.slotId ? `, timed to shot "${input.slotId}"` : "";
		const r = await runTakeWithRecovery({
			elementId: slotId,
			spec,
			exec: executor,
		});
		if (r.status === "ready") {
			return ok(
				`Added voiceover "${slotId}" (${duration.toFixed(1)}s at ${startTime.toFixed(1)}s)${timedTo}.${
					r.rephrased
						? " Auto-rephrased a safety rejection to get it through."
						: ""
				}`,
				{ slotId, takeId: r.takeId },
			);
		}
		return {
			...fail(
				`Voiceover "${slotId}" failed to render (${r.failure ? FAILURE_LABEL[r.failure.class] : "unknown error"})${
					r.failure && !r.failure.retryable ? " — it needs your input" : ""
				}.`,
			),
			data: { slotId, takeId: r.takeId, failure: r.failure },
		};
	}

	/** Browser-bound default: search the sounds library, download the top hit, and
	 *  import it as a durable audio asset. Injectable via `options.audio.resolveMusic`
	 *  so headless tests never touch the network / audio decoder. */
	async function defaultResolveMusic(input: {
		query: string;
		commercialOnly: boolean;
	}): Promise<ResolvedMusic> {
		try {
			const projectId = editor.project.getActive().metadata.id;
			const params = new URLSearchParams({
				q: input.query,
				type: "effects",
				page: "1",
				commercial_only: String(input.commercialOnly),
			});
			const res = await fetch(`/api/sounds/search?${params.toString()}`, {
				headers: getFreesoundHeaders(),
			});
			if (!res.ok) return { error: `sound search failed (${res.status})` };
			const data = (await res.json()) as {
				results?: {
					name?: string;
					duration?: number;
					license?: string;
					url?: string;
					previewUrl?: string;
					downloadUrl?: string;
				}[];
			};
			const hit = data.results?.[0];
			if (!hit) return { error: `no sounds matched "${input.query}"` };
			const audioUrl = hit.downloadUrl || hit.previewUrl;
			if (!audioUrl) {
				return { error: `top sound "${hit.name}" has no downloadable audio` };
			}
			const audioRes = await fetch(audioUrl);
			if (!audioRes.ok) {
				return {
					error: `failed to download "${hit.name}" (${audioRes.status})`,
				};
			}
			const blob = await audioRes.blob();
			const { mediaId } = await importAudioAsset(
				editor,
				projectId,
				blob,
				hit.name || input.query,
			);
			return {
				mediaId,
				name: hit.name || input.query,
				duration: hit.duration,
				license: hit.license,
				sourceUrl: hit.url,
			};
		} catch (err) {
			return {
				error: err instanceof Error ? err.message : "music resolution failed",
			};
		}
	}

	const resolveMusic = options.audio?.resolveMusic ?? defaultResolveMusic;

	/**
	 * Search the sounds library for `query` and lay the top match under the reel
	 * as a quiet music bed (default volume 0.3, so it sits below dialogue/VO).
	 * Spans the whole timeline unless `startTime`/`duration` are given. Places a
	 * plain audio clip (not a generative slot).
	 */
	async function addMusicBed(input: {
		query: string;
		startTime?: number;
		duration?: number;
		volume?: number;
		commercialOnly?: boolean;
		trackId?: string;
	}): Promise<
		DirectorResult<{
			elementId: string;
			mediaId: string;
			name: string;
			license?: string;
			sourceUrl?: string;
		}>
	> {
		const query = input.query?.trim();
		if (!query) return fail("addMusicBed requires a non-empty query.");

		const resolved = await resolveMusic({
			query,
			commercialOnly: input.commercialOnly ?? true,
		});
		if ("error" in resolved) return fail(`addMusicBed: ${resolved.error}`);

		const startTime = input.startTime ?? 0;
		if (startTime < 0) return fail("addMusicBed requires startTime >= 0.");
		const duration =
			input.duration ??
			(editor.timeline.getTotalDuration() ||
				resolved.duration ||
				TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION);
		if (duration <= 0) {
			return fail(
				"addMusicBed needs a positive duration — the timeline is empty, so pass an explicit duration.",
			);
		}

		const volume = Math.min(1, Math.max(0, input.volume ?? 0.3));
		const element = buildUploadAudioElement({
			mediaId: resolved.mediaId,
			name: resolved.name,
			duration,
			startTime,
		});
		element.volume = volume;

		const elementId = editor.timeline.insertElement({
			element,
			placement: input.trackId
				? { mode: "explicit", trackId: input.trackId }
				: { mode: "auto", trackType: "audio" },
		});

		return ok(
			`Added music bed "${resolved.name}" (${duration.toFixed(1)}s at ${startTime.toFixed(1)}s, volume ${volume}). Plain audio clip — not a reel slot, so it won't appear in REEL listings or deltas.`,
			{
				elementId,
				mediaId: resolved.mediaId,
				name: resolved.name,
				license: resolved.license,
				sourceUrl: resolved.sourceUrl,
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
		getBackends,
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
		compareTake,
		remix,
		chooseTake,
		reviewTake,
		// audio
		addVoiceover,
		addMusicBed,
		// consistency
		getConsistencyContext,
		setConsistencyContext,
		// brief (durable creative intent)
		getBrief,
		updateBrief,
		briefPromptBlock,
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
