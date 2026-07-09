import { describe, expect, test } from "bun:test";
import { serializeArrangement, hydrateArrangement } from "./serialize";
import { validateArrangement } from "./validate";
import type { TimelineTrack } from "@/types/timeline";

function makeTracks(): TimelineTrack[] {
	return [
		{
			id: "video-1",
			name: "Main Track",
			type: "video",
			isMain: true,
			muted: false,
			hidden: false,
			elements: [
				{
					id: "el-1",
					type: "video",
					mediaId: "media-abc", // must be stripped
					name: "Shot 1",
					duration: 3,
					startTime: 0,
					trimStart: 0,
					trimEnd: 0,
					transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
					opacity: 1,
					transitionOut: { type: "fade", duration: 0.4 },
					generation: {
						prompt: "a cat",
						mode: "text-to-video",
						resolution: "720p",
						orientation: "portrait",
						duration: 3,
						referenceImageUrl: "https://example.com/ref.png", // must be stripped
						personaId: "persona-1", // must be stripped
						seed: 42, // must be stripped
						seedLocked: true, // must be stripped
					},
					takes: [
						{
							id: "take-1",
							status: "ready",
							mediaId: "media-abc",
							spec: {
								prompt: "a cat",
								mode: "text-to-video",
								resolution: "720p",
								orientation: "portrait",
								duration: 3,
							},
							createdAt: 0,
						},
					],
					activeTakeId: "take-1",
				},
			],
		},
		{
			id: "text-1",
			name: "Text",
			type: "text",
			hidden: false,
			elements: [
				{
					id: "txt-1",
					type: "text",
					name: "Title",
					content: "Hello world",
					duration: 2,
					startTime: 0,
					trimStart: 0,
					trimEnd: 0,
					fontSize: 40,
					fontFamily: "Arial",
					color: "#ffffff",
					textAlign: "center",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					background: { enabled: false, color: "#000000" },
					transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
					opacity: 1,
				},
			],
		},
	];
}

describe("serializeArrangement", () => {
	test("captures slot structure and strips all media/identity", () => {
		const arr = serializeArrangement({
			tracks: makeTracks(),
			name: "My template",
			canvas: { width: 1080, height: 1920 },
			fps: 30,
		});

		expect(arr.slots).toHaveLength(1);
		expect(arr.overlays).toHaveLength(1);
		expect(arr.totalDuration).toBe(3);

		const slot = arr.slots[0];
		expect(slot.kind).toBe("video");
		expect(slot.duration).toBe(3);
		expect(slot.transitionOut).toEqual({ type: "fade", duration: 0.4 });
		// Recipe kept its creative intent…
		expect(slot.recipe?.prompt).toBe("a cat");
		expect(slot.recipe?.orientation).toBe("portrait");
		// …but every media/identity field is gone.
		const recipeJson = JSON.stringify(slot.recipe);
		expect(recipeJson).not.toContain("referenceImageUrl");
		expect(recipeJson).not.toContain("persona");
		expect(recipeJson).not.toContain("42");
		// The whole arrangement is media-free.
		const arrJson = JSON.stringify(arr);
		expect(arrJson).not.toContain("media-abc");
		expect(arrJson).not.toContain("take-1");
	});
});

describe("hydrateArrangement", () => {
	test("recreates empty generative slots with the recipe intact", () => {
		const arr = serializeArrangement({
			tracks: makeTracks(),
			name: "My template",
		});
		const tracks = hydrateArrangement({ arrangement: arr });

		const videoTrack = tracks.find((t) => t.type === "video");
		expect(videoTrack).toBeDefined();
		expect(videoTrack?.type === "video" && videoTrack.isMain).toBe(true);
		const el = videoTrack!.elements[0] as {
			mediaId: string;
			generation?: { prompt: string };
			takes?: unknown[];
		};
		// Empty slot: no media, no takes, but recipe present.
		expect(el.mediaId).toBe("");
		expect(el.takes).toEqual([]);
		expect(el.generation?.prompt).toBe("a cat");

		const textTrack = tracks.find((t) => t.type === "text");
		expect(textTrack?.elements[0]).toMatchObject({ content: "Hello world" });
	});

	test("always yields at least one main video track for an empty arrangement", () => {
		const tracks = hydrateArrangement({
			arrangement: {
				version: 1,
				name: "Blank",
				totalDuration: 0,
				slots: [],
				overlays: [],
			},
		});
		const main = tracks.find((t) => t.type === "video" && t.isMain);
		expect(main).toBeDefined();
	});
});

describe("validateArrangement", () => {
	test("normalizes a round-tripped arrangement and rejects junk", () => {
		const arr = serializeArrangement({ tracks: makeTracks(), name: "T" });
		const validated = validateArrangement(JSON.parse(JSON.stringify(arr)));
		expect(validated.slots).toHaveLength(1);
		expect(validated.name).toBe("T");

		expect(() => validateArrangement(null)).toThrow();
		expect(() => validateArrangement({ slots: new Array(200).fill({}) })).toThrow();
	});
});
