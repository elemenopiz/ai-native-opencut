/**
 * Coverage for the playbooks registry — in particular `shot-craft`, added
 * alongside the two verbatim UGC playbooks (see README.md / POACH-LEDGER.md),
 * and `PROMPT_CRAFT_QUICKREF`, the condensed craft the enhance-prompt route
 * (`app/api/llm/enhance-prompt/route.ts`) weaves into its system prompt.
 */
import { describe, expect, test } from "bun:test";
import { PLAYBOOKS, PROMPT_CRAFT_QUICKREF, type PlaybookId } from "./index";

describe("PLAYBOOKS registry", () => {
	test("all three playbooks are present and well-formed", () => {
		const ids: PlaybookId[] = [
			"ugc-photo-prompts",
			"ugc-video-prompts",
			"shot-craft",
		];
		for (const id of ids) {
			const playbook = PLAYBOOKS[id];
			expect(playbook.id).toBe(id);
			expect(playbook.title.length).toBeGreaterThan(0);
			expect(playbook.description.length).toBeGreaterThan(0);
			expect(playbook.content.length).toBeGreaterThan(0);
			// Every playbook body carries frontmatter, matching the existing format.
			expect(playbook.content.startsWith("---\n")).toBe(true);
		}
	});

	test("shot-craft covers the four required craft topics", () => {
		const { content } = PLAYBOOKS["shot-craft"];
		// Camera/motion language.
		expect(content).toContain("Motion verbs");
		expect(content).toContain("dolly");
		// STYLE-token cross-shot consistency.
		expect(content).toContain("STYLE-token consistency for multi-shot reels");
		expect(content).toContain("verbatim");
		// Structured shot block.
		expect(content).toContain("SCENE:");
		expect(content).toContain("MOTION:");
		expect(content).toContain("AUDIO:");
		expect(content).toContain("NEGATIVE:");
		// Positive phrasing for no-negative-prompt models.
		expect(content).toContain("tack sharp");
		expect(content).toContain("uninhabited landscape");
		// Don't-redescribe-the-anchor-frame rule.
		expect(content).toContain("Don't redescribe the anchor frame");
	});

	test("shot-craft resolves through the same lookup readPlaybook uses", () => {
		// Mirrors the lookup in director/tool-catalog.ts's readPlaybook handler
		// (`PLAYBOOKS[id as PlaybookId]`) — confirms the registry itself, not
		// just the .md source file, carries the new playbook end to end.
		const id = "shot-craft" as PlaybookId;
		const playbook = PLAYBOOKS[id];
		expect(playbook).toBeDefined();
		expect(playbook.title).toBe("Shot Craft: Camera, Motion & Style-Lock");
	});
});

describe("PROMPT_CRAFT_QUICKREF", () => {
	test("has one non-empty craft line per topic, consumed by enhance-prompt", () => {
		for (const value of Object.values(PROMPT_CRAFT_QUICKREF)) {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
	});

	test("positive-phrasing line gives concrete before/after rewrites", () => {
		expect(PROMPT_CRAFT_QUICKREF.positivePhrasing).toContain("tack sharp");
		expect(PROMPT_CRAFT_QUICKREF.positivePhrasing).toContain(
			"uninhabited landscape",
		);
	});

	test("styleToken line states verbatim repetition across shots", () => {
		expect(PROMPT_CRAFT_QUICKREF.styleToken).toContain("verbatim");
		expect(PROMPT_CRAFT_QUICKREF.styleToken).toContain("multi-shot");
	});
});
