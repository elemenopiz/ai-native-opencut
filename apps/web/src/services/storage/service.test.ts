import { describe, expect, it } from "bun:test";
import { deserializeProject } from "@/services/storage/service";
import type { SerializedProject } from "@/services/storage/types";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import {
	DEFAULT_BLEND_MODE,
	DEFAULT_OPACITY,
	DEFAULT_TRANSFORM,
} from "@/constants/timeline-constants";

// A project persisted with a visual element missing `transform` used to crash
// on every load (resolveTransformAtTime read `transform.position` during the
// load-time thumbnail render) — permanently bricking the project. These tests
// pin the heal-on-load seam so existing broken projects hydrate loadable.

function buildSerializedProject({
	tracks,
}: {
	tracks: TimelineTrack[];
}): SerializedProject {
	const now = new Date().toISOString();
	return {
		metadata: {
			id: "project-1",
			name: "Project",
			thumbnail: "",
			duration: 2,
			createdAt: now,
			updatedAt: now,
		},
		scenes: [
			{
				id: "scene-1",
				name: "Scene 1",
				isMain: true,
				tracks,
				bookmarks: [],
				markers: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		currentSceneId: "scene-1",
		settings: {} as SerializedProject["settings"],
		version: 2,
	} as SerializedProject;
}

function buildVideoTrack({ elements }: { elements: unknown[] }): TimelineTrack {
	return {
		id: "track-1",
		name: "Video track",
		type: "video",
		elements,
		isMain: true,
		muted: false,
		hidden: false,
	} as TimelineTrack;
}

describe("deserializeProject — heal malformed visual elements on load", () => {
	it("hydrates a transform-less video element with default transform/opacity/blendMode", () => {
		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [
					buildVideoTrack({
						elements: [
							{
								id: "el-1",
								name: "Bricked clip",
								type: "video",
								mediaId: "media-1",
								startTime: 0,
								duration: 2,
								trimStart: 0,
								trimEnd: 0,
								// no transform, no opacity, no blendMode
							},
						],
					}),
				],
			}),
		});

		const element = project.scenes[0]?.tracks[0]?.elements[0] as VideoElement;
		expect(element).toBeDefined();
		expect(element.transform).toEqual(DEFAULT_TRANSFORM);
		expect(element.opacity).toBe(DEFAULT_OPACITY);
		expect(element.blendMode).toBe(DEFAULT_BLEND_MODE);
	});

	it("leaves a well-formed visual element untouched (same reference)", () => {
		const healthy = {
			id: "el-2",
			name: "Healthy clip",
			type: "video",
			mediaId: "media-2",
			startTime: 0,
			duration: 2,
			trimStart: 0,
			trimEnd: 0,
			transform: { position: { x: 5, y: 6 }, scale: 2, rotate: 45 },
			opacity: 0.5,
			blendMode: "screen",
		};

		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [buildVideoTrack({ elements: [healthy] })],
			}),
		});

		expect(project.scenes[0]?.tracks[0]?.elements[0]).toBe(
			healthy as unknown as VideoElement,
		);
	});

	it("does not add visual defaults to audio elements", () => {
		const audioTrack = {
			id: "track-audio",
			name: "Audio track",
			type: "audio",
			elements: [
				{
					id: "el-3",
					name: "Song",
					type: "audio",
					sourceType: "upload",
					mediaId: "media-3",
					startTime: 0,
					duration: 2,
					trimStart: 0,
					trimEnd: 0,
					volume: 1,
				},
			],
			muted: false,
			hidden: false,
		} as unknown as TimelineTrack;

		const project = deserializeProject({
			serializedProject: buildSerializedProject({ tracks: [audioTrack] }),
		});

		const element = project.scenes[0]?.tracks[0]?.elements[0];
		expect(element).toBeDefined();
		expect(element && "transform" in element).toBe(false);
		expect(element && "blendMode" in element).toBe(false);
	});
});

// BUG129 — extends the transform-brick heal to sibling corruption classes: a
// malformed element/track (not just an element missing visual defaults) used
// to reach a `.type`/`.id` read downstream and crash the load, bricking the
// whole project (or, for a dangling mediaId, silently render an invisible,
// still-selectable clip). These tests pin the drop-the-garbage / keep-the-
// rest contract for each corruption class.
describe("deserializeProject — heal malformed track/element corruption (BUG129)", () => {
	function validElement({ id }: { id: string }) {
		return {
			id,
			name: "Valid clip",
			type: "video",
			mediaId: "media-1",
			startTime: 0,
			duration: 2,
			trimStart: 0,
			trimEnd: 0,
			transform: { position: { x: 0, y: 0 }, scale: 1, rotate: 0 },
			opacity: 1,
			blendMode: "normal",
		};
	}

	it("drops a null element and keeps the valid ones", () => {
		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [
					buildVideoTrack({
						elements: [null, validElement({ id: "el-valid" })],
					}),
				],
			}),
		});

		const elements = project.scenes[0]?.tracks[0]?.elements ?? [];
		expect(elements).toHaveLength(1);
		expect(elements[0]?.id).toBe("el-valid");
	});

	it("drops an element missing an `id`", () => {
		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [
					buildVideoTrack({
						elements: [
							{
								name: "No id",
								type: "video",
								mediaId: "media-1",
								startTime: 0,
								duration: 2,
								trimStart: 0,
								trimEnd: 0,
							},
							validElement({ id: "el-valid" }),
						],
					}),
				],
			}),
		});

		const elements = project.scenes[0]?.tracks[0]?.elements ?? [];
		expect(elements).toHaveLength(1);
		expect(elements[0]?.id).toBe("el-valid");
	});

	it("drops an element with a non-string `type`", () => {
		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [
					buildVideoTrack({
						elements: [
							{
								id: "el-bad-type",
								name: "Bad type",
								type: 123,
								mediaId: "media-1",
								startTime: 0,
								duration: 2,
								trimStart: 0,
								trimEnd: 0,
							},
							validElement({ id: "el-valid" }),
						],
					}),
				],
			}),
		});

		const elements = project.scenes[0]?.tracks[0]?.elements ?? [];
		expect(elements).toHaveLength(1);
		expect(elements[0]?.id).toBe("el-valid");
	});

	it("drops an element with an unrecognized `type` string", () => {
		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [
					buildVideoTrack({
						elements: [
							{
								id: "el-unknown-type",
								name: "Unknown type",
								type: "hologram",
								mediaId: "media-1",
								startTime: 0,
								duration: 2,
								trimStart: 0,
								trimEnd: 0,
							},
							validElement({ id: "el-valid" }),
						],
					}),
				],
			}),
		});

		const elements = project.scenes[0]?.tracks[0]?.elements ?? [];
		expect(elements).toHaveLength(1);
		expect(elements[0]?.id).toBe("el-valid");
	});

	it("keeps the first element of a duplicate `id` pair and drops the later one", () => {
		const first = validElement({ id: "dupe-id" });
		const second = {
			...validElement({ id: "dupe-id" }),
			name: "Second (should be dropped)",
			mediaId: "media-2",
		};

		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [buildVideoTrack({ elements: [first, second] })],
			}),
		});

		const elements = project.scenes[0]?.tracks[0]?.elements ?? [];
		expect(elements).toHaveLength(1);
		expect(elements[0]?.name).toBe("Valid clip");
	});

	it("dedupes duplicate ids scene-wide, across different tracks", () => {
		const trackA = buildVideoTrack({
			elements: [{ ...validElement({ id: "shared-id" }), name: "Track A" }],
		});
		const trackB = buildVideoTrack({
			elements: [{ ...validElement({ id: "shared-id" }), name: "Track B" }],
		});
		(trackB as { id: string }).id = "track-2";

		const project = deserializeProject({
			serializedProject: buildSerializedProject({ tracks: [trackA, trackB] }),
		});

		const allElements = (
			project.scenes[0]?.tracks.map((t) => t.elements as unknown[]) ?? []
		).flat() as { name?: string }[];
		expect(allElements).toHaveLength(1);
		expect(allElements[0]?.name).toBe("Track A");
	});

	it("drops a null track and keeps the valid ones", () => {
		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [
					null as unknown as TimelineTrack,
					buildVideoTrack({ elements: [validElement({ id: "el-valid" })] }),
				],
			}),
		});

		expect(project.scenes[0]?.tracks).toHaveLength(1);
		expect(project.scenes[0]?.tracks[0]?.elements[0]?.id).toBe("el-valid");
	});

	it("drops a track missing an `id`", () => {
		const idlessTrack = {
			name: "No id",
			type: "video",
			elements: [],
			isMain: false,
			muted: false,
			hidden: false,
		} as unknown as TimelineTrack;

		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [
					idlessTrack,
					buildVideoTrack({ elements: [validElement({ id: "el-valid" })] }),
				],
			}),
		});

		expect(project.scenes[0]?.tracks).toHaveLength(1);
	});

	it("drops a video element with a missing `mediaId` — it can never render", () => {
		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [
					buildVideoTrack({
						elements: [
							{
								id: "el-no-media",
								name: "Orphan (no mediaId)",
								type: "video",
								startTime: 0,
								duration: 2,
								trimStart: 0,
								trimEnd: 0,
							},
							validElement({ id: "el-valid" }),
						],
					}),
				],
			}),
		});

		const elements = project.scenes[0]?.tracks[0]?.elements ?? [];
		expect(elements).toHaveLength(1);
		expect(elements[0]?.id).toBe("el-valid");
	});

	it("drops a video element with an empty-string `mediaId`", () => {
		const project = deserializeProject({
			serializedProject: buildSerializedProject({
				tracks: [
					buildVideoTrack({
						elements: [
							{
								id: "el-empty-media",
								name: "Orphan (empty mediaId)",
								type: "video",
								mediaId: "",
								startTime: 0,
								duration: 2,
								trimStart: 0,
								trimEnd: 0,
							},
						],
					}),
				],
			}),
		});

		expect(project.scenes[0]?.tracks[0]?.elements).toHaveLength(0);
	});

	it("does NOT drop a library audio element with no `mediaId` (it plays from `sourceUrl`)", () => {
		const audioTrack = {
			id: "track-audio",
			name: "Audio track",
			type: "audio",
			elements: [
				{
					id: "el-library",
					name: "Library sound",
					type: "audio",
					sourceType: "library",
					sourceUrl: "https://example.com/sound.mp3",
					startTime: 0,
					duration: 2,
					trimStart: 0,
					trimEnd: 0,
					volume: 1,
				},
			],
			muted: false,
			hidden: false,
		} as unknown as TimelineTrack;

		const project = deserializeProject({
			serializedProject: buildSerializedProject({ tracks: [audioTrack] }),
		});

		expect(project.scenes[0]?.tracks[0]?.elements).toHaveLength(1);
	});

	it("a fully valid project round-trips with identical shape (regression)", () => {
		const validTracks: TimelineTrack[] = [
			buildVideoTrack({
				elements: [validElement({ id: "el-1" }), validElement({ id: "el-2" })],
			}),
		];

		const serialized = buildSerializedProject({ tracks: validTracks });
		const project = deserializeProject({ serializedProject: serialized });

		expect(project.scenes[0]?.tracks).toHaveLength(1);
		expect(project.scenes[0]?.tracks[0]?.elements).toHaveLength(2);
		expect(project.scenes[0]?.tracks[0]?.elements.map((e) => e.id)).toEqual([
			"el-1",
			"el-2",
		]);
	});
});
