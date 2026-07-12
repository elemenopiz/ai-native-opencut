import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { LAST_FRAME_EPSILON_S, type FullFrame } from "@/lib/media/last-frame";
import {
	buildDerivedFrom,
	extractAndAddFrame,
	firstFrameSourceTime,
	frameAssetName,
	isPlayheadWithinElement,
	lastFrameSourceTime,
	playheadSourceTime,
	resolveVideoDurationSec,
} from "@/lib/media/frame-extraction";

// A clip placed at timeline 10s, showing source [2s, 7s] (trimStart 2, 5s visible).
const EL = { startTime: 10, duration: 5, trimStart: 2 };

describe("frame source-time math (respecting trim)", () => {
	it("first frame is the trimStart", () => {
		expect(firstFrameSourceTime(EL)).toBe(2);
	});

	it("last frame is trimStart + visibleDuration - epsilon", () => {
		expect(lastFrameSourceTime(EL)).toBeCloseTo(7 - LAST_FRAME_EPSILON_S, 10);
	});

	it("last frame never precedes the first frame on a tiny clip", () => {
		const tiny = { startTime: 0, duration: 0.01, trimStart: 3 };
		expect(lastFrameSourceTime(tiny)).toBe(firstFrameSourceTime(tiny));
	});

	it("playhead maps timeline time back through placement + trim", () => {
		// Playhead at timeline 12s → 2s into the visible span → source 4s.
		expect(playheadSourceTime(EL, 12)).toBe(4);
	});

	it("playhead source time is clamped to the visible source span", () => {
		expect(playheadSourceTime(EL, 100)).toBe(7); // trimStart + duration
		expect(playheadSourceTime(EL, 0)).toBe(2); // not below trimStart
	});

	it("knows when the playhead is over the element", () => {
		expect(isPlayheadWithinElement(EL, 10)).toBe(true);
		expect(isPlayheadWithinElement(EL, 15)).toBe(true);
		expect(isPlayheadWithinElement(EL, 9.9)).toBe(false);
		expect(isPlayheadWithinElement(EL, 15.1)).toBe(false);
	});
});

describe("resolveVideoDurationSec", () => {
	it("returns a valid known duration without touching the source", async () => {
		// No file/url at all — a probe attempt would resolve undefined, so a
		// 6 result proves the known-duration short-circuit.
		expect(await resolveVideoDurationSec({}, 6)).toBe(6);
	});

	it("treats missing/zero/NaN known durations as unknown (probes; undefined without a source)", async () => {
		expect(await resolveVideoDurationSec({}, undefined)).toBeUndefined();
		expect(await resolveVideoDurationSec({}, 0)).toBeUndefined();
		expect(await resolveVideoDurationSec({}, Number.NaN)).toBeUndefined();
	});
});

describe("frame naming + provenance", () => {
	it("names first/last extracts by label and strips the source extension", () => {
		expect(frameAssetName("beach.mp4", "first frame", 2)).toBe(
			"beach — first frame",
		);
		expect(frameAssetName("beach.mp4", "last frame", 6.95)).toBe(
			"beach — last frame",
		);
	});

	it("names generic-frame extracts with the source timestamp", () => {
		expect(frameAssetName("beach.mp4", "frame", 4.24)).toBe(
			"beach — frame @ 4.2s",
		);
	});

	it("stamps machine-readable provenance pinned to the SOURCE time", () => {
		expect(buildDerivedFrom("asset_1", 6.95, "last frame")).toEqual({
			assetId: "asset_1",
			sourceTimeSec: 6.95,
			label: "last frame",
		});
	});
});

describe("extractAndAddFrame", () => {
	const FRAME: FullFrame = {
		// 1x1 transparent PNG.
		dataUrl:
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
		width: 1920,
		height: 1080,
	};

	function makeEditor() {
		const added: { projectId: string; asset: Record<string, unknown> }[] = [];
		const editor = {
			media: {
				addMediaAsset: async (input: {
					projectId: string;
					asset: Record<string, unknown>;
				}) => {
					added.push(input);
					return "frame_media_1";
				},
			},
		} as unknown as EditorCore;
		return { editor, added };
	}

	it("adds a full-res image asset with name, dimensions, and provenance", async () => {
		const { editor, added } = makeEditor();
		const result = await extractAndAddFrame({
			editor,
			projectId: "proj_1",
			source: { videoUrl: "blob:x" },
			sourceAssetId: "src_video_1",
			sourceName: "shot.mp4",
			timeSec: 6.95,
			label: "last frame",
			decode: async () => FRAME,
		});

		expect(result.mediaId).toBe("frame_media_1");
		expect(result.dataUrl).toBe(FRAME.dataUrl);

		expect(added).toHaveLength(1);
		const asset = added[0].asset;
		expect(added[0].projectId).toBe("proj_1");
		expect(asset.type).toBe("image");
		expect(asset.name).toBe("shot — last frame");
		expect(asset.width).toBe(1920);
		expect(asset.height).toBe(1080);
		expect(asset.derivedFrom).toEqual({
			assetId: "src_video_1",
			sourceTimeSec: 6.95,
			label: "last frame",
		});
		// The stored file is a real PNG File materialized from the data URL.
		expect((asset.file as File).type).toBe("image/png");
		expect((asset.file as File).size).toBeGreaterThan(0);
	});

	it("throws a human-readable error when the frame can't be decoded", async () => {
		const { editor, added } = makeEditor();
		await expect(
			extractAndAddFrame({
				editor,
				projectId: "proj_1",
				source: { videoUrl: "blob:x" },
				sourceAssetId: "src_video_1",
				sourceName: "shot.mp4",
				timeSec: 0,
				label: "first frame",
				decode: async () => undefined,
			}),
		).rejects.toThrow(/decode/i);
		expect(added).toHaveLength(0);
	});
});
