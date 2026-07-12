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
