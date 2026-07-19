import { describe, expect, it } from "bun:test";
import type {
	FootageInventory,
	FootageInventoryAsset,
	StoryBrief,
} from "./types";
import {
	TREATMENT_MAX_SECTIONS,
	TREATMENT_SYSTEM_PROMPT,
	buildTreatmentPrompt,
	parseTreatment,
} from "./treatment";

/**
 * SE-2 — the Treatment prompt-building + reply-parsing tests. NO model calls
 * anywhere here (per the design doc's "deterministic stages must never call
 * a model" + this module's own "no relay" discipline): every test either
 * exercises `buildTreatmentPrompt` on plain `StoryBrief`/`FootageInventory`
 * fixtures, or feeds `parseTreatment` a hand-written (mocked) reply string
 * standing in for what a model would have said.
 */

function asset(
	overrides: Partial<FootageInventoryAsset> = {},
): FootageInventoryAsset {
	return {
		id: "a1",
		kind: "video",
		durationSec: 10,
		hasBeatGrid: false,
		hasUnderstanding: false,
		hasDeepUnderstanding: false,
		hasSilenceMap: false,
		possiblyUntranscribed: false,
		...overrides,
	};
}

function inventory(assets: FootageInventoryAsset[]): FootageInventory {
	const totalDurationSec = assets.reduce((acc, a) => acc + a.durationSec, 0);
	const speechDurationSec = assets
		.filter((a) => a.hasTranscriptSegments === true)
		.reduce((acc, a) => acc + a.durationSec, 0);
	return {
		assets,
		totalDurationSec,
		speechShare:
			totalDurationSec > 0 ? speechDurationSec / totalDurationSec : 0,
		untranscribedCount: assets.filter((a) => a.possiblyUntranscribed).length,
	};
}

const basicBrief: StoryBrief = {
	instruction: "make me a 45 second recap",
	goal: "recap the launch",
	targetDuration: {
		sec: 45,
		source: "user-instruction",
		note: "user said '45 seconds'",
	},
};

const basicInventory = inventory([
	asset({
		id: "hero-1",
		kind: "video",
		durationSec: 20,
		hasUnderstanding: true,
		hasDeepUnderstanding: true,
		hasTranscriptSegments: true,
	}),
	asset({
		id: "broll-1",
		kind: "video",
		durationSec: 15,
		hasUnderstanding: true,
	}),
	asset({
		id: "audio-1",
		kind: "audio",
		durationSec: 30,
		possiblyUntranscribed: true,
	}),
]);

describe("buildTreatmentPrompt", () => {
	it("is deterministic: identical inputs produce byte-identical prompt strings", () => {
		const first = buildTreatmentPrompt(basicBrief, basicInventory);
		const second = buildTreatmentPrompt(
			{ ...basicBrief },
			{
				...basicInventory,
				assets: basicInventory.assets.map((a) => ({ ...a })),
			},
		);
		expect(second).toEqual(first);
		expect(second.system).toBe(first.system);
		expect(second.user).toBe(first.user);
	});

	it("system prompt is spec-complete: hook-first + editing-first/never-generate + gap-note + tolerance + schema all present", () => {
		const prompt = buildTreatmentPrompt(basicBrief, basicInventory);
		expect(prompt.system).toBe(TREATMENT_SYSTEM_PROMPT);
		expect(prompt.system).toContain("HOOK FIRST");
		expect(prompt.system.toLowerCase()).toContain("never generate");
		expect(prompt.system).toContain("GAP:");
		expect(prompt.system).toContain("±10%");
		expect(prompt.system).toContain('"materialRefs"');
		expect(prompt.system).toContain('"logline"');
		expect(prompt.system).toContain(String(TREATMENT_MAX_SECTIONS));
	});

	it("user block carries the brief verbatim + inventory digest + target duration with tolerance band", () => {
		const prompt = buildTreatmentPrompt(basicBrief, basicInventory);
		expect(prompt.user).toContain(JSON.stringify(basicBrief.instruction));
		expect(prompt.user).toContain("recap the launch");
		expect(prompt.user).toContain("TARGET DURATION: 45s");
		// ±10% of 45s = 40.5..49.5
		expect(prompt.user).toContain("40.5s");
		expect(prompt.user).toContain("49.5s");
		for (const a of basicInventory.assets) {
			expect(prompt.user).toContain(JSON.stringify(a.id));
		}
		expect(prompt.user).toContain("speechShare=");
		expect(prompt.user).toContain("possibly-untranscribed");
	});

	it("surfaces possiblyUntranscribed honestly per-asset", () => {
		const prompt = buildTreatmentPrompt(basicBrief, basicInventory);
		expect(prompt.user).toContain("speech:UNCHECKED(possibly-untranscribed)");
	});

	it("no target resolved (unset) ⇒ explicit 'pick a natural length' line, never a fabricated number", () => {
		const brief: StoryBrief = { instruction: "make me something cool" };
		const prompt = buildTreatmentPrompt(brief, basicInventory);
		expect(prompt.user).toContain("TARGET DURATION: none specified");
		expect(prompt.user).not.toContain("±10% tolerance).");
	});
});

describe("parseTreatment", () => {
	it("happy parse: valid JSON reply with real material refs ⇒ ok:true, well-formed Treatment", () => {
		const reply = JSON.stringify({
			logline: "A punchy recap of the launch.",
			sections: [
				{ intent: "hook", targetSec: 15, materialRefs: ["hero-1"], order: 0 },
				{ intent: "demo", targetSec: 15, materialRefs: ["broll-1"], order: 1 },
				{ intent: "cta", targetSec: 15, materialRefs: ["audio-1"], order: 2 },
			],
		});
		const result = parseTreatment(reply, basicInventory, {
			targetDurationSec: 45,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.treatment.logline).toBe("A punchy recap of the launch.");
		expect(result.treatment.sections).toHaveLength(3);
		expect(result.treatment.sections.map((s) => s.order)).toEqual([0, 1, 2]);
		expect(result.treatment.sections[0].materialRefs).toEqual(["hero-1"]);
		expect(result.deviationNote).toBeUndefined();
		expect(result.truncationNote).toBeUndefined();
	});

	it("allows an empty materialRefs array (gap-note section) without failing", () => {
		const reply = JSON.stringify({
			logline: "Recap with one gap.",
			sections: [
				{ intent: "hook", targetSec: 20, materialRefs: ["hero-1"], order: 0 },
				{
					intent: "cutaway to product — GAP: no matching b-roll in the library",
					targetSec: 10,
					materialRefs: [],
					order: 1,
				},
			],
		});
		const result = parseTreatment(reply, basicInventory);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.treatment.sections[1].materialRefs).toEqual([]);
	});

	it("tolerates a fenced ```json reply", () => {
		const body = {
			logline: "Fenced reply.",
			sections: [
				{ intent: "hook", targetSec: 10, materialRefs: ["hero-1"], order: 0 },
			],
		};
		const reply = `Here you go:\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\nHope that helps!`;
		const result = parseTreatment(reply, basicInventory);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.treatment.logline).toBe("Fenced reply.");
	});

	it("no JSON in the reply at all ⇒ ok:false with a non-empty retryHint", () => {
		const result = parseTreatment(
			"Sorry, I can't help with that.",
			basicInventory,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected error");
		expect(result.error.reason).toBe("no-json");
		expect(result.retryHint.length).toBeGreaterThan(0);
	});

	it("malformed JSON ⇒ ok:false, reason malformed-json, actionable retryHint", () => {
		// Balanced curly braces (so `firstJsonObject` extracts an object to try
		// parsing), but syntactically invalid JSON inside (a double comma) so
		// `JSON.parse` itself throws — distinct from "no-json" (no extractable
		// object at all).
		const result = parseTreatment(
			'{"logline": "oops", "sections": [1,,2]}',
			basicInventory,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected error");
		expect(result.error.reason).toBe("malformed-json");
		expect(result.retryHint).toContain("malformed");
	});

	it("missing logline ⇒ ok:false, invalid-shape", () => {
		const reply = JSON.stringify({
			sections: [
				{ intent: "hook", targetSec: 10, materialRefs: ["hero-1"], order: 0 },
			],
		});
		const result = parseTreatment(reply, basicInventory);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected error");
		expect(result.error.reason).toBe("invalid-shape");
		expect(result.retryHint).toContain("logline");
	});

	it("empty sections array ⇒ ok:false, invalid-shape", () => {
		const reply = JSON.stringify({ logline: "Empty.", sections: [] });
		const result = parseTreatment(reply, basicInventory);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected error");
		expect(result.error.reason).toBe("invalid-shape");
	});

	it("non-positive/non-finite targetSec ⇒ ok:false, invalid-sections, with a coaching retryHint", () => {
		const reply = JSON.stringify({
			logline: "Bad target.",
			sections: [
				{ intent: "hook", targetSec: -5, materialRefs: ["hero-1"], order: 0 },
			],
		});
		const result = parseTreatment(reply, basicInventory);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected error");
		expect(result.error.reason).toBe("invalid-sections");
		expect(result.retryHint).toContain("positive finite");
	});

	it("missing intent ⇒ ok:false, invalid-sections", () => {
		const reply = JSON.stringify({
			logline: "No intent.",
			sections: [
				{ intent: "", targetSec: 10, materialRefs: ["hero-1"], order: 0 },
			],
		});
		const result = parseTreatment(reply, basicInventory);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected error");
		expect(result.error.reason).toBe("invalid-sections");
	});

	it("unknown materialRef ⇒ ok:false, unknown-material-refs, coaching error lists valid ids, retryHint names them", () => {
		const reply = JSON.stringify({
			logline: "Dangling ref.",
			sections: [
				{
					intent: "hook",
					targetSec: 10,
					materialRefs: ["hero-1", "nonexistent-clip"],
					order: 0,
				},
			],
		});
		const result = parseTreatment(reply, basicInventory);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected error");
		expect(result.error.reason).toBe("unknown-material-refs");
		expect(result.error.unknownRefs).toEqual(["nonexistent-clip"]);
		expect(result.error.validIds).toEqual(
			expect.arrayContaining(["hero-1", "broll-1", "audio-1"]),
		);
		expect(result.retryHint).toContain("nonexistent-clip");
		expect(result.retryHint).toContain("hero-1");
		expect(result.retryHint).toContain("broll-1");
		expect(result.retryHint).toContain("audio-1");
	});

	it("sum-vs-target within tolerance ⇒ no deviationNote", () => {
		const reply = JSON.stringify({
			logline: "On target.",
			sections: [
				{ intent: "hook", targetSec: 22, materialRefs: ["hero-1"], order: 0 },
				{ intent: "demo", targetSec: 22, materialRefs: ["broll-1"], order: 1 },
			],
		});
		// sum = 44s, target = 45s ⇒ within ±10% (40.5..49.5)
		const result = parseTreatment(reply, basicInventory, {
			targetDurationSec: 45,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.deviationNote).toBeUndefined();
	});

	it("sum-vs-target outside tolerance ⇒ ok:true with a deviationNote, not a hard failure", () => {
		const reply = JSON.stringify({
			logline: "Way short.",
			sections: [
				{ intent: "hook", targetSec: 5, materialRefs: ["hero-1"], order: 0 },
			],
		});
		// sum = 5s, target = 45s ⇒ way outside ±10%.
		const result = parseTreatment(reply, basicInventory, {
			targetDurationSec: 45,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.deviationNote).toBeDefined();
		expect(result.deviationNote).toContain("5.0s");
		expect(result.deviationNote).toContain("45s");
	});

	it("no targetDurationSec supplied ⇒ deviation check skipped entirely, never fabricated", () => {
		const reply = JSON.stringify({
			logline: "No target given.",
			sections: [
				{ intent: "hook", targetSec: 5, materialRefs: ["hero-1"], order: 0 },
			],
		});
		const result = parseTreatment(reply, basicInventory);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.deviationNote).toBeUndefined();
	});

	it("section cap: more than TREATMENT_MAX_SECTIONS ⇒ truncated to the cap, ok:true with truncationNote, order re-sequenced", () => {
		const manyAssets = Array.from(
			{ length: TREATMENT_MAX_SECTIONS + 5 },
			(_, i) => asset({ id: `clip-${i}`, kind: "video", durationSec: 5 }),
		);
		const bigInventory = inventory(manyAssets);
		const sections = manyAssets.map((a, i) => ({
			intent: `section ${i}`,
			targetSec: 5,
			materialRefs: [a.id],
			order: i,
		}));
		const reply = JSON.stringify({ logline: "Too many sections.", sections });
		const result = parseTreatment(reply, bigInventory);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.treatment.sections).toHaveLength(TREATMENT_MAX_SECTIONS);
		expect(result.treatment.sections.map((s) => s.order)).toEqual(
			Array.from({ length: TREATMENT_MAX_SECTIONS }, (_, i) => i),
		);
		// The strongest (lowest-order) sections survive truncation.
		expect(result.treatment.sections[0].materialRefs).toEqual(["clip-0"]);
		expect(result.truncationNote).toBeDefined();
		expect(result.truncationNote).toContain(String(TREATMENT_MAX_SECTIONS));
	});

	it("order normalization: out-of-order/non-sequential reported order values are sorted and re-sequenced 0..n-1", () => {
		const reply = JSON.stringify({
			logline: "Scrambled order.",
			sections: [
				{ intent: "third", targetSec: 5, materialRefs: ["audio-1"], order: 9 },
				{ intent: "first", targetSec: 5, materialRefs: ["hero-1"], order: 0 },
				{ intent: "second", targetSec: 5, materialRefs: ["broll-1"], order: 3 },
			],
		});
		const result = parseTreatment(reply, basicInventory);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.treatment.sections.map((s) => s.intent)).toEqual([
			"first",
			"second",
			"third",
		]);
		expect(result.treatment.sections.map((s) => s.order)).toEqual([0, 1, 2]);
	});
});
