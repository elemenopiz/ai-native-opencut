import { afterEach, describe, expect, it } from "bun:test";
import type { TimelineTrack } from "@/types/timeline";
import { makeFakeEditor, type FakeElement } from "./fake-editor";

/**
 * `addText`/`updateText` placement + legibility widening (Wave 1, agent 1B).
 *
 * Before this change the two verbs exposed 8 fields — content/startTime/
 * duration/trackId/fontSize/fontFamily/color/textAlign — and NOT `transform`.
 * A Director-authored overlay always landed at `DEFAULT_TRANSFORM` (dead
 * center, scale 1, no rotation): a "lower third" was impossible to make
 * because there was no verb-level way to move it out of the center.
 *
 * These tests pin the fix at the `DirectorApi` layer (`director-api.ts`'s
 * `addText`/`updateText`), which is where `transform`/`background`/
 * `strokeColor`/`strokeWidth`/`opacity` now merge onto the element —
 * `tool-catalog.ts` is a thin schema/coercion layer in front of the same
 * functions and is covered separately by the Gemini-dialect + phase-scope
 * suites.
 *
 * `updateElements` isn't implemented on the base `fake-editor.ts` stub (see
 * `director-animate-item.test.ts`'s header) — `updateText` needs an actual
 * writer to land its patch, so `makeWritableFakeEditor` below wires it to the
 * REAL `UpdateElementCommand`, the same class `updateText` uses in production.
 * That command reaches the timeline through `EditorCore.getInstance()` (NOT
 * the `editor` instance `createDirectorApi` was constructed with), so every
 * `updateText` test also calls `patchEditorSingleton` — same precedent as
 * `director-animate-item.test.ts`.
 */

const { createDirectorApi } = await import("./director-api");
const { EditorCore: EditorCoreClass } = await import("@/core");
const { UpdateElementCommand } = await import(
	"@/lib/commands/timeline/element/update-element"
);

function makeWritableFakeEditor() {
	const fake = makeFakeEditor();
	const timeline = fake.editor.timeline as unknown as {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
		updateElements: (input: {
			updates: Array<{
				trackId: string;
				elementId: string;
				updates: Record<string, unknown>;
			}>;
		}) => void;
	};
	// De-alias `getTracks()` from the live array `updateTracks` repopulates —
	// see `director-animate-item.test.ts`'s header for why this matters for
	// `UpdateElementCommand`'s save/restore snapshot.
	const liveGetTracks = timeline.getTracks;
	timeline.getTracks = () => [...liveGetTracks()] as TimelineTrack[];
	timeline.updateTracks = (tracks: TimelineTrack[]) => {
		fake.tracks.length = 0;
		fake.tracks.push(...(tracks as unknown as typeof fake.tracks));
	};
	timeline.updateElements = ({ updates }) => {
		for (const u of updates) {
			fake.editor.command.execute({
				command: new UpdateElementCommand(u as never),
			});
		}
	};
	return fake;
}

let restoreGetInstance: (() => void) | undefined;

afterEach(() => {
	restoreGetInstance?.();
	restoreGetInstance = undefined;
});

function patchEditorSingleton(editorLike: unknown) {
	const real = EditorCoreClass.getInstance;
	(EditorCoreClass as unknown as { getInstance: () => unknown }).getInstance =
		() => editorLike;
	restoreGetInstance = () => {
		(EditorCoreClass as unknown as { getInstance: () => unknown }).getInstance =
			real;
	};
}

/** Pull a just-added text element back out of the fake timeline as a TextElement-ish shape. */
function textElement(
	fake: ReturnType<typeof makeFakeEditor>,
	elementId: string,
) {
	return fake.find(elementId)?.element as FakeElement & {
		transform: {
			scale: number;
			position: { x: number; y: number };
			rotate: number;
		};
		background: {
			enabled: boolean;
			color: string;
			paddingX?: number;
			paddingY?: number;
		};
		strokeColor?: string;
		strokeWidth?: number;
		opacity: number;
	};
}

describe("addText — placement (transform) and legibility", () => {
	it("with no transform/background/legibility args, keeps the untouched defaults (regression guard)", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const added = d.addText({ content: "hello", startTime: 0 });
		expect(added.ok).toBe(true);
		const el = textElement(fake, added.data!.elementId);

		expect(el.transform).toEqual({
			scale: 1,
			position: { x: 0, y: 0 },
			rotate: 0,
		});
		expect(el.background.enabled).toBe(false);
		expect(el.strokeColor).toBeUndefined();
		expect(el.opacity).toBe(1);
	});

	it("places a lower-third title via transform.position — the finding's exact repro case", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);
		// canvasSize in fake-editor.ts is { width: 1080, height: 1920 }; a lower
		// third sits below center, e.g. y = +canvasHeight * 0.35 = 672.
		const lowerThirdY = 1920 * 0.35;

		const added = d.addText({
			content: "JANE DOE, Director",
			startTime: 0,
			duration: 4,
			transform: { position: { x: 0, y: lowerThirdY } },
			background: { enabled: true, color: "rgba(0,0,0,0.6)" },
			strokeColor: "#000000",
			strokeWidth: 0.08,
			opacity: 0.95,
		});

		expect(added.ok).toBe(true);
		const el = textElement(fake, added.data!.elementId);

		// Position moved; scale/rotate default to the untouched values.
		expect(el.transform.position).toEqual({ x: 0, y: lowerThirdY });
		expect(el.transform.scale).toBe(1);
		expect(el.transform.rotate).toBe(0);

		// Legibility fields landed using the element's OWN field names.
		expect(el.background.enabled).toBe(true);
		expect(el.background.color).toBe("rgba(0,0,0,0.6)");
		expect(el.strokeColor).toBe("#000000");
		expect(el.strokeWidth).toBe(0.08);
		expect(el.opacity).toBe(0.95);
	});

	it("a partial transform only changes the given axis — the other axis/scale/rotate are unaffected", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const added = d.addText({
			content: "title",
			startTime: 0,
			transform: { position: { x: 100 }, scale: 1.2 },
		});

		const el = textElement(fake, added.data!.elementId);
		expect(el.transform.position).toEqual({ x: 100, y: 0 });
		expect(el.transform.scale).toBe(1.2);
		expect(el.transform.rotate).toBe(0);
	});

	it("a partial background patch only changes enabled/color, leaving other TextBackground fields at their default", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const added = d.addText({
			content: "title",
			startTime: 0,
			background: { enabled: true },
		});

		const el = textElement(fake, added.data!.elementId);
		expect(el.background.enabled).toBe(true);
		expect(el.background.color).toBe("#000000"); // DEFAULT_TEXT_BACKGROUND.color, untouched
		expect(el.background.paddingX).toBe(30); // DEFAULT_TEXT_BACKGROUND.paddingX, untouched
	});
});

describe("updateText — placement/legibility on the update path", () => {
	it("moves an existing overlay's position without disturbing its scale/rotate", () => {
		const fake = makeWritableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);

		const added = d.addText({
			content: "title",
			startTime: 0,
			transform: { scale: 1.5, rotate: 10 },
		});
		const elementId = added.data!.elementId;

		const updated = d.updateText({
			elementId,
			transform: { position: { x: -50, y: 200 } },
		});
		expect(updated.ok).toBe(true);

		const el = textElement(fake, elementId);
		expect(el.transform.position).toEqual({ x: -50, y: 200 });
		expect(el.transform.scale).toBe(1.5);
		expect(el.transform.rotate).toBe(10);
	});

	it("updates only one position axis, preserving the other from the CURRENT (not default) transform", () => {
		const fake = makeWritableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);

		const added = d.addText({
			content: "title",
			startTime: 0,
			transform: { position: { x: 30, y: 40 } },
		});
		const elementId = added.data!.elementId;

		d.updateText({ elementId, transform: { position: { y: 999 } } });

		const el = textElement(fake, elementId);
		expect(el.transform.position).toEqual({ x: 30, y: 999 });
	});

	it("turns on a legibility background and stroke on an existing overlay", () => {
		const fake = makeWritableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);

		const added = d.addText({ content: "caption", startTime: 0 });
		const elementId = added.data!.elementId;

		const updated = d.updateText({
			elementId,
			background: { enabled: true, color: "#111111" },
			strokeColor: "#ffffff",
			strokeWidth: 0.1,
			opacity: 0.8,
		});
		expect(updated.ok).toBe(true);

		const el = textElement(fake, elementId);
		expect(el.background.enabled).toBe(true);
		expect(el.background.color).toBe("#111111");
		expect(el.strokeColor).toBe("#ffffff");
		expect(el.strokeWidth).toBe(0.1);
		expect(el.opacity).toBe(0.8);
	});
});
