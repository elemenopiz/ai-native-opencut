import type { TimelineTrack, VisualElement } from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { ColorNode } from "./nodes/color-node";
import { CompositeEffectNode } from "./nodes/composite-effect-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import { TransitionNode } from "./nodes/transition-node";
import type { BaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/types/project";
import { DEFAULT_BLUR_INTENSITY } from "@/constants/project-constants";
import { isMainTrack } from "@/lib/timeline";
import { TRANSITION_ADJACENCY_EPSILON } from "@/lib/transitions";

const PREVIEW_MAX_IMAGE_SIZE = 2048;
const BLUR_BACKGROUND_ZOOM_SCALE = 1.4;

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

function buildTrackNodes({
	tracks,
	mediaMap,
	canvasSize,
	isPreview,
	useProxy,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	useProxy?: boolean;
}): BaseNode[] {
	const nodes: BaseNode[] = [];

	for (const track of tracks) {
		const elements = getVisibleSortedElements({ track });

		for (const element of elements) {
			if (element.type === "effect") {
				nodes.push(
					new EffectLayerNode({
						effectType: element.effectType,
						effectParams: element.params,
						timeOffset: element.startTime,
						duration: element.duration,
					}),
				);
				continue;
			}

			if (element.type === "video" || element.type === "image") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset?.file || !mediaAsset?.url) {
					continue;
				}

				const shouldUseProxy =
					useProxy && isPreview && mediaAsset.proxyFile && mediaAsset.proxyUrl;

				const effectiveFile = shouldUseProxy
					? mediaAsset.proxyFile!
					: mediaAsset.file;
				const effectiveUrl = shouldUseProxy
					? mediaAsset.proxyUrl!
					: mediaAsset.url;

				if (mediaAsset.type === "video") {
					nodes.push(
						new VideoNode({
							mediaId: mediaAsset.id,
							url: effectiveUrl,
							file: effectiveFile,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							playbackRate:
								element.type === "video" ? element.playbackRate : undefined,
							reversed: element.type === "video" ? element.reversed : undefined,
							transform: element.transform,
							animations: element.animations,
							opacity: element.opacity,
							blendMode: element.blendMode,
							effects: element.effects,
							mask: element.mask,
						}),
					);
				}
				if (mediaAsset.type === "image") {
					nodes.push(
						new ImageNode({
							url: mediaAsset.url,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transform: element.transform,
							animations: element.animations,
							opacity: element.opacity,
							blendMode: element.blendMode,
							effects: element.effects,
							mask: element.mask,
							...(isPreview && {
								maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
							}),
						}),
					);
				}
			}

			if (element.type === "text") {
				nodes.push(
					new TextNode({
						...element,
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
						effects: element.effects,
					}),
				);
			}

			if (element.type === "sticker") {
				nodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: element.transform,
						animations: element.animations,
						opacity: element.opacity,
						blendMode: element.blendMode,
						effects: element.effects,
						mask: element.mask,
					}),
				);
			}
		}
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
	useProxy?: boolean;
};

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
	useProxy,
}: BuildSceneParams) {
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));

	const visibleTracks = tracks.filter(
		(track) => !("hidden" in track && track.hidden),
	);

	const orderedTracksTopToBottom = [
		...visibleTracks.filter((track) => !isMainTrack(track)),
		...visibleTracks.filter((track) => isMainTrack(track)),
	];

	const orderedTracksBottomToTop = orderedTracksTopToBottom.slice().reverse();

	// Interleave each track's transition nodes right after that track's element
	// nodes: a transition repaints its own track's footage full-frame, so it
	// must sit below higher tracks (text/sticker overlays) in paint order or
	// overlays vanish for the duration of every transition.
	const allNodes: BaseNode[] = [];
	for (const track of orderedTracksBottomToTop) {
		allNodes.push(
			...buildTrackNodes({
				tracks: [track],
				mediaMap,
				canvasSize,
				isPreview,
				useProxy,
			}),
		);
		allNodes.push(...buildTransitionNodes({ tracks: [track], mediaMap }));
	}

	for (const backgroundNode of buildBackgroundNodes({
		background,
		allNodes,
	})) {
		rootNode.add(backgroundNode);
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	return rootNode;
}

function buildBackgroundNodes({
	background,
	allNodes,
}: {
	background: TBackground;
	allNodes: BaseNode[];
}): BaseNode[] {
	const nodes: BaseNode[] = [];

	if (background.type === "blur") {
		nodes.push(
			new CompositeEffectNode({
				// Transitions are excluded from the blur-fill composite: they repaint
				// full-frame (heavy) and the underlying clips already feed the blur.
				contentNodes: allNodes.filter(
					(node) =>
						!(node instanceof EffectLayerNode) &&
						!(node instanceof TransitionNode),
				),
				effectType: "blur",
				effectParams: {
					intensity: background.blurIntensity ?? DEFAULT_BLUR_INTENSITY,
				},
				scale: BLUR_BACKGROUND_ZOOM_SCALE,
				// Blur-fill must reach the canvas edges even when the footage only
				// occupies a band of the canvas (16:9 clips on a 9:16 canvas).
				coverCanvas: true,
			}),
		);
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		nodes.push(new ColorNode({ color: background.color }));
	}

	return nodes;
}

function buildTransitionNodes({
	tracks,
	mediaMap,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
}): TransitionNode[] {
	const transitionNodes: TransitionNode[] = [];

	for (const track of tracks) {
		if (track.type === "effect") continue;

		const elements = track.elements
			.filter((el) => !("hidden" in el && el.hidden))
			.slice()
			.sort((a, b) => a.startTime - b.startTime);

		for (let i = 0; i < elements.length - 1; i++) {
			const current = elements[i] as VisualElement;
			const next = elements[i + 1] as VisualElement;

			if (!current.transitionOut) continue;

			// A transition blends across the cut — it only makes sense when the
			// next clip actually starts at this clip's end. A gap would blend
			// into footage that isn't playing yet; render a plain cut instead.
			const gap = next.startTime - (current.startTime + current.duration);
			if (gap > TRANSITION_ADJACENCY_EPSILON) continue;

			if (current.type === "video" || current.type === "image") {
				const asset = mediaMap.get(current.mediaId);
				if (!asset) continue;

				const nextAsset =
					next.type === "video" || next.type === "image"
						? mediaMap.get(next.mediaId)
						: null;

				// Without a resolvable incoming source the node could never draw a
				// frame — skip instead of building a guaranteed no-op.
				if (!nextAsset) continue;

				transitionNodes.push(
					new TransitionNode({
						transitionType: current.transitionOut.type,
						transitionDuration: current.transitionOut.duration,
						cutTime: current.startTime + current.duration,
						sourceA: {
							duration: current.duration,
							timeOffset: current.startTime,
							trimStart: current.trimStart,
							trimEnd: current.trimEnd,
							playbackRate:
								current.type === "video" ? current.playbackRate : undefined,
							reversed: current.type === "video" ? current.reversed : undefined,
							transform: current.transform,
							animations: current.animations,
							opacity: current.opacity,
							blendMode: current.blendMode,
							effects: current.effects,
						},
						sourceB: {
							duration: next.duration,
							timeOffset: next.startTime,
							trimStart: next.trimStart,
							trimEnd: next.trimEnd,
							playbackRate:
								next.type === "video" ? next.playbackRate : undefined,
							reversed: next.type === "video" ? next.reversed : undefined,
							transform: (next as VisualElement).transform,
							animations: (next as VisualElement).animations,
							opacity: (next as VisualElement).opacity,
							blendMode: (next as VisualElement).blendMode,
							effects: (next as VisualElement).effects,
						},
						mediaMap,
						mediaIdA: current.mediaId,
						mediaIdB:
							next.type === "video" || next.type === "image"
								? next.mediaId
								: undefined,
					}),
				);
			}
		}
	}

	return transitionNodes;
}
