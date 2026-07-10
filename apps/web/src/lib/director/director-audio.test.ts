import { describe, expect, it } from "bun:test";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor, type FakeElement } from "./fake-editor";
import { toolCatalog } from "./tool-catalog";
import type { GenerateExecutor } from "./types";

/**
 * Audio-aware directing (Part B): the Director can orchestrate a soundtrack —
 * `addVoiceover` (script → TTS clip timed to a shot) and `addMusicBed` (sounds
 * search → quiet music track) — so a brief that mentions narration yields a reel
 * with a real voiceover track, not just silent video.
 */

// An executor that always lands (voiceover specs route through the same path).
const okExecutor: GenerateExecutor = {
	run: async () => ({ status: "ready", mediaId: "aud_1" }),
};

const fastRecovery = { sleep: async () => {} };

/** A voiceover slot = an audio element carrying a `kind: "voiceover"` recipe. */
const voiceoverElements = (
	tracks: { type: string; elements: FakeElement[] }[],
): FakeElement[] =>
	tracks
		.filter((t) => t.type === "audio")
		.flatMap((t) => t.elements)
		.filter((e) => e.generation?.kind === "voiceover");

describe("Director addVoiceover", () => {
	it("adds a voiceover TIMED to the shot it narrates, with a ready take", async () => {
		const { editor, tracksOfType } = makeFakeEditor();
		const d = createDirectorApi(editor, {
			executor: okExecutor,
			recovery: fastRecovery,
		});
		const shot = d.reserveSlot({
			prompt: "city skyline",
			duration: 6,
			startTime: 3,
		});
		const shotId = shot.data?.slotId;
		expect(shotId).toBeDefined();

		const res = await d.addVoiceover({
			script: "The future of your city, today.",
			slotId: shotId,
		});

		expect(res.ok).toBe(true);
		const audioTracks = tracksOfType("audio");
		expect(audioTracks).toHaveLength(1);
		const vo = audioTracks[0].elements[0];
		expect(vo.generation?.kind).toBe("voiceover");
		expect(vo.generation?.prompt).toBe("The future of your city, today.");
		// Timed to the narrated shot (same start + duration).
		expect(vo.startTime).toBe(3);
		expect(vo.duration).toBe(6);
		// The VO rendered as a ready, auto-selected take.
		expect(vo.takes?.[0]?.status).toBe("ready");
		expect(vo.activeTakeId).toBe(vo.takes?.[0]?.id);
	});

	it("estimates a duration from the script when no shot/duration is given", async () => {
		const { editor, tracksOfType } = makeFakeEditor();
		const d = createDirectorApi(editor, {
			executor: okExecutor,
			recovery: fastRecovery,
		});
		const res = await d.addVoiceover({
			script: "one two three four five six seven eight nine ten",
		});
		expect(res.ok).toBe(true);
		const vo = tracksOfType("audio")[0].elements[0];
		// ~10 words / 2.5 wps = 4s.
		expect(vo.duration).toBeGreaterThan(0);
		expect(vo.startTime).toBe(0);
	});

	it("reserves the VO slot but renders nothing when no executor is configured", async () => {
		const { editor, tracksOfType } = makeFakeEditor();
		const d = createDirectorApi(editor); // no executor
		const res = await d.addVoiceover({ script: "hello", duration: 2 });
		expect(res.ok).toBe(true);
		expect(res.message).toMatch(/no generation executor/i);
		const vo = tracksOfType("audio")[0].elements[0];
		expect(vo.takes ?? []).toHaveLength(0);
	});
});

describe("Director addMusicBed", () => {
	it("lays a resolved track under the reel at bed volume, spanning the timeline", async () => {
		const { editor, tracksOfType } = makeFakeEditor();
		const d = createDirectorApi(editor, {
			executor: okExecutor,
			recovery: fastRecovery,
			audio: {
				resolveMusic: async ({ query }) => ({
					mediaId: "music_1",
					name: `track for ${query}`,
					duration: 120,
					license: "CC0",
				}),
			},
		});
		// Give the timeline some length so the bed spans it.
		d.reserveSlot({ prompt: "shot", duration: 8, startTime: 0 });

		const res = await d.addMusicBed({ query: "upbeat lofi" });

		expect(res.ok).toBe(true);
		expect(res.data?.mediaId).toBe("music_1");
		const audioEl = tracksOfType("audio")[0].elements[0];
		expect(audioEl.mediaId).toBe("music_1");
		expect(audioEl.volume).toBe(0.3); // quiet bed by default
		expect(audioEl.duration).toBe(8); // spans the timeline
		expect(audioEl.startTime).toBe(0);
	});

	it("fails cleanly when the sounds search finds nothing", async () => {
		const { editor } = makeFakeEditor();
		const d = createDirectorApi(editor, {
			audio: { resolveMusic: async () => ({ error: "no sounds matched" }) },
		});
		const res = await d.addMusicBed({ query: "nonexistent" });
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/no sounds matched/i);
	});
});

describe("narration brief → voiceover track on the timeline", () => {
	it("storyboard → generate → addVoiceover yields a reel with a voiceover track", async () => {
		const { editor, tracks } = makeFakeEditor();
		const d = createDirectorApi(editor, {
			executor: okExecutor,
			recovery: fastRecovery,
		});

		// A "make a short ad with a voiceover" flow, driven the way the agent would.
		const board = d.storyboard({
			shots: [
				{ prompt: "product hero shot", duration: 5 },
				{ prompt: "happy customer", duration: 5 },
			],
		});
		expect(board.ok).toBe(true);
		const shotIds = board.data?.slotIds ?? [];
		expect(shotIds).toHaveLength(2);

		await d.generate({ slotIds: "all" });

		// One VO per shot, each timed to the shot it narrates.
		const vo1 = await d.addVoiceover({
			script: "Meet the product that changes everything.",
			slotId: shotIds[0],
		});
		const vo2 = await d.addVoiceover({
			script: "Loved by thousands.",
			slotId: shotIds[1],
		});
		expect(vo1.ok).toBe(true);
		expect(vo2.ok).toBe(true);

		// The timeline now carries a dedicated voiceover (audio) track with synced,
		// rendered VO clips — not silent video.
		const vos = voiceoverElements(tracks);
		expect(vos).toHaveLength(2);
		expect(vos.every((v) => v.takes?.[0]?.status === "ready")).toBe(true);
		expect(vos.map((v) => v.startTime).sort()).toEqual([0, 5]);
		expect(tracks.some((t) => t.type === "audio")).toBe(true);
	});
});

describe("audio verbs are wired into the shared tool catalog", () => {
	it("exposes addVoiceover + addMusicBed as mutating verbs that dispatch", async () => {
		const catalog = toolCatalog();
		const names = catalog.map((t) => t.name);
		expect(names).toContain("addVoiceover");
		expect(names).toContain("addMusicBed");

		const { editor, tracksOfType } = makeFakeEditor();
		const d = createDirectorApi(editor, {
			executor: okExecutor,
			recovery: fastRecovery,
		});

		const voVerb = catalog.find((t) => t.name === "addVoiceover");
		if (!voVerb) throw new Error("addVoiceover verb missing");
		expect(voVerb.mutating).toBe(true);
		const res = await voVerb.handler(d, {
			script: "Dispatched through the catalog.",
		});
		expect(res.ok).toBe(true);
		expect(voiceoverElements(tracksOfType("audio")).length).toBe(1);
	});
});
