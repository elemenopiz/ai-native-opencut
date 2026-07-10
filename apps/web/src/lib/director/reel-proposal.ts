/**
 * Reel Proposal — the PLAN artifact behind Flow B ("propose-first, not
 * assemble-first"): the Director reads {Bible + Manifest + brief} and drafts the
 * ENTIRE reel as an EDITABLE plan that CITES specific library assets per shot,
 * choosing per shot between three sources:
 *
 *  - `library`          — RETRIEVE: place a specific, cited library asset (e.g.
 *                         "cold open: rooftop b-roll #12"). $0, instant.
 *  - `generate`         — no matching asset exists; render it from a prompt (the
 *                         existing `storyboard` path).
 *  - `generate-to-match`— GENERATE conditioned on a cited asset's LOOK (inherit a
 *                         hero/product asset's grade/framing without reusing the
 *                         literal clip). Hero shots that justify the spend.
 *
 * WHY A SEPARATE MODULE (vs. widening `storyboard-plan.ts`): the storyboard plan
 * only ever plans shots it will GENERATE. Flow B adds retrieval + citations, and
 * with them a HARD SAFETY REQUIREMENT the doc is blunt about
 * (`docs/reimagined-director-workflows.md` §6 rule 2): a hallucinated
 * "#12 rooftop b-roll" costs more trust than the feature earns. So the load-
 * bearing logic here is {@link validateProposal} — a plan may cite ONLY asset ids
 * that resolve against the REAL index, validated programmatically before the plan
 * is accepted, with any unresolvable citation REPAIRED (downgraded to `generate`,
 * never silently kept). A fabricated id cannot survive.
 *
 * MIRRORS the shipped `storyboard-plan.ts` conventions: pure, side-effect-free
 * builders + a thin `EditorCore`-keyed `WeakMap` registry for the pending draft
 * (session state, GC'd with the editor — a draft is not persisted until it's
 * accepted, at which point it becomes a durable {@link StoryboardPlan}). The
 * `director-api.ts` verbs (`proposeReel`/`reviseProposal`/`acceptProposal`) are
 * the thin service shell that adapts editor state to these pure functions.
 */

import type { EditorCore } from "@/core";
import {
	buildStoryboardPlan,
	type PlannedShotInput,
	type StoryboardPlan,
	type StyleBible,
} from "./storyboard-plan";
import type { ReelBudget, ShotImportance } from "./budget";

// ── the plan shape ────────────────────────────────────────────────────────────

/**
 * Where a planned shot's pixels come from. The retrieve-vs-generate decision the
 * whole flow turns on (see {@link decideShotSource}).
 */
export type ShotSource = "library" | "generate" | "generate-to-match";

/**
 * A CITATION of a specific library asset — the grounded reference a `library` or
 * `generate-to-match` shot points at. The `mediaId` is the ONLY field the author
 * supplies that matters for safety; everything else is either author intent
 * (`sourceShotIndex`/`timeRange`/`matchScore`) or CANONICALIZED by
 * {@link validateProposal} from the resolved asset (`ref`/`caption`/`role`) so
 * the draft never shows a model-invented caption for a real id.
 */
export interface AssetCitation {
	/**
	 * FULL media-library asset id (NOT a reel slot id). This is what
	 * {@link validateProposal} resolves against the real index; an id that doesn't
	 * resolve gets the whole shot repaired to `generate`.
	 */
	mediaId: string;
	/** Compact "#N" library-position label, filled from the resolved asset (display only). */
	ref?: string;
	/** The asset's UNDERSTANDING caption, filled from the resolver — never the model's. */
	caption?: string;
	/** The asset's role (hero/product/logo/face-anchor/b-roll…), filled from the resolver. */
	role?: string;
	/** The asset's display name (filename), filled from the resolver — a caption fallback. */
	name?: string;
	/**
	 * The search/match score the author saw when grounding this candidate (e.g. a
	 * `searchMedia` cosine). Optional: a citation grounded by ROLE (from the
	 * manifest) carries no score, which {@link decideShotSource} treats as trusted.
	 */
	matchScore?: number;
	/** For a multi-shot source asset: which sub-shot (0-based) to use. Clamped on validate. */
	sourceShotIndex?: number;
	/** Time range (SECONDS) within the source asset to place, when only a slice is wanted. */
	timeRange?: { start: number; end: number };
}

/**
 * One shot as the author (the model) supplies it into {@link buildReelProposal}.
 * A superset of {@link PlannedShotInput}: adds the `source` decision + `citation`.
 * `source` is OPTIONAL — when omitted it's derived by {@link decideShotSource}
 * from `importance` + whether a citation is present, so the author can just cite
 * an asset and let the allocator classify it.
 */
export interface ProposedShotInput extends PlannedShotInput {
	/** Retrieve / generate / generate-to-match. Omitted ⇒ derived by {@link decideShotSource}. */
	source?: ShotSource;
	/** The cited library asset (required in effect for `library`/`generate-to-match`). */
	citation?: AssetCitation;
}

/**
 * One shot in a validated {@link ReelProposal} — the plan-level twin of
 * {@link import("./storyboard-plan").PlannedShot}, plus the retrieve-vs-generate
 * `source` and its grounded `citation`.
 */
export interface ProposedShot {
	/** 1-based position in the sequence. */
	index: number;
	/** Retrieve / generate / generate-to-match — post-validation (repairs applied). */
	source: ShotSource;
	/** The grounded citation, present iff `source` is `library` or `generate-to-match`. */
	citation?: AssetCitation;
	/** Generation prompt (for `generate`/`generate-to-match`); a description for `library`. */
	prompt: string;
	/** What this shot accomplishes narratively. */
	intent?: string;
	/** Framing / camera / lens notes. */
	camera?: string;
	/** Who/what is on screen. */
	subject?: string;
	/** Shot length in seconds. */
	duration: number;
	/** How important the shot is — drives the retrieve-vs-generate decision + budget tier. */
	importance?: ShotImportance;
	/** The materialized id once the proposal is accepted (a slot id for generate, an element id for library). */
	elementId?: string;
}

/**
 * A repair {@link validateProposal} applied to keep the plan honest: a citation
 * that didn't resolve (or was missing) forced the shot back to `generate`. These
 * are surfaced so the draft can say "shot 3 — cited asset not found, will
 * generate" instead of silently dropping the citation.
 */
export interface CitationRepair {
	/** 1-based index of the repaired shot. */
	index: number;
	/** Human-readable reason (e.g. 'cited asset "abc" is not in the library'). */
	reason: string;
	/** The source the shot had before the repair. */
	from: ShotSource;
	/** The source the shot was downgraded to (always `generate`). */
	to: ShotSource;
	/** The id that failed to resolve, when there was one. */
	citedMediaId?: string;
}

/**
 * The editable DRAFT the human reacts to: an ordered list of {@link ProposedShot}s
 * (each retrieve/generate/generate-to-match with grounded citations), the shared
 * {@link StyleBible}, and the list of {@link CitationRepair}s applied to make it
 * honest. Session state until accepted, at which point it materializes into slots
 * and becomes a durable {@link StoryboardPlan}.
 */
export interface ReelProposal {
	/** Number of shots (== `shots.length`). */
	shotCount: number;
	/** Ordered shots, post-validation. */
	shots: ProposedShot[];
	/** The shared style bible every shot inherits (seeds the consistency context). */
	bible: StyleBible;
	/** Total planned runtime in seconds (sum of shot durations). */
	totalDuration: number;
	/** Whole-reel spend plan, when a budget was set (allocated across the GENERATE shots). */
	budget?: ReelBudget;
	/** Citations that didn't resolve and were repaired to `generate` (empty ⇒ fully grounded). */
	repairs: CitationRepair[];
	/** Wall-clock creation time (ms epoch). */
	createdAt: number;
}

/**
 * What the real index tells us about a cited asset — the resolver's return. Only
 * a NON-`undefined` result means "this id exists and may be cited"; the enrichment
 * fields (`caption`/`role`/`ref`/`name`) are CANONICAL (from the media store +
 * Understanding Pass), so the draft never trusts a model-supplied caption.
 */
export interface ResolvedAsset {
	/** The asset id (echoed). */
	id: string;
	/** Display name (filename). */
	name?: string;
	/** Understanding caption, when the asset has an understanding record. */
	caption?: string;
	/** Understanding role (hero/product/…), when known. */
	role?: string;
	/** Compact "#N" library-position label, when the resolver knows the asset's index. */
	ref?: string;
	/** Number of sub-shots in a multi-shot source (bounds `sourceShotIndex`), when known. */
	shotCount?: number;
}

/**
 * Injected read-through to the REAL index: resolve a cited mediaId to its
 * {@link ResolvedAsset}, or `undefined` when the id is NOT in the library. This is
 * the single grounding gate — `director-api.ts` implements it over
 * `editor.media` (existence) + the Understanding Pass lookup (caption/role). A
 * fabricated id returns `undefined` here and cannot survive {@link validateProposal}.
 */
export type AssetResolver = (mediaId: string) => ResolvedAsset | undefined;

// ── the retrieve-vs-generate decision ─────────────────────────────────────────

/**
 * A grounded candidate the author found in the index for a shot — the input to
 * {@link decideShotSource}. `score` is a search match score (absent ⇒ grounded by
 * role, treated as trusted).
 */
export interface ShotCandidate {
	mediaId: string;
	score?: number;
	caption?: string;
	role?: string;
	name?: string;
}

/**
 * Match score at/above which a `support` shot's candidate is "good enough" to
 * RETRIEVE rather than spend on generation. Calibrated to CLIP cosine scores
 * (`searchMedia`), which run low even for good matches; a missing score is treated
 * as trusted (the author grounded it deliberately, e.g. by role).
 */
export const DEFAULT_MATCH_THRESHOLD = 0.2;

/**
 * THE retrieve-vs-generate allocation rule — the same importance signal that
 * routes hero→premium / b-roll→cheap now also decides "is the library good
 * enough, or do we spend?":
 *
 *  - No candidate at all ⇒ `generate` (nothing to retrieve).
 *  - `hero` + a candidate ⇒ `generate-to-match`: a hero justifies generation
 *    spend, but INHERITS the cited asset's look rather than ignoring it.
 *  - `broll` + any candidate ⇒ `library`: b-roll prefers retrieval (free, instant)
 *    whenever there's a real candidate; it's forgiving of a loose match.
 *  - `support` + a STRONG candidate (score ≥ threshold, or no score) ⇒ `library`;
 *    a WEAK candidate ⇒ `generate` (don't retrieve a poor match for a mid-tier shot).
 *
 * Pure. Returns the chosen source and, when it retrieves/matches, the citation to
 * attach. Absent `importance` defaults to `support` (matching the budget allocator).
 */
export function decideShotSource(input: {
	importance?: ShotImportance;
	candidate?: ShotCandidate;
	matchThreshold?: number;
}): { source: ShotSource; citation?: AssetCitation } {
	const importance = input.importance ?? "support";
	const candidate = input.candidate;
	if (!candidate) return { source: "generate" };

	const citation = candidateToCitation(candidate);
	const threshold = input.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
	const strong = candidate.score == null || candidate.score >= threshold;

	if (importance === "hero") {
		// A hero shot earns the spend, but conditions generation on the cited look.
		return { source: "generate-to-match", citation };
	}
	if (importance === "broll") {
		// B-roll prefers retrieval whenever there's any real candidate.
		return { source: "library", citation };
	}
	// support: retrieve a strong match, otherwise generate.
	return strong ? { source: "library", citation } : { source: "generate" };
}

/** Project a {@link ShotCandidate} onto the author-supplied fields of an {@link AssetCitation}. */
function candidateToCitation(candidate: ShotCandidate): AssetCitation {
	return {
		mediaId: candidate.mediaId,
		...(candidate.score != null ? { matchScore: candidate.score } : {}),
		...(candidate.caption ? { caption: candidate.caption } : {}),
		...(candidate.role ? { role: candidate.role } : {}),
		...(candidate.name ? { name: candidate.name } : {}),
	};
}

const DEFAULT_SHOT_DURATION = 6;

/** True ⇒ this source cites a library asset and therefore needs a resolvable citation. */
export function sourceNeedsCitation(source: ShotSource): boolean {
	return source === "library" || source === "generate-to-match";
}

// ── building the draft ────────────────────────────────────────────────────────

/**
 * Assemble a {@link ReelProposal} from the author's shot list + style bible. Pure:
 * floors durations, assigns 1-based indices, and DERIVES each shot's `source` when
 * the author omitted it (via {@link decideShotSource} from importance + citation).
 * Does NOT validate citations — callers run {@link validateProposal} next with a
 * real resolver so the draft is grounded before it's shown or accepted.
 */
export function buildReelProposal(input: {
	shots: ProposedShotInput[];
	bible?: StyleBible;
	now?: number;
}): ReelProposal {
	const shots: ProposedShot[] = input.shots.map((s, i) => {
		const duration =
			s.duration && s.duration > 0 ? s.duration : DEFAULT_SHOT_DURATION;
		// Derive the source when unset: cite-and-let-the-allocator-classify.
		const decided =
			s.source ??
			decideShotSource({
				importance: s.importance,
				candidate: s.citation
					? { mediaId: s.citation.mediaId, score: s.citation.matchScore }
					: undefined,
			}).source;
		return {
			index: i + 1,
			source: decided,
			prompt: s.prompt ?? "",
			duration,
			...(s.citation ? { citation: { ...s.citation } } : {}),
			...(s.intent ? { intent: s.intent } : {}),
			...(s.camera ? { camera: s.camera } : {}),
			...(s.subject ? { subject: s.subject } : {}),
			...(s.importance ? { importance: s.importance } : {}),
		};
	});
	return {
		shotCount: shots.length,
		shots,
		bible: input.bible ?? {},
		totalDuration: shots.reduce((sum, s) => sum + s.duration, 0),
		repairs: [],
		createdAt: input.now ?? Date.now(),
	};
}

// ── grounding: the hard safety gate ────────────────────────────────────────────

/**
 * Validate ONE shot's citation against the resolver and return the shot with its
 * citation either CANONICALIZED (real id: caption/role/ref/name overwritten from
 * the resolved asset, `sourceShotIndex` clamped) or REPAIRED (missing/unresolvable
 * id: source downgraded to `generate`, citation dropped, a {@link CitationRepair}
 * returned). Pure — never mutates its input.
 */
export function validateShot(
	shot: ProposedShot,
	resolve: AssetResolver,
): { shot: ProposedShot; repair?: CitationRepair } {
	if (!sourceNeedsCitation(shot.source)) {
		// A pure `generate` shot must not carry a citation — drop any stray one so
		// the draft can't imply a grounding it doesn't have.
		if (!shot.citation) return { shot };
		const { citation: _dropped, ...rest } = shot;
		return { shot: rest };
	}

	const mediaId = shot.citation?.mediaId;
	if (!mediaId) {
		return {
			shot: downgradeToGenerate(shot),
			repair: {
				index: shot.index,
				reason: `${shot.source} shot cited no asset — will generate instead`,
				from: shot.source,
				to: "generate",
			},
		};
	}

	const resolved = resolve(mediaId);
	if (!resolved) {
		return {
			shot: downgradeToGenerate(shot),
			repair: {
				index: shot.index,
				reason: `cited asset "${mediaId}" is not in the library — will generate instead`,
				from: shot.source,
				to: "generate",
				citedMediaId: mediaId,
			},
		};
	}

	// Real id — rebuild the citation from CANONICAL index data (never trust a
	// model-supplied caption/role) and clamp the sub-shot index into range.
	const canonical: AssetCitation = {
		mediaId,
		...(resolved.ref ? { ref: resolved.ref } : {}),
		...(resolved.caption ? { caption: resolved.caption } : {}),
		...(resolved.role ? { role: resolved.role } : {}),
		...(resolved.name ? { name: resolved.name } : {}),
		...(shot.citation?.matchScore != null
			? { matchScore: shot.citation.matchScore }
			: {}),
		...(shot.citation?.timeRange ? { timeRange: shot.citation.timeRange } : {}),
		...clampSourceShotIndex(shot.citation?.sourceShotIndex, resolved.shotCount),
	};
	return { shot: { ...shot, citation: canonical } };
}

/**
 * Validate an ENTIRE {@link ReelProposal}: run {@link validateShot} over every
 * shot, collecting repairs, and return a NEW proposal whose citations are all
 * grounded (or repaired to `generate`) plus `ok` = "nothing needed repairing".
 * This is the gate `proposeReel`/`acceptProposal` run before showing or
 * materializing a plan — the guarantee that NO accepted shot cites a fabricated id.
 * Pure — never mutates its input.
 */
export function validateProposal(
	proposal: ReelProposal,
	resolve: AssetResolver,
): { proposal: ReelProposal; repairs: CitationRepair[]; ok: boolean } {
	const repairs: CitationRepair[] = [];
	const shots = proposal.shots.map((shot) => {
		const { shot: validated, repair } = validateShot(shot, resolve);
		if (repair) repairs.push(repair);
		return validated;
	});
	return {
		proposal: { ...proposal, shots, repairs },
		repairs,
		ok: repairs.length === 0,
	};
}

/** Downgrade a shot to `generate`, stripping its (unusable) citation. */
function downgradeToGenerate(shot: ProposedShot): ProposedShot {
	const { citation: _dropped, ...rest } = shot;
	return { ...rest, source: "generate" };
}

/** Clamp an author-supplied `sourceShotIndex` into `[0, shotCount-1]`, or drop it. */
function clampSourceShotIndex(
	index: number | undefined,
	shotCount: number | undefined,
): { sourceShotIndex?: number } {
	if (index == null || !Number.isFinite(index)) return {};
	const max = shotCount && shotCount > 0 ? shotCount - 1 : Infinity;
	const clamped = Math.min(max, Math.max(0, Math.floor(index)));
	return Number.isFinite(clamped) ? { sourceShotIndex: clamped } : {};
}

// ── single-line revision (stable re-plan) ──────────────────────────────────────

/** A patch to ONE shot in a proposal — only the fields the human wants to change. */
export interface ShotRevision {
	source?: ShotSource;
	citation?: AssetCitation;
	prompt?: string;
	intent?: string;
	camera?: string;
	subject?: string;
	duration?: number;
	importance?: ShotImportance;
	/** Set true to CLEAR the citation (and let the source fall back to generate). */
	clearCitation?: boolean;
}

/**
 * Re-plan a SINGLE shot (1-based `index`) and return a NEW proposal in which ONLY
 * that shot changed — every OTHER shot is preserved BY REFERENCE, so a revision is
 * stable: "swap shot 2 for the drone pass" leaves shots 1 and 3 byte-for-byte (and
 * identity-) unchanged. The revised shot is re-validated against the resolver
 * (a fabricated swap-in id is repaired just like on the initial plan). An
 * out-of-range index is a no-op (returns the proposal unchanged, `changed:false`).
 * Pure — never mutates its input.
 */
export function reviseProposalShot(
	proposal: ReelProposal,
	index: number,
	patch: ShotRevision,
	resolve: AssetResolver,
): {
	proposal: ReelProposal;
	repair?: CitationRepair;
	changed: boolean;
} {
	const pos = index - 1;
	if (pos < 0 || pos >= proposal.shots.length) {
		return { proposal, changed: false };
	}

	const prev = proposal.shots[pos];
	// Apply the patch onto the prior shot. A cleared/omitted citation vs. a new one
	// is handled explicitly so "change the prompt only" keeps the existing citation.
	const nextCitation = patch.clearCitation
		? undefined
		: (patch.citation ?? prev.citation);
	const merged: ProposedShot = {
		index: prev.index,
		source: patch.source ?? prev.source,
		prompt: patch.prompt ?? prev.prompt,
		duration:
			patch.duration && patch.duration > 0 ? patch.duration : prev.duration,
		...(nextCitation ? { citation: nextCitation } : {}),
		...((patch.intent ?? prev.intent)
			? { intent: patch.intent ?? prev.intent }
			: {}),
		...((patch.camera ?? prev.camera)
			? { camera: patch.camera ?? prev.camera }
			: {}),
		...((patch.subject ?? prev.subject)
			? { subject: patch.subject ?? prev.subject }
			: {}),
		...((patch.importance ?? prev.importance)
			? { importance: patch.importance ?? prev.importance }
			: {}),
	};

	const { shot: validated, repair } = validateShot(merged, resolve);

	// Rebuild shots keeping every OTHER entry by reference (stability guarantee).
	const shots = proposal.shots.map((s, i) => (i === pos ? validated : s));
	// Repairs list: drop any stale repair for this index, add the new one if present.
	const repairs = proposal.repairs.filter((r) => r.index !== index);
	if (repair) repairs.push(repair);

	return {
		proposal: {
			...proposal,
			shots,
			totalDuration: shots.reduce((sum, s) => sum + s.duration, 0),
			repairs,
		},
		...(repair ? { repair } : {}),
		changed: true,
	};
}

// ── acceptance: proposal → durable plan ────────────────────────────────────────

/**
 * Convert an accepted {@link ReelProposal} into the durable {@link StoryboardPlan}
 * the rest of the Director already reads back (`getReel().plan`, the Project
 * Bible's versioned `plan` field). Each proposed shot becomes a `PlannedShot`
 * whose `slotId` is its materialized id. Library shots carry the citation caption
 * as their `intent` so the read-back still explains what the shot is. Pure.
 */
export function proposalToPlan(proposal: ReelProposal): StoryboardPlan {
	const inputs: PlannedShotInput[] = proposal.shots.map((s) => ({
		prompt: s.prompt,
		duration: s.duration,
		...(s.intent
			? { intent: s.intent }
			: s.source === "library" && s.citation
				? { intent: libraryShotIntent(s.citation) }
				: {}),
		...(s.camera ? { camera: s.camera } : {}),
		...(s.subject ? { subject: s.subject } : {}),
		...(s.importance ? { importance: s.importance } : {}),
	}));
	const plan = buildStoryboardPlan({ shots: inputs, bible: proposal.bible });
	// Patch each shot's materialized id + carry the budget over.
	proposal.shots.forEach((s, i) => {
		if (s.elementId) plan.shots[i].slotId = s.elementId;
	});
	if (proposal.budget) plan.budget = proposal.budget;
	plan.createdAt = proposal.createdAt;
	return plan;
}

/** A compact "used <ref> <caption>" intent line for a retrieved library shot. */
function libraryShotIntent(citation: AssetCitation): string {
	const label =
		citation.caption || citation.name || citation.ref || citation.mediaId;
	const ref = citation.ref ? `${citation.ref} ` : "";
	return `library: ${ref}${label}`;
}

// ── draft rendering (the human-facing surface) ─────────────────────────────────

/** A verb icon per source, for the draft's per-line prefix. */
const SOURCE_LABEL: Record<ShotSource, string> = {
	library: "library",
	generate: "generate",
	"generate-to-match": "generate-to-match",
};

/**
 * Render a {@link ReelProposal} as the EDITABLE DRAFT the human reacts to — a
 * compact markdown block (the Director chat surface renders a result's `message`
 * as markdown, so THIS string IS the draft the user reads). One line per shot
 * naming its source + citation, a repairs note when any citation was downgraded,
 * and the accept/revise call-to-action. Pure.
 */
export function formatProposalDraft(proposal: ReelProposal): string {
	const header = `Draft reel — ${proposal.shotCount} shot${
		proposal.shotCount === 1 ? "" : "s"
	}, ${round1(proposal.totalDuration)}s:`;

	const lines = proposal.shots.map((s) => {
		const intent = s.intent ? `${s.intent} · ` : "";
		const body = describeShotSource(s);
		return `${s.index}. ${intent}${body} (${round1(s.duration)}s)`;
	});

	const parts = [header, ...lines];

	if (proposal.repairs.length) {
		const repaired = proposal.repairs.map((r) => `#${r.index}`).join(", ");
		parts.push(
			`⚠︎ ${proposal.repairs.length} citation${
				proposal.repairs.length === 1 ? "" : "s"
			} didn't resolve (${repaired}) — those shots will generate instead.`,
		);
	}

	parts.push(
		'Reply "accept" to place them in order, or tell me what to change (e.g. "swap shot 2 for the drone pass, colder open").',
	);

	return parts.join("\n");
}

/** The per-line source+citation phrase for one shot in the draft. */
function describeShotSource(s: ProposedShot): string {
	const tag = SOURCE_LABEL[s.source];
	if (s.source === "generate") {
		return `${tag}: ${JSON.stringify(truncate(s.prompt, 60))}`;
	}
	const c = s.citation;
	const cite = c
		? `${c.ref ? `${c.ref} ` : ""}${JSON.stringify(
				truncate(c.caption || c.name || c.mediaId, 48),
			)}`
		: "(no citation)";
	return `${tag} → ${cite}`;
}

/** Round to one decimal for compact display. */
function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

/** Truncate a string with an ellipsis for the compact draft. */
function truncate(s: string, max: number): string {
	const t = (s ?? "").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ── editor-keyed registry (the pending draft) ──────────────────────────────────
//
// One editor has at most one PENDING proposal at a time — session state, GC'd
// with the editor, the same `WeakMap` scheme as the storyboard plan / consistency
// context. A draft is deliberately NOT persisted: it becomes durable (a
// `StoryboardPlan` on the Project Bible) only when accepted.

const proposalByEditor = new WeakMap<EditorCore, ReelProposal>();

/** Read the pending reel proposal drafted for this editor, if any. */
export function getStoredProposal(
	editor: EditorCore,
): ReelProposal | undefined {
	return proposalByEditor.get(editor);
}

/** Set (or clear, passing `undefined`) the pending reel proposal for this editor. */
export function storeProposal(
	editor: EditorCore,
	proposal: ReelProposal | undefined,
): void {
	if (proposal) proposalByEditor.set(editor, proposal);
	else proposalByEditor.delete(editor);
}
