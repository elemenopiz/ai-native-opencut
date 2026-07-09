// Adapted from OpenCut-app/opencut-classic (MIT). See THIRD_PARTY_NOTICES.
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useEditor } from "@/hooks/use-editor";
import {
	getVisibleElementsWithBounds,
	type ElementBounds,
	type ElementWithBounds,
} from "@/lib/preview/element-bounds";
import { screenToCanvas } from "@/lib/preview/preview-coords";
import { isVisualElement } from "@/lib/timeline/element-utils";
import {
	MAX_MASK_DIMENSION,
	MIN_MASK_DIMENSION,
	resolveMaskShape,
	type ResolvedMaskShape,
} from "@/lib/effects/definitions/shape-mask";
import type { MaskShape } from "@/types/rendering";

export type MaskHandle =
	| "move"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top"
	| "bottom";

interface MaskDragState {
	trackId: string;
	elementId: string;
	handle: MaskHandle;
	startCanvasX: number;
	startCanvasY: number;
	startMask: ResolvedMaskShape;
	bounds: ElementBounds;
}

function rotateVector({
	x,
	y,
	degrees,
}: {
	x: number;
	y: number;
	degrees: number;
}): { x: number; y: number } {
	const rad = (degrees * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return {
		x: x * cos - y * sin,
		y: x * sin + y * cos,
	};
}

function clampDimension(value: number): number {
	return Math.max(MIN_MASK_DIMENSION, Math.min(MAX_MASK_DIMENSION, value));
}

export function useMaskHandles({
	canvasRef,
}: {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
	const editor = useEditor();
	const [activeHandle, setActiveHandle] = useState<MaskHandle | null>(null);
	const dragStateRef = useRef<MaskDragState | null>(null);

	const selectedElements = useSyncExternalStore(
		(listener) => editor.selection.subscribe(listener),
		() => editor.selection.getSelectedElements(),
	);

	const tracks = editor.timeline.getTracks();
	const currentTime = editor.playback.getCurrentTime();
	const mediaAssets = editor.media.getAssets();
	const canvasSize = editor.project.getActive().settings.canvasSize;

	const elementsWithBounds = getVisibleElementsWithBounds({
		tracks,
		currentTime,
		canvasSize,
		mediaAssets,
	});

	const selectedWithBounds: ElementWithBounds | null =
		selectedElements.length === 1
			? (elementsWithBounds.find(
					(entry) =>
						entry.trackId === selectedElements[0].trackId &&
						entry.elementId === selectedElements[0].elementId,
				) ?? null)
			: null;

	const selectedMask: ResolvedMaskShape | null =
		selectedWithBounds &&
		isVisualElement(selectedWithBounds.element) &&
		selectedWithBounds.element.mask
			? resolveMaskShape({ mask: selectedWithBounds.element.mask })
			: null;

	const handleMaskPointerDown = useCallback(
		({ event, handle }: { event: React.PointerEvent; handle: MaskHandle }) => {
			if (!selectedWithBounds || !selectedMask || !canvasRef.current) return;
			event.stopPropagation();

			const position = screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
				canvas: canvasRef.current,
			});

			dragStateRef.current = {
				trackId: selectedWithBounds.trackId,
				elementId: selectedWithBounds.elementId,
				handle,
				startCanvasX: position.x,
				startCanvasY: position.y,
				startMask: selectedMask,
				bounds: selectedWithBounds.bounds,
			};
			setActiveHandle(handle);
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		},
		[selectedWithBounds, selectedMask, canvasRef],
	);

	const handleMaskPointerMove = useCallback(
		({ event }: { event: React.PointerEvent }) => {
			const dragState = dragStateRef.current;
			if (!dragState || !canvasRef.current) return;

			const position = screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
				canvas: canvasRef.current,
			});
			const deltaX = position.x - dragState.startCanvasX;
			const deltaY = position.y - dragState.startCanvasY;
			const { handle, startMask, bounds } = dragState;

			const maskUpdates: Partial<MaskShape> = {};

			if (handle === "move") {
				// Delta in element-local space (undo the element rotation).
				const local = rotateVector({
					x: deltaX,
					y: deltaY,
					degrees: -bounds.rotation,
				});
				maskUpdates.centerX = Math.max(
					-1,
					Math.min(1, startMask.centerX + local.x / bounds.width),
				);
				maskUpdates.centerY = Math.max(
					-1,
					Math.min(1, startMask.centerY + local.y / bounds.height),
				);
			} else {
				// Delta in mask-local space (undo element + mask rotation).
				const local = rotateVector({
					x: deltaX,
					y: deltaY,
					degrees: -(bounds.rotation + startMask.rotation),
				});
				if (handle !== "top" && handle !== "bottom") {
					const signX = handle.endsWith("right") ? 1 : -1;
					maskUpdates.width = clampDimension(
						startMask.width + (2 * signX * local.x) / bounds.width,
					);
				}
				const signY = handle.startsWith("top") ? -1 : 1;
				maskUpdates.height = clampDimension(
					startMask.height + (2 * signY * local.y) / bounds.height,
				);
			}

			editor.timeline.previewElements({
				updates: [
					{
						trackId: dragState.trackId,
						elementId: dragState.elementId,
						updates: {
							mask: { ...startMask, ...maskUpdates },
						},
					},
				],
			});
		},
		[canvasRef, editor],
	);

	const handleMaskPointerUp = useCallback(
		({ event }: { event: React.PointerEvent }) => {
			if (dragStateRef.current) {
				editor.timeline.commitPreview();
				dragStateRef.current = null;
				setActiveHandle(null);
			}
			(event.currentTarget as HTMLElement).releasePointerCapture(
				event.pointerId,
			);
		},
		[editor],
	);

	return {
		selectedWithBounds,
		selectedMask,
		activeHandle,
		handleMaskPointerDown,
		handleMaskPointerMove,
		handleMaskPointerUp,
	};
}
