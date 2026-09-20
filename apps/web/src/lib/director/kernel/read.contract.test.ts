/**
 * The contract test — the deliverable that matters more than `read.test.ts`.
 *
 * `read.test.ts` proves `read()`'s own logic against schema FIXTURES,
 * deliberately independent of Agent A's registry so it never blocks on
 * parallel work landing. This file does the opposite on purpose: it imports
 * the REAL `KIND_SCHEMAS` and, for a representative object of every
 * REGISTERED kind, checks that `read()`'s output honors the one promise the
 * whole kernel exists to keep — a `_writable` field is never silently
 * `undefined` in `data`. That is exactly the 2026-09-20 prod bug
 * (`clip.start` → silent `undefined` → a crash two frames later), one layer
 * down: `kernel/schemas/element.ts` and `track.ts` are deliberately FLAT (one
 * field list per kind, not branched per concrete sub-type — see each file's
 * own doc comment), so `_writable.fields` alone cannot say a video clip has
 * no `content`. `_unavailable` is how `read` says so instead of leaving the
 * field silently missing from `data`.
 *
 * This test is written to BREAK when either side drifts:
 *  - Agent A adds a schema field `read.ts` doesn't yet project → fails
 *    "declared writable but missing from data".
 *  - a `read.ts` locator starts returning a key no schema declares → fails
 *    "data key is not declared anywhere in the schema".
 *  - `read()`'s `_writable`/`_unavailable` split ever overlaps → fails
 *    "present in BOTH".
 *
 * Every fixture below is a plain object shaped like the real
 * `types/timeline.ts`/`types/project.ts`/`types/assets.ts` interfaces, fed
 * through a fake `EditorCore` — no live editor, no schema injection (the
 * whole point is testing against the REAL `schemaFor`).
 */

import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { KIND_SCHEMAS } from "./schemas";
import type { KindSchema } from "./schema";
import { read, type ReadResult } from "./read";

// ── fixtures: one small, realistic timeline exercising every element/track
// sub-kind, plus one of everything else the registry covers ─────────────────

const videoElement = {
	id: "elVideo",
	type: "video",
	name: "Farm establishing shot",
	startTime: 0,
	duration: 5,
	trimStart: 0,
	trimEnd: 0,
	sourceDuration: 10,
	mediaId: "assetVideo",
	muted: false,
	hidden: false,
	playbackRate: 1,
	reversed: false,
	isSourceAudioEnabled: true,
	transform: { position: { x: 0, y: 0 }, scale: 1, rotate: 0 },
	opacity: 1,
	blendMode: "normal",
	generation: {
		prompt: "a misty coffee farm at dawn",
		mode: "text-to-video",
		resolution: "1080p",
		orientation: "landscape",
		duration: 5,
	},
	takes: [
		{
			id: "take1",
			status: "ready",
			createdAt: 1,
			mediaId: "assetVideo",
			spec: {
				prompt: "a misty coffee farm at dawn",
				mode: "text-to-video",
				resolution: "1080p",
				orientation: "landscape",
				duration: 5,
			},
		},
	],
	activeTakeId: "take1",
	effects: [
		{ id: "fx1", type: "brightness", enabled: true, params: { amount: 0.1 } },
	],
	animations: {
		channels: {
			opacity: {
				valueKind: "number",
				keyframes: [{ id: "kf1", time: 0, value: 1, interpolation: "linear" }],
			},
		},
	},
};

const imageElement = {
	id: "elImage",
	type: "image",
	name: "Title card",
	startTime: 5,
	duration: 3,
	trimStart: 0,
	trimEnd: 0,
	mediaId: "assetImage",
	hidden: false,
	transform: { position: { x: 0, y: 0 }, scale: 1, rotate: 0 },
	opacity: 1,
};

const textElement = {
	id: "elText",
	type: "text",
	name: "Caption",
	startTime: 0,
	duration: 4,
	trimStart: 0,
	trimEnd: 0,
	content: "Hello world",
	fontSize: 32,
	fontFamily: "Inter",
	color: "#ffffff",
	highlightColor: "#00ff00",
	wordActiveColor: "#ffff00",
	wordActiveBackground: "#000000",
	wordTimings: [{ word: "Hello", start: 0, end: 0.5 }],
	wordPopScale: 1.2,
	strokeColor: "#000000",
	strokeWidth: 0.08,
	background: { enabled: true, color: "#000000" },
	textAlign: "center",
	fontWeight: "bold",
	fontStyle: "normal",
	textDecoration: "none",
	letterSpacing: 0,
	lineHeight: 1.2,
	hidden: false,
	transform: { position: { x: 0, y: 0 }, scale: 1, rotate: 0 },
	opacity: 1,
};

const stickerElement = {
	id: "elSticker",
	type: "sticker",
	name: "Star",
	startTime: 0,
	duration: 2,
	trimStart: 0,
	trimEnd: 0,
	stickerId: "star-1",
	hidden: false,
	transform: { position: { x: 0, y: 0 }, scale: 1, rotate: 0 },
	opacity: 1,
};

const shapeElement = {
	id: "elShape",
	type: "shape",
	name: "Lower-third scrim",
	startTime: 0,
	duration: 2,
	trimStart: 0,
	trimEnd: 0,
	shapeKind: "rect",
	width: 400,
	height: 120,
	fill: { type: "solid", color: "#000000" },
	stroke: { color: "#ffffff", width: 2 },
	cornerRadius: 8,
	hidden: false,
	transform: { position: { x: 0, y: 0 }, scale: 1, rotate: 0 },
	opacity: 1,
};

const effectElement = {
	id: "elEffect",
	type: "effect",
	name: "Color grade",
	startTime: 0,
	duration: 5,
	trimStart: 0,
	trimEnd: 0,
	effectType: "lut",
	params: { intensity: 0.5 },
};

/** Upload audio — HAS `mediaId` (the branch `mediaId`'s applicability check must accept). */
const audioUploadElement = {
	id: "elAudioUpload",
	type: "audio",
	name: "Voiceover",
	startTime: 0,
	duration: 5,
	trimStart: 0,
	trimEnd: 0,
	sourceType: "upload",
	mediaId: "assetAudio",
	volume: 1,
	muted: false,
	playbackRate: 1,
	generation: {
		prompt: "say hi",
		mode: "text-to-video",
		kind: "voiceover",
		resolution: "1080p",
		orientation: "landscape",
		duration: 5,
	},
};

/** Library audio — NO `mediaId` at all (the branch `mediaId`'s applicability check must reject, with a reason, not silently). */
const audioLibraryElement = {
	id: "elAudioLibrary",
	type: "audio",
	name: "Music bed",
	startTime: 5,
	duration: 10,
	trimStart: 0,
	trimEnd: 0,
	sourceType: "library",
	sourceUrl: "https://cdn.example/music.mp3",
	volume: 0.5,
	muted: false,
	playbackRate: 1,
};

const videoTrack = {
	id: "trackVideo",
	type: "video",
	name: "Video 1",
	color: "default",
	locked: false,
	muted: false,
	hidden: false,
	volume: 0.8,
	solo: false,
	isMain: true,
	elements: [videoElement, imageElement],
};

const textTrack = {
	id: "trackText",
	type: "text",
	name: "Captions",
	color: "default",
	locked: false,
	hidden: false,
	elements: [textElement],
};

const audioTrack = {
	id: "trackAudio",
	type: "audio",
	name: "Audio 1",
	color: "default",
	locked: false,
	muted: false,
	volume: 0.9,
	pan: 0,
	solo: false,
	elements: [audioUploadElement, audioLibraryElement],
};

const stickerTrack = {
	id: "trackSticker",
	type: "sticker",
	name: "Stickers",
	color: "default",
	locked: false,
	hidden: false,
	elements: [stickerElement],
};

const shapeTrack = {
	id: "trackShape",
	type: "shape",
	name: "Shapes",
	color: "default",
	locked: false,
	hidden: false,
	elements: [shapeElement],
};

const effectTrack = {
	id: "trackEffect",
	type: "effect",
	name: "Grade",
	color: "default",
	locked: false,
	hidden: false,
	elements: [effectElement],
};

const allTracks = [
	videoTrack,
	textTrack,
	audioTrack,
	stickerTrack,
	shapeTrack,
	effectTrack,
];

const marker = {
	id: "marker1",
	time: 1.5,
	color: "red",
	note: "beat hit",
	createdAt: 1,
};

const scene = {
	id: "scene1",
	name: "Main cut",
	isMain: true,
	tracks: allTracks,
	markers: [marker],
	bookmarks: [{ time: 2, note: "legacy bookmark" }],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-02T00:00:00Z"),
};

const project = {
	metadata: {
		id: "project1",
		name: "My Reel",
		thumbnail: "data:image/png;base64,",
		duration: 20,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-02T00:00:00Z"),
	},
	scenes: [scene],
	currentSceneId: "scene1",
	settings: {
		fps: 30,
		canvasSize: { width: 1080, height: 1920 },
		background: { type: "color", color: "#000000" },
		proxyEditing: true,
		proxyResolution: "720p",
	},
	version: 1,
	directorBrief: { goal: "drive signups", audience: "creators", tone: "warm" },
};

const asset = {
	id: "assetVideo",
	name: "farm.mp4",
	type: "video",
	label: "Farm",
	folderId: "folder1",
	width: 1920,
	height: 1080,
	duration: 12,
	fps: 30,
	thumbnailUrl: "thumb.jpg",
	source: "ai",
	ephemeral: false,
	needsProxy: false,
	proxy: undefined,
	decodeUnsupported: false,
	file: new File([], "farm.mp4"),
};

function makeEditor(): EditorCore {
	return {
		timeline: { getTracks: () => allTracks },
		media: {
			getAssets: () => [asset],
			getAssetById: (id: string) => (id === asset.id ? asset : undefined),
		},
		project: {
			getActiveOrNull: () => project,
			getDirectorBrief: () => project.directorBrief,
			getProjectBible: () => undefined,
		},
		selection: {
			getSelectedElements: () => [
				{ trackId: "trackVideo", elementId: "elVideo" },
			],
			getSelectedKeyframes: () => [],
			getKeyframeSelectionAnchor: () => null,
		},
		playback: {
			getCurrentTime: () => 3.2,
			getIsPlaying: () => true,
			getIsScrubbing: () => false,
			getVolume: () => 1,
			isMuted: () => false,
			getShuttleSpeed: () => 0,
			getShuttleDirection: () => null,
		},
		command: {
			canUndo: () => false,
			canRedo: () => false,
			getHistoryLength: () => 0,
			getRedoLength: () => 0,
			peekUndoName: () => undefined,
		},
		scenes: {
			getMarkers: () => scene.markers,
			getScenes: () => [scene],
		},
	} as unknown as EditorCore;
}

// ── the contract itself ──────────────────────────────────────────────────

/**
 * For one `read()` result, checks the invariant against the REAL schema for
 * its kind: every non-readOnly schema field is EITHER present in `data` (if
 * `_writable` still promises it) OR named in `_unavailable` with a reason —
 * never neither, never both. Then checks the reverse: every key `read`
 * actually returned in `data` is a name the schema recognizes at all.
 */
function assertReadContract(result: ReadResult): void {
	const schema = KIND_SCHEMAS[result.kind] as KindSchema | undefined;
	if (!schema) {
		throw new Error(
			`assertReadContract called for kind "${result.kind}" (at ${result.id}), which has no entry in KIND_SCHEMAS — this helper only makes sense for registered kinds.`,
		);
	}
	const writableNames = new Set(Object.keys(result._writable.fields));
	const unavailable = result._unavailable ?? {};

	for (const [name, spec] of Object.entries(schema.fields)) {
		if (spec.readOnly) continue; // no _writable/_unavailable obligation — see file header
		const inWritable = writableNames.has(name);
		const inUnavailable = Object.hasOwn(unavailable, name);

		expect(
			inWritable || inUnavailable,
			`${result.kind}.${name} (at ${result.id}): a writable schema field must land in EITHER _writable.fields or _unavailable — it is in neither.`,
		).toBe(true);
		expect(
			inWritable && inUnavailable,
			`${result.kind}.${name} (at ${result.id}): present in BOTH _writable.fields and _unavailable — they must never overlap.`,
		).toBe(false);

		if (inWritable) {
			expect(
				Object.hasOwn(result.data, name),
				`${result.kind}.${name} (at ${result.id}): _writable promises this field but it is missing from data — this IS the silent-undefined bug this test exists to catch.`,
			).toBe(true);
		} else {
			expect(
				typeof unavailable[name] === "string" && unavailable[name].length > 0,
				`${result.kind}.${name} (at ${result.id}): listed in _unavailable with an empty/missing reason.`,
			).toBe(true);
		}
	}

	for (const key of Object.keys(result.data)) {
		expect(
			Object.hasOwn(schema.fields, key),
			`${result.kind} (at ${result.id}): data key "${key}" is not declared anywhere in kernel/schemas/${result.kind}.ts — either it needs a schema entry, or read.ts should stop returning it.`,
		).toBe(true);
	}
}

describe("read contract — every registered kind, against the REAL schemaFor", () => {
	const registeredKinds = new Set(Object.keys(KIND_SCHEMAS));

	it("sanity: this test's fixtures cover every kind currently registered", () => {
		// If Agent A registers a new kind and this file isn't updated, THIS is
		// the assertion that says so, rather than the new kind silently getting
		// zero contract coverage.
		const covered = new Set([
			"element",
			"track",
			"take",
			"effect",
			"keyframe",
			"marker",
			"scene",
			"asset",
			"project",
			"selection",
			"playhead",
		]);
		expect([...registeredKinds].sort()).toEqual([...covered].sort());
	});

	describe("element", () => {
		const targets: Array<[string, string]> = [
			["video (generative slot)", "element:elVideo"],
			["image", "element:elImage"],
			["text", "element:elText"],
			["sticker", "element:elSticker"],
			["shape", "element:elShape"],
			["effect (track-level adjustment layer)", "element:elEffect"],
			["audio, upload source (has mediaId)", "element:elAudioUpload"],
			["audio, library source (no mediaId)", "element:elAudioLibrary"],
		];
		for (const [label, at] of targets) {
			it(label, async () => {
				const result = await read(makeEditor(), { at });
				assertReadContract(result);
			});
		}

		it("library audio specifically routes mediaId to _unavailable, not a silent omission", async () => {
			const result = await read(makeEditor(), { at: "element:elAudioLibrary" });
			expect(result._unavailable?.mediaId).toBeDefined();
			expect(result._writable.fields.mediaId).toBeUndefined();
			expect(Object.hasOwn(result.data, "mediaId")).toBe(false);
		});
	});

	describe("track", () => {
		const targets: Array<[string, string]> = [
			["video", "track:trackVideo"],
			["text", "track:trackText"],
			["audio", "track:trackAudio"],
			["sticker", "track:trackSticker"],
			["shape", "track:trackShape"],
			["effect", "track:trackEffect"],
		];
		for (const [label, at] of targets) {
			it(label, async () => {
				const result = await read(makeEditor(), { at });
				assertReadContract(result);
			});
		}

		it("audio tracks specifically route hidden to _unavailable (AudioTrack has no hidden field)", async () => {
			const result = await read(makeEditor(), { at: "track:trackAudio" });
			expect(result._unavailable?.hidden).toBeDefined();
			expect(result._writable.fields.hidden).toBeUndefined();
		});
	});

	const singleTargets: Array<[string, string]> = [
		["take", "take:take1"],
		["effect", "effect:fx1"],
		["keyframe", "keyframe:kf1"],
		["marker", "marker:marker1"],
		["scene", "scene:scene1"],
		["asset", "asset:assetVideo"],
		["project", "project"],
		["selection", "selection"],
		["playhead", "playhead"],
	];
	for (const [kind, at] of singleTargets) {
		it(kind, async () => {
			const result = await read(makeEditor(), { at });
			assertReadContract(result);
		});
	}
});
