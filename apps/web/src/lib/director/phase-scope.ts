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
	// getTimeline: briefing only — same rationale as its sibling
	// getLibraryManifest: the one-line TIMELINE digest already rides the system
	// prompt every turn (buildContextBlock, agent.ts) regardless of phase, so
	// the VERB (full per-element detail) is a planning-time "what do I already
	// have on the timeline before I decide what to build" read. Production and
	// polish are already at their enforced ceiling (see phase-scope.test.ts).
	getTimeline: ["briefing"],
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
	// getBoard/promoteBoardItem/discardBoardItem: production only — a Board
	// draft only exists once a batch generation has produced one, and
	// resolving it (star/dismiss) is take-judging work, the same bucket as
	// compareTake/chooseTake/reviewTake. Kept together (not split across
	// phases) so the model can always list AND act on Board items in the same
	// turn — see the ceiling note in phase-scope.test.ts for why production's
	// bound moved from 27 to 28 to fit this trio.
	getBoard: ["production"],
	promoteBoardItem: ["production"],
	discardBoardItem: ["production"],
	// meta/read utilities — orientation aids: readPlaybook (fetch a prompt
	// playbook body) and reportLimitation (feed back a capability gap).
	// Briefing-only: production sat at its enforced ceiling (28, see the count
	// bounds in phase-scope.test.ts) once the Board trio landed, and polish
	// likewise — prompt-craft guidance is a planning-time read anyway, and
	// hard capability failures in production are already captured by the MCP
	// boundary telemetry (meta.blocked) without needing the verb on the menu.
	readPlaybook: ["briefing"],
	reportLimitation: ["briefing"],
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
	// draftCut (SE-4, editing-first first-cut assembly): briefing ONLY, and not
	// a bug — this is the from-nothing entry point for an editing-first project
	// (real footage, no generative slots). Its ops are plain `addClip`/`trim`/
	// `move` clips, which — like `addClip` itself — never appear in
	// `getReel().slots` (see director-api.ts's `addClip` doc comment), so
	// `deriveDirectorPhase` (keyed on `getReel().slots.length`) stays "briefing"
	// for such a project FOREVER, generative slots or not. Bucketing draftCut
	// anywhere else would strand it: unreachable for the exact footage-only,
	// zero-generation use case it exists for. Same "deciding + producing what
	// to make in one shot" bucket as storyboard/proposeReel.
	draftCut: ["briefing"],
	// production: filling slots with takes
	generate: ["briefing", "production", "polish"],
	reroll: ["production", "polish"],
	remix: ["production"],
	chainFrom: ["production"],
	extractFrame: ["production"],
	compareTake: ["production"],
	chooseTake: ["production"],
	reviewTake: ["production"],
	// watchBack ("SEE the cut" — see docs/plans/2026-09-18-director-autonomy-
	// architecture.md §7): production + polish.
	//  - production, because this is the take-judging phase — the natural home
	//    for every "look before you commit" verb, alongside its source-media
	//    sibling reviewTake.
	//  - polish, because that is where the verb's actual subject EXISTS.
	//    watchBack renders the COMPOSITED timeline (tracks, transitions, text,
	//    effects together), and polish is the only bucket carrying the verbs
	//    that change it — trim/split/reorder/addText/applyTransition/
	//    applyEffect. Scoping it to production alone let the model make those
	//    edits and then be unable to look at what it made: the exact "edits a
	//    timeline it has never seen" failure §7 exists to close, reintroduced
	//    by the phase filter. Two earlier passes deferred this because polish
	//    sat on phase-scope.test.ts's enforced count ceiling; the ceiling was
	//    raised 32 → 33 for this verb specifically (see the bound's comment
	//    there) rather than leaving the polish surface eyeless.
	watchBack: ["production", "polish"],
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
	// addCaptions: polish — same "dress up an already-cut reel" bucket as
	// addText/updateText (it IS an addText batch, just collapsed to one call
	// and one undo step for a whole transcript's worth of cards). Captioning
	// is timeline surgery on footage that is already placed and already
	// transcribed, the same precondition trim/split/addText share.
	addCaptions: ["polish"],
	applyTransition: ["polish"],
	applyEffect: ["polish"],
	// animateItem/removeBackground: polish — motion + AI matting cleanup on
	// EXISTING footage are the same "dress up an already-cut reel" bucket as
	// applyEffect/applyTransition (poach plan items #2/#3,
	// docs/poach/vyra-poach-plan.md).
	animateItem: ["polish"],
	removeBackground: ["polish"],
	addClip: ["polish"],
	export: ["polish"],
	approveFinalCut: ["polish"],
	// readMix (the AUDIO half of "give it eyes" — docs/plans/2026-09-18-
	// director-autonomy-architecture.md §4): polish ONLY, for two reasons that
	// point the same way.
	//  - PRECONDITION. It measures the MIX — dead air, integrated loudness,
	//    where music is competing with speech. That only means something once
	//    footage, voiceover and a music bed are actually assembled together,
	//    the same "needs a real cut-together sequence" precondition
	//    trim/removeSilence/applyEdit share. Reading the mix of a
	//    half-generated reel measures nothing but the gaps.
	//  - REMEDY ADJACENCY. Every fix it can point at — a duck-style applyEdit
	//    program (competing music), removeSilence/a tighten-style applyEdit
	//    program (dead air) — is polish-only. Diagnosis and remedy have to be
	//    reachable in the same bucket or the read is a dead end. This pairing
	//    is not incidental: readMix merges its overlap windows with the
	//    duck-music program's own DEFAULT_MERGE_GAP_SEC so a `competingDb`
	//    figure describes exactly the window that program would duck.
	// Deliberately NOT in production, even though addVoiceover/addMusicBed are
	// (audio is part of BUILDING the reel): during production the mix is still
	// being assembled, and none of the verbs that would act on a bad reading
	// are on the menu there.
	readMix: ["polish"],
	// applyEdit (Wave 2A — the program-engine composition verb, lib/director/
	// program/*): polish ONLY, for the same reason its own primitives
	// (trim/move/split/reorder/remove/addClip/addText/applyTransition/
	// applyEffect/animateItem) all live there — a program can only ever call
	// primitives this bucket already grants one at a time, so bucketing it
	// anywhere else would let it reach ops its OWN phase can't reach
	// individually.
	//
	// HISTORY: this pushed the shared ceiling 34 → 35 when `applyEdit` first
	// landed alongside the three P5 craft macros it was built to subsume
	// (`cutOnBeat`/`tightenToLength`/`duckMusicUnderSpeech`), on the explicit,
	// written promise that "the honest expectation is that a LATER pass
	// deletes them". That pass is this one: all three are proven op-for-op
	// equivalent to a program over the primitive surface
	// (`program/programs/*.program.test.ts`) and DELETED — from this table,
	// the tool catalog, and `director-api.ts`. The ceiling is 35 → 32.
	// `removeSilence` was investigated for the same treatment and STAYS (see
	// its own entry above): it plans through a whole-track
	// `TracksSnapshotCommand`, not a `CraftOp[]`/primitive sequence, and its
	// detection pass is an async file decode this synchronous-only engine
	// cannot run.
	applyEdit: ["polish"],
	// scoreCut (Wave 2 "scoreCut" — lib/director/scoring/score-cut.ts): polish
	// ONLY, the same bucket as its two review siblings watchBack/readMix (the
	// "measure/perceive what you built" reads) — grading the cut is a
	// judged-and-settled-cut activity, not a briefing-time or mid-generation
	// concern. It also pairs with applyEdit, which is polish-only too: a weak
	// hook/hold-rate routes to a suggested tighten-to-length/cut-on-beat
	// program (`edit-critic.ts`'s `suggestFixesForCutScore`), and bucketing
	// scoreCut anywhere applyEdit isn't would surface a fix the model cannot
	// reach the verb to run. The bound moves 32 → 33 for this one addition —
	// see the count-bounds comment in `phase-scope.test.ts` for the running
	// history; this is a single READ, no new mutation surface.
	scoreCut: ["polish"],
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
