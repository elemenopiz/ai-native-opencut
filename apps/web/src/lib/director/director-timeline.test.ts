import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { buildContextBlock, buildFrontierSystemPrompt } from "./agent";
import { createDirectorApi } from "./director-api";

/**
 * `getTimeline` (Director's fix for "timeline blindness" — see
 * `docs/plans/2026-07-19-director-revamp-design.md` §Item 1) surfaces the
 * WHOLE timeline: uploaded clips, text overlays, audio, AND generative slots.
 * Before this verb, `getReel().slots` only ever saw `.generation`-bearing
 * image/video elements, so a hand-built timeline with no generative slots
 * reported as an EMPTY reel even though it held real, visible content.
 *
 * These tests wire `getTimeline` through a real `DirectorApi` over an
 * in-memory editor — proving the verb sees non-slot content, the digest
 * counts it, and `buildContextBlock` folds a live TIMELINE line into the
 * system prompt next to PROJECT/PERSONAS/LIBRARY.
 */

interface FakeAsset {
	id: string;
	name: string;
}

/**
 * In-memory `EditorCore` stub: real tracks/elements (so `getTimeline`/`getReel`
 * read live state), a media-asset lookup (so manual clips resolve a `label`
 * from `mediaId`), no active project (irrelevant to this feature).
 */
function makeEditor(
	tracks: Array<{
		id: string;
		type: string;
		elements: Array<Record<string, unknown>>;
	}>,
	assets: FakeAsset[] = [],
	totalDuration = 0,
): EditorCore {
	let brief: Record<string, unknown> = {};
	return {
		timeline: {
			getTotalDuration: () => totalDuration,
			getTracks: () => tracks,
		},
		command: new CommandManager(),
		media: {
			getAssetById: (id: string) => assets.find((a) => a.id === id),
			getAssets: () => assets,
		},
		project: {
			getActiveOrNull: () => null,
			getDirectorBrief: () => brief,
			setDirectorBrief: ({
				brief: next,
			}: {
				brief: Record<string, unknown>;
			}) => {
				brief = next;
			},
		},
	} as unknown as EditorCore;
}

describe("getTimeline — whole-timeline visibility", () => {
	it("surfaces a manual clip, a text element, and an audio element — none of which are reel slots", () => {
		const editor = makeEditor(
			[
				{
					id: "track_video",
					type: "video",
					elements: [
						{
							id: "el_clip",
							type: "video",
							name: "fallback-name.mp4",
							mediaId: "m1",
							startTime: 0,
							duration: 5,
						},
					],
				},
				{
					id: "track_text",
					type: "text",
					elements: [
						{
							id: "el_text",
							type: "text",
							name: "Text 1",
							content: "Hello World",
							startTime: 0,
							duration: 3,
						},
					],
				},
				{
					id: "track_audio",
					type: "audio",
					elements: [
						{
							id: "el_audio",
							type: "audio",
							name: "fallback-audio.mp3",
							mediaId: "m2",
							startTime: 0,
							duration: 5,
						},
					],
				},
			],
			[
				{ id: "m1", name: "beach-walk.mp4" },
				{ id: "m2", name: "ambient-hum.mp3" },
			],
			42,
		);
		const director = createDirectorApi(editor);

		// GROUND TRUTH: the reel is empty — none of these elements carry a
		// `.generation` recipe, so `locateSlots`/`getReel` see nothing.
		expect(director.getReel().slots).toEqual([]);

		const res = director.getTimeline();
		expect(res.ok).toBe(true);
		const data = res.data;
		expect(data).toBeDefined();
		if (!data) return;

		expect(data.tracks).toHaveLength(3);

		const [videoTrack, textTrack, audioTrack] = data.tracks;
		expect(videoTrack).toMatchObject({
			id: "track_video",
			kind: "video",
			elementCount: 1,
		});
		expect(videoTrack.elements[0]).toEqual({
			id: "el_clip",
			kind: "video",
			startSec: 0,
			durationSec: 5,
			label: "beach-walk.mp4", // resolved via mediaId, not the element's own name
			isGenerative: false,
		});

		expect(textTrack).toMatchObject({
			id: "track_text",
			kind: "text",
			elementCount: 1,
		});
		expect(textTrack.elements[0]).toEqual({
			id: "el_text",
			kind: "text",
			startSec: 0,
			durationSec: 3,
			label: "Hello World",
			isGenerative: false,
		});

		expect(audioTrack).toMatchObject({
			id: "track_audio",
			kind: "audio",
			elementCount: 1,
		});
		expect(audioTrack.elements[0]).toEqual({
			id: "el_audio",
			kind: "audio",
			startSec: 0,
			durationSec: 5,
			label: "ambient-hum.mp3",
			isGenerative: false,
		});

		expect(data.totalDurationSec).toBe(42);

		// The exact digest string — non-empty, and it counts every element kind.
		expect(data.digest).toBe(
			"TIMELINE: 3 tracks · 1 clip (1 uploaded, 0 generative) · 1 text · 1 audio · 0:42 total.",
		);
		expect(res.message).toBe(data.digest);
	});

	it("marks a generative slot as generative AND cross-references its reel slotId", () => {
		const editor = makeEditor(
			[
				{
					id: "track_video",
					type: "video",
					elements: [
						{
							id: "slot_1",
							type: "video",
							name: "slot",
							startTime: 0,
							duration: 5,
							generation: { prompt: "a dog running on a beach" },
							takes: [],
						},
					],
				},
			],
			[],
			5,
		);
		const director = createDirectorApi(editor);

		const reelSlotId = director.getReel().slots[0]?.id;
		expect(reelSlotId).toBe("slot_1");

		const data = director.getTimeline().data;
		expect(data?.tracks[0].elements[0]).toMatchObject({
			id: "slot_1",
			isGenerative: true,
			label: "generative slot",
			slotId: "slot_1",
		});
		expect(data?.digest).toBe(
			"TIMELINE: 1 track · 1 clip (0 uploaded, 1 generative) · 0:05 total.",
		);
	});

	it("marks a generative AUDIO (voiceover) element as generative but NOT a reel slotId — audio is never a reel slot", () => {
		const editor = makeEditor(
			[
				{
					id: "track_audio",
					type: "audio",
					elements: [
						{
							id: "vo_1",
							type: "audio",
							name: "voiceover",
							startTime: 0,
							duration: 4,
							generation: { prompt: "welcome to the show", kind: "voiceover" },
							takes: [],
						},
					],
				},
			],
			[],
			4,
		);
		const director = createDirectorApi(editor);

		// isSlotElement is image/video-only — a generative audio element is
		// invisible to getReel().slots even though it clearly carries a recipe.
		expect(director.getReel().slots).toEqual([]);

		const data = director.getTimeline().data;
		expect(data?.tracks[0].elements[0]).toMatchObject({
			id: "vo_1",
			kind: "audio",
			isGenerative: true,
			label: "generative slot",
		});
		expect(data?.tracks[0].elements[0].slotId).toBeUndefined();
	});

	it("caps elements per track and reports an overflowCount", () => {
		const many = Array.from({ length: 25 }, (_, i) => ({
			id: `el_${i}`,
			type: "text",
			name: `t${i}`,
			content: `text ${i}`,
			startTime: i,
			duration: 1,
		}));
		const editor = makeEditor(
			[{ id: "track_text", type: "text", elements: many }],
			[],
			26,
		);
		const director = createDirectorApi(editor);

		const data = director.getTimeline().data;
		expect(data?.tracks[0].elementCount).toBe(25);
		expect(data?.tracks[0].elements).toHaveLength(20);
		expect(data?.tracks[0].overflowCount).toBe(5);
	});

	it("reports empty for a project with no tracks", () => {
		const editor = makeEditor([], [], 0);
		const director = createDirectorApi(editor);

		const data = director.getTimeline().data;
		expect(data?.tracks).toEqual([]);
		expect(data?.digest).toBe("TIMELINE: empty.");
	});

	it("reports empty for tracks that hold zero elements", () => {
		const editor = makeEditor(
			[
				{ id: "track_1", type: "video", elements: [] },
				{ id: "track_2", type: "audio", elements: [] },
			],
			[],
			0,
		);
		const director = createDirectorApi(editor);

		const data = director.getTimeline().data;
		expect(data?.digest).toBe("TIMELINE: empty.");
	});

	it("is registered in the shared tool catalog as a read-only verb with an empty input schema", async () => {
		const { toolCatalog, scopeForTool } = await import("./tool-catalog");
		const entry = toolCatalog().find((t) => t.name === "getTimeline");
		expect(entry).toBeDefined();
		expect(entry?.mutating).toBe(false);
		expect(scopeForTool("getTimeline")).toBe("reel:read");
		expect(entry?.inputSchema).toMatchObject({ type: "object" });
	});
});

describe("buildContextBlock — TIMELINE digest (the empty-reel-but-not-empty-timeline case)", () => {
	it("folds a non-empty TIMELINE line into the context block when the reel has zero slots", () => {
		const editor = makeEditor(
			[
				{
					id: "track_video",
					type: "video",
					elements: [
						{
							id: "el_clip",
							type: "video",
							name: "clip.mp4",
							mediaId: "m1",
							startTime: 0,
							duration: 5,
						},
					],
				},
				{
					id: "track_text",
					type: "text",
					elements: [
						{
							id: "el_text",
							type: "text",
							name: "Text 1",
							content: "Hand-built caption",
							startTime: 0,
							duration: 3,
						},
					],
				},
				{
					id: "track_audio",
					type: "audio",
					elements: [
						{
							id: "el_audio",
							type: "audio",
							name: "audio.mp3",
							mediaId: "m2",
							startTime: 0,
							duration: 5,
						},
					],
				},
			],
			[
				{ id: "m1", name: "clip.mp4" },
				{ id: "m2", name: "audio.mp3" },
			],
			42,
		);
		const director = createDirectorApi(editor);

		// The reel is empty — this IS the design gap the digest fixes.
		expect(director.getReel().slots).toEqual([]);

		const block = buildContextBlock(director);
		const lines = block.split("\n");
		const timelineLine = lines.find((l) => l.startsWith("TIMELINE:"));

		expect(timelineLine).toBeDefined();
		expect(timelineLine).not.toBe("TIMELINE: empty.");
		expect(timelineLine).toBe(
			"TIMELINE: 3 tracks · 1 clip (1 uploaded, 0 generative) · 1 text · 1 audio · 0:42 total.",
		);
		// Rides alongside the pre-existing PROJECT/PERSONAS/LIBRARY lines.
		expect(lines.some((l) => l.startsWith("PROJECT:"))).toBe(true);
		expect(lines.some((l) => l.startsWith("PERSONAS"))).toBe(true);
		expect(lines.some((l) => l.startsWith("LIBRARY"))).toBe(true);
	});

	it("emits 'TIMELINE: empty.' for a genuinely empty project", () => {
		const editor = makeEditor([], [], 0);
		const director = createDirectorApi(editor);

		const block = buildContextBlock(director);
		expect(block.split("\n")).toContain("TIMELINE: empty.");
	});
});

describe("buildFrontierSystemPrompt — reel-vs-timeline framing", () => {
	it("frames the reel as the generative LAYER on a timeline that may hold more, not the whole project", () => {
		const editor = makeEditor([], [], 0);
		const director = createDirectorApi(editor);

		const prompt = buildFrontierSystemPrompt(director);

		expect(prompt).toContain("GENERATIVE LAYER");
		expect(prompt).toContain(
			"may ALSO hold uploaded clips, text overlays, and audio",
		);
		// The live TIMELINE digest itself rides later in the same prompt (via
		// buildContextBlock), so the model never has to call getTimeline blind.
		expect(prompt).toContain("TIMELINE:");
	});
});
