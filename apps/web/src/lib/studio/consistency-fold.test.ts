import { describe, expect, test } from "bun:test";
import { makeFakeEditor } from "@/lib/director/fake-editor";
import { storeConsistencyContext } from "@/lib/director/consistency-prompt";
import type { ConsistencyContext } from "@/lib/director/consistency-prompt";
import type { GenerationSpec } from "@/types/timeline";
import {
	foldConsistencyIntoPrompt,
	foldConsistencyIntoSpec,
	isConsistencyFolded,
	resolveConsistencyContext,
	resolvePersonaSeedOverride,
} from "./consistency-fold";

const ctx: ConsistencyContext = {
	style: "warm amber grade",
	characters: [{ name: "Mara", descriptor: "auburn hair, green jacket" }],
	setting: "sunlit kitchen",
};

const baseSpec: GenerationSpec = {
	prompt: "a woman pours coffee",
	mode: "text-to-video",
	resolution: "720p",
	orientation: "landscape",
	duration: 5,
};

// ── resolveConsistencyContext — WeakMap-first, bible-fallback order ─────────

describe("resolveConsistencyContext", () => {
	test("returns undefined when neither the WeakMap nor the bible carry a context", () => {
		const { editor } = makeFakeEditor();
		expect(resolveConsistencyContext(editor)).toBeUndefined();
	});

	test("reads the live WeakMap when set (the fast/normal path post-hydration)", () => {
		const { editor } = makeFakeEditor();
		storeConsistencyContext(editor, ctx);
		expect(resolveConsistencyContext(editor)).toEqual(ctx);
	});

	test("falls back to the persisted Project Bible when the WeakMap is empty", () => {
		const { editor } = makeFakeEditor();
		// Simulate hydration not having run yet (or an editor used outside the
		// EditorProvider mount flow): bible carries a context, WeakMap doesn't.
		editor.project.setProjectBible({
			bible: { version: 1, updatedAt: 1, consistencyContext: ctx },
		});
		expect(resolveConsistencyContext(editor)).toEqual(ctx);
	});

	test("the live WeakMap wins over a (stale) persisted bible value", () => {
		const { editor } = makeFakeEditor();
		const staleCtx: ConsistencyContext = { ...ctx, style: "stale grade" };
		editor.project.setProjectBible({
			bible: { version: 1, updatedAt: 1, consistencyContext: staleCtx },
		});
		storeConsistencyContext(editor, ctx);
		expect(resolveConsistencyContext(editor)).toEqual(ctx);
	});
});

// ── isConsistencyFolded / foldConsistencyIntoPrompt — idempotency ──────────

describe("foldConsistencyIntoPrompt", () => {
	test("no-ops when there is no context", () => {
		expect(foldConsistencyIntoPrompt(baseSpec.prompt, undefined)).toBe(
			baseSpec.prompt,
		);
	});

	test("prepends the STYLE/CHARACTERS/SETTING block when a context is given", () => {
		const folded = foldConsistencyIntoPrompt(baseSpec.prompt, ctx);
		expect(folded).toContain("STYLE: warm amber grade");
		expect(folded).toContain("CHARACTERS:");
		expect(folded).toContain("- Mara: auburn hair, green jacket");
		expect(folded).toContain("SETTING: sunlit kitchen");
		expect(folded).toContain(`SHOT: ${baseSpec.prompt}`);
		expect(isConsistencyFolded(folded)).toBe(true);
	});

	test("is idempotent: folding an already-folded prompt again is a no-op", () => {
		const once = foldConsistencyIntoPrompt(baseSpec.prompt, ctx);
		const twice = foldConsistencyIntoPrompt(once, ctx);
		expect(twice).toBe(once);
		// And doesn't compound under a DIFFERENT context either — the guard is
		// "already folded", not "already folded with this exact context".
		const otherCtx: ConsistencyContext = { ...ctx, style: "cool teal grade" };
		const stillOnce = foldConsistencyIntoPrompt(once, otherCtx);
		expect(stillOnce).toBe(once);
	});

	test("an ordinary user prompt that happens not to match the folded shape is untouched by the guard", () => {
		const prompt = "STYLE guide reference shot, no other markers here";
		const folded = foldConsistencyIntoPrompt(prompt, ctx);
		// Doesn't match the exact `STYLE: ...\n\nSHOT:` shape, so it still folds.
		expect(folded).not.toBe(prompt);
		expect(folded).toContain("SHOT: STYLE guide reference shot");
	});
});

describe("foldConsistencyIntoSpec", () => {
	test("folds spec.prompt using the editor's resolved context", () => {
		const { editor } = makeFakeEditor();
		storeConsistencyContext(editor, ctx);
		const folded = foldConsistencyIntoSpec(baseSpec, editor);
		expect(folded.prompt).toContain("STYLE: warm amber grade");
		expect(folded).not.toBe(baseSpec);
		// Every other field passes through unchanged.
		expect(folded.mode).toBe(baseSpec.mode);
		expect(folded.duration).toBe(baseSpec.duration);
	});

	test("returns the same spec reference when there is no context to fold", () => {
		const { editor } = makeFakeEditor();
		const result = foldConsistencyIntoSpec(baseSpec, editor);
		expect(result).toBe(baseSpec);
	});

	test("is idempotent across two calls (e.g. a remix re-submitting an already-folded take)", () => {
		const { editor } = makeFakeEditor();
		storeConsistencyContext(editor, ctx);
		const once = foldConsistencyIntoSpec(baseSpec, editor);
		const twice = foldConsistencyIntoSpec(once, editor);
		expect(twice).toBe(once);
	});

	test("never folds a voiceover spec — the visual block doesn't belong in dialogue text", () => {
		const { editor } = makeFakeEditor();
		storeConsistencyContext(editor, ctx);
		const voSpec: GenerationSpec = {
			...baseSpec,
			kind: "voiceover",
			prompt: "Welcome back to the show.",
		};
		const result = foldConsistencyIntoSpec(voSpec, editor);
		expect(result).toBe(voSpec);
	});
});

// ── resolvePersonaSeedOverride — the persona-seed threading rule ───────────

describe("resolvePersonaSeedOverride", () => {
	const persona = { seed: 4242 };

	test("single shot + personaId + locked persona seed + no explicit seed -> threads the persona seed", () => {
		expect(
			resolvePersonaSeedOverride({
				personaId: "p1",
				batchSize: 1,
				seed: undefined,
				persona,
			}),
		).toBe(4242);
	});

	test("batch (2+) stays seedless even with a locked persona", () => {
		expect(
			resolvePersonaSeedOverride({
				personaId: "p1",
				batchSize: 4,
				seed: undefined,
				persona,
			}),
		).toBeUndefined();
	});

	test("an explicit seed always wins over the persona's stored seed", () => {
		expect(
			resolvePersonaSeedOverride({
				personaId: "p1",
				batchSize: 1,
				seed: 999,
				persona,
			}),
		).toBeUndefined();
	});

	test("no personaId -> never threads a seed", () => {
		expect(
			resolvePersonaSeedOverride({
				personaId: undefined,
				batchSize: 1,
				seed: undefined,
				persona,
			}),
		).toBeUndefined();
	});

	test("personaId present but the persona has no locked seed -> stays seedless", () => {
		expect(
			resolvePersonaSeedOverride({
				personaId: "p1",
				batchSize: 1,
				seed: undefined,
				persona: { seed: null },
			}),
		).toBeUndefined();
	});

	test("personaId present but the persona record wasn't found -> stays seedless", () => {
		expect(
			resolvePersonaSeedOverride({
				personaId: "p1",
				batchSize: 1,
				seed: undefined,
				persona: undefined,
			}),
		).toBeUndefined();
	});

	test("batchSize of 0 (defensive) is treated as a single shot, not a batch", () => {
		expect(
			resolvePersonaSeedOverride({
				personaId: "p1",
				batchSize: 0,
				seed: undefined,
				persona,
			}),
		).toBe(4242);
	});
});
