"use client";

import { useEditor } from "@/hooks/use-editor";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import AudioWaveform from "./audio-waveform";
import {
	GenerativeSlotContent,
	SlotTakesBadge,
} from "./generative-slot-content";
import { useTimelineElementResize } from "@/hooks/timeline/element/use-element-resize";
import {
	useKeyframeDrag,
	type KeyframeDragState,
} from "@/hooks/timeline/element/use-keyframe-drag";
import { useKeyframeSelection } from "@/hooks/timeline/element/use-keyframe-selection";
import type { SnapPoint } from "@/lib/timeline/snap-utils";
import { getElementKeyframes } from "@/lib/animation";
import {
	getTrackClasses,
	getTrackHeight,
	canElementHaveAudio,
	canElementBeHidden,
	hasMediaId,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/lib/timeline";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type {
	TimelineElement as TimelineElementType,
	TimelineTrack,
	VisualElement,
	ElementDragState,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { mediaSupportsAudio } from "@/lib/media/media-utils";
import {
	canToggleSourceAudio,
	getSourceAudioActionLabel,
} from "@/lib/timeline/audio-separation";
import { getActionDefinition, type TAction, invokeAction } from "@/lib/actions";
import {
	getTransition,
	hasTransition,
	TRANSITION_ADJACENCY_EPSILON,
} from "@/lib/transitions";
import { RemoveTransitionCommand } from "@/lib/commands/timeline/element/transitions/add-transition";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { resolveStickerId } from "@/lib/stickers";
import Image from "next/image";
import {
	ScissorIcon,
	Delete02Icon,
	Copy01Icon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeHighIcon,
	VolumeOffIcon,
	VolumeMute02Icon,
	Search01Icon,
	Exchange01Icon,
	KeyframeIcon,
	MagicWand05Icon,
	Unlink04Icon,
	ImageCropIcon,
	SentIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { uppercase } from "@/utils/string";
import type { ComponentProps, ReactNode } from "react";
import type { SelectedKeyframeRef, ElementKeyframe } from "@/types/animation";
import { cn } from "@/utils/ui";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePropertiesStore } from "@/stores/properties-store";
import { useTimelineStore } from "@/stores/timeline-store";
import { useFrameChainStore } from "@/stores/frame-chain-store";
import { toast } from "sonner";
import {
	extractAndAddFrame,
	firstFrameSourceTime,
	lastFrameSourceTime,
	playheadSourceTime,
	isPlayheadWithinElement,
	type FrameDecodeSource,
} from "@/lib/media/frame-extraction";
import type { DerivedFrameLabel } from "@/services/storage/types";
import { dataUrlToFile } from "@/lib/media/data-url";
import { uploadReferenceFile } from "@/lib/studio/reference-upload";
import {
	extractTrimmedVideoRaw,
	extractTrimmedVideoComposited,
	type ExtractedClip,
} from "@/lib/media/clip-reference";
import { useOmniReferenceChainStore } from "@/stores/omni-reference-chain-store";
import type { TProjectSettings } from "@/types/project";
import { RemoveSilenceDialog } from "./remove-silence-dialog";

const KEYFRAME_INDICATOR_MIN_WIDTH_PX = 40;
const ELEMENT_RING_WIDTH_PX = 1.5;

/** The classic NLE bowtie mark for a cut transition. */
function TransitionGlyph({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 12 12"
			className={className}
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M1 2.5 L5.3 6 L1 9.5 Z M11 2.5 L6.7 6 L11 9.5 Z" />
		</svg>
	);
}

/**
 * Resolve an element's outgoing transition for display: its definition (null
 * if the registered type vanished) and whether it will actually render —
 * transitions need an adjacent video/image clip right after the cut.
 */
function getTransitionOutInfo({
	element,
	track,
}: {
	element: TimelineElementType;
	track: TimelineTrack;
}) {
	if (!("transitionOut" in element) || !element.transitionOut) return null;
	const transitionOut = element.transitionOut;
	const definition = hasTransition({ transitionType: transitionOut.type })
		? getTransition({ transitionType: transitionOut.type })
		: null;

	const sorted = track.elements
		.filter((el) => !("hidden" in el && el.hidden))
		.slice()
		.sort((a, b) => a.startTime - b.startTime);
	const index = sorted.findIndex((el) => el.id === element.id);
	const next = index >= 0 ? sorted[index + 1] : undefined;
	const cutTime = element.startTime + element.duration;

	const isActive = Boolean(
		definition &&
			(element.type === "video" || element.type === "image") &&
			next &&
			(next.type === "video" || next.type === "image") &&
			next.startTime - cutTime <= TRANSITION_ADJACENCY_EPSILON,
	);

	return { transitionOut, definition, isActive };
}

interface KeyframeIndicator {
	time: number;
	offsetPx: number;
	keyframes: SelectedKeyframeRef[];
}

export function buildKeyframeIndicator({
	keyframe,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
}: {
	keyframe: ElementKeyframe;
	trackId: string;
	elementId: string;
	displayedStartTime: number;
	zoomLevel: number;
	elementLeft: number;
}): {
	time: number;
	offsetPx: number;
	keyframeRef: SelectedKeyframeRef;
} {
	const keyframeRef = {
		trackId,
		elementId,
		propertyPath: keyframe.propertyPath,
		keyframeId: keyframe.id,
	};
	const keyframeLeft = timelineTimeToSnappedPixels({
		time: displayedStartTime + keyframe.time,
		zoomLevel,
	});
	return {
		time: keyframe.time,
		offsetPx: keyframeLeft - elementLeft,
		keyframeRef,
	};
}

export function getKeyframeIndicators({
	keyframes,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
	elementWidth,
}: {
	keyframes: ElementKeyframe[];
	trackId: string;
	elementId: string;
	displayedStartTime: number;
	zoomLevel: number;
	elementLeft: number;
	elementWidth: number;
}): KeyframeIndicator[] {
	if (elementWidth < KEYFRAME_INDICATOR_MIN_WIDTH_PX) {
		return [];
	}

	const keyframesByTime = new Map<number, KeyframeIndicator>();
	for (const keyframe of keyframes) {
		const indicator = buildKeyframeIndicator({
			keyframe,
			trackId,
			elementId,
			displayedStartTime,
			zoomLevel,
			elementLeft,
		});
		const existingIndicator = keyframesByTime.get(indicator.time);
		if (!existingIndicator) {
			keyframesByTime.set(indicator.time, {
				time: indicator.time,
				offsetPx: indicator.offsetPx,
				keyframes: [indicator.keyframeRef],
			});
			continue;
		}

		existingIndicator.keyframes.push(indicator.keyframeRef);
	}

	return [...keyframesByTime.values()].sort((a, b) => a.time - b.time);
}

export function getDisplayShortcut({ action }: { action: TAction }) {
	const { defaultShortcuts } = getActionDefinition({ action });
	if (!defaultShortcuts?.length) {
		return "";
	}

	return uppercase({
		string: defaultShortcuts[0].replace("+", " "),
	});
}

interface TimelineElementProps {
	element: TimelineElementType;
	track: TimelineTrack;
	zoomLevel: number;
	isSelected: boolean;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
	onResizeStateChange?: (params: { isResizing: boolean }) => void;
	onElementMouseDown: (
		event: React.MouseEvent,
		element: TimelineElementType,
	) => void;
	onElementClick: (
		event: React.MouseEvent,
		element: TimelineElementType,
	) => void;
	dragState: ElementDragState;
	isDropTarget?: boolean;
}

export function TimelineElement({
	element,
	track,
	zoomLevel,
	isSelected,
	onSnapPointChange,
	onResizeStateChange,
	onElementMouseDown,
	onElementClick,
	dragState,
	isDropTarget = false,
}: TimelineElementProps) {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const { selectedKeyframes } = useKeyframeSelection();
	const { requestRevealMedia } = useAssetsPanelStore();
	const hasCopiedKeyframes = useTimelineStore((state) =>
		Boolean(state.keyframeClipboard?.items.length),
	);

	let mediaAsset: MediaAsset | null = null;

	if (hasMediaId(element)) {
		mediaAsset =
			editor.media.getAssets().find((asset) => asset.id === element.mediaId) ??
			null;
	}

	const hasAudio = mediaSupportsAudio({ media: mediaAsset });

	// Auto-cut (silence removal): offered on a single-selected clip whose media
	// carries an audio track and has a decodable File. Opens a small analyze →
	// apply dialog (see remove-silence-dialog.tsx).
	const [showRemoveSilence, setShowRemoveSilence] = useState(false);
	const canRemoveSilence =
		selectedElements.length === 1 &&
		canElementHaveAudio(element) &&
		hasAudio &&
		!!mediaAsset?.file;

	const { handleResizeStart, isResizing, currentStartTime, currentDuration } =
		useTimelineElementResize({
			element,
			track,
			zoomLevel,
			onSnapPointChange,
			onResizeStateChange,
		});

	const isCurrentElementSelected = selectedElements.some(
		(selected) =>
			selected.elementId === element.id && selected.trackId === track.id,
	);

	const isBeingDragged = dragState.elementId === element.id;
	const dragOffsetY =
		isBeingDragged && dragState.isDragging
			? dragState.currentMouseY - dragState.startMouseY
			: 0;
	const elementStartTime =
		isBeingDragged && dragState.isDragging
			? dragState.currentTime
			: element.startTime;
	const displayedStartTime = isResizing ? currentStartTime : elementStartTime;
	const displayedDuration = isResizing ? currentDuration : element.duration;
	const elementWidth = timelineTimeToPixels({
		time: displayedDuration,
		zoomLevel,
	});
	const elementLeft = timelineTimeToSnappedPixels({
		time: displayedStartTime,
		zoomLevel,
	});
	const keyframeIndicators = isSelected
		? getKeyframeIndicators({
				keyframes: getElementKeyframes({ animations: element.animations }),
				trackId: track.id,
				elementId: element.id,
				displayedStartTime,
				zoomLevel,
				elementLeft,
				elementWidth,
			})
		: [];

	const {
		keyframeDragState,
		handleKeyframeMouseDown,
		handleKeyframeClick,
		getVisualOffsetPx,
	} = useKeyframeDrag({ zoomLevel, element, displayedStartTime });
	const handleRevealInMedia = ({ event }: { event: React.MouseEvent }) => {
		event.stopPropagation();
		if (hasMediaId(element)) {
			requestRevealMedia(element.mediaId);
		}
	};

	// ── Extract frame ──────────────────────────────────────────────────────────
	// Grab a full-resolution still from this video clip and add it to the library
	// with provenance. Offered on single-selected VIDEO clips whose media is
	// resolved. "Frame at playhead" is enabled only while the playhead sits over
	// the clip (read live so a stale render doesn't offer an out-of-span grab).
	const setPendingFirstFrame = useFrameChainStore(
		(s) => s.setPendingFirstFrame,
	);
	const setPendingReference = useOmniReferenceChainStore(
		(s) => s.setPendingReference,
	);
	const canExtractFrame =
		element.type === "video" &&
		selectedElements.length === 1 &&
		!!mediaAsset &&
		(!!mediaAsset.file || !!mediaAsset.url);
	const playheadOverElement =
		canExtractFrame &&
		isPlayheadWithinElement(element, editor.playback.getCurrentTime());
	// A single-selected IMAGE clip with resolved media can go straight to the
	// Omni reference list — no trim re-encode, just upload the asset as-is.
	const canSendImageReference =
		element.type === "image" &&
		selectedElements.length === 1 &&
		!!mediaAsset &&
		(!!mediaAsset.file || !!mediaAsset.url);

	async function handleExtractFrame(kind: "first" | "last" | "playhead") {
		if (element.type !== "video" || !mediaAsset) return;
		let projectId: string;
		try {
			projectId = editor.project.getActive().metadata.id;
		} catch {
			toast.error("No active project to add the frame to.");
			return;
		}

		const label: DerivedFrameLabel =
			kind === "first"
				? "first frame"
				: kind === "last"
					? "last frame"
					: "frame";
		const timeSec =
			kind === "first"
				? firstFrameSourceTime(element)
				: kind === "last"
					? lastFrameSourceTime(element)
					: playheadSourceTime(element, editor.playback.getCurrentTime());

		if (
			kind === "playhead" &&
			!isPlayheadWithinElement(element, editor.playback.getCurrentTime())
		) {
			toast.error("Move the playhead over this clip first.");
			return;
		}

		const source: FrameDecodeSource = {
			videoFile: mediaAsset.file,
			videoUrl: mediaAsset.url,
			name: mediaAsset.name,
		};
		const toastId = toast.loading("Extracting frame…");
		try {
			const result = await extractAndAddFrame({
				editor,
				projectId,
				source,
				sourceAssetId: mediaAsset.id,
				sourceName: element.name || mediaAsset.name,
				timeSec,
				label,
			});
			const isFirst = kind === "first";
			toast.success(`Added "${result.name}" to your library.`, {
				id: toastId,
				action: {
					label: isFirst ? "Use in Generate" : "Use as next first frame",
					onClick: () => {
						void chainFrameToGenerate(result.dataUrl, result.name);
					},
				},
				// Secondary affordance: jump to the Media tab and flash-highlight the
				// new frame asset (reuses the "Reveal media" seam). No auto tab-switch
				// on extraction itself — the toast is the navigation hub.
				cancel: {
					label: "Reveal",
					onClick: () => requestRevealMedia(result.mediaId),
				},
			});
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't extract the frame.",
				{ id: toastId },
			);
		}
	}

	async function chainFrameToGenerate(dataUrl: string, name: string) {
		const uploadingId = toast.loading("Preparing frame for Generate…");
		try {
			const file = dataUrlToFile(dataUrl, name);
			const { url } = await uploadReferenceFile(file);
			setPendingFirstFrame({ url, label: name });
			// Neutral on purpose: whether the frame can seed the next
			// generation depends on the model selected IN the form (First/Last
			// support) — the form surfaces an inline warning when it can't.
			toast.success("Frame sent to Generate.", {
				id: uploadingId,
			});
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't prepare the frame.",
				{ id: uploadingId },
			);
		}
	}

	// ── Send to Omni Reference ─────────────────────────────────────────────────
	// Turn this timeline clip into a hosted reference for the next generation.
	// A VIDEO clip becomes a short motion clip — either a fast RAW cut of the
	// trimmed span, or a full COMPOSITED render that bakes in the timeline edits
	// (filters/speed/crop/transform/background). An IMAGE clip is uploaded as-is.
	// The hosted (R2) URL is parked in the omni-reference chain store; the right
	// panel jumps to Generate and appends it as a reference chip.
	async function handleSendClipToOmni(mode: "raw" | "composited") {
		if (element.type !== "video" || !mediaAsset) return;

		const base = element.name || mediaAsset.name;
		const label =
			mode === "composited" ? `${base} — clip (edited)` : `${base} — clip`;
		const toastId = toast.loading("Sending to Omni Reference…");
		try {
			let clip: ExtractedClip;
			if (mode === "composited") {
				// Bake the timeline edits in via a full compositor render, using the
				// active project's render settings. Mirrors handleExtractFrame's
				// "no active project" guard.
				let settings: TProjectSettings;
				try {
					settings = editor.project.getActive().settings;
				} catch {
					toast.error("No active project to render the clip from.", {
						id: toastId,
					});
					return;
				}
				clip = await extractTrimmedVideoComposited({
					element,
					mediaAssets: editor.media.getAssets(),
					canvasSize: settings.canvasSize,
					background: settings.background,
					fps: settings.fps,
					sourceName: base,
				});
			} else {
				clip = await extractTrimmedVideoRaw({
					element,
					source: {
						videoFile: mediaAsset.file,
						videoUrl: mediaAsset.url,
						name: mediaAsset.name,
					},
					sourceName: base,
				});
			}
			const { url } = await uploadReferenceFile(clip.file);
			setPendingReference({ url, kind: "video", label });
			toast.success("Sent to Omni Reference.", { id: toastId });
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't send the clip.",
				{ id: toastId },
			);
		}
	}

	async function handleSendImageToOmni() {
		if (element.type !== "image" || !mediaAsset) return;
		const label = element.name || mediaAsset.name;
		const toastId = toast.loading("Sending to Omni Reference…");
		try {
			const { url } = await uploadReferenceFile(mediaAsset.file);
			setPendingReference({ url, kind: "image", label });
			toast.success("Sent to Omni Reference.", { id: toastId });
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't send the image.",
				{ id: toastId },
			);
		}
	}

	const isMuted = canElementHaveAudio(element) && element.muted === true;

	const transitionInfo = getTransitionOutInfo({ element, track });
	const handleRemoveTransition = () => {
		editor.command.execute({
			command: new RemoveTransitionCommand({
				trackId: track.id,
				elementId: element.id,
			}),
		});
	};

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						data-testid="timeline-element"
						data-element-id={element.id}
						data-element-type={element.type}
						className="absolute top-0 h-full select-none"
						style={{
							left: `${elementLeft}px`,
							width: `${elementWidth}px`,
							transform:
								isBeingDragged && dragState.isDragging
									? `translate3d(0, ${dragOffsetY}px, 0)`
									: undefined,
						}}
					>
						<ElementInner
							element={element}
							track={track}
							isSelected={isSelected}
							onElementClick={onElementClick}
							onElementMouseDown={onElementMouseDown}
							handleResizeStart={handleResizeStart}
							isDropTarget={isDropTarget}
						/>
						{transitionInfo && (
							<button
								type="button"
								data-testid="transition-badge"
								className={cn(
									"absolute right-0 top-1/2 z-10 -translate-y-1/2 translate-x-1/2",
									"flex size-[18px] cursor-pointer items-center justify-center rounded-full",
									"border bg-background shadow-sm",
									transitionInfo.isActive
										? "border-foreground/40 text-foreground"
										: "border-amber-500/60 text-amber-500",
								)}
								title={
									transitionInfo.isActive
										? `${transitionInfo.definition?.name} transition · ${transitionInfo.transitionOut.duration.toFixed(1)}s — right-click clip to remove`
										: "Transition won't play: needs an adjacent video or image clip right after this one — right-click clip to remove"
								}
								onMouseDown={(event) => onElementMouseDown(event, element)}
								onClick={(event) => onElementClick(event, element)}
							>
								<TransitionGlyph className="size-[10px]" />
							</button>
						)}
						{isSelected && (
							<div className="pointer-events-none absolute inset-0 overflow-hidden">
								<KeyframeIndicators
									indicators={keyframeIndicators}
									dragState={keyframeDragState}
									displayedStartTime={displayedStartTime}
									elementLeft={elementLeft}
									onKeyframeMouseDown={handleKeyframeMouseDown}
									onKeyframeClick={handleKeyframeClick}
									getVisualOffsetPx={getVisualOffsetPx}
								/>
							</div>
						)}
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent className="w-64">
					<ActionMenuItem
						action="split"
						icon={<HugeiconsIcon icon={ScissorIcon} />}
					>
						Split
					</ActionMenuItem>
					<CopyMenuItem />
					{hasCopiedKeyframes &&
						(selectedElements.length === 1 || selectedKeyframes.length > 0) && (
							<ActionMenuItem
								action="paste-copied"
								icon={<HugeiconsIcon icon={KeyframeIcon} />}
							>
								Paste keyframes
							</ActionMenuItem>
						)}
					{canElementHaveAudio(element) && hasAudio && (
						<MuteMenuItem
							isMultipleSelected={selectedElements.length > 1}
							isCurrentElementSelected={isCurrentElementSelected}
							isMuted={isMuted}
						/>
					)}
					{selectedElements.length === 1 &&
						element.type === "video" &&
						canToggleSourceAudio(element, mediaAsset) && (
							<ActionMenuItem
								action="separate-audio"
								icon={<HugeiconsIcon icon={Unlink04Icon} />}
							>
								{getSourceAudioActionLabel({ element })}
							</ActionMenuItem>
						)}
					{canRemoveSilence && (
						<ContextMenuItem
							icon={<HugeiconsIcon icon={VolumeMute02Icon} />}
							onClick={() => setShowRemoveSilence(true)}
						>
							Remove silence
						</ContextMenuItem>
					)}
					{canElementBeHidden(element) && (
						<VisibilityMenuItem
							element={element}
							isMultipleSelected={selectedElements.length > 1}
							isCurrentElementSelected={isCurrentElementSelected}
						/>
					)}
					{selectedElements.length === 1 && (
						<ActionMenuItem
							action="duplicate-selected"
							icon={<HugeiconsIcon icon={Copy01Icon} />}
						>
							Duplicate
						</ActionMenuItem>
					)}
					{canExtractFrame && (
						<ContextMenuSub>
							<ContextMenuSubTrigger
								icon={<HugeiconsIcon icon={ImageCropIcon} />}
							>
								Extract frame
							</ContextMenuSubTrigger>
							<ContextMenuSubContent className="w-48">
								<ContextMenuItem
									onClick={() => void handleExtractFrame("first")}
								>
									First frame
								</ContextMenuItem>
								<ContextMenuItem
									onClick={() => void handleExtractFrame("last")}
								>
									Last frame
								</ContextMenuItem>
								{playheadOverElement && (
									<ContextMenuItem
										onClick={() => void handleExtractFrame("playhead")}
									>
										Frame at playhead
									</ContextMenuItem>
								)}
							</ContextMenuSubContent>
						</ContextMenuSub>
					)}
					{canExtractFrame && (
						<ContextMenuSub>
							<ContextMenuSubTrigger icon={<HugeiconsIcon icon={SentIcon} />}>
								Send to Omni Reference
							</ContextMenuSubTrigger>
							<ContextMenuSubContent className="w-56">
								<ContextMenuItem
									onClick={() => void handleSendClipToOmni("raw")}
								>
									Raw clip
								</ContextMenuItem>
								<ContextMenuItem
									onClick={() => void handleSendClipToOmni("composited")}
								>
									With edits
								</ContextMenuItem>
							</ContextMenuSubContent>
						</ContextMenuSub>
					)}
					{canSendImageReference && (
						<ContextMenuItem
							icon={<HugeiconsIcon icon={SentIcon} />}
							onClick={() => void handleSendImageToOmni()}
						>
							Send to Omni Reference
						</ContextMenuItem>
					)}
					{selectedElements.length === 1 && hasMediaId(element) && (
						<>
							<ContextMenuItem
								icon={<HugeiconsIcon icon={Search01Icon} />}
								onClick={(event: React.MouseEvent) =>
									handleRevealInMedia({ event })
								}
							>
								Reveal media
							</ContextMenuItem>
							<ContextMenuItem
								icon={<HugeiconsIcon icon={Exchange01Icon} />}
								disabled
							>
								Replace media
							</ContextMenuItem>
						</>
					)}
					{transitionInfo && (
						<ContextMenuItem
							icon={<TransitionGlyph className="size-3.5" />}
							onClick={handleRemoveTransition}
						>
							Remove transition
							{transitionInfo.definition
								? ` (${transitionInfo.definition.name})`
								: ""}
						</ContextMenuItem>
					)}
					<ContextMenuSeparator />
					<DeleteMenuItem
						isMultipleSelected={selectedElements.length > 1}
						isCurrentElementSelected={isCurrentElementSelected}
						elementType={element.type}
						selectedCount={selectedElements.length}
					/>
				</ContextMenuContent>
			</ContextMenu>
			{canRemoveSilence && mediaAsset?.file && (
				<RemoveSilenceDialog
					isOpen={showRemoveSilence}
					onOpenChange={setShowRemoveSilence}
					editor={editor}
					element={element}
					mediaFile={mediaAsset.file}
					mediaId={mediaAsset.id}
				/>
			)}
		</>
	);
}

function ElementInner({
	element,
	track,
	isSelected,
	onElementClick,
	onElementMouseDown,
	handleResizeStart,
	isDropTarget = false,
}: {
	element: TimelineElementType;
	track: TimelineTrack;
	isSelected: boolean;
	onElementClick: (
		event: React.MouseEvent,
		element: TimelineElementType,
	) => void;
	onElementMouseDown: (
		event: React.MouseEvent,
		element: TimelineElementType,
	) => void;
	handleResizeStart: (params: {
		event: React.MouseEvent;
		elementId: string;
		side: "left" | "right";
	}) => void;
	isDropTarget?: boolean;
}) {
	const opacityClass =
		(canElementBeHidden(element) && element.hidden) || isDropTarget
			? "opacity-50"
			: "";
	const closeClipEffects = usePropertiesStore(
		(state) => state.closeClipEffects,
	);

	return (
		<div
			className="relative h-full cursor-pointer"
			style={{ marginInline: ELEMENT_RING_WIDTH_PX }}
		>
			<div
				className={cn(
					"absolute inset-0 overflow-hidden rounded-sm",
					getTrackClasses({ type: track.type }),
					opacityClass,
				)}
				style={
					isSelected
						? {
								boxShadow: `0 0 0 ${ELEMENT_RING_WIDTH_PX}px var(--foreground)`,
							}
						: undefined
				}
			>
				<button
					type="button"
					className="absolute inset-0 size-full cursor-pointer flex flex-col"
					onClick={(event) => {
						closeClipEffects();
						onElementClick(event, element);
					}}
					onMouseDown={(event) => onElementMouseDown(event, element)}
				>
					<div className="flex flex-1 min-h-0 items-center overflow-hidden">
						<ElementContent
							element={element}
							track={track}
							isSelected={isSelected}
						/>
					</div>
				</button>
			</div>

			{element.type !== "audio" && element.type !== "effect" && (
				<div className="sticky left-1 mt-1 ml-1 w-fit">
					<EffectsButton
						element={element as VisualElement}
						trackId={track.id}
					/>
				</div>
			)}

			{isSelected && (
				<>
					<ResizeHandle
						side="left"
						elementId={element.id}
						handleResizeStart={handleResizeStart}
					/>
					<ResizeHandle
						side="right"
						elementId={element.id}
						handleResizeStart={handleResizeStart}
					/>
				</>
			)}
		</div>
	);
}

function ResizeHandle({
	side,
	elementId,
	handleResizeStart,
}: {
	side: "left" | "right";
	elementId: string;
	handleResizeStart: (params: {
		event: React.MouseEvent;
		elementId: string;
		side: "left" | "right";
	}) => void;
}) {
	const isLeft = side === "left";
	return (
		<button
			type="button"
			className={cn(
				"absolute top-0 bottom-0 w-2",
				isLeft ? "-left-1 cursor-w-resize" : "-right-1 cursor-e-resize",
			)}
			onMouseDown={(event) => handleResizeStart({ event, elementId, side })}
			onClick={(event) => event.stopPropagation()}
			aria-label={`${isLeft ? "Left" : "Right"} resize handle`}
		></button>
	);
}

function KeyframeIndicators({
	indicators,
	dragState,
	displayedStartTime,
	elementLeft,
	onKeyframeMouseDown,
	onKeyframeClick,
	getVisualOffsetPx,
}: {
	indicators: KeyframeIndicator[];
	dragState: KeyframeDragState;
	displayedStartTime: number;
	elementLeft: number;
	onKeyframeMouseDown: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
	}) => void;
	onKeyframeClick: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: number;
	}) => void;
	getVisualOffsetPx: (params: {
		indicatorTime: number;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: number;
		elementLeft: number;
	}) => number;
}) {
	const { isKeyframeSelected } = useKeyframeSelection();
	const orderedKeyframes = indicators.flatMap(
		(indicator) => indicator.keyframes,
	);

	return indicators.map((indicator) => {
		const isIndicatorSelected = indicator.keyframes.some((keyframe) =>
			isKeyframeSelected({ keyframe }),
		);
		const isBeingDragged = indicator.keyframes.some((kf) =>
			dragState.draggingKeyframeIds.has(kf.keyframeId),
		);
		const visualOffsetPx = getVisualOffsetPx({
			indicatorTime: indicator.time,
			indicatorOffsetPx: indicator.offsetPx,
			isBeingDragged,
			displayedStartTime,
			elementLeft,
		});

		return (
			<button
				key={indicator.time}
				type="button"
				className="pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab"
				style={{ left: visualOffsetPx }}
				onMouseDown={(event) =>
					onKeyframeMouseDown({ event, keyframes: indicator.keyframes })
				}
				onClick={(event) =>
					onKeyframeClick({
						event,
						keyframes: indicator.keyframes,
						orderedKeyframes,
						indicatorTime: indicator.time,
					})
				}
				aria-label="Select keyframe"
			>
				<HugeiconsIcon
					icon={KeyframeIcon}
					className={cn(
						"size-3.5 mt-1.5 text-black",
						isIndicatorSelected ? "fill-primary" : "fill-white",
					)}
					strokeWidth={1.5}
				/>
			</button>
		);
	});
}

interface ElementContentProps {
	element: TimelineElementType;
	track: TimelineTrack;
	isSelected: boolean;
}

interface ElementContentRendererProps extends ElementContentProps {
	mediaAssets: MediaAsset[];
	editor: ReturnType<typeof useEditor>;
}

type ElementContentRenderer = (props: ElementContentRendererProps) => ReactNode;

export function renderTiledMedia({
	element,
	imageUrl,
	track,
}: {
	element: VisualElement;
	imageUrl: string | undefined;
	track: ElementContentProps["track"];
}): ReactNode {
	if (!imageUrl) {
		return (
			<span className="text-foreground/80 truncate text-xs">
				{element.name}
			</span>
		);
	}

	const trackHeight = getTrackHeight({ type: track.type });

	return (
		<div
			className="absolute inset-0"
			style={{
				backgroundImage: `url(${imageUrl})`,
				backgroundRepeat: "repeat-x",
				// `auto <height>` keeps each tile at the media's own aspect ratio
				// (fit to track height, width proportional) so portrait clips don't
				// get stretched into a 16:9 box.
				backgroundSize: `auto ${trackHeight}px`,
				backgroundPosition: "left center",
				pointerEvents: "none",
			}}
		/>
	);
}

function EffectsButton({
	element,
	trackId,
	className,
}: {
	element: VisualElement;
	trackId: string;
	className?: string;
}) {
	const openClipEffects = usePropertiesStore((state) => state.openClipEffects);
	const { selectElement } = useElementSelection();

	if (!element.effects?.length) {
		return null;
	}

	const handleClick = (event: React.MouseEvent) => {
		event.stopPropagation();
		selectElement({ elementId: element.id, trackId });
		openClipEffects({ elementId: element.id, trackId });
	};

	return (
		<Button
			variant="text"
			size="icon"
			className={cn("rounded-sm !size-5 bg-black/50 text-white", className)}
			onClick={handleClick}
			onMouseDown={(event) => event.stopPropagation()}
		>
			<HugeiconsIcon icon={MagicWand05Icon} />
		</Button>
	);
}

function AudioVolumeLine({
	volume,
	volumeDb,
	volumePercent,
	onVolumeChange,
	onVolumeCommit,
}: {
	volume: number;
	volumeDb: number;
	volumePercent: number;
	onVolumeChange: (v: number) => void;
	onVolumeCommit: (v: number) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const isDragging = useRef(false);
	const startVolume = useRef(volume);

	const calcVolume = useCallback(
		(e: MouseEvent) => {
			const container = containerRef.current;
			if (!container) return volume;
			const rect = container.getBoundingClientRect();
			const y = e.clientY - rect.top;
			const ratio = 1 - Math.max(0, Math.min(1, y / rect.height));
			return Math.round(ratio * 100) / 100;
		},
		[volume],
	);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			// Only start volume drag if the click is near the volume line (within 6px)
			const container = containerRef.current;
			if (!container) return;
			const rect = container.getBoundingClientRect();
			const lineY = rect.top + rect.height * (1 - volumePercent / 100);
			const distanceFromLine = Math.abs(e.clientY - lineY);
			if (distanceFromLine > 6) return;

			e.stopPropagation();
			e.preventDefault();
			isDragging.current = true;
			startVolume.current = volume;

			const handleMove = (ev: MouseEvent) => {
				if (!isDragging.current) return;
				onVolumeChange(calcVolume(ev));
			};

			const handleUp = (ev: MouseEvent) => {
				if (!isDragging.current) return;
				isDragging.current = false;
				onVolumeCommit(calcVolume(ev));
				window.removeEventListener("mousemove", handleMove);
				window.removeEventListener("mouseup", handleUp);
			};

			window.addEventListener("mousemove", handleMove);
			window.addEventListener("mouseup", handleUp);
		},
		[volume, volumePercent, onVolumeChange, onVolumeCommit, calcVolume],
	);

	return (
		<div
			ref={containerRef}
			className="absolute inset-0 z-10"
			onMouseDown={handleMouseDown}
			style={{ cursor: "ns-resize" }}
		>
			{/* Volume level line */}
			<div
				className="absolute left-0 right-0 border-t-2 border-yellow-400/80 pointer-events-none transition-[top] duration-75"
				style={{ top: `${100 - volumePercent}%` }}
			>
				{/* dB label */}
				<span className="absolute right-1 -top-3.5 text-3xs font-mono text-yellow-400/90 pointer-events-none select-none">
					{volumeDb > -60 ? `${volumeDb} dB` : "-∞ dB"}
				</span>
			</div>
		</div>
	);
}

const ELEMENT_CONTENT_RENDERERS: Record<
	TimelineElementType["type"],
	ElementContentRenderer
> = {
	text: ({ element }) => {
		const textElement = element as Extract<
			TimelineElementType,
			{ type: "text" }
		>;
		return (
			<div className="flex size-full items-center justify-start pl-2">
				<span className="truncate text-xs text-white">
					{textElement.content}
				</span>
			</div>
		);
	},
	effect: ({ element }) => (
		<div className="flex size-full items-center justify-start gap-1 pl-2">
			<HugeiconsIcon
				icon={MagicWand05Icon}
				className="size-4 shrink-0 text-white"
			/>
			<span className="truncate text-xs text-white ml-1">{element.name}</span>
		</div>
	),
	sticker: ({ element }) => {
		const stickerElement = element as Extract<
			TimelineElementType,
			{ type: "sticker" }
		>;
		return (
			<div className="flex size-full items-center gap-2 pl-2">
				<Image
					src={resolveStickerId({
						stickerId: stickerElement.stickerId,
						options: { width: 20, height: 20 },
					})}
					alt={stickerElement.name}
					className="size-5 shrink-0"
					width={20}
					height={20}
					unoptimized
				/>
				<span className="truncate text-xs text-white">
					{stickerElement.name}
				</span>
			</div>
		);
	},
	shape: ({ element }) => {
		const shapeElement = element as Extract<
			TimelineElementType,
			{ type: "shape" }
		>;
		// A shape has no thumbnail to show, so the swatch stands in for one:
		// solid fills paint directly, gradients show their first stop.
		const swatch =
			shapeElement.fill.type === "solid"
				? shapeElement.fill.color
				: shapeElement.fill.stops[0]?.color;
		return (
			<div className="flex size-full items-center gap-2 pl-2">
				<span
					aria-hidden
					className={cn(
						"size-4 shrink-0 border border-white/40",
						shapeElement.shapeKind === "ellipse" && "rounded-full",
						shapeElement.shapeKind === "line" && "h-0.5 self-center",
					)}
					style={{ background: swatch ?? "transparent" }}
				/>
				<span className="truncate text-xs text-white">
					{shapeElement.name}
				</span>
			</div>
		);
	},
	audio: ({ element, track, mediaAssets, editor }) => {
		const audioElement = element as Extract<
			TimelineElementType,
			{ type: "audio" }
		>;
		const audioBuffer =
			audioElement.sourceType === "library" ? audioElement.buffer : undefined;
		const audioUrl =
			audioElement.sourceType === "library"
				? audioElement.sourceUrl
				: mediaAssets.find((asset) => asset.id === audioElement.mediaId)?.url;

		const volume = audioElement.volume ?? 1;
		const volumeDb = volume > 0 ? Math.round(20 * Math.log10(volume)) : -60;
		const volumePercent = Math.min(volume, 1) * 100;

		return (
			<div className="relative flex size-full items-center gap-2">
				{(audioBuffer || audioUrl) && (
					<div className="min-w-0 flex-1 opacity-60">
						<AudioWaveform
							audioBuffer={audioBuffer}
							audioUrl={audioUrl}
							// Re-window the waveform to this clip's actual trimmed range
							// (BUG170) — without these, splitting or trim-dragging a clip
							// leaves the waveform showing the pre-split/pre-trim source.
							trimStart={audioElement.trimStart}
							duration={audioElement.duration}
							playbackRate={audioElement.playbackRate}
							height={24}
							className="w-full"
						/>
					</div>
				)}
				{!audioBuffer && !audioUrl && (
					<span className="text-foreground/80 truncate text-xs">
						{audioElement.name}
					</span>
				)}

				{/* Volume line — draggable */}
				<AudioVolumeLine
					volume={volume}
					volumeDb={volumeDb}
					volumePercent={volumePercent}
					onVolumeChange={(newVolume) => {
						editor.timeline.updateElements({
							updates: [
								{
									trackId: track.id,
									elementId: element.id,
									updates: { volume: newVolume },
								},
							],
							pushHistory: false,
						});
					}}
					onVolumeCommit={(newVolume) => {
						editor.timeline.updateElements({
							updates: [
								{
									trackId: track.id,
									elementId: element.id,
									updates: { volume: newVolume },
								},
							],
							pushHistory: true,
						});
					}}
				/>
			</div>
		);
	},
	video: ({ element, track, mediaAssets }) => {
		const videoElement = element as Extract<
			TimelineElementType,
			{ type: "video" }
		>;
		const mediaAsset = mediaAssets.find(
			(asset) => asset.id === videoElement.mediaId,
		);
		// A generative slot with no resolved media yet → empty/generating visual.
		if (videoElement.generation && !mediaAsset) {
			return <GenerativeSlotContent element={videoElement} />;
		}
		return (
			<>
				{renderTiledMedia({
					element: videoElement,
					imageUrl: mediaAsset?.thumbnailUrl,
					track,
				})}
				<SlotTakesBadge element={videoElement} />
			</>
		);
	},
	image: ({ element, track, mediaAssets }) => {
		const imageElement = element as Extract<
			TimelineElementType,
			{ type: "image" }
		>;
		const mediaAsset = mediaAssets.find(
			(asset) => asset.id === imageElement.mediaId,
		);
		if (imageElement.generation && !mediaAsset) {
			return <GenerativeSlotContent element={imageElement} />;
		}
		return (
			<>
				{renderTiledMedia({
					element: imageElement,
					imageUrl: mediaAsset?.url,
					track,
				})}
				<SlotTakesBadge element={imageElement} />
			</>
		);
	},
};

function ElementContent({ element, track, isSelected }: ElementContentProps) {
	const editor = useEditor();
	const renderer = ELEMENT_CONTENT_RENDERERS[element.type];
	return (
		<>
			{renderer({
				element,
				track,
				isSelected,
				mediaAssets: editor.media.getAssets(),
				editor,
			})}
		</>
	);
}

function CopyMenuItem() {
	return (
		<ActionMenuItem
			action="copy-selected"
			icon={<HugeiconsIcon icon={Copy01Icon} />}
		>
			Copy
		</ActionMenuItem>
	);
}

function MuteMenuItem({
	isMultipleSelected,
	isCurrentElementSelected,
	isMuted,
}: {
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
	isMuted: boolean;
}) {
	const getIcon = () => {
		if (isMultipleSelected && isCurrentElementSelected) {
			return <HugeiconsIcon icon={VolumeMute02Icon} />;
		}
		return isMuted ? (
			<HugeiconsIcon icon={VolumeOffIcon} />
		) : (
			<HugeiconsIcon icon={VolumeHighIcon} />
		);
	};

	return (
		<ActionMenuItem action="toggle-elements-muted-selected" icon={getIcon()}>
			{isMuted ? "Unmute" : "Mute"}
		</ActionMenuItem>
	);
}

function VisibilityMenuItem({
	element,
	isMultipleSelected,
	isCurrentElementSelected,
}: {
	element: TimelineElementType;
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
}) {
	const isHidden = canElementBeHidden(element) && element.hidden;

	const getIcon = () => {
		if (isMultipleSelected && isCurrentElementSelected) {
			return <HugeiconsIcon icon={ViewOffSlashIcon} />;
		}
		return isHidden ? (
			<HugeiconsIcon icon={ViewIcon} />
		) : (
			<HugeiconsIcon icon={ViewOffSlashIcon} />
		);
	};

	return (
		<ActionMenuItem
			action="toggle-elements-visibility-selected"
			icon={getIcon()}
		>
			{isHidden ? "Show" : "Hide"}
		</ActionMenuItem>
	);
}

function DeleteMenuItem({
	isMultipleSelected,
	isCurrentElementSelected,
	elementType,
	selectedCount,
}: {
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
	elementType: TimelineElementType["type"];
	selectedCount: number;
}) {
	return (
		<ActionMenuItem
			action="delete-selected"
			variant="destructive"
			icon={<HugeiconsIcon icon={Delete02Icon} />}
		>
			{isMultipleSelected && isCurrentElementSelected
				? `Delete ${selectedCount} elements`
				: `Delete ${elementType === "text" ? "text" : "clip"}`}
		</ActionMenuItem>
	);
}

function ActionMenuItem({
	action,
	children,
	...props
}: Omit<ComponentProps<typeof ContextMenuItem>, "onClick" | "textRight"> & {
	action: TAction;
	children: ReactNode;
}) {
	return (
		<ContextMenuItem
			onClick={(event: React.MouseEvent) => {
				event.stopPropagation();
				invokeAction(action);
			}}
			textRight={getDisplayShortcut({ action })}
			{...props}
		>
			{children}
		</ContextMenuItem>
	);
}
