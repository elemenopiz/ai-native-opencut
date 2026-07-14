import { describe, expect, test } from "bun:test";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type { MediaAsset } from "@/types/assets";
import type { TCanvasSize } from "@/types/project";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import { buildScene } from "./scene-builder";
import { VideoNode } from "./nodes/video-node";

/**
 * Export-time cross-browser decode fallback: `buildTrackNodes` substitutes a
 * media asset's proxy for its original when the caller marks that asset's id
 * in `forceProxyAssetIds` — precomputed by `resolveExportProxyFallback`
 * (`export-decodability.ts`) via an independent, export-time `VideoDecoder`
 * check. This must stay additive: untouched (preview, or export with no
 * forced ids) behavior is byte-identical to before this fallback existed.
 */

const CANVAS_SIZE: TCanvasSize = { width: 1280, height: 720 };

function makeVideoElement(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "el-1",
		name: "Clip",
		type: "video",
		mediaId: "asset-1",
		duration: 5,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		...overrides,
	};
}

function makeTrack(elements: VideoElement[]): TimelineTrack {
	return {
		id: "track-1",
		name: "Video",
		type: "video",
		isMain: true,
		muted: false,
		hidden: false,
		elements,
	} as TimelineTrack;
}

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "asset-1",
		name: "clip.mov",
		type: "video",
		file: new File([], "clip-original.mov"),
		url: "blob://original",
		proxyFile: new File([], "clip-proxy.mp4"),
		proxyUrl: "blob://proxy",
		...overrides,
	} as MediaAsset;
}

function firstVideoNode(root: ReturnType<typeof buildScene>): VideoNode {
	const node = root.children.find((child) => child instanceof VideoNode);
	if (!node) throw new Error("Expected a VideoNode in the built scene");
	return node as VideoNode;
}

describe("buildScene — export-time proxy fallback (forceProxyAssetIds)", () => {
	test("export, no forceProxyAssetIds: resolves the ORIGINAL file (unchanged pre-existing behavior)", () => {
		const root = buildScene({
			canvasSize: CANVAS_SIZE,
			tracks: [makeTrack([makeVideoElement()])],
			mediaAssets: [makeAsset()],
			duration: 5,
			background: { type: "color", color: "transparent" },
			isPreview: false,
		});

		const node = firstVideoNode(root);
		expect(node.params.file.name).toBe("clip-original.mov");
		expect(node.params.url).toBe("blob://original");
	});

	test("export with the asset id in forceProxyAssetIds: substitutes the proxy", () => {
		const root = buildScene({
			canvasSize: CANVAS_SIZE,
			tracks: [makeTrack([makeVideoElement()])],
			mediaAssets: [makeAsset()],
			duration: 5,
			background: { type: "color", color: "transparent" },
			isPreview: false,
			forceProxyAssetIds: new Set(["asset-1"]),
		});

		const node = firstVideoNode(root);
		expect(node.params.file.name).toBe("clip-proxy.mp4");
		expect(node.params.url).toBe("blob://proxy");
	});

	test("forceProxyAssetIds is ignored when the asset has no proxy (nothing to substitute)", () => {
		const root = buildScene({
			canvasSize: CANVAS_SIZE,
			tracks: [makeTrack([makeVideoElement()])],
			mediaAssets: [makeAsset({ proxyFile: undefined, proxyUrl: undefined })],
			duration: 5,
			background: { type: "color", color: "transparent" },
			isPreview: false,
			forceProxyAssetIds: new Set(["asset-1"]),
		});

		const node = firstVideoNode(root);
		expect(node.params.file.name).toBe("clip-original.mov");
	});

	test("preview scenes ignore forceProxyAssetIds entirely (export-only fallback)", () => {
		const root = buildScene({
			canvasSize: CANVAS_SIZE,
			tracks: [makeTrack([makeVideoElement()])],
			mediaAssets: [makeAsset()],
			duration: 5,
			background: { type: "color", color: "transparent" },
			isPreview: true,
			// Even if a caller mistakenly passed this for a preview scene, preview
			// substitution stays gated on `useProxy && isPreview` alone.
			forceProxyAssetIds: new Set(["asset-1"]),
		});

		const node = firstVideoNode(root);
		expect(node.params.file.name).toBe("clip-original.mov");
	});

	test("preview scenes keep their pre-existing useProxy-gated substitution untouched", () => {
		const root = buildScene({
			canvasSize: CANVAS_SIZE,
			tracks: [makeTrack([makeVideoElement()])],
			mediaAssets: [makeAsset()],
			duration: 5,
			background: { type: "color", color: "transparent" },
			isPreview: true,
			useProxy: true,
		});

		const node = firstVideoNode(root);
		expect(node.params.file.name).toBe("clip-proxy.mp4");
	});
});
