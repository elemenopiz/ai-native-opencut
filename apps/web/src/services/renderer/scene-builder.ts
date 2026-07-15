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
/**
 * Preview video decodes are capped at the project canvas's long edge, but
 * never below this. The canvas-long-edge part guarantees paused full-res
 * preview frames stay pixel-exact for contain-fit clips (the preview renders
 * at native canvas size while paused); the floor keeps headroom for clips
 * scaled up past 1× on small canvases.
 */
const PREVIEW_MIN_DECODE_CAP = 1920;

/**
 * Export/snapshot scenes render at a fixed output canvas size (no user
 * pan/zoom of an editing viewport, unlike preview) — so decode can be capped
 * exactly at the canvas's long edge with zero quality loss for elements drawn
 * 1:1 (contain-fit, no zoom). `elementSamplesAboveOutputDensity` is the
 * correctness gate: any element whose effective on-screen magnification could
 * exceed that 1:1 mapping falls back to the uncapped "full" decode tier
 * instead, per opportunity #2's "full-res fallback" requirement. When in
 * doubt this returns true (decode full) — see the caveats on crop and easing
 * overshoot below.
 */
function elementSamplesAboveOutputDensity({
	element,
}: {
	element: VisualElement;
}): boolean {
	// Base zoom above 1x upscales the decoded frame at paint time; decoding at
	// the (lower) output cap would bake in that upscale as a soft image.
	if (element.transform.scale > 1) return true;

	// A `transform.scale` keyframe animates zoom over the clip's life; any
	// keyframe value above 1x means some portion of the clip needs full res.
	// Caveat: this does not account for cubic-bezier easing overshoot beyond
	// the keyframe values themselves (a curve can transiently exceed its
	// endpoints) — an accepted, narrow gap per "when in doubt, decode full"
	// erring the other way would require resolving the full easing curve.
	const scaleChannel = element.animations?.channels["transform.scale"];
	if (scaleChannel?.valueKind === "number") {
		for (const keyframe of scaleChannel.keyframes) {
			if (keyframe.value > 1) return true;
		}
	}

	// `crop` is modeled on the timeline element but not yet consumed by the
	// canvas render pipeline (video-node/visual-node never read it) — so it
	// can't currently push sampling density above the output today. Still
	// treated as a fallback trigger defensively: a non-zero crop signals
	// tighter effective framing than the full source frame, and this keeps
	// the export tier honest if/when crop rendering lands.
	const crop = element.crop;
	if (crop && (crop.top || crop.right || crop.bottom || crop.left)) {
		return true;
	}

	return false;
}

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

/**
 * Preview-only guard against upscaling a proxy: the long edge (in device
 * pixels) of the canvas the proxy would actually be painted into. When this
 * exceeds the proxy's own long edge, decoding the proxy would hand the
 * compositor fewer source pixels than the destination needs — an upscale
 * baked in on top of the proxy's own downscale, doubly soft. Undefined means
 * "unknown, don't second-guess useProxy" (e.g. non-preview scenes, or callers
 * that haven't wired the backing-store size through yet).
 */
function proxyWouldBeUpscaled({
	mediaAsset,
	previewBackingStoreLongEdge,
}: {
	mediaAsset: MediaAsset;
	previewBackingStoreLongEdge?: number;
}): boolean {
	if (previewBackingStoreLongEdge === undefined) return false;
	if (!mediaAsset.proxy) return false;
	const proxyLongEdge = Math.max(
		mediaAsset.proxy.width,
		mediaAsset.proxy.height,
	);
	return previewBackingStoreLongEdge > proxyLongEdge;
}

function buildTrackNodes({
	tracks,
	mediaMap,
	canvasSize,
	isPreview,
	useProxy,
	forceProxyAssetIds,
	previewBackingStoreLongEdge,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	useProxy?: boolean;
	/**
	 * Export-only cross-browser decode fallback: ids of media assets whose
	 * original this browser can't decode but that have a portable H.264 proxy
	 * ready (see `resolveExportProxyFallback` in `export-decodability.ts`).
	 * Precomputed by the caller — never consulted for preview (`isPreview`)
	 * scenes — so this stays a synchronous, additive branch: undefined/empty
	 * means byte-identical behavior to before this fallback existed.
	 */
	forceProxyAssetIds?: Set<string>;
	/**
	 * Preview-only: the long edge (device pixels) of the canvas backing store
	 * the scene will actually be painted into right now (accounts for zoom,
	 * display size, devicePixelRatio, and playback-quality scaling — see
	 * `getPlaybackRenderScale`). When a per-element proxy would be upscaled to
	 * fill that backing store, this scene decodes the original instead — never
	 * display upscaled proxy pixels. Cheap, per-element arithmetic; see
	 * `proxyWouldBeUpscaled`.
	 */
	previewBackingStoreLongEdge?: number;
}): BaseNode[] {
	const nodes: BaseNode[] = [];

	const previewDecodeMaxSize = isPreview
		? Math.max(PREVIEW_MIN_DECODE_CAP, canvasSize.width, canvasSize.height)
		: undefined;

	// Export and snapshot scenes render at a fixed output canvas size, so
	// decode can be capped at its long edge — per-element, since a zoomed
	// element still needs the uncapped "full" tier (see
	// elementSamplesAboveOutputDensity). Undefined for preview scenes, which
	// use previewDecodeMaxSize above instead.
	const exportDecodeMaxSize = isPreview
		? undefined
		: Math.max(canvasSize.width, canvasSize.height);

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
					(useProxy &&
						isPreview &&
						mediaAsset.proxyFile &&
						mediaAsset.proxyUrl &&
						!proxyWouldBeUpscaled({
							mediaAsset,
							previewBackingStoreLongEdge,
						})) ||
					(!isPreview &&
						forceProxyAssetIds?.has(mediaAsset.id) &&
						mediaAsset.proxyFile &&
						mediaAsset.proxyUrl);

				const effectiveFile = shouldUseProxy
					? mediaAsset.proxyFile!
					: mediaAsset.file;
				const effectiveUrl = shouldUseProxy
					? mediaAsset.proxyUrl!
					: mediaAsset.url;

				if (mediaAsset.type === "video") {
					// A capped export decode would upscale (soften) elements whose
					// effective on-screen sampling exceeds the output canvas density
					// (zoom > 1x, etc.) — those fall back to the full-res tier.
					const needsFullResExport =
						exportDecodeMaxSize !== undefined &&
						elementSamplesAboveOutputDensity({ element });
					nodes.push(
						new VideoNode({
							mediaId: mediaAsset.id,
							url: effectiveUrl,
							file: effectiveFile,
							previewDecodeMaxSize,
							exportDecodeMaxSize: needsFullResExport
								? undefined
								: exportDecodeMaxSize,
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
	/**
	 * Export-only cross-browser decode fallback — see `buildTrackNodes`. Ignored
	 * for preview scenes. Callers precompute this via `resolveExportProxyFallback`
	 * (`export-decodability.ts`) before calling `buildScene`, since resolving it
	 * requires an async `VideoDecoder.isConfigSupported` check that `buildScene`
	 * itself stays free of.
	 */
	forceProxyAssetIds?: Set<string>;
	/**
	 * Preview-only: see `buildTrackNodes`'s param of the same name. Omitted (or
	 * for non-preview scenes) preserves prior behavior — proxy use is decided
	 * purely by `useProxy` + asset availability, with no upscale guard.
	 */
	previewBackingStoreLongEdge?: number;
};

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
	useProxy,
	forceProxyAssetIds,
	previewBackingStoreLongEdge,
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
				forceProxyAssetIds,
				previewBackingStoreLongEdge,
			}),
		);
		allNodes.push(
			...buildTransitionNodes({
				tracks: [track],
				mediaMap,
				// Export scenes: transitions must read from the SAME capped export
				// sink their clips' VideoNodes use — a second full-res decoder per
				// media measurably regressed export. Preview scenes pass undefined
				// (transitions keep their existing full-tier decode there).
				exportDecodeMaxSize: isPreview
					? undefined
					: Math.max(canvasSize.width, canvasSize.height),
			}),
		);
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
	exportDecodeMaxSize,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
	/** Export scenes only — see the buildScene call site. */
	exportDecodeMaxSize?: number;
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
							// Same per-element full-res fallback as the clip's VideoNode,
							// so both read the same sink tier.
							exportDecodeMaxSize:
								exportDecodeMaxSize !== undefined &&
								!elementSamplesAboveOutputDensity({ element: current })
									? exportDecodeMaxSize
									: undefined,
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
							exportDecodeMaxSize:
								exportDecodeMaxSize !== undefined &&
								!elementSamplesAboveOutputDensity({ element: next })
									? exportDecodeMaxSize
									: undefined,
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
