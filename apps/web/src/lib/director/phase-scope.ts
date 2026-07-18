/**
 * Phase-scoped tool exposure for the NATIVE Gemini Director brain.
 *
 * The Director catalog is ~50 verbs; Google's function-calling guidance says
 * keep the ACTIVE set to 10–20 tools per request (a bigger menu measurably
 * degrades Gemini's tool selection). We deliberately do NOT consolidate the
 * catalog — instead, each Gemini request exposes only the verbs plausible for
 * the session's current PHASE, derived from readable DirectorApi state. The
 * catalog itself, the Anthropic/Kimi brains, and the MCP surface are untouched:
 * this module is consumed by `agent-gemini.ts` ONLY.
 *
 * The three phases mirror how a reel actually gets made:
 *  - "briefing"   — deciding WHAT to make: brief, proposal, storyboard, refs.
 *  - "production" — filling slots with takes: generate/reroll/remix/review.
 *  - "polish"     — the reel is fully generated: timeline surgery, text,
 *                   audio, export, final approval.
 *
 * Buckets are GENEROUS, not minimal — each keeps the adjacent-phase verbs a
 * user plausibly jumps to mid-conversation (polish keeps generate/reroll for
 * "redo shot 3"; briefing keeps generate for "just make me one quick clip").
 * The phase is recomputed EVERY model turn, so a mid-run transition (e.g.
 * acceptProposal creates slots → production) widens the menu on the very next
 * model call — the model never has to finish a run inside a stale bucket.
 */

import type { DirectorApi } from "./director-api";
import { toolCatalog } from "./tool-catalog";

/** The Director session's coarse position in the reel-making arc. */
export type DirectorPhase = "briefing" | "production" | "polish";

/**
 * How long after its newest take a fully-"ready" reel still counts as
 * "production": freshly generated shots are usually still being judged
 * (review/choose/reroll), so the generation verbs must stay on the menu even
 * though every slot reads `status: "ready"`.
 */
export const RECENT_TAKE_WINDOW_MS = 10 * 60_000;

/**
 * Derive the current phase from synchronously readable DirectorApi state — a
 * conservative waterfall that prefers the EARLIER phase when ambiguous (the
 * earlier buckets are generous, so under-shooting costs nothing; over-shooting
 * hides the verbs the model actually needs).
 *
 * Signals, in order (all from `getReel()`/`getProposal()`, the two cheap
 * synchronous reads the panel itself relies on):
 *  1. No slots on the timeline → "briefing". Nothing exists yet, so the work
 *     is deciding what to make (brief/proposal/storyboard/references).
 *  2. An OPEN draft proposal → "briefing", even if slots exist. A pending
 *     proposeReel draft means the user is (re)deciding scope — the
 *     accept/revise verbs must be active, and briefing keeps enough production
 *     adjacency (generate/setPrompt) for a quick pivot.
 *  3. Any slot unfilled — status "empty" | "queued" | "generating" | "failed",
 *     or zero takes → "production". Slots exist but the reel isn't rendered:
 *     the generation/iteration verbs are the work.
 *  4. Every slot "ready" but the newest take is younger than
 *     {@link RECENT_TAKE_WINDOW_MS} → "production". A just-rendered reel is
 *     still being judged; flipping to polish the instant the last take lands
 *     would hide reroll/remix/review mid-conversation.
 *  5. Otherwise → "polish". The reel is fully generated and has settled;
 *     the work is timeline surgery, text/audio dressing, export.
 *
 * Any read failure fails safe to the EARLIEST plausible phase rather than
 * throwing — phase scoping must never take the whole brain down.
 */
export function deriveDirectorPhase(
	api: DirectorApi,
	now: number = Date.now(),
): DirectorPhase {
	let slots: ReturnType<DirectorApi["getReel"]>["slots"];
	try {
		slots = api.getReel().slots;
	} catch {
		return "briefing"; // no readable reel — assume nothing exists yet
	}
	if (!slots || slots.length === 0) return "briefing";

	// An open draft proposal means the user is (re)deciding what to make.
	try {
		if (api.getProposal().data) return "briefing";
	} catch {
		/* stubs/legacy apis without getProposal → no draft, keep going */
	}

	const unfilled = slots.some((s) => s.status !== "ready" || s.takeCount === 0);
	if (unfilled) return "production";

	// All ready — but a freshly generated reel is still being judged.
	const newestTakeAt = Math.max(
		0,
		...slots.flatMap((s) => s.takes.map((t) => t.createdAt ?? 0)),
	);
	if (newestTakeAt > 0 && now - newestTakeAt < RECENT_TAKE_WINDOW_MS) {
		return "production";
	}

	return "polish";
}

/**
 * Verbs active in EVERY phase — cheap reads the model orients with, plus
 * undo/redo (a mistake must be reversible no matter where the session is).
 */
export const CORE_TOOL_NAMES: readonly string[] = [
	"getReel",
	"getSlot",
	"searchMedia",
	"getProjectInfo",
	"getBudgetStatus",
	"undo",
	"redo",
];

/**
 * Explicit phase assignment for every NON-core catalog verb. Every verb in the
 * catalog MUST appear here or in {@link CORE_TOOL_NAMES} — the coverage test
 * in `phase-scope.test.ts` reads the live catalog and fails with the verb's
 * name when a future verb lands without an assignment. At runtime an
 * unassigned verb FAILS OPEN (active in every phase, see
 * {@link activeToolNamesForPhase}) so a forgotten assignment can never make a
 * verb unreachable — the test failing loudly is the enforcement.
 *
 * Per-verb rationale for the non-obvious placements:
 *  - generate: all THREE phases — briefing for "just make me one clip"
 *    single-turn asks, production as the core verb, polish for "redo shot 3".
 *  - reroll: production + polish (quality retries happen after "done" too).
 *  - reserveSlot: briefing (the quick single-clip path — it carries the
 *    prompt itself, so briefing does not need setPrompt) + production ("add
 *    one more shot"). setPrompt is production-only: rewriting a prompt is an
 *    iteration move (setPrompt → reroll).
 *  - intakeReferences / seedStyleFromUnderstanding: briefing + production —
 *    style refs arrive with the brief OR mid-generation ("match this look").
 *  - addVoiceover/addMusicBed: production + polish — audio is part of
 *    BUILDING the reel (a reel is not silent), not only an afterthought.
 *  - revokeVoiceConsent / getVoiceProfiles: polish, where the voice verbs'
 *    review/consent questions actually come up (addVoiceover carries its own
 *    consent gate in production; the profile/consent MANAGEMENT verbs are
 *    rare and polish-shaped).
 *  - approveHeroShot/revertBibleCheckpoint: production — the bible is written
 *    and reverted while shots are being made. The pure READS of that state
 *    (getProjectBible, getConsistencyContext) live in briefing, where "what's
 *    our current look?" grounds the next plan — and `getReel` (core) carries
 *    the plan + consistency block everywhere else.
 *  - export/approveFinalCut: polish only — exporting a half-generated reel is
 *    never the intent (and getReel/undo stay available everywhere).
 */
export const PHASE_TOOL_ASSIGNMENTS: Readonly<
	Record<string, readonly DirectorPhase[]>
> = {
	// reads beyond the core set
	getLibraryManifest: ["briefing"],
	// getTranscript: briefing (proposals want to know what footage SAYS) +
	// polish (speech-aligned trim/split live there). Production is generative —
	// generated takes have no source transcript to consult.
	getTranscript: ["briefing", "polish"],
	// findDuplicateAssets: briefing only — checking the library for near-
	// identical takes is a planning/proposing-time move (same bucket as
	// searchMedia's sibling getLibraryManifest). Production is generative
	// (freshly rendered takes aren't library assets this scans) and polish is
	// already at its enforced ceiling (see phase-scope.test.ts); a "duplicate
	// clips back-to-back" check before export is a rarer ask than the
	// pre-generation library review this verb primarily serves.
	findDuplicateAssets: ["briefing"],
	getBackends: ["production"],
	// meta/read utilities — orientation aids: readPlaybook (fetch a prompt
	// playbook body) and reportLimitation (feed back a capability gap). Kept on
	// the briefing+production menu, where prompt-craft guidance and mid-build
	// gap-reporting actually happen; polish is at its enforced ceiling (see the
	// count bounds in phase-scope.test.ts), so these stay off it.
	readPlaybook: ["briefing", "production"],
	reportLimitation: ["briefing", "production"],
	getBrief: ["briefing"],
	getProposal: ["briefing"],
	getConsistencyContext: ["briefing"],
	getProjectBible: ["briefing"],
	getVoiceProfiles: ["polish"],
	// briefing: deciding what to make
	storyboard: ["briefing"],
	proposeReel: ["briefing"],
	reviseProposal: ["briefing"],
	acceptProposal: ["briefing"],
	updateBrief: ["briefing"],
	setBudget: ["briefing"],
	intakeReferences: ["briefing", "production"],
	seedStyleFromUnderstanding: ["briefing", "production"],
	reserveSlot: ["briefing", "production"],
	setPrompt: ["production"],
	// production: filling slots with takes
	generate: ["briefing", "production", "polish"],
	reroll: ["production", "polish"],
	remix: ["production"],
	chainFrom: ["production"],
	extractFrame: ["production"],
	compareTake: ["production"],
	chooseTake: ["production"],
	reviewTake: ["production"],
	approveHeroShot: ["production"],
	setConsistencyContext: ["production"],
	revertBibleCheckpoint: ["production"],
	// audio: part of building the reel AND of dressing it
	addVoiceover: ["production", "polish"],
	addMusicBed: ["production", "polish"],
	revokeVoiceConsent: ["polish"],
	// polish: timeline surgery, text, export
	trim: ["polish"],
	move: ["polish"],
	split: ["polish"],
	reorder: ["polish"],
	remove: ["polish"],
	// removeSilence: polish — auto-cutting dead air is timeline surgery on an
	// already-generated reel, the same bucket as trim/split.
	removeSilence: ["polish"],
	addText: ["polish"],
	updateText: ["polish"],
	applyTransition: ["polish"],
	applyEffect: ["polish"],
	addClip: ["polish"],
	export: ["polish"],
	approveFinalCut: ["polish"],
};

/**
 * The ACTIVE verb names for one phase, in catalog order (stable ordering keeps
 * the declaration payload deterministic turn to turn within a phase). A verb
 * is active when it is core, assigned to this phase, or — fail-open — missing
 * from the assignment table entirely (a new verb someone forgot to bucket:
 * reachable everywhere at runtime, loud test failure at CI time).
 */
export function activeToolNamesForPhase(phase: DirectorPhase): string[] {
	const core = new Set(CORE_TOOL_NAMES);
	return toolCatalog()
		.map((t) => t.name)
		.filter((name) => {
			if (core.has(name)) return true;
			const assigned = PHASE_TOOL_ASSIGNMENTS[name];
			if (!assigned) return true; // fail open — never strand a verb
			return assigned.includes(phase);
		});
}
