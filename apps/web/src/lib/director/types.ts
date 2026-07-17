/**
 * Director API — director-specific types.
 *
 * This module layers a coarse, agent-friendly command façade on top of the
 * editor. The *generative* model (a clip is a slot iff `element.generation` is
 * set; alternates live in `element.takes`) is CANONICAL and owned by
 * `@/types/timeline` — we re-export those types here for convenience but never
 * redefine them.
 *
 * The only NEW types this module owns are the agent-facing snapshot shapes
 * (`ReelSnapshot`, `SlotSnapshot`), the guarded result envelope
 * (`DirectorResult`), and the injectable generation boundary
 * (`GenerateExecutor`).
 *
 * Design rules (docs §8 "Director command API"):
 *  - Few, coarse, stable, agent-friendly verbs.
 *  - Stable IDs (a slot id IS its underlying element id).
 *  - Idempotent where reasonable.
 *  - Compact, readable state snapshots.
 *  - Self-describing guarded returns: validate inputs and return plain-language
 *    `{ ok, message, data? }` results instead of throwing.
 */

import type {
	GenerationSpec,
	GenerativeFields,
	SafetyTier,
	Take,
	TakeStatus,
} from "@/types/timeline";
import type { ConsistencyContext } from "./consistency-prompt";
import type { StoryboardPlan, StyleBible } from "./storyboard-plan";
import type { DerivedReference } from "./reference-intake";
import type { ReelSpend, ShotAllocation } from "./budget";
import type { LibraryManifest } from "./asset-manifest";

// Re-export the canonical generative types so Director consumers have a single
// import site. These are NOT redefined — they live in `@/types/timeline`.
export type { GenerationSpec, GenerativeFields, SafetyTier, Take, TakeStatus };

/** Compact, agent-readable snapshot of a single generative slot. */
export interface SlotSnapshot {
	/** Slot id == underlying timeline element id. */
	id: string;
	/** Current prompt (empty string if the slot has no spec yet). */
	prompt: string;
	/** Derived status: the active/most-recent take's status, or "empty". */
	status: TakeStatus | "empty";
	/** Number of takes generated for this slot. */
	takeCount: number;
	/** All takes, in creation order. */
	takes: Take[];
	/** Currently selected take id, if any. */
	activeTakeId?: string;
	/** Timeline start time in seconds. */
	start: number;
	/** Duration in seconds. */
	duration: number;
}

/** Compact, agent-readable snapshot of the whole reel. */
export interface ReelSnapshot {
	/** Slots in timeline order (by start time). */
	slots: SlotSnapshot[];
	/** Total timeline duration in seconds. */
	totalDuration: number;
	/**
	 * The brief's target reel length in seconds (`DirectorBrief.durationSec`),
	 * carried alongside `totalDuration` so a single `getReel` call gives a
	 * built-vs-target pacing check ("34s built / 60s target") without the agent
	 * having to separately call `getBrief` and do the arithmetic itself. Absent
	 * when the user hasn't stated a target duration.
	 */
	targetDurationSec?: number;
	canUndo: boolean;
	canRedo: boolean;
	/** Reel-level STYLE/CHARACTERS/SETTING block, if set (see `consistency-prompt.ts`). */
	consistency?: ConsistencyContext;
	/**
	 * The active multi-shot storyboard plan, if one was authored (see
	 * `storyboard-plan.ts`). Persisted per editor so later turns read back the
	 * per-shot intent and shared style bible instead of re-deriving them.
	 */
	plan?: StoryboardPlan;
	/**
	 * The reel's running spend against its budget cap, if a budget is active (see
	 * `budget.ts`). Surfaced so the panel can render "spent X of $Y" live.
	 */
	spend?: ReelSpend;
}

/**
 * The reel's budget + running spend, as {@link DirectorApi.getBudgetStatus}
 * reports it. `budgetUsd`/`remainingUsd` are absent when no cap is set;
 * `allocations` mirrors the persisted plan's per-shot tier split.
 */
export interface BudgetStatus {
	/** Active USD cap, or undefined when the reel is unbudgeted. */
	budgetUsd?: number;
	/** Actual USD spent so far this turn/session. */
	spentUsd: number;
	/** USD left before the cap (undefined when unbudgeted). */
	remainingUsd?: number;
	/** Per-shot tier + planned USD from the authored plan, if one exists. */
	allocations?: ShotAllocation[];
	/** Whether the authored allocation fits the cap (false ⇒ generation will pause). */
	withinBudget?: boolean;
}

/**
 * A single slot's change within a {@link MutationDelta}. Only the fields that
 * actually changed are present, so a status-only flip is `{ id, status }`. All
 * ids are SHORT ids (see `short-id.ts`); all times are in SECONDS.
 */
export interface SlotChange {
	/** Short slot id. */
	id: string;
	/** New prompt, when it changed. */
	prompt?: string;
	/** New derived status, when it changed. */
	status?: TakeStatus | "empty";
	/** New take count, when it changed. */
	takes?: number;
	/** New start time (seconds), when it changed and not folded into a shift. */
	start?: number;
	/** New duration (seconds), when it changed. */
	duration?: number;
	/** New active take (short id), when the selected take changed. */
	activeTake?: string;
}

/**
 * A run of >= 3 clips on one track whose start times all moved by the same
 * amount (e.g. an insert/reorder that pushes everything downstream). Compresses
 * what would otherwise be many near-identical {@link SlotChange} entries.
 */
export interface UniformShift {
	/** Short id of the track the shifted clips live on. */
	track: string;
	/** Clips whose start was at or after this time (seconds) moved. */
	fromSeconds: number;
	/** Signed amount each start time moved, in seconds. */
	bySeconds: number;
	/** How many clips this rule covers. */
	count: number;
}

/**
 * Compact, LLM-facing description of what a mutating verb changed, diffed from
 * before/after reel snapshots. Absent arrays mean "nothing of that kind
 * changed". Ids are SHORT; times are SECONDS.
 */
export interface MutationDelta {
	/** Slots created by this verb. */
	added?: SlotChange[];
	/** Short ids of slots removed by this verb. */
	removed?: string[];
	/** Slots whose fields changed, listed individually (capped at 30). */
	changed?: SlotChange[];
	/** Uniform start-time shifts (>= 3 clips), replacing individual entries. */
	shifts?: UniformShift[];
	/** Count of `changed` entries omitted when more than 30 slots changed. */
	truncated?: number;
}

/**
 * Standard self-describing result. Every mutating verb returns one of these so
 * a human UI or an agent can branch on `ok` and surface `message` directly
 * instead of catching exceptions.
 */
export interface DirectorResult<T = undefined> {
	ok: boolean;
	/** Plain-language explanation, suitable to show a user or feed an agent. */
	message: string;
	/** Verb-specific payload (e.g. created slot ids, the resulting snapshot). */
	data?: T;
	/**
	 * Compact diff of what this mutation changed (short ids, seconds). Present on
	 * successful mutating verbs; absent on read-only verbs and on failures.
	 * Additive/optional — legacy callers that only read `ok`/`message`/`data`
	 * are unaffected.
	 */
	delta?: MutationDelta;
}

/**
 * One compact hit returned by {@link DirectorApi.searchMedia} — a media asset
 * (identified by its FULL mediaId; these are not reel slot ids and are never
 * routed through the short-id map) plus the best-matching moment within it.
 *
 * `width`/`height`/`durationSec`/`source` mirror the same optional facets the
 * library manifest's `ManifestAsset`/`ManifestHero` carry (`asset-manifest.ts`)
 * — populated from the matched media-library asset when it resolves, so a
 * semantic-search result carries the same orientation/duration/provenance
 * grounding a named hero does, not just its score and timestamp.
 */
export interface MediaSearchHit {
	mediaId: string;
	/** Cosine similarity in [-1, 1]; higher = more relevant. */
	score: number;
	/** Best-matching frame's offset into the media, in SECONDS. */
	timestampSec: number;
	mediaName?: string;
	/** Pixel width, when the asset's metadata has been probed. */
	width?: number;
	/** Pixel height, when the asset's metadata has been probed. */
	height?: number;
	/** Duration in seconds, when known. */
	durationSec?: number;
	/** Provenance ("ai" ⇒ Studio-generated; "upload" ⇒ user-uploaded/imported), when known. */
	source?: "upload" | "ai";
}

/**
 * One near-duplicate pair returned by {@link DirectorApi.findDuplicateAssets} —
 * two media-library assets (identified by FULL mediaIds; these are not reel
 * slot ids) whose mean CLIP frame vectors are cosine-similar above
 * `DUPLICATE_THRESHOLD` (see `embedding-types.ts`). "Duplicate" here means
 * visually near-identical CONTENT — multiple takes of the same shot, or a
 * burst of near-identical uploads — never exact file/byte duplicates, which
 * this never inspects.
 */
export interface DuplicateAssetPair {
	mediaIdA: string;
	mediaIdB: string;
	/** Cosine similarity of the pair's mean frame vectors, in [-1, 1]; higher = more similar. */
	score: number;
	mediaNameA?: string;
	mediaNameB?: string;
}

/**
 * Compact project-level grounding for the agent (see {@link DirectorApi.getProjectInfo}):
 * canvas/fps settings, the persona roster (reusable characters), and a
 * media-library summary. Cheap to compute and small enough to ride in the
 * once-per-turn system prompt.
 */
export interface ProjectInfo {
	/** Frames per second of the active project, if any. */
	fps?: number;
	canvasWidth?: number;
	canvasHeight?: number;
	orientation?: "portrait" | "landscape" | "square";
	/** First few personas (name + descriptor), capped for prompt size. */
	personas: { name: string; descriptor: string }[];
	/** Total persona count (may exceed `personas.length`). */
	personaCount: number;
	/** Total indexed/available media-library assets. */
	assetCount: number;
	/** A few recent asset names + ids, capped for prompt size. */
	recentAssets: { id: string; name: string }[];
	/**
	 * Faceted, role-aware digest of the whole media library (see
	 * `asset-manifest.ts`) — TIER-0 grounding that gives the Director STANDING
	 * awareness of every asset (counts by role, named heroes, face-anchors, a
	 * searchable tail) instead of only the last few by recency. `manifest.digest`
	 * is the one-line string folded into the system prompt. Degrades to
	 * media-type counts + recent names when no Understanding Pass data is wired.
	 */
	manifest: LibraryManifest;
}

/**
 * One backend the Director may route a shot to, as seen by the AGENT (not the
 * server registry). Mirrors the client-safe fields of `/api/studio/backends`
 * plus a RELATIVE cost tier — enough for the model to pick intent-appropriately
 * ("draft on cheap, hero on premium, persona-critical on seed-lock") without
 * ever seeing a provider key. This is the read side of model-routing: the same
 * catalog `useBackends` renders in the UI, handed to the agent as a verb.
 */
export interface BackendCatalogEntry {
	id: string;
	label: string;
	vendor: string;
	modality: "video" | "image";
	safetyTier: SafetyTier;
	intents: string[];
	/** Reproduces identity from a seed — the persona-critical routing signal. */
	supportsSeedLock: boolean;
	/** Reference-conditioned edits (identity carry when no seed). */
	supportsReferenceEdits: boolean;
	/** Relative cost bucket vs. the cheapest available backend of this modality. */
	costTier: "cheap" | "standard" | "premium";
	/** Normalized credits for a nominal generation (finer-grained ranking aid). */
	relativeCost: number;
}

/**
 * Injectable read-through to the backend catalog. The Director API is browser-
 * side pure logic and MUST NOT import the server registry (it reads secret keys),
 * so the concrete provider (wired in `use-director`) fetches `/api/studio/backends`
 * and hands back the client-safe entries. Absent ⇒ `getBackends` reports an empty
 * catalog and generation falls back to default auto-routing.
 */
export type BackendCatalogProvider = (
	modality?: "video" | "image",
) => Promise<BackendCatalogEntry[]>;

/**
 * A vision critic that scores candidate takes and picks the best — the D1
 * capability `compareTake` auto-picks with. Injected (not imported) so the
 * Director degrades gracefully when D1 isn't merged: with no critic, `compareTake`
 * simply presents both takes for the user to choose. Returning `null` (or an
 * unknown takeId) means "no confident pick" → also present both.
 */
export interface TakeCritic {
	pickBest(input: {
		slotId: string;
		prompt: string;
		takes: { takeId: string; mediaId?: string; thumbnailUrl?: string }[];
	}): Promise<{ takeId: string; reason?: string } | null>;
}

/**
 * Result of {@link DirectorApi.reviewTake} — the frames of a take decoded for a
 * VISION review, plus the slot's intent to judge them against. `frames` are
 * base64 `data:` image URLs (first → last); the agent layer turns them into
 * image content blocks so the model actually SEES the generated clip. Kept off
 * the plain-text observation path (they're large) — surfaced only as images.
 */
export interface ReviewTakeData {
	/** Full slot (element) id the reviewed take belongs to. */
	slotId: string;
	/** Full id of the reviewed take. */
	takeId: string;
	/** The slot's prompt — the intent the take is judged against. */
	prompt: string;
	status: TakeStatus;
	/** Number of frames actually decoded (1–3). */
	frameCount: number;
	/** Decoded frames as base64 `data:` image URLs, in first → last order. */
	frames: string[];
}

/**
 * Result of {@link DirectorApi.intakeReferences} — the outcome of giving the
 * Director EYES ON INPUT. The model looked at the user's reference images and
 * derived a {@link DerivedReference} (a StyleBible + optional persona sketch);
 * the verb then seeded the reel-level consistency context from the style,
 * optionally locked a persona (seed-lock path) from the character, and recorded
 * the look on the durable brief. This payload reports what was derived and
 * applied so the agent can pass `bible` straight into `storyboard`.
 */
export interface IntakeReferencesData {
	/** The full derived look — StyleBible + optional persona sketch + summary. */
	derived: DerivedReference;
	/** The derived StyleBible, hoisted for a direct `storyboard({ bible })` handoff. */
	bible: StyleBible;
	/** True ⇒ the reel-level consistency context was seeded from the derived style. */
	styleApplied: boolean;
	/** Set ⇒ a persona was locked + activated from the reference character. */
	personaId?: string;
	/** How many reference assets were actually decoded into images. */
	imageCount: number;
	/** Any requested mediaIds that didn't resolve to an asset (skipped). */
	missingMediaIds: string[];
}

/**
 * Coarse class of a generation failure, assigned at the executor boundary
 * (`studio-executor.ts`). It drives the Director's SELF-CORRECTING recovery
 * strategy (`director-api.ts`), so a stalled/failed slot is no longer a dead
 * end the user has to notice:
 *
 *  - `"provider"`  — the backend errored. Retryable ones (5xx/429/network) are
 *     retried with backoff; a non-retryable 4xx (bad request) is escalated.
 *  - `"timeout"`   — the job/network timed out. Retried with backoff.
 *  - `"safety"`    — content-moderation rejection. The prompt is AUTO-REPHRASED
 *     and retried; the user is told why.
 *  - `"empty"`     — the provider returned no media. One cautious retry.
 *  - `"unknown"`   — unclassified. One cautious retry, then escalate.
 *
 * `retryable` is set by the classifier (not purely a function of `class`), so a
 * 400-class `"provider"` error can be marked non-retryable while a 503 is not.
 */
export type FailureClass =
	| "provider"
	| "timeout"
	| "safety"
	| "empty"
	| "unknown";

/**
 * Structured, self-describing reason a generation attempt failed — the
 * replacement for the opaque error strings the Director used to bubble up. The
 * `class` picks the recovery strategy; `message` is safe to show a user.
 */
export interface GenerationFailure {
	class: FailureClass;
	/** Human-readable, user-safe explanation of what went wrong. */
	message: string;
	/** Whether the boundary considers this retryable AS-IS (drives retry vs. escalate). */
	retryable: boolean;
	/** Provider/HTTP status code, when the boundary knew one. */
	status?: number;
	/** Raw provider error text, kept for logs (not shown verbatim to users). */
	detail?: string;
}

/**
 * The outcome of generating takes for ONE slot after self-correction: the takes
 * created, any UNRECOVERED failures (structured, not opaque strings), and
 * whether recovery (retry/rephrase) was needed to succeed. Carried in the
 * `generate`/`reroll` result `data` so a UI or agent can escalate precisely.
 */
export interface SlotGenerationOutcome {
	slotId: string;
	takeIds: string[];
	/** Present ⇒ at least one take could not be recovered; escalate to the user. */
	failures?: GenerationFailure[];
	/** True ⇒ a take needed an auto-rephrase (safety) or a retry before it landed. */
	recovered?: boolean;
}

/**
 * Injectable boundary for the actual generation network calls.
 *
 * The Director API performs all *bookkeeping* (appending takes, flipping
 * status, selecting takes — all via the canonical timeline-manager methods) but
 * DELEGATES the real provider/network work to this executor. Wire a concrete
 * implementation (e.g. the studio generate pipeline) when constructing the API.
 * If none is provided, generation verbs enqueue `queued` takes and report that
 * no executor is configured.
 */
export interface GenerateExecutor {
	/**
	 * Run a single generation. Implementations should resolve with the finished
	 * take fields (status `ready` + mediaId, or `failed` + error) and — on
	 * failure — a structured {@link GenerationFailure} classifying it, so the
	 * Director can decide whether to retry, rephrase, or escalate. Executors that
	 * omit `failure` fall back to the Director classifying the raw `error` string.
	 */
	run(input: {
		slotId: string;
		takeId: string;
		spec: GenerationSpec;
	}): Promise<
		Pick<
			Take,
			"status" | "mediaId" | "thumbnailUrl" | "seed" | "jobId" | "error"
		> & { failure?: GenerationFailure }
	>;
}

/**
 * Compact, agent-readable snapshot of one pending Board item — a multi-take/
 * -image generation draft parked for the user to star into Assets
 * ({@link DirectorApi.promoteBoardItem}) or dismiss
 * ({@link DirectorApi.discardBoardItem}). Mirrors the shape
 * `useBoardItems`/`GET /api/studio/board` return, flattened and with
 * null/absent fields OMITTED (token economy, same convention as
 * {@link SlotSnapshot}).
 */
export interface BoardItemSnapshot {
	id: string;
	kind: "take" | "image";
	/** The draft's generation status (e.g. "ready"/"queued"/"failed"), when known. */
	status?: string;
	/** The prompt that produced this draft (from the parent generation set or image). */
	prompt?: string;
	/** Resolution (video takes) or size (images), when known. */
	resolution?: string;
	notes?: string;
	createdAt: string;
}

/**
 * Injectable read-through to the caller's pending Board items (see
 * `apps/web/src/hooks/use-board-items.ts`'s `refetch`, which hits
 * `GET /api/studio/board`). Powers the read-only `getBoard` verb. BROWSER-BOUND
 * — the app wires the real fetch in `use-director.ts`; headless tests inject a
 * stub. Absent ⇒ `getBoard` reports the Board is unavailable in this context.
 */
export type BoardFetchFn = () => Promise<BoardItemSnapshot[]>;

/**
 * Outcome of an injected Board mutation (`promote`/`discard`) — translates
 * `use-board-items.ts`'s throw-on-failure convention into a result, so
 * `director-api.ts` never needs to catch a thrown Error from browser code.
 */
export type BoardMutationResult = { ok: true } | { ok: false; error: string };

/**
 * Injectable star-to-Assets action for one Board item by id (see
 * `useBoardItems`'s `promoteToAssets`, which resolves the item's media, adds
 * it to the project's Assets, then removes the Board row). BROWSER-BOUND, like
 * {@link BoardFetchFn}. Absent ⇒ `promoteBoardItem` reports the Board is
 * unavailable in this context.
 */
export type BoardPromoteFn = (itemId: string) => Promise<BoardMutationResult>;

/**
 * Injectable dismiss action for one Board item by id (see `useBoardItems`'s
 * `dismiss`, which removes the Board row without saving it anywhere).
 * BROWSER-BOUND, like {@link BoardFetchFn}. Absent ⇒ `discardBoardItem`
 * reports the Board is unavailable in this context.
 */
export type BoardDiscardFn = (itemId: string) => Promise<BoardMutationResult>;
