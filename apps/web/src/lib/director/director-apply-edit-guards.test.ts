import { describe, expect, it } from "bun:test";
import { registerDefaultEffects } from "@/lib/effects";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor } from "./fake-editor";

/**
 * The two branches Wave 2A ADDED but left uncovered, plus `applyEdit`'s
 * failure paths as reached THROUGH the verb.
 *
 * Why these specifically. Widening target resolution from `findSlot` to
 * `findSlot ?? findElement` let `applyTransition`/`applyEffect` reach elements
 * they previously could not — including AUDIO ones. Underneath,
 * `AddTransitionCommand`/`AddClipEffectCommand` filter on `isVisualElement`
 * and simply do nothing for a non-visual target, so without an explicit guard
 * the widened verbs would have answered `ok: true` for an edit that never
 * happened. A false success is the worst possible result here: the Director
 * believes the cut changed, and every later decision compounds the error.
 * 2A added the guard and said plainly it was untested; this covers it.
 *
 * `runProgram`'s own error taxonomy is already unit-tested in
 * `program/executor.test.ts`. What was NOT tested is that those failures
 * survive the trip through `applyEdit` — that a parse error or a tripped cap
 * arrives as `ok: false` rather than being swallowed into a success envelope.
 */

registerDefaultEffects();

const audioBase = { trimStart: 0, trimEnd: 0 };

function addAudio(fake: ReturnType<typeof makeFakeEditor>, name: string) {
	return fake.editor.timeline.insertElement({
		element: {
			type: "audio",
			sourceType: "upload",
			mediaId: `media_${name}`,
			name,
			volume: 1,
			startTime: 0,
			duration: 5,
			...audioBase,
		},
		placement: { mode: "auto", trackType: "audio" },
	});
}

describe("widened targeting — non-visual guard", () => {
	it("applyTransition on an AUDIO element fails loudly instead of silently no-opping", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);
		const id = addAudio(fake, "vo");

		const result = d.applyTransition({
			slotId: String(id),
			transitionType: "fade",
		});

		expect(result.ok).toBe(false);
		// The message must name the element's actual type, so the agent can
		// correct its own target rather than retrying the same call.
		expect(result.message).toContain("audio");
	});

	it("applyEffect on an AUDIO element fails loudly instead of silently no-opping", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);
		const id = addAudio(fake, "vo");

		const result = d.applyEffect({
			slotId: String(id),
			effectType: "blur",
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("audio");
	});

	it("still reports SLOT_NOT_FOUND for an id that matches nothing", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const result = d.applyTransition({
			slotId: "ghost",
			transitionType: "fade",
		});

		expect(result.ok).toBe(false);
		// Widening changed only the FOUND case; the not-found contract is pinned.
		expect(result.code).toBe("SLOT_NOT_FOUND");
	});
});

describe("applyEdit — failure paths through the verb", () => {
	it("rejects an empty program without invoking the engine", () => {
		const d = createDirectorApi(makeFakeEditor().editor);
		const result = d.applyEdit({ program: "   " });
		expect(result.ok).toBe(false);
	});

	it("surfaces a parse error as a failure, not a successful empty run", () => {
		const d = createDirectorApi(makeFakeEditor().editor);
		const result = d.applyEdit({ program: "let x = ;;;" });
		expect(result.ok).toBe(false);
	});

	it("surfaces a tripped cap as a failure", () => {
		const d = createDirectorApi(makeFakeEditor().editor);
		// Deep nesting trips a parse-time cap well before anything executes.
		const result = d.applyEdit({
			program: `let x = ${"(".repeat(400)}1${")".repeat(400)}`,
		});
		expect(result.ok).toBe(false);
	});

	it("defaults to dry-run and reports that mode back", () => {
		const d = createDirectorApi(makeFakeEditor().editor);
		const result = d.applyEdit({ program: "log(1)" });
		expect(result.ok).toBe(true);
		expect(result.data?.mode).toBe("dry-run");
	});

	it("a dry run registers nothing to undo", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);
		// A fresh editor has nothing to undo; a dry run must not change that.
		// `canUndo()` is the public surface — `history` is private on purpose.
		expect(fake.editor.command.canUndo()).toBe(false);

		d.applyEdit({ program: "log(1)" });

		expect(fake.editor.command.canUndo()).toBe(false);
	});
});
