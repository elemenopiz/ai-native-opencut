import { describe, expect, it } from "bun:test";
import {
	buildReelProposal,
	decideShotSource,
	formatProposalDraft,
	proposalToPlan,
	reviseProposalShot,
	validateProposal,
	type AssetResolver,
	type ProposedShotInput,
	type ReelProposal,
	type ResolvedAsset,
} from "./reel-proposal";

/**
 * Pure-logic tests for Flow B (propose-first drafting): the retrieve-vs-generate
 * allocation rule ({@link decideShotSource}), the HARD grounding gate
 * ({@link validateProposal} — a fabricated citation cannot survive), and the
 * single-line re-plan stability ({@link reviseProposalShot} touches only one shot).
 */

// A resolver over a tiny fixed "real index": only these ids exist.
const INDEX: Record<string, ResolvedAsset> = {
	m_rooftop: {
		id: "m_rooftop",
		name: "rooftop.mp4",
		ref: "#12",
		caption: "rooftop b-roll, dusk, warm",
		role: "b-roll",
	},
	m_hero: {
		id: "m_hero",
		name: "packshot.mp4",
		ref: "#4",
		caption: "product on marble, backlit",
		role: "hero",
	},
	m_multishot: {
		id: "m_multishot",
		name: "montage.mp4",
		ref: "#7",
		caption: "3-shot montage",
		role: "b-roll",
		shotCount: 3,
	},
};
const resolve: AssetResolver = (id) => INDEX[id];

describe("decideShotSource — retrieve-vs-generate allocation", () => {
	it("generates when there is no candidate at all", () => {
		expect(decideShotSource({ importance: "hero" }).source).toBe("generate");
		expect(decideShotSource({ importance: "broll" }).source).toBe("generate");
		expect(decideShotSource({}).source).toBe("generate");
	});

	it("routes a hero with a candidate to generate-to-match (spend, inherit the look)", () => {
		const d = decideShotSource({
			importance: "hero",
			candidate: { mediaId: "m_hero", score: 0.31 },
		});
		expect(d.source).toBe("generate-to-match");
		expect(d.citation?.mediaId).toBe("m_hero");
	});

	it("prefers retrieval for b-roll whenever there's any candidate", () => {
		const d = decideShotSource({
			importance: "broll",
			candidate: { mediaId: "m_rooftop", score: 0.05 }, // even a loose match
		});
		expect(d.source).toBe("library");
		expect(d.citation?.mediaId).toBe("m_rooftop");
	});

	it("retrieves a STRONG support match but generates a WEAK one", () => {
		const strong = decideShotSource({
			importance: "support",
			candidate: { mediaId: "m_rooftop", score: 0.5 },
		});
		expect(strong.source).toBe("library");

		const weak = decideShotSource({
			importance: "support",
			candidate: { mediaId: "m_rooftop", score: 0.05 },
		});
		expect(weak.source).toBe("generate");
	});

	it("treats a scoreless candidate as trusted (grounded by role)", () => {
		const d = decideShotSource({
			importance: "support",
			candidate: { mediaId: "m_rooftop" },
		});
		expect(d.source).toBe("library");
	});
});

describe("validateProposal — the grounding gate (no fabricated citations)", () => {
	it("REJECTS a fabricated id: the shot is repaired to generate and cites nothing", () => {
		const proposal = buildReelProposal({
			shots: [
				{
					source: "library",
					citation: { mediaId: "m_DOES_NOT_EXIST" },
					prompt: "cold open",
					importance: "broll",
				},
				{
					source: "generate-to-match",
					citation: { mediaId: "m_ALSO_FAKE" },
					prompt: "hero shot",
					importance: "hero",
				},
			],
		});

		const {
			proposal: validated,
			ok,
			repairs,
		} = validateProposal(proposal, resolve);

		expect(ok).toBe(false);
		expect(repairs).toHaveLength(2);
		// Both shots were downgraded to generate and stripped of their citation.
		for (const shot of validated.shots) {
			expect(shot.source).toBe("generate");
			expect(shot.citation).toBeUndefined();
		}
		// The fabricated ids appear NOWHERE in the accepted plan's citations.
		const citedIds = validated.shots
			.map((s) => s.citation?.mediaId)
			.filter(Boolean);
		expect(citedIds).not.toContain("m_DOES_NOT_EXIST");
		expect(citedIds).not.toContain("m_ALSO_FAKE");
		// The repair carries the offending id for the draft to explain.
		expect(repairs[0].citedMediaId).toBe("m_DOES_NOT_EXIST");
		expect(repairs[0].to).toBe("generate");
	});

	it("CANONICALIZES a real citation from the index — a model-supplied caption cannot survive", () => {
		const proposal = buildReelProposal({
			shots: [
				{
					source: "library",
					// The model tries to assert a caption/role/ref — all must be overwritten.
					citation: {
						mediaId: "m_rooftop",
						caption: "a beach at noon (WRONG, hallucinated)",
						role: "hero",
						ref: "#999",
					},
					prompt: "cold open",
					importance: "broll",
				},
			],
		});

		const { proposal: validated, ok } = validateProposal(proposal, resolve);
		expect(ok).toBe(true);
		const c = validated.shots[0].citation;
		expect(c?.mediaId).toBe("m_rooftop");
		expect(c?.caption).toBe("rooftop b-roll, dusk, warm"); // from the index, not the model
		expect(c?.role).toBe("b-roll");
		expect(c?.ref).toBe("#12");
	});

	it("repairs a library shot that cited NOTHING", () => {
		const proposal = buildReelProposal({
			shots: [
				{ source: "library", prompt: "some b-roll", importance: "broll" },
			],
		});
		const { proposal: validated, repairs } = validateProposal(
			proposal,
			resolve,
		);
		expect(validated.shots[0].source).toBe("generate");
		expect(repairs[0].reason).toContain("cited no asset");
	});

	it("clamps an out-of-range sourceShotIndex into the source's shot count", () => {
		const proposal = buildReelProposal({
			shots: [
				{
					source: "library",
					citation: { mediaId: "m_multishot", sourceShotIndex: 99 },
					prompt: "montage beat",
				},
			],
		});
		const { proposal: validated } = validateProposal(proposal, resolve);
		expect(validated.shots[0].citation?.sourceShotIndex).toBe(2); // clamped to shotCount-1
	});

	it("drops a stray citation from a pure generate shot", () => {
		const proposal = buildReelProposal({
			shots: [
				{ source: "generate", citation: { mediaId: "m_hero" }, prompt: "x" },
			],
		});
		const { proposal: validated } = validateProposal(proposal, resolve);
		expect(validated.shots[0].citation).toBeUndefined();
	});
});

describe("buildReelProposal — derivation + defaults", () => {
	it("floors durations, assigns 1-based indices, and sums total duration", () => {
		const proposal = buildReelProposal({
			shots: [
				{ prompt: "a", duration: 0 }, // floored to default 6
				{ prompt: "b", duration: 4 },
			],
		});
		expect(proposal.shots[0].duration).toBe(6);
		expect(proposal.shots[0].index).toBe(1);
		expect(proposal.shots[1].index).toBe(2);
		expect(proposal.totalDuration).toBe(10);
	});

	it("derives the source from importance + citation when the author omits it", () => {
		const proposal = buildReelProposal({
			shots: [
				// b-roll + a citation → library
				{ citation: { mediaId: "m_rooftop" }, importance: "broll", prompt: "" },
				// hero + a citation → generate-to-match
				{ citation: { mediaId: "m_hero" }, importance: "hero", prompt: "" },
				// no citation → generate
				{ importance: "support", prompt: "x" },
			],
		});
		expect(proposal.shots[0].source).toBe("library");
		expect(proposal.shots[1].source).toBe("generate-to-match");
		expect(proposal.shots[2].source).toBe("generate");
	});
});

describe("reviseProposalShot — single-line stability", () => {
	function threeShotDraft(): ReelProposal {
		const shots: ProposedShotInput[] = [
			{
				source: "library",
				citation: { mediaId: "m_rooftop" },
				prompt: "cold open",
				importance: "broll",
			},
			{
				source: "generate",
				prompt: "founder to camera",
				importance: "support",
			},
			{ source: "library", citation: { mediaId: "m_hero" }, prompt: "outro" },
		];
		return validateProposal(buildReelProposal({ shots }), resolve).proposal;
	}

	it("re-plans ONLY the target shot; the others are preserved BY REFERENCE", () => {
		const before = threeShotDraft();
		const { proposal: after, changed } = reviseProposalShot(
			before,
			2,
			{ prompt: "founder to camera, colder grade" },
			resolve,
		);

		expect(changed).toBe(true);
		// Shots 1 and 3 are the SAME object references (untouched).
		expect(after.shots[0]).toBe(before.shots[0]);
		expect(after.shots[2]).toBe(before.shots[2]);
		// Shot 2 is a new object with the new prompt.
		expect(after.shots[1]).not.toBe(before.shots[1]);
		expect(after.shots[1].prompt).toBe("founder to camera, colder grade");
	});

	it("re-validates a swapped-in citation: a fabricated swap-in is rejected", () => {
		const before = threeShotDraft();
		const { proposal: after, repair } = reviseProposalShot(
			before,
			2,
			{ source: "library", citation: { mediaId: "m_FAKE_SWAP" } },
			resolve,
		);
		expect(after.shots[1].source).toBe("generate");
		expect(after.shots[1].citation).toBeUndefined();
		expect(repair?.citedMediaId).toBe("m_FAKE_SWAP");
		// Still didn't touch the neighbors.
		expect(after.shots[0]).toBe(before.shots[0]);
	});

	it("swaps shot 2 to a real library asset and grounds it", () => {
		const before = threeShotDraft();
		const { proposal: after } = reviseProposalShot(
			before,
			2,
			{ source: "library", citation: { mediaId: "m_hero" } },
			resolve,
		);
		expect(after.shots[1].source).toBe("library");
		expect(after.shots[1].citation?.caption).toBe("product on marble, backlit");
	});

	it("is a no-op for an out-of-range index", () => {
		const before = threeShotDraft();
		const { proposal: after, changed } = reviseProposalShot(
			before,
			9,
			{ prompt: "x" },
			resolve,
		);
		expect(changed).toBe(false);
		expect(after).toBe(before);
	});
});

describe("proposalToPlan + formatProposalDraft", () => {
	it("renders a readable, cited draft the human reacts to", () => {
		const proposal = validateProposal(
			buildReelProposal({
				shots: [
					{
						source: "library",
						citation: { mediaId: "m_rooftop" },
						intent: "cold open",
						importance: "broll",
						prompt: "",
					},
					{ source: "generate", prompt: "founder to camera, warm" },
				],
			}),
			resolve,
		).proposal;

		const draft = formatProposalDraft(proposal);
		expect(draft).toContain("Draft reel — 2 shots");
		expect(draft).toContain("#12");
		expect(draft).toContain("library →");
		expect(draft).toContain("generate:");
		expect(draft).toContain("accept");
	});

	it("converts an accepted proposal into a durable StoryboardPlan", () => {
		const proposal = validateProposal(
			buildReelProposal({
				shots: [
					{
						source: "library",
						citation: { mediaId: "m_rooftop" },
						importance: "broll",
						prompt: "",
					},
				],
			}),
			resolve,
		).proposal;
		// Pretend it was materialized.
		proposal.shots[0].elementId = "el_1";

		const plan = proposalToPlan(proposal);
		expect(plan.shotCount).toBe(1);
		expect(plan.shots[0].slotId).toBe("el_1");
		expect(plan.shots[0].intent).toContain("rooftop b-roll");
	});
});
