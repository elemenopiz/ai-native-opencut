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
	applyBudgetToPlan,
	bibleToConsistencyInput,
	buildStoryboardPlan,
	getStoredPlan,
	storePlan,
	type PlannedShotInput,
	type StoryboardPlan,
	type StyleBible,
} from "./storyboard-plan";
import {
	buildReelProposal,
	formatProposalDraft,
	getStoredProposal,
	proposalToPlan,
	reviseProposalShot,
	sourceNeedsCitation,
	storeProposal,
	validateProposal,
	type AssetResolver,
	type ProposedShotInput,
	type ReelProposal,
	type ResolvedAsset,
	type ShotRevision,
} from "./reel-proposal";
import {
	formatSpend,
	formatUsd,
	getReelSpend,
	planActionWithinBudget,
	recordReelSpend,
	remainingBudgetUsd,
	setReelBudget,
	TIER_ORDER,
	type BudgetGateDecision,
	type CostTier,
	type ReelSpend,
} from "./budget";
import {
	applyBriefPatch,
	summarizeBrief,
	type BriefPatch,
} from "./director-brief";
import {
	recordBibleApproval,
	revertProjectBible,
	seedStyleBibleFromProbe,
	syncProjectBible,
	type RevertResult,
	type StyleProbeSeedResult,
} from "./project-bible";
import type { StyleProbeLookup } from "./understanding-lookup";
import type { AssetTranscriptLookup } from "./transcript-lookup";
import {
	renderTranscriptDigest,
	windowSegments,
	type TranscriptSegmentLite,
} from "@/lib/search/asset-transcript";
import { useVoiceConsentStore } from "@/stores/voice-consent-store";
import type { ClonedVoiceProfile } from "./voice-consent";
import type { BibleApproval } from "@/types/project";
import {
	relayDeriveReferences,
	styleBibleToBriefLine,
	styleHasContent,
	type DeriveReferencesFn,
	type DerivedReference,
} from "./reference-intake";
import { uploadReferenceFile } from "@/lib/studio/reference-upload";
import type { MediaAsset } from "@/types/assets";
import type {
	DirectorBrief,
	PersonaRosterEntry,
	ProjectBible,
} from "@/types/project";
import { buildRemixSpec } from "@/lib/studio/remix";
import {
	extractTakeLastFrame,
	extractTakeFrames,
} from "@/lib/media/last-frame";
import {
	extractAndAddFrame,
	firstFrameSourceTime,
	lastFrameSourceTime,
	resolveVideoDurationSec,
	type DurationProbe,
	type FrameDecoder,
} from "@/lib/media/frame-extraction";
import { dataUrlToFile } from "@/lib/media/data-url";
import { analyzeMediaSilence } from "@/lib/auto-cut";
import { applyAutoCut, type AutoCutApplySummary } from "@/lib/auto-cut/apply";
import type { DerivedFrameLabel } from "@/services/storage/types";
import {
	estimateBatchCost,
	estimateSpecCost,
	formatCostRange,
	type CostRange,
} from "@/lib/studio/cost";
import { createShortIdMap } from "./short-id";
import {
	buildLibraryManifest,
	type AssetOrientation,
	type AssetUnderstandingLookup,
	type LibraryManifest,
} from "./asset-manifest";
import {
	embeddings as embeddingBackend,
	filterToCurrentModel,
} from "@/lib/local-ai/embeddings";
import { getAllEmbeddings } from "@/services/search/embedding-store";
import { findDuplicates } from "@/services/search/embedding-service";
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
	commitExport,
	createExportJobId,
	getExportFileExtension,
	getExportMimeType,
} from "@/lib/export";
import type {
	ExportFormat,
	ExportJobStatus,
	ExportOptions,
	ExportQuality,
} from "@/types/export";
import type {
	BackendCatalogEntry,
	BackendCatalogProvider,
	BudgetStatus,
	DirectorResult,
	DuplicateAssetPair,
	GenerationFailure,
	IntakeReferencesData,
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
	DuplicateAssetPair,
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

export type {
	AssetRole,
	AssetUnderstanding,
	AssetUnderstandingLookup,
	LibraryManifest,
} from "./asset-manifest";

export type {
	AssetCitation,
	CitationRepair,
	ProposedShot,
	ProposedShotInput,
	ReelProposal,
	ShotSource,
} from "./reel-proposal";

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
	/**
	 * Reference-intake seam (see `reference-intake.ts`). `derive` runs the user's
	 * reference images through the model to derive a StyleBible/persona; the
	 * default hits the same `/api/llm/agent` relay the agent uses. `uploadAnchor`
	 * rehosts a persona anchor File to a fetchable URL (default: the shared
	 * `/api/studio/upload` path); `createPersona` persists+returns a persona
	 * (default: the client `usePersonaStore`). All three are BROWSER-BOUND, so
	 * headless tests inject stubs — the same pattern as `executor`/`audio`.
	 */
	references?: {
		derive?: DeriveReferencesFn;
		uploadAnchor?: (file: File) => Promise<string>;
		createPersona?: (input: {
			name: string;
			descriptor: string;
			anchorImageUrl: string;
			refImageUrls?: string[];
			seed?: number;
		}) => Promise<{ id: string } | null>;
	};
	/**
	 * Frame-extraction seam (see `lib/media/frame-extraction.ts`). `decode` pulls a
	 * full-resolution still from a video at a source time (default: the browser
	 * mediabunny decode); `upload` rehosts the decoded still to a fetchable URL so
	 * it can seed a generation (default: the shared `/api/studio/upload` path);
	 * `probeDuration` resolves a video's real duration when the asset metadata
	 * lacks one (default: `resolveVideoDurationSec`'s container-header decode).
	 * BROWSER-BOUND, so headless tests inject stubs — same pattern as `references`.
	 */
	frames?: {
		decode?: FrameDecoder;
		upload?: (file: File) => Promise<string>;
		probeDuration?: DurationProbe;
	};
	/**
	 * "Understanding Pass" seam (see `asset-manifest.ts`). A per-asset lookup that
	 * returns the role/caption/face understanding for a media id — the data behind
	 * the faceted library manifest folded into the agent's system prompt. Built by
	 * a sibling agent; ABSENT ⇒ the manifest DEGRADES GRACEFULLY to media-type
	 * counts + recent asset names. Pure + injectable, so this ships and is tested
	 * independently — the same pattern as `executor`/`audio`/`references`.
	 */
	understanding?: AssetUnderstandingLookup;
	/**
	 * Flow-D follow-up B seam: a per-asset {@link StyleProbe} lookup (palette /
	 * lens-mood / setting), so `seedStyleFromUnderstanding` can route an
	 * Understanding-Pass style read into the Bible's `styleBible`. Default in the
	 * app is `styleProbeLookup` (understanding-lookup.ts); ABSENT ⇒ the verb reports
	 * there is nothing to seed. Pure + injectable like `understanding`.
	 */
	styleProbe?: StyleProbeLookup;
	/**
	 * Transcript-pass seam (see `lib/search/asset-transcript.ts`): a per-asset
	 * lookup returning the SPEECH TRANSCRIPT for a media id — timestamped
	 * sentence segments in asset-relative seconds, the timebase `trim` already
	 * speaks. Feeds the manifest's speech facet and the `getTranscript` verb.
	 * Default in the app is `assetTranscriptLookup` (transcript-lookup.ts);
	 * ABSENT ⇒ the verb reports no transcripts and the digest omits the facet.
	 * Pure + injectable like `understanding`.
	 */
	transcripts?: AssetTranscriptLookup;
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

/**
 * Bridge `estimateSpecCost`/`estimateBatchCost`'s credits estimate (see
 * `studio/cost.ts`) into the USD `baseCostUsd` the whole-reel BUDGET system
 * (`./budget.ts`) expects — that module stays USD-denominated by design (a
 * real dollar cap the user sets), independent of the credits-denominated
 * per-action cost-preview gate. 1 credit = US$0.01 (`credits/cost-table.ts`),
 * so this is an exact unit conversion, not a re-estimate.
 *
 * IMPORTANT: always feed this the LOW end of a `CostRange` when bridging into
 * budget.ts — `ShotBudgetInput.baseCostUsd` is documented as the "cheapest-tier"
 * estimate that `tierCostUsd` multiplies UP by the requested tier's factor. A
 * `CostRange`'s LOW end (the cheapest registered backend's rate) IS that
 * baseline; its HIGH end is a different concept — the cross-backend ask-early
 * figure the display/approval gate shows the user.
 */
function creditsToUsd(credits: number): number {
	return credits / 100;
}

/** One-line " Budget: $X across N shots (…)" tail appended to a storyboard message. */
function budgetSummary(budget: StoryboardPlan["budget"] | undefined): string {
	if (!budget) return "";
	const tiers = budget.allocations.reduce<Record<CostTier, number>>(
		(acc, a) => {
			acc[a.tier] = (acc[a.tier] ?? 0) + 1;
			return acc;
		},
		{ cheap: 0, standard: 0, premium: 0 },
	);
	const mix = (["premium", "standard", "cheap"] as const)
		.filter((t) => tiers[t] > 0)
		.map((t) => `${tiers[t]} ${t}`)
		.join(", ");
	const fit = budget.withinBudget
		? ""
		: " — over budget even all-cheap; generation will pause for approval";
	return ` Budget ${formatUsd(budget.totalBudgetUsd)} across ${
		budget.allocations.length
	} shot(s) (${mix}); planned ${formatUsd(budget.plannedTotalUsd)}${fit}.`;
}

/**
 * Pick a concrete cheaper backend to down-route to: the lowest-`relativeCost`
 * entry at or below `maxTier`, falling back to the globally cheapest when nothing
 * sits within the tier. Returns `undefined` for an empty catalog (caller then
 * simply drops any premium pin and lets the router auto-pick cheaper).
 */
function cheapestBackendId(
	catalog: BackendCatalogEntry[],
	maxTier: CostTier,
): string | undefined {
	if (catalog.length === 0) return undefined;
	const cap = TIER_ORDER.indexOf(maxTier);
	const withinTier = catalog.filter(
		(b) => TIER_ORDER.indexOf(b.costTier) <= cap,
	);
	const pool = withinTier.length > 0 ? withinTier : catalog;
	return [...pool].sort((a, b) => a.relativeCost - b.relativeCost)[0]?.id;
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

	// Reference-intake seam: model derivation + anchor upload + persona create.
	// Defaults are browser-bound (relay / R2 upload / persona store); tests inject.
	const deriveReferences: DeriveReferencesFn =
		options.references?.derive ?? relayDeriveReferences;
	const uploadAnchorFile: (file: File) => Promise<string> =
		options.references?.uploadAnchor ??
		(async (file) => (await uploadReferenceFile(file)).url);
	const createPersonaRecord =
		options.references?.createPersona ??
		((input: {
			name: string;
			descriptor: string;
			anchorImageUrl: string;
			refImageUrls?: string[];
			seed?: number;
		}) => usePersonaStore.getState().create(input));

	// Frame-extraction seam: full-res decode + rehost. `decodeFrame` is passed
	// straight to `extractAndAddFrame` (undefined ⇒ its browser default);
	// `uploadFrame` rehosts the decoded still so it can seed a generation.
	const decodeFrame: FrameDecoder | undefined = options.frames?.decode;
	const uploadFrame: (file: File) => Promise<string> =
		options.frames?.upload ??
		(async (file) => (await uploadReferenceFile(file)).url);
	const probeDuration: DurationProbe =
		options.frames?.probeDuration ??
		((source) => resolveVideoDurationSec(source));

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

	/**
	 * Wrap a SYNCHRONOUS cluster of mutations (no `await` inside `fn`) in one
	 * origin-tagged, named undo entry — the atomicity half of agent-scoped
	 * undo (poach: palmier-mcp-schema-spec.md §"Agent-scoped undo"; A2). Only
	 * ever call this around code with no `await` inside: the top-level verb
	 * choke point (see `withAgentOrigin` near the bottom of this file) never
	 * holds a transaction open across a real `await` — doing so would risk
	 * sweeping an unrelated concurrent command (e.g. a manual user edit made
	 * while a generation network call is in flight) into the agent's batch,
	 * corrupting both its origin and its atomicity. `withAgentBatch` nests
	 * safely whether or not that outer transaction is still open (it always
	 * is, before a verb's first real await; it never is, after) — either way
	 * the resulting entry inherits the calling verb's name/origin from
	 * whichever ambient context is active, so no name is passed here.
	 */
	function withAgentBatch<T>(fn: () => T): T {
		editor.command.beginTransaction();
		try {
			const result = fn();
			editor.command.commitTransaction();
			return result;
		} catch (error) {
			editor.command.rollbackTransaction();
			throw error;
		}
	}

	// ---- READ -------------------------------------------------------------

	function getReel(): ReelSnapshot {
		return {
			slots: locateSlots().map((s) => toSnapshot(s.element)),
			totalDuration: editor.timeline.getTotalDuration(),
			targetDurationSec: readBrief().durationSec,
			canUndo: editor.command.canUndo(),
			canRedo: editor.command.canRedo(),
			consistency: getStoredConsistencyContext(editor),
			plan: getStoredPlan(editor),
			spend: getReelSpend(editor),
		};
	}

	/** Cap on personas/assets surfaced in {@link getProjectInfo} — keep the once-per-turn system prompt cheap. */
	const CONTEXT_LIST_CAP = 5;

	/**
	 * The active project's canvas orientation, or `undefined` when no project
	 * (or no settings) is active. Shared by `getProjectInfo` (the
	 * `ProjectInfo.orientation` field) and `buildManifest` (the manifest's
	 * ORIENTATION-MISMATCH facet) so the two are always computed identically —
	 * `getProjectInfo`'s `orientation` and the manifest's warning clause can
	 * never disagree about what the canvas is.
	 */
	function getCanvasOrientation(): AssetOrientation | undefined {
		const settings = editor.project.getActiveOrNull()?.settings;
		if (!settings) return undefined;
		if (settings.canvasSize.width === settings.canvasSize.height)
			return "square";
		return settings.canvasSize.width > settings.canvasSize.height
			? "landscape"
			: "portrait";
	}

	/**
	 * Build the faceted, role-aware {@link LibraryManifest} from CURRENT editor
	 * state (assets + persona roster) through the injected Understanding Pass
	 * lookup. Shared by `getProjectInfo` (rides the system prompt) and the
	 * `getLibraryManifest` verb (re-queryable on demand) so both render one digest.
	 * Cheap, O(assets) — safe to rebuild every turn like `getProjectInfo` itself.
	 *
	 * Maps each editor `MediaAsset` (`@/services/storage/types`'s
	 * `MediaAssetData`) onto the manifest's `ManifestAsset`: `duration` → the
	 * unit-disambiguated `durationSec`, and `source` (`"ai"` or absent) →
	 * `"ai"` | `"upload"` (that field has no third state — see
	 * `MediaAssetData.source`'s own doc comment). Also resolves the canvas
	 * orientation so `buildLibraryManifest` can compute the
	 * ORIENTATION-MISMATCH facet.
	 */
	function buildManifest(): LibraryManifest {
		const assets = editor.media.getAssets();
		const personas = usePersonaStore.getState().personas;
		return buildLibraryManifest({
			assets: assets.map((a) => ({
				id: a.id,
				name: a.name,
				type: a.type,
				width: a.width,
				height: a.height,
				durationSec: a.duration,
				fps: a.fps,
				source: a.source === "ai" ? "ai" : "upload",
			})),
			understanding: options.understanding,
			personas: personas.map((p) => ({ id: p.id, name: p.name })),
			speech: options.transcripts
				? (mediaId) => {
						const t = options.transcripts?.(mediaId);
						return t ? t.segments.some((s) => s.text.trim() !== "") : undefined;
					}
				: undefined,
			canvasOrientation: getCanvasOrientation(),
		});
	}

	/**
	 * Compact project-level grounding: canvas/fps settings, the persona roster
	 * (reusable characters for consistency), and a faceted media-library MANIFEST
	 * (counts by role, named heroes, face-anchors, a searchable tail — see
	 * `asset-manifest.ts`). Read-only — no `withDelta`, nothing mutates. Cheap
	 * enough to call every turn; also folded into the agent's system prompt (see
	 * `agent.ts`'s context block) so this exists both as prompt grounding AND as a
	 * re-queryable verb.
	 */
	function getProjectInfo(): DirectorResult<ProjectInfo> {
		const project = editor.project.getActiveOrNull();
		const settings = project?.settings;
		const orientation = getCanvasOrientation();

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
			manifest: buildManifest(),
		});
	}

	/**
	 * Re-query the faceted library MANIFEST on demand (the same digest already in
	 * the system prompt via `getProjectInfo`). The result `message` IS the one-line
	 * digest; `data` carries the structured facets (per-role counts, named heroes
	 * with FULL media ids + captions, face-anchor personas, the searchable tail) so
	 * the agent can read exact ids/captions after the library changes mid-turn.
	 * Read-only — nothing mutates.
	 */
	function getLibraryManifest(): DirectorResult<LibraryManifest> {
		const manifest = buildManifest();
		return ok(manifest.digest, manifest);
	}

	/** The `getTranscript` verb's payload shape. */
	interface TranscriptData {
		mediaId: string;
		language: string;
		durationSec: number;
		/** Total segments in the whole transcript (pre-window, pre-cap). */
		segmentCount: number;
		/** The windowed, capped segments (asset-relative seconds). */
		segments: TranscriptSegmentLite[];
		/** True when the cap dropped segments — re-query a narrower window. */
		truncated: boolean;
	}

	/**
	 * Read the speech transcript of ONE media asset — timestamped sentence
	 * segments in ASSET-RELATIVE seconds, the same timebase as `trim`'s
	 * `trimStart`/`trimEnd`, so segment boundaries are directly usable as cut
	 * points. Optional `startSec`/`endSec` window the read (a long source can
	 * exceed the observation cap). Read-only — nothing mutates. Transcripts are
	 * produced by the auto-transcribe ingest pass (on-device Whisper); an asset
	 * without one is either silent media, still pending, or an unsupported
	 * browser — the message distinguishes "no record" from "no speech".
	 */
	function getTranscript(input: {
		mediaId: string;
		startSec?: number;
		endSec?: number;
	}): DirectorResult<TranscriptData> {
		if (!options.transcripts) {
			return fail(
				"No transcript pass is wired in this context — speech-aware cuts are unavailable.",
			);
		}
		const t = options.transcripts(input.mediaId);
		if (!t) {
			return fail(
				`No transcript for media "${input.mediaId}" — it may still be transcribing, or transcription is unavailable here. For placed footage you can still cut on visual boundaries.`,
			);
		}
		if (t.segments.length === 0) {
			return ok(`Media "${input.mediaId}" was transcribed: no speech found.`, {
				mediaId: t.mediaId,
				language: t.language,
				durationSec: t.durationSec,
				segmentCount: 0,
				segments: [],
				truncated: false,
			});
		}
		const windowed = windowSegments(t.segments, input.startSec, input.endSec);
		const digest = renderTranscriptDigest(windowed);
		const windowNote =
			input.startSec !== undefined || input.endSec !== undefined
				? ` in window [${input.startSec ?? 0}s–${input.endSec ?? t.durationSec}s]`
				: "";
		const truncNote = digest.truncated
			? ` (showing first ${digest.included} — re-query with startSec/endSec for the rest)`
			: "";
		return ok(
			`Transcript of "${input.mediaId}"${windowNote}: ${digest.included} segment(s)${truncNote}. Timestamps are asset-relative seconds — align trim/split points to segment boundaries so speech is never cut mid-sentence.\n${digest.lines.join("\n")}`,
			{
				mediaId: t.mediaId,
				language: t.language,
				durationSec: t.durationSec,
				segmentCount: t.segments.length,
				segments: windowed.slice(0, digest.included),
				truncated: digest.truncated,
			},
		);
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
		syncBible("setConsistencyContext", "Set reel consistency context");
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
	 * `searchMedia` below calls the same embedding store / embedding seam
	 * directly instead of going through the hook.
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

		// Stale-model records (pre-migration vector space) are invisible here:
		// they rank meaninglessly against a current-model query vector, and the
		// background re-index will rewrite them shortly.
		const indexed = filterToCurrentModel(await getAllEmbeddings());
		if (indexed.length === 0) {
			return ok(
				"No media indexed yet — import footage and let it index before searching.",
				[],
			);
		}

		// Embed the query in-browser through the seam (L2-normalized, so the
		// dot products below remain cosine similarities).
		const [queryVec] = await embeddingBackend.embedTexts([query]);
		const assets = editor.media.getAssets();
		const byId = new Map(assets.map((a) => [a.id, a]));
		const limit = Math.max(1, input.limit ?? 5);

		const hits: MediaSearchHit[] = [];
		for (const media of indexed) {
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
			// Resolved once so mediaName + the dims/duration/provenance facets
			// (see MediaSearchHit's doc comment) all come from the same asset read.
			const asset = byId.get(media.mediaId);
			hits.push({
				mediaId: media.mediaId,
				score: bestScore,
				timestampSec: bestTs,
				mediaName: asset?.name,
				width: asset?.width,
				height: asset?.height,
				durationSec: asset?.duration,
				source: asset ? (asset.source === "ai" ? "ai" : "upload") : undefined,
			});
		}

		hits.sort((a, b) => b.score - a.score);
		const top = hits.slice(0, limit);
		if (top.length === 0) return ok(`No footage matched "${query}".`, []);
		return ok(`Found ${top.length} match(es) for "${query}".`, top);
	}

	/**
	 * Find near-duplicate media-library assets via CLIP embedding similarity —
	 * multiple takes of the same shot, or a burst of near-identical uploads.
	 * "Duplicate" means visually near-identical CONTENT (cosine similarity of
	 * mean frame vectors above `DUPLICATE_THRESHOLD`), NOT byte-identical files.
	 * Wraps the SAME `findDuplicates` the Visual Search panel's "Find duplicate
	 * / retake clips" button calls (`embedding-service.ts`) — read-only, no
	 * `withDelta`, nothing mutates.
	 *
	 * `findDuplicates` itself has only ONE mode: a whole-library O(n²) scan (no
	 * single-asset comparison entry point). When `mediaId` is passed here, the
	 * full scan still runs and results are filtered to pairs that include it
	 * afterward — cheap relative to the scan itself (a plain array filter), so
	 * both call shapes are supported without forcing a shape the underlying
	 * function doesn't have.
	 */
	async function findDuplicateAssets(
		input: { mediaId?: string } = {},
	): Promise<DirectorResult<DuplicateAssetPair[]>> {
		const pairs = await findDuplicates();
		const scoped = input.mediaId
			? pairs.filter(
					(p) => p.mediaIdA === input.mediaId || p.mediaIdB === input.mediaId,
				)
			: pairs;

		if (scoped.length === 0) {
			return ok(
				input.mediaId
					? `No near-duplicates found for "${input.mediaId}".`
					: "No near-duplicates detected in the library.",
				[],
			);
		}

		const assets = editor.media.getAssets();
		const byId = new Map(assets.map((a) => [a.id, a]));
		const result: DuplicateAssetPair[] = scoped.map((p) => ({
			mediaIdA: p.mediaIdA,
			mediaIdB: p.mediaIdB,
			score: p.score,
			mediaNameA: byId.get(p.mediaIdA)?.name,
			mediaNameB: byId.get(p.mediaIdB)?.name,
		}));

		return ok(
			`Found ${result.length} near-duplicate pair${result.length === 1 ? "" : "s"}` +
				(input.mediaId ? ` for "${input.mediaId}".` : "."),
			result,
		);
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
		/**
		 * Total USD the whole reel may spend. When set, the plan allocates this cap
		 * across shots by importance (hero → premium tier, b-roll → cheap), down-
		 * tiering the least-important shots to fit, and ARMS the running spend
		 * tracker so later generation is gated against the remaining budget.
		 */
		budgetUsd?: number;
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
		// Each shot's base (cheapest-tier) USD estimate, in shot order — the budget
		// allocator's cost basis that `tierCostUsd` multiplies UP by the requested
		// tier's factor (cheap 1×, standard 1.9×, premium 3.2×). Uses the LOW end
		// of `estimateSpecCost` (the cheapest registered backend's rate) — that IS
		// the "cheapest-tier" baseline; the HIGH end is a cross-backend ask-early
		// display figure (the approval gate), a different concept.
		const baseCostUsd: number[] = [];
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
				baseCostUsd.push(creditsToUsd(estimateSpecCost(spec).low));
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

		// Budget: allocate the cap across shots (patches each shot's tier +
		// allocatedUsd, sets plan.budget) and arm the running spend tracker.
		if (input.budgetUsd != null && input.budgetUsd > 0) {
			applyBudgetToPlan(plan, baseCostUsd, input.budgetUsd);
			setReelBudget(editor, input.budgetUsd);
		}

		// Persist the plan so getReel/later turns read back the per-shot intent.
		storePlan(editor, plan);

		// Auto-seed the reel-level consistency context from the bible so every
		// generate call inherits style/cast. `bibleToConsistencyInput` returns
		// undefined for an empty bible → leave any prior context untouched.
		if (input.seedConsistency !== false) {
			const seed = bibleToConsistencyInput(plan.bible);
			if (seed) applyConsistencyContext(seed);
		}

		// Write-through to the durable bible (plan + any seeded consistency + roster).
		syncBible("storyboard", `Storyboarded ${ids.length} shot(s)`);

		return withDelta(
			before,
			ok(`Storyboarded ${ids.length} shot(s).${budgetSummary(plan.budget)}`, {
				slotIds: ids,
				plan,
			}),
		);
	}

	// ---- PROPOSE-FIRST DRAFTING (Flow B) ----------------------------------
	//
	// The inversion of `storyboard`: instead of the human hand-placing clips, the
	// Director drafts the WHOLE reel as an editable plan that CITES specific library
	// assets per shot (retrieve), or plans to GENERATE where nothing matches, or
	// GENERATE-TO-MATCH a cited asset's look. The human reacts to the draft (accept
	// / revise one line) rather than assembling. See `reel-proposal.ts`.
	//
	// THE SAFETY GATE: a plan may cite ONLY asset ids that resolve against the REAL
	// index. `resolveAssetForCitation` is that gate — existence comes from the media
	// store, caption/role from the injected Understanding Pass; a fabricated id
	// resolves to `undefined` and `validateProposal` repairs the shot to `generate`.

	/**
	 * Resolve a cited mediaId against the REAL index — the single grounding source
	 * for Flow B. EXISTENCE is the media store (a fabricated id returns `undefined`
	 * and cannot be cited); the `#N` ref is the asset's 1-based library position;
	 * caption/role come from the injected Understanding Pass when present (absent ⇒
	 * the citation is still valid, just captionless — grounding degrades gracefully).
	 */
	const resolveAssetForCitation: AssetResolver = (
		mediaId,
	): ResolvedAsset | undefined => {
		const assets = editor.media.getAssets();
		const index = assets.findIndex((a) => a.id === mediaId);
		if (index === -1) return undefined;
		const asset = assets[index];
		const u = options.understanding?.(mediaId);
		return {
			id: asset.id,
			name: asset.name,
			ref: `#${index + 1}`,
			...(u?.caption ? { caption: u.caption } : {}),
			...(u?.role ? { role: u.role } : {}),
		};
	};

	/** Per-shot base (cheapest-tier) USD estimate for budget allocation: library shots cost $0. */
	function proposalBaseCosts(proposal: ReelProposal): number[] {
		return proposal.shots.map((s) =>
			s.source === "library"
				? 0
				: creditsToUsd(estimateSpecCost(buildSpec(s.prompt, s.duration)).low),
		);
	}

	/**
	 * DRAFT the entire reel as an editable, CITED plan (Flow B). Decomposes the
	 * brief into shots, each with a `source` — `library` (cite a specific asset),
	 * `generate` (no match — render it), or `generate-to-match` (generate in a cited
	 * asset's look). Every citation is VALIDATED against the real index before the
	 * draft is returned: any id that doesn't resolve is repaired to `generate` (never
	 * silently kept), so the draft can't hallucinate an asset. The draft is stored
	 * pending — nothing is placed on the timeline until `acceptProposal`. The result
	 * `message` IS the rendered draft (markdown) the human reacts to; `data.proposal`
	 * carries the structured plan.
	 */
	function proposeReel(input: {
		shots: ProposedShotInput[];
		bible?: StyleBible;
		budgetUsd?: number;
	}): DirectorResult<{ proposal: ReelProposal; draft: string }> {
		if (!input.shots || input.shots.length === 0) {
			return fail("proposeReel requires at least one shot.");
		}

		// Build the draft (pure), then GROUND it: validate every citation against the
		// real index and repair any that don't resolve.
		const built = buildReelProposal({
			shots: input.shots,
			bible: input.bible,
		});
		const { proposal } = validateProposal(built, resolveAssetForCitation);

		// Allocate a budget across the GENERATE shots (library shots are $0) for the
		// draft's spend line; the running tracker is ARMED at acceptProposal, not now.
		if (input.budgetUsd != null && input.budgetUsd > 0) {
			const tmpPlan = proposalToPlan(proposal);
			applyBudgetToPlan(tmpPlan, proposalBaseCosts(proposal), input.budgetUsd);
			proposal.budget = tmpPlan.budget;
		}

		storeProposal(editor, proposal);

		const draft = formatProposalDraft(proposal);
		const grounded = proposal.shots.filter((s) =>
			sourceNeedsCitation(s.source),
		).length;
		const headline = `Drafted a ${proposal.shotCount}-shot reel (${grounded} from the library, ${
			proposal.shotCount - grounded
		} to generate).${
			proposal.repairs.length
				? ` ${proposal.repairs.length} unresolved citation(s) fell back to generate.`
				: ""
		}${budgetSummary(proposal.budget)}`;

		return ok(`${headline}\n\n${draft}`, { proposal, draft });
	}

	/**
	 * Revise a SINGLE line of the pending draft and leave the rest STABLE — "swap
	 * shot 2 for the drone pass, colder open" re-plans only shot 2; shots 1 and 3 are
	 * untouched (preserved by reference). The revised shot's citation is re-validated
	 * against the real index (a fabricated swap-in id is repaired just like on the
	 * first draft). Fails if there's no pending draft or the index is out of range.
	 */
	function reviseProposal(
		input: { index: number } & ShotRevision,
	): DirectorResult<{ proposal: ReelProposal; draft: string }> {
		const pending = getStoredProposal(editor);
		if (!pending) {
			return fail("No draft to revise — call proposeReel first.");
		}
		const { index, ...patch } = input;
		if (!Number.isFinite(index) || index < 1 || index > pending.shots.length) {
			return fail(
				`No shot #${index} in the draft (it has ${pending.shots.length} shot(s)).`,
			);
		}

		const { proposal, repair, changed } = reviseProposalShot(
			pending,
			index,
			patch,
			resolveAssetForCitation,
		);
		if (!changed) {
			return fail(`Couldn't revise shot #${index}.`);
		}

		// Re-allocate the budget across the revised shots so the spend line stays honest.
		if (proposal.budget) {
			const tmpPlan = proposalToPlan(proposal);
			applyBudgetToPlan(
				tmpPlan,
				proposalBaseCosts(proposal),
				proposal.budget.totalBudgetUsd,
			);
			proposal.budget = tmpPlan.budget;
		}

		storeProposal(editor, proposal);

		const draft = formatProposalDraft(proposal);
		const note = repair ? ` (${repair.reason})` : "";
		return ok(`Revised shot #${index}${note}.\n\n${draft}`, {
			proposal,
			draft,
		});
	}

	/**
	 * ACCEPT the pending draft: materialize every shot IN ORDER — library shots place
	 * their cited asset via the `addClip` path, generate/generate-to-match shots
	 * become generative slots (generate-to-match attaches the cited asset as a
	 * reference image so generation inherits its look). Re-validates citations
	 * against the CURRENT index first (assets may have changed since drafting), then
	 * persists the accepted plan as the durable {@link StoryboardPlan}, arms the
	 * budget, seeds the reel consistency context from the bible, and write-throughs to
	 * the Project Bible. Clears the pending draft. Fails if there's no draft.
	 */
	function acceptProposal(input?: {
		seedConsistency?: boolean;
	}): DirectorResult<{ elementIds: string[]; plan: StoryboardPlan }> {
		const pending = getStoredProposal(editor);
		if (!pending) {
			return fail("No draft to accept — call proposeReel first.");
		}

		// Re-ground against the live index; assets may have been deleted since drafting.
		const { proposal } = validateProposal(pending, resolveAssetForCitation);

		const before = captureReel();
		const elementIds: string[] = [];
		// Materialized copies so we can patch each shot's elementId without mutating
		// the pending draft until the transaction commits.
		const materialized = proposal.shots.map((s) => ({ ...s }));
		let cursor = editor.timeline.getTotalDuration();

		editor.command.beginTransaction();
		try {
			for (const shot of materialized) {
				if (shot.source === "library" && shot.citation) {
					const res = addClip({
						mediaId: shot.citation.mediaId,
						startTime: cursor,
						duration: shot.duration,
					});
					if (res.ok && res.data) {
						shot.elementId = res.data.elementId;
						elementIds.push(res.data.elementId);
						cursor += shot.duration;
					}
					// A library citation that can't be placed (e.g. an audio asset) is
					// skipped rather than aborting the whole accept — the rest still lands.
					continue;
				}

				// generate / generate-to-match → a generative slot.
				const overrides: Partial<GenerationSpec> = {};
				if (shot.source === "generate-to-match" && shot.citation) {
					const url = editor.media.getAssetById(shot.citation.mediaId)?.url;
					// Condition generation on the cited asset's LOOK via omni-reference.
					if (url) overrides.referenceImages = [url];
				}
				const spec = buildSpec(shot.prompt, shot.duration, overrides);
				const slotId = editor.timeline.addGenerativeSlot({
					spec,
					duration: shot.duration,
					startTime: cursor,
				});
				shot.elementId = slotId;
				elementIds.push(slotId);
				cursor += shot.duration;
			}
		} catch (error) {
			editor.command.rollbackTransaction();
			return fail(
				`acceptProposal failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		editor.command.commitTransaction();

		// Persist the accepted draft as the durable plan (read back off getReel().plan).
		const accepted: ReelProposal = { ...proposal, shots: materialized };
		const plan = proposalToPlan(accepted);
		storePlan(editor, plan);

		// Arm the running spend tracker if the draft carried a budget.
		if (accepted.budget && accepted.budget.totalBudgetUsd > 0) {
			setReelBudget(editor, accepted.budget.totalBudgetUsd);
		}

		// Seed the reel consistency context from the bible so every generate shot
		// inherits the look (unless opted out) — the same path storyboard uses.
		if (input?.seedConsistency !== false) {
			const seed = bibleToConsistencyInput(plan.bible);
			if (seed) applyConsistencyContext(seed);
		}

		// Write-through to the durable Project Bible (plan + consistency + roster).
		syncBible(
			"acceptProposal",
			`Accepted draft — ${elementIds.length} shot(s)`,
		);

		// Draft consumed.
		storeProposal(editor, undefined);

		const libraryCount = materialized.filter(
			(s) => s.source === "library" && s.elementId,
		).length;
		return withDelta(
			before,
			ok(
				`Placed ${elementIds.length} shot(s) from the draft (${libraryCount} from the library, ${
					elementIds.length - libraryCount
				} generative).${budgetSummary(plan.budget)} Generate the slots when you're ready.`,
				{ elementIds, plan },
			),
		);
	}

	/** Read the pending Flow-B draft, if one is open (read-only). */
	function getProposal(): DirectorResult<ReelProposal | undefined> {
		const proposal = getStoredProposal(editor);
		return ok(
			proposal
				? formatProposalDraft(proposal)
				: "No draft proposal is open — call proposeReel to draft one.",
			proposal,
		);
	}

	// ---- REFERENCE INTAKE (eyes on INPUT) ---------------------------------
	//
	// The INPUT twin of `reviewTake`: reviewTake feeds the model its OWN output
	// (a generated take); intakeReferences feeds it the user's INPUT — dropped
	// style refs / a character photo — and turns what it SEES into the two
	// artifacts the reel already honors. A derived StyleBible seeds the reel-level
	// consistency context (so every `generate` inherits the LOOK); a derived
	// persona is locked on the seed-lock path (so a dropped face recurs shot to
	// shot). The look is also recorded on the durable brief (D4). The model call
	// itself is the injectable `deriveReferences` seam (default: the relay).

	/** Read an image File into a base64 `data:` URL for an Anthropic image block. */
	async function fileToDataUrl(file: File): Promise<string | undefined> {
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			// Chunked to keep String.fromCharCode off a huge spread for big images.
			let binary = "";
			const chunk = 0x8000;
			for (let i = 0; i < bytes.length; i += chunk) {
				binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
			}
			const mime =
				file.type && file.type.startsWith("image/") ? file.type : "image/png";
			return `data:${mime};base64,${btoa(binary)}`;
		} catch {
			return undefined;
		}
	}

	/**
	 * Decode one media asset to a base64 image `data:` URL the model can SEE:
	 * image assets are read straight from their File (no CORS); video assets
	 * sample their first frame through the same decode path `reviewTake` uses.
	 */
	async function decodeAssetToImage(
		asset: MediaAsset | undefined,
	): Promise<string | undefined> {
		if (!asset) return undefined;
		if (asset.type === "image" && asset.file) return fileToDataUrl(asset.file);
		if (asset.type === "video") {
			const [frame] = await extractTakeFrames(asset, {
				count: 1,
				name: asset.name,
			});
			return frame;
		}
		return undefined;
	}

	/**
	 * Resolve a reference asset to a publicly-fetchable URL for use as a persona
	 * anchor (the persona endpoint + downstream providers pull it server-side, so
	 * a `blob:`/object URL won't do). An already-remote `http(s)` URL passes
	 * through; otherwise the asset's File is rehosted via `uploadAnchor`.
	 */
	async function resolveAnchorUrl(
		asset: MediaAsset | undefined,
	): Promise<string | undefined> {
		if (!asset) return undefined;
		if (asset.url && /^https?:\/\//i.test(asset.url)) return asset.url;
		if (asset.file) {
			try {
				return await uploadAnchorFile(asset.file);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	/**
	 * Give the Director EYES ON INPUT: run the user's reference images through the
	 * model to derive the referenced LOOK (a StyleBible) and, when the refs center
	 * on a person, a CHARACTER (a persona), then wire both so every generated shot
	 * inherits them:
	 *  1. decode each `mediaId` (uploaded image/video asset) to an image block;
	 *  2. `deriveReferences` → StyleBible (+ optional persona sketch);
	 *  3. lock + activate a persona from the character on the seed-lock path
	 *     (unless `createPersona: false`), rehosting its anchor + extra refs;
	 *  4. seed the reel-level consistency context from the style (which also
	 *     folds in the now-active persona);
	 *  5. record the derived look on the durable brief (D4) unless `record: false`.
	 *
	 * The returned `bible` is ready to pass straight into `storyboard({ bible })`.
	 * Never throws: a decode/model/upload hiccup yields a `fail`/partial result.
	 */
	async function intakeReferences(input: {
		mediaIds: string[];
		hint?: string;
		createPersona?: boolean;
		personaName?: string;
		seed?: number;
		record?: boolean;
	}): Promise<DirectorResult<IntakeReferencesData>> {
		const ids = (input.mediaIds ?? []).filter(
			(id): id is string => typeof id === "string" && id.length > 0,
		);
		if (ids.length === 0) {
			return fail(
				"intakeReferences requires at least one reference mediaId (an uploaded image or video asset).",
			);
		}

		// 1. Resolve + decode each reference into an image the model can SEE.
		const entries = ids.map((id) => ({
			id,
			asset: editor.media.getAssetById(id),
		}));
		const missing = entries.filter((e) => !e.asset).map((e) => e.id);
		const decoded: { asset: MediaAsset; image: string }[] = [];
		for (const entry of entries) {
			if (!entry.asset) continue;
			const image = await decodeAssetToImage(entry.asset);
			if (image) decoded.push({ asset: entry.asset, image });
		}
		if (decoded.length === 0) {
			return fail(
				`Couldn't decode any of the ${ids.length} reference asset(s) into images${
					missing.length ? ` (${missing.length} id(s) not found)` : ""
				}. Pass uploaded IMAGE (or video) media ids.`,
			);
		}
		const images = decoded.map((d) => d.image);

		// 2. Run them through the model → derived StyleBible (+ optional persona).
		let derived: DerivedReference;
		try {
			derived = await deriveReferences(images, input.hint);
		} catch (err) {
			return fail(
				`Reference intake couldn't reach the model: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}

		const applied: string[] = [];

		// 3. Persona FIRST (so the consistency re-pull in step 4 includes it), on
		//    the seed-lock path: rehost the anchor (+ every other ref as an extra
		//    likeness photo), persist a persona, and activate it.
		let personaId: string | undefined;
		if (derived.persona && input.createPersona !== false) {
			const anchor = decoded[derived.persona.anchorIndex] ?? decoded[0];
			const anchorUrl = await resolveAnchorUrl(anchor?.asset);
			if (anchorUrl) {
				const refUrls: string[] = [];
				for (const d of decoded) {
					if (d === anchor) continue;
					const u = await resolveAnchorUrl(d.asset);
					if (u) refUrls.push(u);
				}
				const name = input.personaName?.trim() || derived.persona.name;
				const persona = await createPersonaRecord({
					name,
					descriptor: derived.persona.descriptor,
					anchorImageUrl: anchorUrl,
					...(refUrls.length ? { refImageUrls: refUrls } : {}),
					...(input.seed != null ? { seed: input.seed } : {}),
				});
				if (persona) {
					personaId = persona.id;
					usePersonaStore.getState().setActive(persona.id);
					applied.push(`locked & activated persona "${name}"`);
				}
			}
		}

		// 4. Seed the reel-level consistency context from the derived style (+ the
		//    now-active persona, which `applyConsistencyContext` pulls from the store).
		let styleApplied = false;
		if (styleHasContent(derived.style) || personaId) {
			applyConsistencyContext(bibleToConsistencyInput(derived.style) ?? {});
			styleApplied = styleHasContent(derived.style);
			if (styleApplied)
				applied.push("seeded the reel style from the reference(s)");
		}

		// 5. Record the derived look on the durable brief (D4) so it persists across turns.
		if (input.record !== false) {
			const briefLine = styleBibleToBriefLine(derived.style);
			const patch: BriefPatch = {};
			if (briefLine) patch.styleNote = briefLine;
			const note = derived.summary?.trim();
			if (note) patch.notes = [`Reference look: ${note}`];
			if (patch.styleNote || patch.notes) {
				persistBrief(applyBriefPatch(readBrief(), patch));
				applied.push("recorded the look on the director brief");
			}
		}

		// Write-through to the durable bible: the seeded style/consistency, the
		// locked persona (roster), and the recorded brief all just changed.
		if (applied.length) syncBible("intakeReferences", "Intook references");

		const headline = applied.length
			? `Reference intake (${images.length} image${images.length === 1 ? "" : "s"}): ${applied.join("; ")}.`
			: `Read ${images.length} reference(s) but derived nothing to apply.`;

		// No reel-slot change (consistency/persona/brief are session + durable
		// state, not timeline slots), so this carries DATA, not a mutation delta —
		// like getConsistencyContext/getBrief. The agent reads `bible` off DATA.
		return ok(
			`${headline}${derived.summary ? ` ${derived.summary}` : ""} Pass the returned bible to storyboard({bible}) to plan shots in this look.`,
			{
				derived,
				bible: derived.style,
				styleApplied,
				personaId,
				imageCount: images.length,
				missingMediaIds: missing,
			},
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

			// Success ⇒ commit the ready take and (maybe) auto-select it. Batched
			// as ONE undo entry — these two mutations always land back-to-back
			// with no `await` between them.
			if (result.status === "ready" && result.mediaId) {
				withAgentBatch(() => {
					editor.timeline.updateTake({ elementId, takeId, patch: result });
					if (!activeTakeIdOf(elementId)) {
						editor.timeline.selectTake({ elementId, takeId });
					}
				});
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
			// One undo entry for the whole placeholder batch, not one per take.
			withAgentBatch(() => {
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
			});
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

	// ---- BUDGET (whole-reel spend planning) -------------------------------
	//
	// Helpers first (closures over `editor`/plan), then the verbs.

	/** The priciest tier the plan assigned to any of these targeted slots (undefined if none carry a tier). */
	function priciestPlannedTier(targets: LocatedSlot[]): CostTier | undefined {
		const plan = getStoredPlan(editor);
		if (!plan) return undefined;
		const wanted = new Set(targets.map((t) => t.element.id));
		let best: CostTier | undefined;
		for (const shot of plan.shots) {
			if (!shot.slotId || !shot.tier || !wanted.has(shot.slotId)) continue;
			if (
				best === undefined ||
				TIER_ORDER.indexOf(shot.tier) > TIER_ORDER.indexOf(best)
			) {
				best = shot.tier;
			}
		}
		return best;
	}
	//
	// A reel can carry a total USD budget the Director plans spend against (see
	// `budget.ts`): the storyboard allocates the cap across shots by importance,
	// and every subsequent generation is checked against the REMAINING budget so a
	// hero shot at a premium tier can't quietly drain what six b-roll shots need.
	// The cap + running tally are session state (a WeakMap keyed by editor); the
	// authored per-shot allocation is persisted on the plan.

	/** Read the reel's budget cap, running spend, and per-shot allocation. */
	function getBudgetStatus(): DirectorResult<BudgetStatus> {
		const spend = getReelSpend(editor);
		const plan = getStoredPlan(editor);
		const status: BudgetStatus = {
			spentUsd: spend.spentUsd,
			...(spend.budgetUsd != null ? { budgetUsd: spend.budgetUsd } : {}),
			...(remainingBudgetUsd(spend) != null
				? { remainingUsd: remainingBudgetUsd(spend) }
				: {}),
			...(plan?.budget
				? {
						allocations: plan.budget.allocations,
						withinBudget: plan.budget.withinBudget,
					}
				: {}),
		};
		const msg =
			spend.budgetUsd == null
				? "No budget set for this reel."
				: `${formatSpend(spend, formatUsd)} (${formatUsd(
						Math.max(0, spend.budgetUsd - spend.spentUsd),
					)} remaining).`;
		return ok(msg, status);
	}

	/**
	 * Set (or change) the reel's total USD budget and RESET the running spend. If
	 * a storyboard plan already exists it is re-allocated against the new cap
	 * (re-tiering each shot from its located spec's cost). Use to answer "keep the
	 * whole thing under $X" after shots are laid out.
	 */
	function setBudget(input: {
		budgetUsd: number;
	}): DirectorResult<BudgetStatus> {
		if (!(input.budgetUsd > 0)) {
			return fail("setBudget requires a positive budgetUsd.");
		}
		setReelBudget(editor, input.budgetUsd);
		const plan = getStoredPlan(editor);
		if (plan && plan.shots.length > 0) {
			const baseCostUsd = plan.shots.map((s) => {
				const located = s.slotId ? findSlot(s.slotId) : null;
				return creditsToUsd(
					located
						? estimateSpecCost(located.element.generation).low
						: estimateSpecCost(buildSpec(s.prompt, s.duration)).low,
				);
			});
			applyBudgetToPlan(plan, baseCostUsd, input.budgetUsd);
			storePlan(editor, plan);
		}
		const status = getBudgetStatus();
		return ok(
			`Budget set to ${formatUsd(input.budgetUsd)}.${budgetSummary(
				plan?.budget,
			)}`,
			status.data,
		);
	}

	/**
	 * Add `usd` to the reel's running spend — called after a gated generation
	 * actually runs so "spent X of $Y" stays live. Returns the updated tally.
	 */
	function recordSpend(input: { usd: number }): ReelSpend {
		return recordReelSpend(editor, input.usd);
	}

	/**
	 * The heart of the spend gate: decide whether a proposed generation fits the
	 * REMAINING budget. Given the same targeting args `generate` takes, it (a)
	 * estimates the batch's base (cheapest-tier) cost, (b) picks the requested tier
	 * — from an explicit `backendId`'s tier, else the priciest targeted shot's
	 * planned tier, else "standard" — and (c) returns a {@link BudgetGateDecision}:
	 * proceed, down-route (with a concrete cheaper `downrouteBackendId` resolved
	 * from the live catalog), or pause. `active:false` ⇒ no budget is set, so the
	 * caller falls back to the flat approval threshold. Async only to resolve the
	 * cheaper backend from the catalog.
	 */
	async function evaluateSpend(input: {
		slotIds?: string[] | "all";
		alternatives?: number;
		backendId?: string;
	}): Promise<{
		active: boolean;
		decision?: BudgetGateDecision;
		downrouteBackendId?: string;
		spend: ReelSpend;
	}> {
		const spend = getReelSpend(editor);
		if (spend.budgetUsd == null) return { active: false, spend };

		const est = estimateGenerateCost({
			slotIds: input.slotIds,
			alternatives: input.alternatives,
		}).data;
		// LOW end (cheapest registered backend) — the "cheapest-tier" baseline
		// `planActionWithinBudget` multiplies UP by the requested tier's factor.
		// `est`'s HIGH end is the display/approval-gate's ask-early figure, a
		// different concept (see `creditsToUsd`'s doc comment).
		const baseCostUsd = creditsToUsd(est?.low ?? 0);

		// Which slots does this action hit? (drives modality + planned tier.)
		const targets = resolveTargets(input.slotIds);
		const modality: "video" | "image" =
			targets.length > 0 && targets.every((t) => t.element.type === "image")
				? "image"
				: "video";

		// Requested tier: an explicit backendId's tier wins; else the priciest
		// planned tier among the targeted shots; else "standard".
		let requestedTier: CostTier = "standard";
		const catalog = backendsProvider
			? await backendsProvider(modality).catch(
					() => [] as BackendCatalogEntry[],
				)
			: [];
		if (input.backendId) {
			const entry = catalog.find((b) => b.id === input.backendId);
			if (entry) requestedTier = entry.costTier;
			else requestedTier = "premium"; // an unknown explicit pin — assume worst case
		} else {
			requestedTier = priciestPlannedTier(targets) ?? "standard";
		}

		const decision = planActionWithinBudget({
			baseCostUsd,
			requestedTier,
			spentUsd: spend.spentUsd,
			budgetUsd: spend.budgetUsd,
		});

		let downrouteBackendId: string | undefined;
		if (decision.outcome === "downroute" && catalog.length > 0) {
			downrouteBackendId = cheapestBackendId(catalog, decision.tier);
		}

		return { active: true, decision, downrouteBackendId, spend };
	}

	/**
	 * Record the reel's FINAL spend on the durable brief (a one-line learned note),
	 * so a budget outcome survives the turn. No-op when nothing was spent under a
	 * budget. Called by the agent loop when a turn completes.
	 */
	function recordFinalSpend(): DirectorResult<{
		note?: string;
		spend: ReelSpend;
	}> {
		const spend = getReelSpend(editor);
		if (spend.budgetUsd == null || spend.spentUsd <= 0) {
			return ok("No budgeted spend to record.", { spend });
		}
		const note = `Reel spend: ${formatSpend(spend, formatUsd)}.`;
		persistBrief(applyBriefPatch(readBrief(), { notes: [note] }));
		return ok("Recorded final spend to the brief.", { note, spend });
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
			// One undo entry for the whole placeholder batch, not one per take.
			withAgentBatch(() => {
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
			});
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
		/**
		 * Explicit frame to re-condition on, overriding the source take's own last
		 * frame. The cross-shot continuity self-correction passes the PRIOR shot's
		 * frame here so the remix is anchored on the shot it must match (see
		 * `agent.ts`'s auto-review loop). Omit for the normal "fix this take against
		 * its own last frame" remix.
		 */
		anchorImageUrl?: string;
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

		// Anchor the remix on an EXPLICIT frame when given (continuity: the prior
		// shot's frame), else on the source take's REAL last frame when it's a
		// finished, imported take — true img2img re-conditioning. Falls back
		// (inside buildRemixSpec) to the prior spec's referenceImageUrl when the
		// take isn't imported yet or the frame can't be decoded.
		const anchorImageUrl =
			input.anchorImageUrl ??
			(source.mediaId
				? await extractTakeLastFrame(
						editor.media.getAssetById(source.mediaId),
						source.id,
					)
				: undefined);

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
		// One undo entry for "queue the take" (+ the immediate "generating"
		// transition, when there's an executor to run it) — both always land
		// with no `await` between them.
		withAgentBatch(() => {
			editor.timeline.addTakeToElement({
				elementId: input.slotId,
				take: newTake,
			});
			if (executor) {
				editor.timeline.updateTake({
					elementId: input.slotId,
					takeId: newTake.id,
					patch: { status: "generating" },
				});
			}
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
		// One undo entry for the result landing (+ auto-select, when it
		// applies) — again always adjacent with no `await` between them.
		withAgentBatch(() => {
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
		});

		return withDelta(
			before,
			ok(`Remixed slot "${input.slotId}".`, {
				slotId: input.slotId,
				takeId: newTake.id,
			}),
		);
	}

	// ---- FRAME EXTRACTION / CHAINING --------------------------------------
	//
	// The stills that let the Director stitch generated shots: pull a full-res
	// frame from a slot's take (or a library asset) into the media library with
	// provenance, and seed the NEXT slot on the PRIOR slot's last frame.

	/**
	 * Resolve the VIDEO asset a frame should be pulled from — either a slot's
	 * active (else most-recent) rendered take, or a direct library media id.
	 * Returns the asset plus a human name, or an error message.
	 */
	function resolveFrameSourceAsset(input: {
		slotId?: string;
		mediaId?: string;
	}): { asset: MediaAsset; name: string } | { error: string } {
		if (input.mediaId) {
			const asset = editor.media.getAssetById(input.mediaId);
			if (!asset)
				return { error: `No media asset with id "${input.mediaId}".` };
			if (asset.type !== "video")
				return { error: `Asset "${input.mediaId}" is not a video.` };
			return { asset, name: asset.name };
		}
		if (input.slotId) {
			const located = findSlot(input.slotId);
			if (!located) return { error: `No slot with id "${input.slotId}".` };
			const takes = takesOf(located.element);
			const source = located.element.activeTakeId
				? takes.find((t) => t.id === located.element.activeTakeId)
				: takes[takes.length - 1];
			if (!source?.mediaId)
				return {
					error: `Slot "${input.slotId}" has no rendered take to extract a frame from — generate one first.`,
				};
			const asset = editor.media.getAssetById(source.mediaId);
			if (!asset)
				return { error: `Slot "${input.slotId}"'s take media is missing.` };
			if (asset.type !== "video")
				return { error: `Slot "${input.slotId}"'s take is not a video.` };
			return { asset, name: located.element.name || asset.name };
		}
		return { error: "extractFrame requires a slotId or mediaId." };
	}

	/**
	 * Extract a full-resolution still from a slot's take (or a library asset) and
	 * add it to the media library WITH provenance, returning its media id and a
	 * hosted, generation-usable URL. `position` picks the first/last visible
	 * frame of the (untrimmed) source video, or an explicit `atTimeSec`.
	 */
	async function extractFrame(input: {
		slotId?: string;
		mediaId?: string;
		position: "first" | "last" | { atTimeSec: number };
	}): Promise<DirectorResult<{ mediaId: string; url: string }>> {
		const before = captureReel();
		const resolved = resolveFrameSourceAsset(input);
		if ("error" in resolved) return fail(resolved.error);
		const { asset, name } = resolved;

		let projectId: string;
		try {
			projectId = editor.project.getActive().metadata.id;
		} catch {
			return fail("No active project to add the frame to.");
		}

		// Library assets / takes are the FULL source (no trim), so a full-span
		// synthetic element gives the right first/last source time. A "last"
		// extraction needs the REAL duration: asset metadata can lack one (some
		// containers report NaN/0 at import), and a 0-duration span would silently
		// resolve "last" to t=0 — the FIRST frame. Probe the container instead,
		// and fail honestly if it can't be determined.
		let label: DerivedFrameLabel;
		let timeSec: number;
		if (input.position === "first") {
			label = "first frame";
			timeSec = firstFrameSourceTime({
				startTime: 0,
				duration: asset.duration ?? 0,
				trimStart: 0,
			});
		} else if (input.position === "last") {
			label = "last frame";
			const durationSec =
				Number.isFinite(asset.duration) && (asset.duration as number) > 0
					? (asset.duration as number)
					: await probeDuration({
							videoFile: asset.file,
							videoUrl: asset.url,
							name: asset.name,
						});
			if (!(Number.isFinite(durationSec) && (durationSec as number) > 0)) {
				return fail(
					`Couldn't determine the duration of "${name}" — can't locate its last frame.`,
				);
			}
			timeSec = lastFrameSourceTime({
				startTime: 0,
				duration: durationSec as number,
				trimStart: 0,
			});
		} else {
			label = "frame";
			timeSec = Math.max(0, input.position.atTimeSec);
		}

		let extracted: Awaited<ReturnType<typeof extractAndAddFrame>>;
		try {
			extracted = await extractAndAddFrame({
				editor,
				projectId,
				source: {
					videoFile: asset.file,
					videoUrl: asset.url,
					name: asset.name,
				},
				sourceAssetId: asset.id,
				sourceName: name,
				timeSec,
				label,
				decode: decodeFrame,
			});
		} catch (err) {
			return fail(
				err instanceof Error ? err.message : "Frame extraction failed.",
			);
		}

		let url: string;
		try {
			url = await uploadFrame(dataUrlToFile(extracted.dataUrl, extracted.name));
		} catch (err) {
			return fail(
				`Extracted the frame but couldn't rehost it for generation: ${
					err instanceof Error ? err.message : "upload failed"
				}.`,
			);
		}

		return withDelta(
			before,
			ok(`Extracted ${label} of "${name}" → "${extracted.name}".`, {
				mediaId: extracted.mediaId,
				url,
			}),
		);
	}

	/**
	 * Chain slot `toSlotId` onto the LAST frame of slot `fromSlotId`: extract the
	 * source slot's real last frame (added to the library with provenance) and
	 * stamp it onto the target slot's generation spec as `referenceImageUrl` with
	 * `mode: "image-to-video"` — the base first-frame conditioning every i2v-
	 * capable backend supports (mirrors how `remix` re-conditions). Does NOT
	 * generate; call `generate`/`reroll` on the target slot afterward.
	 */
	async function chainFrom(input: {
		fromSlotId: string;
		toSlotId: string;
	}): Promise<
		DirectorResult<{ toSlotId: string; url: string; mediaId: string }>
	> {
		const before = captureReel();
		if (input.fromSlotId === input.toSlotId)
			return fail("chainFrom needs two different slots.");
		const to = findSlot(input.toSlotId);
		if (!to) return fail(`No slot with id "${input.toSlotId}".`);

		const extracted = await extractFrame({
			slotId: input.fromSlotId,
			position: "last",
		});
		if (!extracted.ok || !extracted.data) return fail(extracted.message);
		const { url, mediaId } = extracted.data;

		const nextSpec: GenerationSpec = {
			...to.element.generation,
			referenceImageUrl: url,
			mode: "image-to-video",
		};
		editor.timeline.setSlotSpec({ elementId: input.toSlotId, spec: nextSpec });

		return withDelta(
			before,
			ok(
				`Chained slot "${input.toSlotId}" onto the last frame of "${input.fromSlotId}". Generate it to render the meshed shot.`,
				{ toSlotId: input.toSlotId, url, mediaId },
			),
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
	// audience, tone, one-line style note, target duration, do/don't constraints,
	// and learned notes. Unlike the session-only consistency context above, it
	// lives on the active `TProject`
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

	/** Compact, durable snapshot of the reusable persona roster for the bible. */
	function personaRoster(): PersonaRosterEntry[] {
		return usePersonaStore.getState().personas.map((p) => ({
			id: p.id,
			name: p.name,
			descriptor: p.descriptor,
		}));
	}

	/**
	 * WRITE-THROUGH to the durable {@link ProjectBible}: capture the editor's
	 * current Director state (brief + consistency context + plan + persona roster),
	 * checkpoint the prior bible, and persist. Called after every creative-state
	 * mutation (setConsistencyContext / storyboard / updateBrief / intakeReferences)
	 * so the persisted bible stays the source of truth the WeakMaps hydrate from.
	 * Best-effort: a persistence hiccup must never break the verb that triggered it.
	 */
	function syncBible(label: string, note?: string): void {
		try {
			syncProjectBible(editor, { label, note, personas: personaRoster() });
		} catch {
			// swallow — the WeakMap write already succeeded; the bible is a cache-behind.
		}
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
	 * Update the durable brief. Scalar fields (goal/audience/tone/styleNote)
	 * REPLACE; `durationSec` REPLACES the target duration (0 or below clears it);
	 * `dos`/`donts` APPEND (deduped); `notes` append learned one-liners (capped).
	 * An empty string clears a scalar. Returns the merged brief.
	 */
	function updateBrief(patch: BriefPatch): DirectorResult<DirectorBrief> {
		const next = persistBrief(applyBriefPatch(readBrief(), patch));
		syncBible("updateBrief", "Updated director brief");
		return ok("Director brief updated.", next);
	}

	// ---- PROJECT BIBLE (durable, versioned creative memory) ---------------
	//
	// The bible is written through automatically by the creative-state verbs above
	// (setConsistencyContext / storyboard / updateBrief / intakeReferences). These
	// two verbs expose the DURABLE artifact itself: read the current bible (with its
	// checkpoint history) and REVERT to a prior checkpoint — "revert the look to
	// before the last change" — re-hydrating the session WeakMaps from the restored
	// state. See `lib/director/project-bible.ts`.

	/** Read the persisted Project Bible (durable creative memory + checkpoint history). */
	function getProjectBible(): DirectorResult<ProjectBible | undefined> {
		return ok("Project bible.", editor.project.getProjectBible());
	}

	/**
	 * Revert the bible to a prior checkpoint (a specific `toVersion`, else the most
	 * recent change) and re-hydrate the live consistency/plan state + brief from it.
	 * Reports a no-op when there is nothing to revert to.
	 */
	function revertBibleCheckpoint(input?: {
		toVersion?: number;
	}): DirectorResult<RevertResult> {
		const before = captureReel();
		const result = revertProjectBible(editor, {
			...(input?.toVersion != null ? { toVersion: input.toVersion } : {}),
		});
		if (!result.reverted) {
			return fail(
				input?.toVersion != null
					? `No checkpoint v${input.toVersion} to revert to.`
					: "No earlier checkpoint to revert to.",
			);
		}
		return withDelta(
			before,
			ok(
				`Reverted the project bible to checkpoint v${result.toVersion} (now v${result.bible.version}).`,
				result,
			),
		);
	}

	// ---- FLOW D: human APPROVAL gates -------------------------------------
	//
	// The human's job collapses to EXPRESS / REACT / APPROVE. These verbs are the
	// two creative APPROVE gates (the third, voice-clone consent, lives in the
	// consent store below). Each approval WRITES ITS RATIONALE INTO THE BIBLE via
	// the existing durable paths — a brief note (prompt-facing memory) plus a
	// checkpointed entry in the bible's approvals ledger — so decisions compound.
	// Rejection is simply NOT calling approve: nothing permanent is recorded.

	/**
	 * HERO-SHOT approval gate. The human approves a specific shot's take as THE
	 * hero: the take is selected active (the approval choice), a rationale is
	 * folded into the durable brief, and a `hero-shot` entry is checkpointed into
	 * the bible's approvals ledger referencing the slot/take/asset — so the
	 * manifest/proposals/consistency can treat it as the approved hero.
	 */
	function approveHeroShot(input: {
		slotId: string;
		takeId?: string;
		index?: number;
		rationale?: string;
	}): DirectorResult<SlotSnapshot> {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);

		const takes = takesOf(located.element);
		let take: Take | undefined;
		if (input.takeId) {
			take = takes.find((t) => t.id === input.takeId);
			if (!take) {
				return fail(`Slot "${input.slotId}" has no take "${input.takeId}".`);
			}
		} else if (input.index != null) {
			take = takes[input.index];
			if (!take) {
				return fail(
					`Slot "${input.slotId}" has no take at index ${input.index} (has ${takes.length}).`,
				);
			}
		} else {
			take = pickReviewTake(located.element);
		}
		if (!take) {
			return fail(
				`Slot "${input.slotId}" has no take to approve — generate one first.`,
			);
		}

		// Selecting the take IS the approval choice (mirrors chooseTake).
		editor.timeline.selectTake({ elementId: input.slotId, takeId: take.id });

		const chosenIndex = takes.findIndex((t) => t.id === take.id);
		const promptSnippet = briefSnippet(located.element.generation.prompt);
		const rationale = input.rationale?.trim();
		const takeRef = `take ${chosenIndex + 1}/${takes.length}`;
		const forPrompt = promptSnippet ? ` — "${promptSnippet}"` : "";
		const note = `Approved hero shot "${input.slotId}" (${takeRef}${forPrompt})${
			rationale ? `: ${rationale}` : "."
		}`;
		persistBrief(applyBriefPatch(readBrief(), { notes: [note] }));

		const approval: BibleApproval = {
			kind: "hero-shot",
			at: Date.now(),
			...(rationale ? { rationale } : {}),
			ref: {
				slotId: input.slotId,
				takeId: take.id,
				...(take.mediaId ? { mediaId: take.mediaId } : {}),
			},
		};
		try {
			recordBibleApproval(editor, approval, {
				label: "approveHeroShot",
				note,
				personas: personaRoster(),
			});
		} catch {
			// best-effort — the take selection + brief note already landed.
		}

		const updated = findSlot(input.slotId);
		return withDelta(
			before,
			ok(
				`Approved hero shot "${input.slotId}" (take ${chosenIndex + 1}/${takes.length}).`,
				updated ? toSnapshot(updated.element) : undefined,
			),
		);
	}

	/**
	 * FINAL-CUT approval gate — the human's sign-off before export/render
	 * finalization. Records the approval + a summary of what shipped into the
	 * bible (approvals ledger + brief note). A SOFT gate: it does not render; the
	 * Director asks for it before `export`, and the manual UI Export button is
	 * itself the human approval (not nagged/blocked).
	 */
	function approveFinalCut(input?: {
		summary?: string;
		rationale?: string;
	}): DirectorResult<BibleApproval> {
		const totalDuration = editor.timeline.getTotalDuration();
		if (totalDuration === 0) {
			return fail(
				"Nothing to approve — the timeline is empty. Storyboard and generate some shots first.",
			);
		}
		const slotCount = captureReel().slots.size;
		const summary =
			input?.summary?.trim() ||
			`${slotCount} shot${slotCount === 1 ? "" : "s"}, ${totalDuration.toFixed(1)}s`;
		const rationale = input?.rationale?.trim();
		const note = `Approved final cut (${summary})${rationale ? `: ${rationale}` : "."}`;
		persistBrief(applyBriefPatch(readBrief(), { notes: [note] }));

		const approval: BibleApproval = {
			kind: "final-cut",
			at: Date.now(),
			summary,
			...(rationale ? { rationale } : {}),
		};
		try {
			recordBibleApproval(editor, approval, {
				label: "approveFinalCut",
				note,
				personas: personaRoster(),
			});
		} catch {
			// best-effort — the brief note already landed.
		}
		return ok(`Final cut approved — ${summary}. Ready to export.`, approval);
	}

	/** True when a final-cut approval is on record in the bible (soft-gate check). */
	function hasFinalCutApproval(): boolean {
		try {
			const bible = editor.project.getProjectBible?.();
			return (bible?.approvals ?? []).some((a) => a.kind === "final-cut");
		} catch {
			return false;
		}
	}

	// ---- FLOW D: voice-clone consent (read + revoke; GRANT is UI-only) -----
	//
	// Consent is a deliberate HUMAN act (record your voice reading the phrase) and
	// is captured in the Voiceover panel — the agent must never fabricate it, so
	// there is no grant verb. The Director can SEE consent status (to tell the user
	// what's blocking a clone) and REVOKE on request (immediate disable). The gate
	// itself is enforced in `addVoiceover` + `generateVoiceoverTakeMedia`.

	/** Read the cloned-voice consent registry (status per clone). */
	function getVoiceProfiles(): DirectorResult<{
		profiles: ClonedVoiceProfile[];
	}> {
		const profiles = useVoiceConsentStore.getState().listProfiles();
		const pending = profiles.filter(
			(p) => p.consentStatus !== "consented",
		).length;
		return ok(
			profiles.length === 0
				? "No cloned voices registered."
				: `${profiles.length} cloned voice(s); ${pending} not usable until consented.`,
			{ profiles },
		);
	}

	/** Revoke consent for a cloned voice — immediately disables it for all TTS. */
	function revokeVoiceConsent(input: {
		profileId: string;
		reason?: string;
	}): DirectorResult<{ profile: ClonedVoiceProfile }> {
		const profile = useVoiceConsentStore
			.getState()
			.revokeProfileConsent(input.profileId, {
				...(input.reason ? { reason: input.reason } : {}),
			});
		if (!profile) return fail(`No voice profile "${input.profileId}".`);
		return ok(
			`Revoked consent for voice "${profile.name}" — it can no longer be used to generate speech.`,
			{ profile },
		);
	}

	// ---- FLOW D follow-up B: Understanding style probe → styleBible --------

	/**
	 * Route an Understanding-Pass style read for one asset into the Project Bible's
	 * `styleBible` — additive + checkpointed, and NEVER clobbering a human-set look
	 * (an existing styleBible is preserved and the read is logged as a note unless
	 * `force`). Needs the injected `styleProbe` lookup; absent ⇒ nothing to seed.
	 */
	function seedStyleFromUnderstanding(input: {
		mediaId: string;
		force?: boolean;
	}): DirectorResult<StyleProbeSeedResult> {
		const probe = options.styleProbe?.(input.mediaId);
		if (!probe) {
			return fail(
				`No style read available for "${input.mediaId}" — run the Understanding Pass on it first.`,
			);
		}
		const result = seedStyleBibleFromProbe(editor, probe, {
			...(input.force ? { force: true } : {}),
		});
		if (result.seeded) {
			return ok(
				"Seeded the Project Bible's styleBible from the style read.",
				result,
			);
		}
		if (result.noted) {
			return ok(
				"styleBible already set — preserved the human look and logged the style read as a note.",
				result,
			);
		}
		return fail("The style read was empty — nothing to seed.");
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

		// CONSENT GATE (Flow D #1): refuse to speak a cloned voice whose profile is
		// not `consented`. Server-side-equivalent enforcement in the Director path —
		// client-side UI gating alone is not a gate. A built-in speaker / unknown
		// ref passes (see `voice-consent-store`).
		if (
			input.voiceRef &&
			!useVoiceConsentStore.getState().isReferenceUsable(input.voiceRef)
		) {
			const profile = useVoiceConsentStore
				.getState()
				.getByReference(input.voiceRef);
			return fail(
				`Voice clone "${profile?.name ?? input.voiceRef}" is ${
					profile?.consentStatus ?? "pending"
				} — it can't be used until the speaker's consent is captured. ` +
					"Ask the user to record their consent statement in the Voiceover panel first.",
			);
		}

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

	/**
	 * Auto-cut silence out of a slot's clip. Resolves the slot's underlying media
	 * (a placed clip's `mediaId`, or a generative slot's active/most-recent
	 * take), analyzes its audio for dead air, and hard-cuts the silent stretches
	 * via the apply layer — ONE undoable step, downstream slots ripple left. All
	 * time knobs are SECONDS; `threshold` is a 0–1 loudness level. Omitted knobs
	 * fall through to the engine's contract defaults.
	 */
	async function removeSilence(input: {
		slotId: string;
		threshold?: number;
		marginBefore?: number;
		marginAfter?: number;
		minKeep?: number;
		minCut?: number;
	}): Promise<DirectorResult<AutoCutApplySummary>> {
		const before = captureReel();
		const located = findSlot(input.slotId);
		if (!located) return fail(`No slot with id "${input.slotId}".`);
		const el = located.element;

		// A placed clip carries `mediaId` directly; a generative slot mirrors its
		// active (else most-recent) take's media.
		let mediaId =
			"mediaId" in el && el.mediaId ? (el.mediaId as string) : undefined;
		if (!mediaId) {
			const takes = takesOf(el);
			const take = el.activeTakeId
				? takes.find((t) => t.id === el.activeTakeId)
				: takes[takes.length - 1];
			mediaId = take?.mediaId;
		}
		if (!mediaId) {
			return fail(
				`Slot "${input.slotId}" has no rendered media to analyze — generate or place a clip first.`,
			);
		}
		const asset = editor.media.getAssetById(mediaId);
		if (!asset?.file) {
			return fail(
				`Slot "${input.slotId}"'s media file isn't available for silence analysis.`,
			);
		}

		let analysis: Awaited<ReturnType<typeof analyzeMediaSilence>>;
		try {
			analysis = await analyzeMediaSilence(asset.file, {
				threshold: input.threshold,
				marginBefore: input.marginBefore,
				marginAfter: input.marginAfter,
				minKeep: input.minKeep,
				minCut: input.minCut,
			});
		} catch (err) {
			return fail(
				`Couldn't analyze "${asset.name}" for silence: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}

		const summary = applyAutoCut({
			editor,
			elementId: el.id,
			segments: analysis.segments,
		});
		if (!summary) {
			return fail(`Slot "${input.slotId}" is no longer on the timeline.`);
		}
		if (summary.removedCount === 0) {
			return withDelta(
				before,
				ok(`No silence to remove in slot "${input.slotId}".`, summary),
			);
		}
		return withDelta(
			before,
			ok(
				`Removed ${summary.removedCount} silent section${
					summary.removedCount === 1 ? "" : "s"
				} (${summary.removedSeconds.toFixed(2)}s) from slot "${input.slotId}".`,
				summary,
			),
		);
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

	/** Trailer appended to a successful undo/redo — the ids/times the agent
	 * was holding from before this call may no longer describe the reel. */
	const STALE_STATE_NOTE =
		" Note: any slot/take ids or times you were tracking before this call may now be stale — call getReel before referencing them again.";

	/**
	 * Agent-scoped undo (poach: palmier-mcp-schema-spec.md §"Agent-scoped
	 * undo"; A2). Refuses when the top of the undo stack wasn't made by the
	 * agent — i.e. the human has edited since the agent's last change — so
	 * the Director can never blow away a manual edit it didn't make.
	 */
	function undo(): DirectorResult {
		const topOrigin = editor.command.peekUndoOrigin();
		if (topOrigin === undefined) return fail("Nothing to undo.");
		if (topOrigin !== "agent") {
			return fail(
				"Can't undo — the most recent edit is the user's; their edits are theirs to undo.",
			);
		}
		const before = captureReel();
		const name = editor.command.peekUndoName();
		editor.command.undo();
		return withDelta(
			before,
			ok(`Undid "${name ?? "last action"}".${STALE_STATE_NOTE}`),
		);
	}

	/** Mirror of {@link undo}: refuses to redo an edit that wasn't the
	 * agent's own (e.g. the human undid their own edit via the UI). */
	function redo(): DirectorResult {
		const topOrigin = editor.command.peekRedoOrigin();
		if (topOrigin === undefined) return fail("Nothing to redo.");
		if (topOrigin !== "agent") {
			return fail(
				"Can't redo — the most recently undone edit is the user's; their edits are theirs to redo.",
			);
		}
		const before = captureReel();
		editor.command.redo();
		return withDelta(before, ok(`Redid last action.${STALE_STATE_NOTE}`));
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
	 *
	 * JOBID CONTRACT (poach: palmier-delta-refresh-2026-07-14.md §4.4, idea
	 * only — clean-room, no palmier-pro source consulted): a stable `jobId` is
	 * minted per invocation and returned in `data` alongside `status`, which
	 * is typed as the full future {@link ExportJobStatus} lifecycle even
	 * though only `"completed"`/`"failed"` are ever emitted today (export is
	 * still single-shot and synchronous — no queue, no `manage_exports`, no
	 * "queued"/"preparing"/"rendering" state exists yet). The point is that a
	 * FIFO `ExportQueue` can start emitting the rest of that enum later
	 * without breaking this response shape. Handoff to the browser download
	 * is gated through {@link commitExport} — see its doc for the write-path
	 * audit (in-memory buffer, no durable intermediate to stage on disk).
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
			jobId: string;
			status: ExportJobStatus;
			format?: ExportFormat;
			bytes?: number;
			durationSeconds?: number;
			downloaded?: boolean;
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

		const jobId = createExportJobId();

		const options: ExportOptions = {
			format: input?.format ?? DEFAULT_EXPORT_OPTIONS.format,
			quality: input?.quality ?? DEFAULT_EXPORT_OPTIONS.quality,
			fps: project.settings.fps,
			includeAudio: input?.includeAudio ?? DEFAULT_EXPORT_OPTIONS.includeAudio,
			includeWatermark: input?.includeWatermark ?? true,
		};

		const result = await editor.project.export({ options });

		const outcome = commitExport({
			result,
			jobId,
			filename: `${project.metadata.name}${getExportFileExtension({ format: options.format })}`,
			mimeType: getExportMimeType({ format: options.format }),
			download: input?.download ?? true,
		});

		if (outcome.status === "failed") {
			const message =
				outcome.reason === "cancelled"
					? outcome.message
					: `Export failed: ${outcome.message}.`;
			return {
				ok: false,
				message,
				data: { jobId, status: "failed" },
			};
		}

		const megabytes = outcome.bytes / (1024 * 1024);
		// SOFT final-cut gate (Flow D #3): the Director should get the human's
		// final-cut sign-off before finalizing. We never hard-block (a manual UI
		// Export IS the human's approval); we just note a missing approval so the
		// agent is nudged to call approveFinalCut next time.
		const finalCutNote = hasFinalCutApproval()
			? ""
			: " (note: no final-cut approval on record — call approveFinalCut before export next time).";
		// Same cross-browser decode fallback surfaced as a toast in the manual
		// export UI (export-button.tsx) — appended here so the agent (and
		// whoever reads its transcript) also sees the quality tradeoff.
		const degradationNote =
			result.warnings && result.warnings.length > 0
				? ` (note: ${result.warnings.join(" ")})`
				: "";
		return ok(
			`Exported "${project.metadata.name}" — ${options.format.toUpperCase()}, ` +
				`${megabytes.toFixed(1)} MB, ${durationSeconds.toFixed(1)}s` +
				(outcome.downloaded ? " (downloaded)." : ".") +
				finalCutNote +
				degradationNote,
			{
				jobId,
				status: "completed",
				format: options.format,
				bytes: outcome.bytes,
				durationSeconds,
				downloaded: outcome.downloaded,
			},
		);
	}

	/**
	 * Director/MCP verb choke point (A2, poach: palmier-mcp-schema-spec.md
	 * §"Agent-scoped undo"). Wraps EVERY verb below so a single call becomes
	 * exactly one origin-`"agent"`, verb-named undo entry — no per-verb
	 * changes needed. An external MCP call relays through this SAME
	 * `DirectorApi` (never `editor.command`/`editor.timeline` directly), so
	 * it inherits `"agent"` for free; the manual UI drives the managers
	 * directly and never calls through here, so its edits keep
	 * `CommandManager`'s `"user"` default untouched.
	 *
	 * For a SYNCHRONOUS verb this brackets the whole call in a transaction —
	 * safe, because nothing yields to the event loop, so no concurrent
	 * command can land in the shared buffer.
	 * `storyboard`/`acceptProposal`/`reorder`'s own explicit
	 * begin/commit nests inside this one for free (see
	 * `CommandManager.beginTransaction`'s frame-stack doc) — no changes
	 * needed there either.
	 *
	 * For an ASYNC verb, holding a transaction open across a real `await`
	 * would risk sweeping an unrelated concurrent command (e.g. a manual user
	 * edit made while a generation network call is in flight) into the
	 * agent's batch — corrupting both its origin AND its atomicity (a
	 * rollback would silently discard the user's already-executed edit from
	 * undo history). So instead: commit whatever ran before the verb's first
	 * real `await` (often nothing; occasionally a whole synchronous
	 * "no executor" placeholder loop — see `runTakesForSlot`/`compareTake`),
	 * then fall back to `pushOrigin` for the rest of the call — every
	 * subsequent mutation still lands tagged `"agent"`, just as its own entry
	 * unless the verb explicitly batches a post-await cluster with
	 * `withAgentBatch` (see `remix`, `runTakeWithRecovery`'s ready branch).
	 * Residual gap, documented rather than silently accepted: a `generate`
	 * call that retries/rephrases still produces multiple *correctly agent-
	 * tagged* history entries (queued → generating → ready are genuinely
	 * separated by network awaits) rather than collapsing to one.
	 */
	function withAgentOrigin<F extends (...args: never[]) => unknown>(
		name: string,
		fn: F,
	): F {
		const wrapped = (...args: Parameters<F>): ReturnType<F> => {
			editor.command.beginTransaction({ origin: "agent", name });
			let result: ReturnType<F>;
			try {
				result = fn(...args) as ReturnType<F>;
			} catch (error) {
				editor.command.rollbackTransaction();
				throw error;
			}
			if (result instanceof Promise) {
				editor.command.commitTransaction();
				const popOrigin = editor.command.pushOrigin("agent", name);
				return result.finally(popOrigin) as ReturnType<F>;
			}
			editor.command.commitTransaction();
			return result;
		};
		return wrapped as F;
	}

	/** Apply {@link withAgentOrigin} to every verb except lifecycle (`undo`/
	 * `redo` act ON history — they refuse/tag by inspecting it, they don't
	 * create new entries, so wrapping them would be a meaningless no-op at
	 * best). */
	function wrapVerbs<T extends Record<string, unknown>>(api: T): T {
		const wrapped = { ...api };
		for (const key of Object.keys(api) as (keyof T & string)[]) {
			if (key === "undo" || key === "redo") continue;
			const value = api[key];
			if (typeof value === "function") {
				(wrapped as Record<string, unknown>)[key] = withAgentOrigin(
					key,
					value as (...args: never[]) => unknown,
				);
			}
		}
		return wrapped;
	}

	return wrapVerbs({
		// read
		getReel,
		getSlot,
		getProjectInfo,
		getLibraryManifest,
		getTranscript,
		getBackends,
		// media search / placement
		searchMedia,
		findDuplicateAssets,
		addClip,
		// storyboard
		storyboard,
		intakeReferences,
		reserveSlot,
		setPrompt,
		// propose-first drafting (Flow B)
		proposeReel,
		reviseProposal,
		acceptProposal,
		getProposal,
		// generate
		estimateGenerateCost,
		generate,
		reroll,
		compareTake,
		remix,
		extractFrame,
		chainFrom,
		chooseTake,
		reviewTake,
		// budget (whole-reel spend planning)
		getBudgetStatus,
		setBudget,
		recordSpend,
		evaluateSpend,
		recordFinalSpend,
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
		// project bible (durable, versioned creative memory + checkpoint revert)
		getProjectBible,
		revertBibleCheckpoint,
		// Flow D — human approval gates
		approveHeroShot,
		approveFinalCut,
		getVoiceProfiles,
		revokeVoiceConsent,
		seedStyleFromUnderstanding,
		// edit
		trim,
		move,
		split,
		reorder,
		remove,
		removeSilence,
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
	});
}

export type DirectorApi = ReturnType<typeof createDirectorApi>;
