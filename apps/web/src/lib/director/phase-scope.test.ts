/**
 * Coverage for `phase-scope.ts` — the Gemini brain's phase-scoped tool
 * exposure.
 *
 * Two invariants matter here:
 *  1. PHASE DERIVATION is a conservative waterfall over readable DirectorApi
 *     state (prefer the EARLIER phase when ambiguous, never throw).
 *  2. BUCKET COVERAGE is total: the union of the three phase buckets must
 *     cover EVERY catalog verb. The test reads names from the LIVE catalog,
 *     so a future verb added without an assignment fails loudly by name.
 */
import { expect, test } from "bun:test";
import type { DirectorApi } from "./director-api";
import {
	activeToolNamesForPhase,
	CORE_TOOL_NAMES,
	deriveDirectorPhase,
	PHASE_TOOL_ASSIGNMENTS,
	RECENT_TAKE_WINDOW_MS,
	type DirectorPhase,
} from "./phase-scope";
import { toolCatalog } from "./tool-catalog";

const PHASES: DirectorPhase[] = ["briefing", "production", "polish"];
const NOW = 1_700_000_000_000;

/** Minimal slot shape the phase waterfall reads. */
function slot(
	status: "empty" | "queued" | "generating" | "ready" | "failed",
	takeCreatedAts: number[] = [],
): Record<string, unknown> {
	return {
		id: "s1",
		prompt: "a shot",
		status,
		takeCount: takeCreatedAts.length,
		takes: takeCreatedAts.map((createdAt, i) => ({
			id: `t${i}`,
			status,
			createdAt,
		})),
		start: 0,
		duration: 4,
	};
}

/** DirectorApi stub exposing only the reads the waterfall touches. */
function api(state: {
	slots?: Array<Record<string, unknown>>;
	proposal?: unknown;
	omitGetProposal?: boolean;
	throwOnGetReel?: boolean;
}): DirectorApi {
	return {
		getReel: () => {
			if (state.throwOnGetReel) throw new Error("no reel");
			return { slots: state.slots ?? [], totalDuration: 0 };
		},
		...(state.omitGetProposal
			? {}
			: {
					getProposal: () => ({
						ok: true,
						message: "",
						data: state.proposal,
					}),
				}),
	} as unknown as DirectorApi;
}

// ── phase derivation ─────────────────────────────────────────────────────────

test("empty reel → briefing (nothing exists; the work is deciding what to make)", () => {
	expect(deriveDirectorPhase(api({}), NOW)).toBe("briefing");
});

test("open draft proposal → briefing even when slots already exist (re-deciding scope)", () => {
	expect(
		deriveDirectorPhase(
			api({ slots: [slot("ready", [NOW - 60_000])], proposal: { shots: [] } }),
			NOW,
		),
	).toBe("briefing");
});

test.each([
	["empty" as const],
	["queued" as const],
	["generating" as const],
	["failed" as const],
])("a slot with status %s → production (unfilled work remains)", (status) => {
	expect(
		deriveDirectorPhase(
			api({
				slots: [slot("ready", [NOW - RECENT_TAKE_WINDOW_MS * 2]), slot(status)],
			}),
			NOW,
		),
	).toBe("production");
});

test("all slots ready but freshly generated → production (still judging takes)", () => {
	expect(
		deriveDirectorPhase(api({ slots: [slot("ready", [NOW - 30_000])] }), NOW),
	).toBe("production");
});

test("all slots ready and settled past the recency window → polish", () => {
	expect(
		deriveDirectorPhase(
			api({ slots: [slot("ready", [NOW - RECENT_TAKE_WINDOW_MS - 1])] }),
			NOW,
		),
	).toBe("polish");
});

test("api without getProposal (legacy/test stubs) never throws — waterfall continues", () => {
	expect(deriveDirectorPhase(api({ omitGetProposal: true }), NOW)).toBe(
		"briefing",
	);
	expect(
		deriveDirectorPhase(
			api({
				omitGetProposal: true,
				slots: [slot("ready", [NOW - RECENT_TAKE_WINDOW_MS - 1])],
			}),
			NOW,
		),
	).toBe("polish");
});

test("unreadable reel fails safe to briefing (the most generous early bucket)", () => {
	expect(deriveDirectorPhase(api({ throwOnGetReel: true }), NOW)).toBe(
		"briefing",
	);
});

// ── bucket coverage (the HARD invariant) ─────────────────────────────────────

test("HARD INVARIANT: every live catalog verb is core or explicitly phase-assigned", () => {
	const assigned = new Set([
		...CORE_TOOL_NAMES,
		...Object.keys(PHASE_TOOL_ASSIGNMENTS),
	]);
	for (const { name } of toolCatalog()) {
		expect(
			assigned.has(name),
			`Catalog verb "${name}" has NO phase assignment — add it to ` +
				`PHASE_TOOL_ASSIGNMENTS (or CORE_TOOL_NAMES) in phase-scope.ts, or it ` +
				`only reaches the Gemini brain through the fail-open runtime default.`,
		).toBe(true);
	}
});

test("HARD INVARIANT: the union of all phase buckets covers every catalog verb", () => {
	const union = new Set(PHASES.flatMap((p) => activeToolNamesForPhase(p)));
	for (const { name } of toolCatalog()) {
		expect(
			union.has(name),
			`Catalog verb "${name}" is unreachable in EVERY phase — it must be ` +
				`active in at least one bucket in phase-scope.ts.`,
		).toBe(true);
	}
});

test("assignment table carries no stale names (every key exists in the live catalog)", () => {
	const catalogNames = new Set(toolCatalog().map((t) => t.name));
	for (const name of [
		...CORE_TOOL_NAMES,
		...Object.keys(PHASE_TOOL_ASSIGNMENTS),
	]) {
		expect(
			catalogNames.has(name),
			`phase-scope.ts assigns "${name}", which is not a catalog verb — ` +
				`stale entry or typo.`,
		).toBe(true);
	}
	// Core and the assignment table must not overlap (one source of truth each).
	for (const name of CORE_TOOL_NAMES) {
		expect(
			name in PHASE_TOOL_ASSIGNMENTS,
			`"${name}" is core AND phase-assigned — remove one.`,
		).toBe(false);
	}
	// Every assignment names at least one phase.
	for (const [name, phases] of Object.entries(PHASE_TOOL_ASSIGNMENTS)) {
		expect(
			phases.length,
			`"${name}" is assigned to zero phases.`,
		).toBeGreaterThan(0);
	}
});

// ── bucket shape ─────────────────────────────────────────────────────────────

test("every phase includes the always-on core", () => {
	for (const phase of PHASES) {
		const active = new Set(activeToolNamesForPhase(phase));
		for (const name of CORE_TOOL_NAMES) {
			expect(active.has(name), `${phase} is missing core verb "${name}"`).toBe(
				true,
			);
		}
	}
});

test("per-phase active counts stay generous but bounded (15–32)", () => {
	// Target is 15–22 (Google's 10–20 guidance, buckets deliberately generous).
	// Polish is REQUIRED to carry the full timeline/text/audio surface plus
	// export/approveFinalCut/voice verbs plus generate+reroll on top of the
	// 7-verb core — that mandated content alone is 25 — plus getTranscript
	// (speech-aligned trim/split is a polish move) and removeSilence (auto-cut
	// dead air is timeline surgery), so polish's own content pins it at 27.
	// Production separately picked up the getBoard/promoteBoardItem/
	// discardBoardItem trio (kept together so the model can list AND act on
	// Board items in the same turn — see phase-scope.ts), pushing the shared
	// ceiling to 28. animateItem (poach plan item #2, "motion on existing
	// footage" — same bucket as applyEffect/applyTransition) landed
	// polish-only, pushing the shared ceiling to 29. The P5 craft trio
	// (cutOnBeat/tightenToLength/duckMusicUnderSpeech — free, instant edits on
	// existing footage, same "editing on an already-cut reel" bucket as
	// trim/removeSilence) landed polish-only too, pushing the shared ceiling
	// to 32.
	//
	// The bound then moved 32 → 33 → 34, both times for a verb that lets the
	// model PERCEIVE the thing polish edits — a class the bucket had been
	// silently starving because it was the cheapest thing to cut against a
	// count:
	//  - 32 → 33, watchBack. Polish owns every verb that changes the
	//    COMPOSITED timeline (trim/split/reorder/addText/applyTransition/
	//    applyEffect) and watchBack is the only verb that RENDERS it. Two
	//    earlier passes deliberately left it production-only to avoid touching
	//    this bound, which meant the polish surface could edit a cut it was
	//    structurally unable to look at — the exact failure
	//    docs/plans/2026-09-18-director-autonomy-architecture.md §7 exists to
	//    close. The bound was the wrong thing to protect; it moved.
	//  - 33 → 34, readMix. Same argument on the audio half (§4 of that doc):
	//    polish owns duckMusicUnderSpeech/removeSilence/tightenToLength/
	//    addMusicBed, and readMix is the only verb that MEASURES the mix those
	//    act on. A remedy on the menu with no way to diagnose what it should
	//    remedy is the same gap as an edit with no way to see it.
	// Both are READS: they add no new mutation surface, only sight.
	//
	// It got nudged once more — 34 → 35, for `applyEdit` (Wave 2A, the
	// program-engine composition verb, `lib/director/program/*`) — landing
	// TEMPORARILY alongside the three P5 craft macros it was designed to
	// subsume, on the explicit written promise that "the honest expectation is
	// that a LATER pass deletes them". `applyEdit` itself added no new
	// mutation SURFACE — every op it can perform is one of the ten primitives
	// already in this bucket, individually — but sitting next to the macros it
	// subsumed was never the end state.
	//
	// That later pass is THIS one. `cutOnBeat`, `tightenToLength` and
	// `duckMusicUnderSpeech` are each now proven op-for-op equivalent to a
	// program over the primitive surface (`program/programs/
	// {cut-on-beat,tighten-to-length,duck-music-under-speech}.ts`, each with
	// its own `*.program.test.ts` parity suite) and are DELETED — from this
	// table, `tool-catalog.ts`, and `director-api.ts`. The bound drops
	// 35 → 32 (the craft trio's own +3 from above, undone); `applyEdit` stays
	// (it is the replacement, not one of the deleted three).
	// `removeSilence` was investigated for the same treatment and STAYS
	// undeleted: it plans through a whole-track `TracksSnapshotCommand` (not a
	// `CraftOp[]`/primitive sequence) built from an async file-decode analysis
	// pass this synchronous-only program engine cannot run — not expressible
	// without inventing new capability the brief for this pass explicitly said
	// not to force.
	//
	// Polish is still past Google's 10–20 guidance (32, vs. briefing/
	// production's high-20s) — the still-open REBALANCE this comment has
	// flagged since the ceiling first crossed 30 remains the honest next step
	// if it grows again, not another nudge.
	for (const phase of PHASES) {
		const count = activeToolNamesForPhase(phase).length;
		expect(
			count,
			`${phase} bucket too small (${count})`,
		).toBeGreaterThanOrEqual(15);
		expect(count, `${phase} bucket too fat (${count})`).toBeLessThanOrEqual(32);
	}
});

test("adjacent-phase jumps stay possible (pinned memberships)", () => {
	const briefing = new Set(activeToolNamesForPhase("briefing"));
	const production = new Set(activeToolNamesForPhase("production"));
	const polish = new Set(activeToolNamesForPhase("polish"));

	// Briefing: planning verbs + the quick single-clip path.
	for (const name of [
		"storyboard",
		"proposeReel",
		"reviseProposal",
		"acceptProposal",
		"intakeReferences",
		"seedStyleFromUnderstanding",
		"reserveSlot",
		"generate",
		"setBudget",
	]) {
		expect(briefing.has(name), `briefing should include ${name}`).toBe(true);
	}
	// Production: the full take-iteration surface, including chaining/extraction.
	for (const name of [
		"generate",
		"reroll",
		"remix",
		"chainFrom",
		"extractFrame",
		"compareTake",
		"chooseTake",
		"reviewTake",
		"approveHeroShot",
		"setPrompt",
		"addVoiceover",
		"addMusicBed",
	]) {
		expect(production.has(name), `production should include ${name}`).toBe(
			true,
		);
	}
	// Polish: all timeline/text/audio verbs + export/final approval + voice
	// consent + generate/reroll for "redo shot 3" asks + the two PERCEPTION
	// verbs (watchBack sees the cut, readMix measures the mix) — pinned here
	// so a future count squeeze can't quietly make the polish surface blind
	// again; see the count-bounds comment above for why the ceiling moved.
	for (const name of [
		"watchBack",
		"readMix",
		"applyEdit",
		"trim",
		"move",
		"split",
		"reorder",
		"remove",
		"removeSilence",
		"addClip",
		"addText",
		"updateText",
		"applyTransition",
		"applyEffect",
		"addVoiceover",
		"addMusicBed",
		"export",
		"approveFinalCut",
		"getVoiceProfiles",
		"revokeVoiceConsent",
		"generate",
		"reroll",
	]) {
		expect(polish.has(name), `polish should include ${name}`).toBe(true);
	}
	// And the scoping actually scopes: no bucket is the whole catalog.
	const total = toolCatalog().length;
	for (const phase of PHASES) {
		expect(activeToolNamesForPhase(phase).length).toBeLessThan(total);
	}
});

test("active names preserve catalog order (stable declarations within a phase)", () => {
	const order = toolCatalog().map((t) => t.name);
	for (const phase of PHASES) {
		const active = activeToolNamesForPhase(phase);
		const indices = active.map((n) => order.indexOf(n));
		expect(indices).toEqual([...indices].sort((a, b) => a - b));
	}
});
