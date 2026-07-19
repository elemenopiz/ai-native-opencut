import { afterEach, describe, expect, it } from "bun:test";
import type { TimelineTrack } from "@/types/timeline";
import { makeFakeEditor, type FakeElement } from "./fake-editor";

/**
 * `animateItem` (poach plan item #2, `docs/poach/vyra-poach-plan.md` §2) —
 * exposes the EXISTING animation/keyframe system as one Director verb.
 * Static `value` sets go through `UpdateElementCommand` (same class
 * `updateText` uses); keyframed `keyframes` go through `UpsertKeyframeCommand`
 * (same class the Properties-panel keyframe UI uses). BOTH reach the global
 * `EditorCore.getInstance()` singleton from inside `execute()` (a repo-wide
 * pattern — see `adapter-defaults.test.ts`'s header), not the `editor`
 * instance `createDirectorApi` was constructed with, and `fake-editor.ts`'s
 * hand-rolled `timeline` stub implements neither method by design (see its
 * own header). This file locally extends the fake with both (mirroring
 * `adapter-defaults.test.ts`'s `updateElementTrim` precedent for `trim`) and
 * patches `EditorCore.getInstance` for the duration of each test — its own
 * technique, not an edit to the shared fixture.
 */

const { createDirectorApi } = await import("./director-api");
const { EditorCore: EditorCoreClass } = await import("@/core");
const { UpdateElementCommand } = await import(
	"@/lib/commands/timeline/element/update-element"
);
const { UpsertKeyframeCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/upsert-keyframe"
);
const { BatchCommand } = await import("@/lib/commands/batch-command");

/**
 * A fake editor whose `timeline.updateElements`/`upsertKeyframes` actually
 * land via the REAL command classes, so `animateItem` has somewhere to write.
 *
 * De-aliasing note: a `Command`'s `execute()` snapshots
 * `this.savedState = editor.timeline.getTracks()` for undo. The base
 * `fake-editor.ts` `getTracks()` returns the SAME array reference on every
 * call, so a naive `updateTracks` stub that mutates that array in place
 * (`length = 0` + `push`, the `adapter-defaults.test.ts` precedent for
 * `trim`/`applyTransition`, which never exercises undo) would alias the
 * "before" snapshot onto the "after" state — undo would silently no-op.
 * `updateElementInTracks` (the shared helper both commands route through)
 * never mutates a track/element object IN PLACE — it always `.map()`s to new
 * objects — so wrapping `getTracks()` in a shallow top-level array copy here
 * is enough to de-alias the snapshot from the live array `updateTracks`
 * repopulates, without touching the shared fixture.
 */
function makeAnimatableFakeEditor() {
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
		upsertKeyframes: (input: {
			keyframes: Array<{
				trackId: string;
				elementId: string;
				propertyPath: string;
				time: number;
				value: unknown;
				interpolation?: string;
			}>;
		}) => void;
	};
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
	timeline.upsertKeyframes = ({ keyframes }) => {
		if (keyframes.length === 0) return;
		const commands = keyframes.map(
			(kf) => new UpsertKeyframeCommand(kf as never),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		fake.editor.command.execute({ command });
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

function reserve(d: ReturnType<typeof createDirectorApi>): string {
	const shot = d.reserveSlot({ prompt: "a shot", duration: 5 });
	return shot.data?.slotId as string;
}

describe("animateItem — static value set", () => {
	it("sets transform.scale directly (no animation channel)", () => {
		const fake = makeAnimatableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);
		const slotId = reserve(d);

		const result = d.animateItem({
			itemId: slotId,
			property: "scale",
			value: 1.5,
		});

		expect(result.ok).toBe(true);
		const el = fake.find(slotId)?.element as FakeElement & {
			transform?: { scale?: number };
			animations?: unknown;
		};
		expect(el.transform?.scale).toBe(1.5);
		expect(el.animations).toBeUndefined();
	});

	it("position requires {x, y} — a bare number is rejected", () => {
		const fake = makeAnimatableFakeEditor();
		const d = createDirectorApi(fake.editor);
		const slotId = reserve(d);

		const result = d.animateItem({
			itemId: slotId,
			property: "position",
			value: 5,
		});

		expect(result.ok).toBe(false);
	});

	it("position {x, y} lands on transform.position", () => {
		const fake = makeAnimatableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);
		const slotId = reserve(d);

		const result = d.animateItem({
			itemId: slotId,
			property: "position",
			value: { x: 10, y: -20 },
		});

		expect(result.ok).toBe(true);
		const el = fake.find(slotId)?.element as FakeElement & {
			transform?: { position?: { x: number; y: number } };
		};
		expect(el.transform?.position).toEqual({ x: 10, y: -20 });
	});

	it("rejects EXACTLY-one-of violations: both value and keyframes given", () => {
		const fake = makeAnimatableFakeEditor();
		const d = createDirectorApi(fake.editor);
		const slotId = reserve(d);

		const result = d.animateItem({
			itemId: slotId,
			property: "opacity",
			value: 0.5,
			keyframes: [{ time: 0, value: 1 }],
		});

		expect(result.ok).toBe(false);
	});

	it("rejects EXACTLY-one-of violations: neither value nor keyframes given", () => {
		const fake = makeAnimatableFakeEditor();
		const d = createDirectorApi(fake.editor);
		const slotId = reserve(d);

		const result = d.animateItem({ itemId: slotId, property: "opacity" });

		expect(result.ok).toBe(false);
	});
});

describe("animateItem — keyframed animation", () => {
	it("an opacity fade creates a real animation channel with both keyframes", () => {
		const fake = makeAnimatableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);
		const slotId = reserve(d);

		const result = d.animateItem({
			itemId: slotId,
			property: "opacity",
			keyframes: [
				{ time: 0, value: 0 },
				{ time: 1, value: 1 },
			],
		});

		expect(result.ok).toBe(true);
		expect(result.data?.keyframeCount).toBe(2);
		const el = fake.find(slotId)?.element as FakeElement & {
			animations?: {
				channels: Record<
					string,
					{ keyframes: { value: number }[] } | undefined
				>;
			};
		};
		const channel = el.animations?.channels.opacity;
		expect(channel?.keyframes.length).toBe(2);
		expect(channel?.keyframes.map((k) => k.value)).toEqual([0, 1]);
	});

	it("a position keyframe writes BOTH the x and y channels", () => {
		const fake = makeAnimatableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);
		const slotId = reserve(d);

		const result = d.animateItem({
			itemId: slotId,
			property: "position",
			keyframes: [
				{ time: 0, value: { x: 0, y: 0 } },
				{ time: 2, value: { x: 100, y: -50 } },
			],
		});

		expect(result.ok).toBe(true);
		const el = fake.find(slotId)?.element as FakeElement & {
			animations?: {
				channels: Record<
					string,
					{ keyframes: { value: number }[] } | undefined
				>;
			};
		};
		const xChannel = el.animations?.channels["transform.position.x"];
		const yChannel = el.animations?.channels["transform.position.y"];
		expect(xChannel?.keyframes.map((k) => k.value)).toEqual([0, 100]);
		expect(yChannel?.keyframes.map((k) => k.value)).toEqual([0, -50]);
	});

	it("the whole multi-keyframe batch undoes as ONE step", () => {
		const fake = makeAnimatableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);
		const slotId = reserve(d);

		const result = d.animateItem({
			itemId: slotId,
			property: "opacity",
			keyframes: [
				{ time: 0, value: 0 },
				{ time: 1, value: 1 },
			],
		});
		expect(result.ok).toBe(true);
		expect(
			(
				fake.find(slotId)?.element as FakeElement & {
					animations?: { channels: Record<string, unknown> };
				}
			).animations?.channels.opacity,
		).toBeDefined();

		const undoResult = d.undo();
		expect(undoResult.ok).toBe(true);

		const elAfterUndo = fake.find(slotId)?.element as FakeElement & {
			animations?: { channels: Record<string, unknown> };
		};
		expect(elAfterUndo.animations?.channels.opacity).toBeUndefined();
	});

	it("rejects a negative keyframe time", () => {
		const fake = makeAnimatableFakeEditor();
		patchEditorSingleton(fake.editor);
		const d = createDirectorApi(fake.editor);
		const slotId = reserve(d);

		const result = d.animateItem({
			itemId: slotId,
			property: "opacity",
			keyframes: [{ time: -1, value: 0.5 }],
		});

		expect(result.ok).toBe(false);
	});
});

describe("animateItem — lookup + type-target failures", () => {
	it("item-not-found uses the structured lookup contract (poach plan item #1)", () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const result = d.animateItem({
			itemId: "no_such_item",
			property: "opacity",
			value: 0.5,
		});

		expect(result.ok).toBe(false);
		expect(result.code).toBe("ITEM_NOT_FOUND");
		expect(result.error).toBe('No element with id "no_such_item".');
	});

	it("refuses to animate a non-visual element (audio)", () => {
		const fake = makeAnimatableFakeEditor();
		const d = createDirectorApi(fake.editor);
		// A voiceover slot is an audio element — not visual, so it has no
		// transform/opacity to animate. Insert one directly via the fake
		// editor's own (synchronous) timeline helper.
		const audioId = fake.editor.timeline.addVoiceoverSlot({});

		const result = d.animateItem({
			itemId: audioId,
			property: "opacity",
			value: 1,
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("audio");
	});
});
