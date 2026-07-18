import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type { EditorCore } from "@/core";
import type {
	AudioTrack,
	TimelineTrack,
	TransitionData,
	VideoElement,
	VideoTrack,
} from "@/types/timeline";

/**
 * C27 (undo/redo integrity), Worker B: property tests for the 19
 * keyframe/effect/transition/track/clipboard commands (audit table #15-33 in
 * `docs/campaigns/undo-integrity.md`). Contract per command (mirrors
 * `media/__tests__/remove-media-asset.test.ts`, the C25/BUG34 reference):
 *
 *   1. execute -> undo restores state deep-equal to pre-state.
 *   2. execute -> undo -> redo -> undo returns to pre-state again (redo must
 *      not replay a stale snapshot — `base-command.ts`'s default `redo()` is
 *      `execute()`, so this only holds if `execute()` re-snapshots CURRENT
 *      state on every call, which is the pattern every command below uses:
 *      `this.savedState = editor.timeline.getTracks()` at the top of
 *      `execute()`, never in the constructor).
 *   3. exactly one history entry per dispatch (`editor.command.execute(...)`
 *      is the ONLY thing that pushes; commands never call a manager method
 *      that itself dispatches — confirmed by reading `TimelineManager.
 *      updateTracks` (`core/managers/timeline-manager.ts`), which is a dumb
 *      `scenes.updateSceneTracks` + `notify()` with no command dispatch).
 *
 * A few commands (`AddClipEffectCommand`, `PasteCommand`, `PasteKeyframesCommand`,
 * and `UpsertKeyframeCommand`/`UpsertEffectParamKeyframeCommand` when inserting
 * a brand-new keyframe rather than editing an existing `keyframeId`) mint a
 * fresh random id (`generateUUID()`) on EVERY `execute()` call, including the
 * one `redo()` triggers — so the id present after the first execute differs
 * from the id present after redo. That's fine for contract
 * items 1-3 (the FINAL state after a full execute/undo/redo/undo cycle is
 * still deep-equal to pre-state — only the transient state straight after
 * `redo()` has a different id than the transient state straight after the
 * first `execute()`), so those tests assert structure/values after redo
 * rather than exact id equality.
 *
 * Order-dependence guard: `EditorCore` (from "@/core") and every command
 * class below transitively import `@/core/managers/media-manager`, which
 * statically imports the real `@/services/proxy` barrel (chaining into
 * proxy-encoder-controller.ts -> proxy-generator.ts). Plain static imports
 * here would cache the real chain in bun test's shared module registry
 * before proxy-encoder-controller.test.ts's own `mock.module()` can take
 * effect, if that file runs later in the same `bun test` invocation. Mock
 * the barrel and import dynamically, AFTER the mock (mirrors
 * media-manager-decode-reprobe.test.ts's barrel mock + "Import AFTER the
 * mocks" convention, also used by keyframe-aware-commands.test.ts and
 * paste-keyframes-command.test.ts in this same directory). Proxy generation
 * itself is never exercised here.
 */
mock.module("@/services/proxy", () => ({
	generateProxyOffThread: async () => ({
		file: new File([new Uint8Array([1])], "proxy.mp4", { type: "video/mp4" }),
		width: 1280,
		height: 720,
	}),
	isProxyCancelledError: (error: unknown) =>
		error instanceof Error &&
		(error.message === "Proxy generation cancelled" ||
			error.name === "AbortError"),
}));

const { EditorCore: EditorCoreClass } = await import("@/core");
const { registerEffect } = await import("@/lib/effects/registry");
const { registerTransition } = await import("@/lib/transitions/registry");

const { UpsertKeyframeCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/upsert-keyframe"
);
const { RemoveKeyframeCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/remove-keyframe"
);
const { RetimeKeyframeCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/retime-keyframe"
);
const { SetKeyframeEasingCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/set-keyframe-easing"
);
const { UpsertEffectParamKeyframeCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/upsert-effect-param-keyframe"
);
const { RemoveEffectParamKeyframeCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/remove-effect-param-keyframe"
);
const { PasteKeyframesCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/paste-keyframes"
);
const { AddClipEffectCommand } = await import(
	"@/lib/commands/timeline/element/effects/add-effect"
);
const { RemoveClipEffectCommand } = await import(
	"@/lib/commands/timeline/element/effects/remove-effect"
);
const { ReorderClipEffectsCommand } = await import(
	"@/lib/commands/timeline/element/effects/reorder-effect"
);
const { ToggleClipEffectCommand } = await import(
	"@/lib/commands/timeline/element/effects/toggle-effect"
);
const { UpdateClipEffectParamsCommand } = await import(
	"@/lib/commands/timeline/element/effects/update-effect-params"
);
const { AddTransitionCommand } = await import(
	"@/lib/commands/timeline/element/transitions/add-transition"
);
const { AddTrackCommand } = await import(
	"@/lib/commands/timeline/track/add-track"
);
const { RemoveTrackCommand } = await import(
	"@/lib/commands/timeline/track/remove-track"
);
const { ToggleTrackMuteCommand } = await import(
	"@/lib/commands/timeline/track/toggle-track-mute"
);
const { ToggleTrackVisibilityCommand } = await import(
	"@/lib/commands/timeline/track/toggle-track-visibility"
);
const { PasteCommand } = await import(
	"@/lib/commands/timeline/clipboard/paste"
);
const { TracksSnapshotCommand } = await import(
	"@/lib/commands/timeline/tracks-snapshot"
);

// Minimal fake effect/transition catalog entries — registered directly on
// the registries (no glsl/definitions-catalog imports) so these tests stay
// isolated from the real effect/transition libraries and fast.
registerEffect({
	definition: {
		type: "test-blur",
		name: "Test Blur",
		keywords: [],
		params: [
			{
				key: "intensity",
				label: "Intensity",
				type: "number",
				default: 15,
				min: 0,
				max: 100,
				step: 1,
			},
		],
		renderer: { type: "webgl", passes: [] },
	},
});
registerTransition({
	definition: {
		type: "test-fade",
		name: "Test Fade",
		category: "dissolve",
		keywords: [],
		defaultDuration: 1,
		fragmentShader: "",
	},
});

type ElementRef = { trackId: string; elementId: string };
type FakeTimeline = {
	getTracks: () => TimelineTrack[];
	updateTracks: (tracks: TimelineTrack[]) => void;
};
type FakeSelection = {
	getSelectedElements: () => ElementRef[];
	setSelectedElements: (args: { elements: ElementRef[] }) => void;
};

const originalGetInstance = EditorCoreClass.getInstance;

afterEach(() => {
	(
		EditorCoreClass as unknown as {
			getInstance: typeof EditorCoreClass.getInstance;
		}
	).getInstance = originalGetInstance;
});

/** Wires a fake editor the same way the real EditorCore wires itself: a REAL
 * `CommandManager` (so `getHistoryLength()`/`undo()`/`redo()` exercise the
 * exact production dispatch/undo/redo path, not a hand-rolled stand-in) plus
 * fake timeline/selection stores. */
function makeEditor({ tracks }: { tracks: TimelineTrack[] }): EditorCore {
	let currentTracks = tracks;
	let selection: ElementRef[] = [];

	const editor = {} as EditorCore;
	(editor as unknown as { command: CommandManager }).command =
		new CommandManager();
	(editor as unknown as { timeline: FakeTimeline }).timeline = {
		getTracks: () => currentTracks,
		updateTracks: (next) => {
			currentTracks = next;
		},
	};
	(editor as unknown as { selection: FakeSelection }).selection = {
		getSelectedElements: () => selection,
		setSelectedElements: ({ elements }) => {
			selection = elements;
		},
	};

	(
		EditorCoreClass as unknown as { getInstance: () => EditorCore }
	).getInstance = () => editor;

	return editor;
}

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "element-1",
		name: "Clip",
		type: "video",
		mediaId: "media-1",
		duration: 8,
		startTime: 1,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		...overrides,
	};
}

function videoTrack({
	id = "track-1",
	elements,
	isMain = true,
}: {
	id?: string;
	elements: VideoElement[];
	isMain?: boolean;
}): VideoTrack {
	return {
		id,
		name: id,
		type: "video",
		elements,
		isMain,
		muted: false,
		hidden: false,
	};
}

describe("keyframe commands — undo/redo round trip", () => {
	function seedElement(): VideoElement {
		return buildVideoElement({
			animations: {
				channels: {
					"transform.scale": {
						valueKind: "number",
						keyframes: [
							{ id: "kf-a", time: 0, value: 1, interpolation: "linear" },
							{ id: "kf-b", time: 3, value: 1.5, interpolation: "linear" },
							{ id: "kf-c", time: 6, value: 2, interpolation: "linear" },
						],
					},
				},
			},
		});
	}

	test("UpsertKeyframeCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const tracks = [videoTrack({ elements: [seedElement()] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		function keyframeTimes(source: TimelineTrack[]): number[] {
			return (
				(source[0].elements[0] as VideoElement).animations?.channels[
					"transform.scale"
				]?.keyframes ?? []
			).map((k) => k.time);
		}

		const command = new UpsertKeyframeCommand({
			trackId: "track-1",
			elementId: "element-1",
			propertyPath: "transform.scale",
			time: 4.5,
			value: 1.8,
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(keyframeTimes(editor.timeline.getTracks())).toEqual([0, 3, 4.5, 6]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		// `upsertElementKeyframe` mints a fresh keyframe id for the new
		// keyframe on every execute() (no explicit `keyframeId` passed), so
		// assert by value, not full object/id equality against the first
		// execute's snapshot.
		expect(keyframeTimes(editor.timeline.getTracks())).toEqual([0, 3, 4.5, 6]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("RemoveKeyframeCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const tracks = [videoTrack({ elements: [seedElement()] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new RemoveKeyframeCommand({
			trackId: "track-1",
			elementId: "element-1",
			propertyPath: "transform.scale",
			keyframeId: "kf-b",
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		expect(
			(
				(afterExecute[0].elements[0] as VideoElement).animations?.channels[
					"transform.scale"
				]?.keyframes ?? []
			).map((k) => k.id),
		).toEqual(["kf-a", "kf-c"]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("RetimeKeyframeCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const tracks = [videoTrack({ elements: [seedElement()] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new RetimeKeyframeCommand({
			trackId: "track-1",
			elementId: "element-1",
			propertyPath: "transform.scale",
			keyframeId: "kf-b",
			nextTime: 4,
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("SetKeyframeEasingCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const tracks = [videoTrack({ elements: [seedElement()] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new SetKeyframeEasingCommand({
			trackId: "track-1",
			elementId: "element-1",
			propertyPath: "transform.scale",
			keyframeId: "kf-b",
			easing: { preset: "ease-out", bezier: [0, 0, 0.58, 1] },
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("UpsertEffectParamKeyframeCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const element = buildVideoElement({
			effects: [
				{
					id: "fx-1",
					type: "test-blur",
					params: { intensity: 10 },
					enabled: true,
				},
			],
		});
		const tracks = [videoTrack({ elements: [element] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new UpsertEffectParamKeyframeCommand({
			trackId: "track-1",
			elementId: "element-1",
			effectId: "fx-1",
			paramKey: "intensity",
			time: 2,
			value: 50,
		});
		// Keyframe `value` is `number | DiscreteValue` — let TS infer the
		// element type instead of over-narrowing to number[].
		function paramKeyframeValues(source: TimelineTrack[]) {
			return (
				(source[0].elements[0] as VideoElement).animations?.channels[
					"effects.fx-1.params.intensity"
				]?.keyframes ?? []
			).map((k) => k.value);
		}

		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(paramKeyframeValues(editor.timeline.getTracks())).toEqual([50]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		// Fresh keyframe id minted each execute() (no explicit `keyframeId`
		// passed) — assert by value, not full object/id equality.
		expect(paramKeyframeValues(editor.timeline.getTracks())).toEqual([50]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("RemoveEffectParamKeyframeCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const element = buildVideoElement({
			effects: [
				{
					id: "fx-1",
					type: "test-blur",
					params: { intensity: 10 },
					enabled: true,
				},
			],
			animations: {
				channels: {
					"effects.fx-1.params.intensity": {
						valueKind: "number",
						keyframes: [
							{ id: "kf-fx-1", time: 1, value: 20, interpolation: "linear" },
						],
					},
				},
			},
		});
		const tracks = [videoTrack({ elements: [element] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new RemoveEffectParamKeyframeCommand({
			trackId: "track-1",
			elementId: "element-1",
			effectId: "fx-1",
			paramKey: "intensity",
			keyframeId: "kf-fx-1",
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		expect(
			(afterExecute[0].elements[0] as VideoElement).animations?.channels[
				"effects.fx-1.params.intensity"
			],
		).toBeUndefined();

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("PasteKeyframesCommand: execute/undo/redo/undo returns to pre-state; 1 history entry; redo re-pastes by value (fresh keyframe ids each execute)", () => {
		const tracks = [videoTrack({ elements: [buildVideoElement()] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const clipboardItems = [
			{
				propertyPath: "transform.scale" as const,
				timeOffset: 0,
				value: 1,
				interpolation: "linear" as const,
			},
			{
				propertyPath: "transform.scale" as const,
				timeOffset: 2,
				value: 2,
				interpolation: "hold" as const,
			},
		];

		const command = new PasteKeyframesCommand({
			trackId: "track-1",
			elementId: "element-1",
			time: 3,
			clipboardItems,
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecuteTimes = (
			(editor.timeline.getTracks()[0].elements[0] as VideoElement).animations
				?.channels["transform.scale"]?.keyframes ?? []
		).map((k) => k.time);
		expect(afterExecuteTimes).toEqual([3, 5]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		// Fresh ids each execute (generateUUID() in applyKeyframeClipboardToElement)
		// — assert by VALUE, not object identity/id equality.
		const afterRedoTimes = (
			(editor.timeline.getTracks()[0].elements[0] as VideoElement).animations
				?.channels["transform.scale"]?.keyframes ?? []
		).map((k) => k.time);
		expect(afterRedoTimes).toEqual([3, 5]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

describe("effect commands — undo/redo round trip", () => {
	test("AddClipEffectCommand: execute/undo/redo/undo returns to pre-state; 1 history entry; redo re-adds by value (fresh effect id each execute)", () => {
		const tracks = [videoTrack({ elements: [buildVideoElement()] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new AddClipEffectCommand({
			trackId: "track-1",
			elementId: "element-1",
			effectType: "test-blur",
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const firstEffectId = command.getEffectId();
		expect(firstEffectId).not.toBeNull();
		const afterExecuteEffects = (
			editor.timeline.getTracks()[0].elements[0] as VideoElement
		).effects;
		expect(afterExecuteEffects?.map((e) => e.type)).toEqual(["test-blur"]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterRedoEffects = (
			editor.timeline.getTracks()[0].elements[0] as VideoElement
		).effects;
		expect(afterRedoEffects?.map((e) => e.type)).toEqual(["test-blur"]);
		expect(afterRedoEffects).toHaveLength(1);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("RemoveClipEffectCommand: execute/undo/redo/undo round-trips exactly, and forward-prunes orphaned effect-param keyframes (cascade fix)", () => {
		const element = buildVideoElement({
			effects: [
				{
					id: "fx-1",
					type: "test-blur",
					params: { intensity: 10 },
					enabled: true,
				},
			],
			animations: {
				channels: {
					"effects.fx-1.params.intensity": {
						valueKind: "number",
						keyframes: [
							{ id: "kf-fx-1", time: 1, value: 20, interpolation: "linear" },
						],
					},
				},
			},
		});
		const tracks = [videoTrack({ elements: [element] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new RemoveClipEffectCommand({
			trackId: "track-1",
			elementId: "element-1",
			effectId: "fx-1",
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);

		const afterExecute = editor.timeline.getTracks()[0]
			.elements[0] as VideoElement;
		expect(afterExecute.effects).toEqual([]);
		// Cascade fix: the orphaned "effects.fx-1.params.intensity" channel
		// (dangling — points at an effect id that no longer exists) must be
		// pruned, not left behind as inert bloat (same dangling-reference class
		// as BUG34, scoped to one element's animation map).
		expect(afterExecute.animations?.channels).toEqual({});

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterRedo = editor.timeline.getTracks()[0]
			.elements[0] as VideoElement;
		expect(afterRedo.effects).toEqual([]);
		expect(afterRedo.animations?.channels).toEqual({});

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("ReorderClipEffectsCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const element = buildVideoElement({
			effects: [
				{ id: "fx-1", type: "test-blur", params: {}, enabled: true },
				{ id: "fx-2", type: "test-blur", params: {}, enabled: true },
			],
		});
		const tracks = [videoTrack({ elements: [element] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new ReorderClipEffectsCommand({
			trackId: "track-1",
			elementId: "element-1",
			fromIndex: 0,
			toIndex: 1,
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		expect(
			(afterExecute[0].elements[0] as VideoElement).effects?.map((e) => e.id),
		).toEqual(["fx-2", "fx-1"]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("ToggleClipEffectCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const element = buildVideoElement({
			effects: [{ id: "fx-1", type: "test-blur", params: {}, enabled: true }],
		});
		const tracks = [videoTrack({ elements: [element] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new ToggleClipEffectCommand({
			trackId: "track-1",
			elementId: "element-1",
			effectId: "fx-1",
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		expect(
			(afterExecute[0].elements[0] as VideoElement).effects?.[0]?.enabled,
		).toBe(false);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("UpdateClipEffectParamsCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const element = buildVideoElement({
			effects: [
				{
					id: "fx-1",
					type: "test-blur",
					params: { intensity: 10 },
					enabled: true,
				},
			],
		});
		const tracks = [videoTrack({ elements: [element] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new UpdateClipEffectParamsCommand({
			trackId: "track-1",
			elementId: "element-1",
			effectId: "fx-1",
			params: { intensity: 80 },
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		expect(
			(afterExecute[0].elements[0] as VideoElement).effects?.[0]?.params,
		).toEqual({ intensity: 80 });

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

describe("transition command — undo/redo round trip", () => {
	test("AddTransitionCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const tracks = [videoTrack({ elements: [buildVideoElement()] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new AddTransitionCommand({
			trackId: "track-1",
			elementId: "element-1",
			transitionType: "test-fade",
		});
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		const transition = (afterExecute[0].elements[0] as VideoElement)
			.transitionOut as TransitionData;
		expect(transition).toEqual({ type: "test-fade", duration: 1 });

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

describe("track commands — undo/redo round trip", () => {
	test("AddTrackCommand: execute/undo/redo/undo round-trips exactly (stable trackId across redo); 1 history entry", () => {
		const tracks = [videoTrack({ elements: [] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new AddTrackCommand("audio", 0);
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		expect(afterExecute).toHaveLength(2);
		expect(afterExecute[0].id).toBe(command.getTrackId());
		expect(afterExecute[0].type).toBe("audio");

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		// trackId is generated once in the constructor (not re-rolled per
		// execute), so redo reproduces the exact same track — strict equality.
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("RemoveTrackCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const mainTrack = videoTrack({ id: "main", elements: [], isMain: true });
		const secondaryTrack = videoTrack({
			id: "secondary",
			elements: [buildVideoElement()],
			isMain: false,
		});
		const tracks = [mainTrack, secondaryTrack];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new RemoveTrackCommand("secondary");
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		expect(afterExecute.map((t) => t.id)).toEqual(["main"]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("RemoveTrackCommand: removing the main track is a guarded no-op (still 1 history entry; undo is a harmless replay of the same state) — see BUG103 for the related dangling-selection gap on a REAL removal", () => {
		const mainTrack = videoTrack({ id: "main", elements: [], isMain: true });
		const tracks = [mainTrack];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new RemoveTrackCommand("main");
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("ToggleTrackMuteCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const track: AudioTrack = {
			id: "track-1",
			name: "Audio",
			type: "audio",
			elements: [],
			muted: false,
		};
		const tracks: TimelineTrack[] = [track];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new ToggleTrackMuteCommand("track-1");
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		expect((afterExecute[0] as AudioTrack).muted).toBe(true);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("ToggleTrackVisibilityCommand: execute/undo/redo/undo round-trips exactly; 1 history entry", () => {
		const tracks = [videoTrack({ elements: [] })];
		const editor = makeEditor({ tracks });
		const preState = structuredClone(tracks);

		const command = new ToggleTrackVisibilityCommand("track-1");
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		expect((afterExecute[0] as VideoTrack).hidden).toBe(true);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterExecute);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

describe("clipboard command — undo/redo round trip", () => {
	test("PasteCommand: execute/undo/redo/undo returns to pre-state; selection captured/restored; 1 history entry; redo re-pastes by value (fresh element id each execute)", () => {
		const existingClip = buildVideoElement({
			id: "el-existing",
			startTime: 0,
			duration: 2,
		});
		const tracks = [videoTrack({ elements: [existingClip] })];
		const editor = makeEditor({ tracks });
		editor.selection.setSelectedElements({
			elements: [{ trackId: "track-1", elementId: "el-existing" }],
		});
		const preState = structuredClone(tracks);
		const preSelection = editor.selection.getSelectedElements();

		const clipboardItems = [
			{
				trackId: "track-old", // no longer exists -> falls to the
				// highest-compatible-track branch of resolveTargetTrackIndex
				trackType: "video" as const,
				element: buildVideoElement({
					startTime: 10,
					duration: 3,
				}) as VideoElement,
			},
		];
		// Cast away the `id` field PasteCommand strips via CreateTimelineElement.
		const clipboardPayload = clipboardItems.map((item) => {
			const { id: _unusedId, ...rest } = item.element;
			return { ...item, element: rest };
		});

		const command = new PasteCommand(12, clipboardPayload as never);
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterExecute = editor.timeline.getTracks();
		expect(afterExecute[0].elements).toHaveLength(2);
		const pastedAfterExecute = afterExecute[0].elements.find(
			(e) => e.id !== "el-existing",
		) as VideoElement;
		expect(pastedAfterExecute.startTime).toBe(12);
		expect(editor.selection.getSelectedElements()).toEqual([
			{ trackId: "track-1", elementId: pastedAfterExecute.id },
		]);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
		expect(editor.selection.getSelectedElements()).toEqual(preSelection);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		const afterRedo = editor.timeline.getTracks();
		expect(afterRedo[0].elements).toHaveLength(2);
		const pastedAfterRedo = afterRedo[0].elements.find(
			(e) => e.id !== "el-existing",
		) as VideoElement;
		expect(pastedAfterRedo.startTime).toBe(12);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
		expect(editor.selection.getSelectedElements()).toEqual(preSelection);
	});
});

describe("tracks-snapshot command — undo/redo round trip", () => {
	test("TracksSnapshotCommand: execute/undo/redo/undo round-trips exactly against the two FIXED snapshots captured at construction; 1 history entry", () => {
		const before = [videoTrack({ elements: [], isMain: true })];
		const after = [
			videoTrack({ elements: [buildVideoElement()], isMain: true }),
		];
		const editor = makeEditor({ tracks: before });
		const preState = structuredClone(before);
		const afterState = structuredClone(after);

		const command = new TracksSnapshotCommand(before, after);
		editor.command.execute({ command });
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterState);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toEqual(afterState);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});
