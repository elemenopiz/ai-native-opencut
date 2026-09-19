import { describe, expect, it } from "bun:test";
import {
	bindReferenceHandleSentence,
	buildReferenceContractSentence,
	composeHandlePersonaPrompt,
	composePersonaScenePrompt,
	composePersonaVideoPrompt,
	formatReferenceHandle,
	toReferenceHandle,
} from "../personas";
import type { ReferenceImage } from "../backends/types";

describe("composePersonaScenePrompt", () => {
	it("anchors identity and places the character in the scene", () => {
		const out = composePersonaScenePrompt(
			"Male, Latino, ~30, athletic, hazel eyes",
			"walking into a rain-soaked alley",
		);
		expect(out).toContain(
			"Keep the exact same character shown in the reference image(s): Male, Latino, ~30, athletic, hazel eyes.",
		);
		expect(out).toContain(
			"Place them in this scene: walking into a rain-soaked alley.",
		);
	});
});

describe("composePersonaVideoPrompt", () => {
	it("appends the descriptor as a trailing anchor", () => {
		expect(composePersonaVideoPrompt("He opens the door.", "Orlando")).toBe(
			"He opens the door. Featuring Orlando.",
		);
	});
});

describe("toReferenceHandle", () => {
	it("passes a clean single-word name through unchanged", () => {
		expect(toReferenceHandle("Orlando")).toBe("Orlando");
	});

	it("joins multi-word names with underscores, matching the source doc's examples", () => {
		expect(toReferenceHandle("Orlando spy costume")).toBe(
			"Orlando_spy_costume",
		);
		expect(toReferenceHandle("hologram img")).toBe("hologram_img");
	});

	it("strips punctuation and collapses runs of separators", () => {
		expect(toReferenceHandle("  Maria!! (lead) ")).toBe("Maria_lead");
	});

	it("is deterministic — the same name always yields the same handle", () => {
		expect(toReferenceHandle("Orlando")).toBe(toReferenceHandle("Orlando"));
	});

	it("prefixes a leading digit so the token doesn't read as a number", () => {
		expect(toReferenceHandle("99 Luftballons")).toBe("Ref_99_Luftballons");
	});

	it("returns null when there is no usable character", () => {
		expect(toReferenceHandle("")).toBeNull();
		expect(toReferenceHandle("   ")).toBeNull();
		expect(toReferenceHandle("!!!")).toBeNull();
	});
});

describe("formatReferenceHandle", () => {
	it("prefixes a bare handle body with @", () => {
		expect(formatReferenceHandle("Orlando")).toBe("@Orlando");
	});

	it("is idempotent on an already-formatted handle", () => {
		expect(formatReferenceHandle("@Orlando")).toBe("@Orlando");
	});
});

describe("bindReferenceHandleSentence", () => {
	it("binds the handle to the descriptor with strict identity language", () => {
		const out = bindReferenceHandleSentence(
			"Orlando",
			"Male, Latino, ~30, athletic",
		);
		expect(out.startsWith("@Orlando is the character shown")).toBe(true);
		expect(out).toContain("Male, Latino, ~30, athletic");
		expect(out).toContain("unmistakably the same person");
	});
});

describe("composeHandlePersonaPrompt", () => {
	it("leads the prompt with the handle when not already addressed", () => {
		expect(
			composeHandlePersonaPrompt(
				"opens the door, pauses, looks around",
				"Orlando",
			),
		).toBe("@Orlando opens the door, pauses, looks around");
	});

	it("carries only the delta — no descriptor re-statement", () => {
		const out = composeHandlePersonaPrompt("takes off his jacket", "Orlando");
		expect(out).toBe("@Orlando takes off his jacket");
		expect(out).not.toContain("Featuring");
	});

	it("does not duplicate the handle when the prompt already addresses it", () => {
		expect(
			composeHandlePersonaPrompt("@Orlando opens the door", "Orlando"),
		).toBe("@Orlando opens the door");
	});

	it("is case-insensitive when checking for an existing mention", () => {
		expect(
			composeHandlePersonaPrompt("@orlando opens the door", "Orlando"),
		).toBe("@orlando opens the door");
	});

	it("returns an empty prompt unchanged", () => {
		expect(composeHandlePersonaPrompt("", "Orlando")).toBe("");
		expect(composeHandlePersonaPrompt("   ", "Orlando")).toBe("");
	});

	it("does not treat a handle as already-addressed when it's a substring of another word", () => {
		// "@OrlandoJr" mentions a DIFFERENT handle — @Orlando must still be
		// prepended so the correct character is addressed.
		expect(
			composeHandlePersonaPrompt("@OrlandoJr enters the frame", "Orlando"),
		).toBe("@Orlando @OrlandoJr enters the frame");
	});
});

describe("buildReferenceContractSentence", () => {
	it("returns an empty string when no reference carries a role", () => {
		const refs: ReferenceImage[] = [{ url: "https://x/a.png" }];
		expect(buildReferenceContractSentence(refs)).toBe("");
	});

	it("writes a single-reference contract clause, addressed by handle", () => {
		const refs: ReferenceImage[] = [
			{ url: "https://x/a.png", role: "appearance", handle: "Maria" },
		];
		expect(buildReferenceContractSentence(refs)).toBe(
			"Use @Maria exclusively for the character's appearance.",
		);
	});

	it("writes a multi-reference contract, mirroring the source doc's two-image example", () => {
		const refs: ReferenceImage[] = [
			{ url: "https://x/a.png", role: "appearance" },
			{ url: "https://x/b.png", role: "environment" },
		];
		expect(buildReferenceContractSentence(refs)).toBe(
			"Use image 1 exclusively for the character's appearance; use image 2 only for the environment, lighting, atmosphere, materials, and architectural language.",
		);
	});

	it("numbers a roleless reference by its true position in the full array", () => {
		const refs: ReferenceImage[] = [
			{ url: "https://x/unrelated.png" }, // no role — skipped, but still position 1
			{ url: "https://x/grade.png", role: "grade" },
		];
		expect(buildReferenceContractSentence(refs)).toBe(
			"Use image 2 exclusively for color grading and tonal balance.",
		);
	});

	it("mixes handles and positional fallbacks in one sentence", () => {
		const refs: ReferenceImage[] = [
			{ url: "https://x/orlando.png", role: "appearance", handle: "Orlando" },
			{ url: "https://x/loft.png", role: "environment" },
			{ url: "https://x/grade.png", role: "grade", handle: "moody_grade" },
		];
		expect(buildReferenceContractSentence(refs)).toBe(
			"Use @Orlando exclusively for the character's appearance; " +
				"use image 2 only for the environment, lighting, atmosphere, materials, and architectural language; " +
				"use @moody_grade only for color grading and tonal balance.",
		);
	});

	it("covers the style role", () => {
		const refs: ReferenceImage[] = [
			{ url: "https://x/ref.png", role: "style" },
		];
		expect(buildReferenceContractSentence(refs)).toBe(
			"Use image 1 exclusively for style, mood, and lighting.",
		);
	});
});
