import { describe, expect, it } from "bun:test";
import {
	deserializeProject,
	serializeProject,
} from "@/services/storage/service";
import type { TProject, TProjectSettings } from "@/types/project";
import type { ShapeElement, ShapeTrack, TimelineTrack } from "@/types/timeline";

/**
 * ShapeElement is a first-class timeline element (see types/timeline.ts) with
 * no media asset behind it — like a sticker, it must round-trip through
 * `serializeProject`/`deserializeProject` (the pure mapping `saveProject`/
 * `loadProject` wrap) byte-for-byte, and survive `deserializeProject`'s
 * heal-on-load pass (`isPlausibleTrack`/`isPlausibleTimelineElement`/
 * `ensureVisualElementDefaults`) without being dropped or altered.
 */

function makeShapeElement(overrides: Partial<ShapeElement> = {}): ShapeElement {
	return {
		id: "shape-1",
		name: "Lower-third scrim",
		type: "shape",
		shapeKind: "rect",
		width: 1080,
		height: 320,
		cornerRadius: 0,
		fill: {
			type: "linear-gradient",
			angle: 180,
			stops: [
				{ offset: 0, color: "rgba(0,0,0,0)" },
				{ offset: 1, color: "rgba(0,0,0,0.75)" },
			],
		},
		stroke: { color: "#ffffff", width: 2 },
		duration: 5,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: { position: { x: 0, y: 400 }, scale: 1, rotate: 0 },
		opacity: 1,
		blendMode: "normal",
		hidden: false,
		...overrides,
	};
}

function makeShapeTrack(elements: ShapeElement[]): ShapeTrack {
	return {
		id: "track-shape",
		name: "Shape track",
		type: "shape",
		elements,
		hidden: false,
	};
}

function makeProject({ tracks }: { tracks: TimelineTrack[] }): TProject {
	const now = new Date("2026-01-01T00:00:00.000Z");
	return {
		metadata: {
			id: "project-1",
			name: "Project",
			thumbnail: "",
			duration: 5,
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
		settings: {} as TProjectSettings,
		version: 10,
	};
}

describe("ShapeElement — serializeProject / deserializeProject round trip", () => {
	it("preserves every shape-specific field through a full serialize→deserialize cycle", () => {
		const shape = makeShapeElement();
		const project = makeProject({ tracks: [makeShapeTrack([shape])] });

		const serialized = serializeProject({ project });
		const restored = deserializeProject({ serializedProject: serialized });

		const restoredTrack = restored.scenes[0].tracks[0] as ShapeTrack;
		expect(restoredTrack.type).toBe("shape");
		expect(restoredTrack.elements).toHaveLength(1);

		const restoredShape = restoredTrack.elements[0];
		expect(restoredShape).toEqual(shape);
	});

	it("keeps a shape track/element intact after the load-time heal pass (not dropped as unrecognized)", () => {
		const shape = makeShapeElement({ id: "shape-2", shapeKind: "ellipse" });
		const project = makeProject({ tracks: [makeShapeTrack([shape])] });
		const serialized = serializeProject({ project });

		const restored = deserializeProject({ serializedProject: serialized });

		expect(restored.scenes[0].tracks).toHaveLength(1);
		expect(restored.scenes[0].tracks[0].elements).toHaveLength(1);
	});

	it("heals a shape element persisted without transform/opacity/blendMode (same seam as other visual elements)", () => {
		const bareShape = {
			id: "shape-3",
			name: "Bare shape",
			type: "shape",
			shapeKind: "rect",
			width: 100,
			height: 100,
			fill: { type: "solid", color: "#fff" },
			duration: 2,
			startTime: 0,
			trimStart: 0,
			trimEnd: 0,
			// no transform, opacity, or blendMode
		};
		const project = makeProject({
			tracks: [makeShapeTrack([bareShape as unknown as ShapeElement])],
		});
		const serialized = serializeProject({ project });

		const restored = deserializeProject({ serializedProject: serialized });
		const restoredShape = restored.scenes[0].tracks[0]
			.elements[0] as ShapeElement;

		expect(restoredShape.transform).toEqual({
			position: { x: 0, y: 0 },
			scale: 1,
			rotate: 0,
		});
		expect(restoredShape.opacity).toBe(1);
		expect(restoredShape.blendMode).toBe("normal");
	});
});
