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
	| "bottom"
	| "left"
	| "right"
	| "rotation"
	| "feather";

interface MaskDragState {
	trackId: string;
	elementId: string;
	handle: MaskHandle;
	startCanvasX: number;
	startCanvasY: number;
	startMask: ResolvedMaskShape;
	bounds: ElementBounds;
}

export function rotateVector({
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

/** The mask's center in canvas-pixel space (the fractional offset lives in
 * element-local space, so it rotates with the element). Shared by the drag
 * math here and the on-canvas overlay in `mask-handles.tsx`. */
export function getMaskCenterCanvas({
	mask,
	bounds,
}: {
	mask: Pick<ResolvedMaskShape, "centerX" | "centerY">;
	bounds: ElementBounds;
}): { x: number; y: number } {
	const offset = rotateVector({
		x: mask.centerX * bounds.width,
		y: mask.centerY * bounds.height,
		degrees: bounds.rotation,
	});
	return { x: bounds.cx + offset.x, y: bounds.cy + offset.y };
}

/** Wraps a rotation value into (-180, 180], matching the numeric field's range. */
export function wrapRotationDegrees(degrees: number): number {
	let wrapped = degrees % 360;
	if (wrapped > 180) wrapped -= 360;
	if (wrapped <= -180) wrapped += 360;
	return wrapped;
}

// Ported from OpenCut-app/opencut-classic's masks/param-update.ts (MIT), adapted
// for our feather representation: theirs is an absolute canvas-pixel blur radius
// (0..MAX_FEATHER, scaled by a tuned FEATHER_HANDLE_SCALE constant); ours is a
// fraction of the element's short side (see shape-mask.frag.glsl, where
// featherPx = feather * shortSide * 0.5). Projecting the drag delta onto the
// feather axis and dividing by shortSide * 0.5 keeps the handle's screen
// position and the rendered feather band in a direct 1:1 relationship.
export function computeFeatherUpdate({
	startFeather,
	deltaX,
	deltaY,
	directionX,
	directionY,
	shortSide,
}: {
	startFeather: number;
	deltaX: number;
	deltaY: number;
	directionX: number;
	directionY: number;
	shortSide: number;
}): { feather: number } {
	const projection = deltaX * directionX + deltaY * directionY;
	const scale = Math.max(shortSide, 1) * 0.5;
	return {
		feather: Math.max(0, Math.min(1, startFeather + projection / scale)),
	};
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
		selectedWithBounds.element.mask &&
		// Custom pen-tool masks have their own overlay (pen-mask-handles.tsx);
		// keep them out of the analytic box-handle path (resolveMaskShape would
		// otherwise force their type to "rectangle").
		selectedWithBounds.element.mask.type !== "custom"
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
			} else if (handle === "rotation") {
				// Standard "drag around a pivot" rotation: compare the cursor's angle
				// from the mask center at drag-start vs. now, and add the difference.
				const pivot = getMaskCenterCanvas({ mask: startMask, bounds });
				const startAngle =
					Math.atan2(
						dragState.startCanvasY - pivot.y,
						dragState.startCanvasX - pivot.x,
					) *
					(180 / Math.PI);
				const currentAngle =
					Math.atan2(position.y - pivot.y, position.x - pivot.x) *
					(180 / Math.PI);
				let deltaAngle = currentAngle - startAngle;
				if (deltaAngle > 180) deltaAngle -= 360;
				if (deltaAngle < -180) deltaAngle += 360;
				maskUpdates.rotation = wrapRotationDegrees(
					startMask.rotation + deltaAngle,
				);
			} else if (handle === "feather") {
				// Delta in mask-local space (undo element + mask rotation) so the
				// feather axis below is a fixed local direction regardless of the
				// mask's on-screen rotation.
				const local = rotateVector({
					x: deltaX,
					y: deltaY,
					degrees: -(bounds.rotation + startMask.rotation),
				});
				const direction =
					startMask.type === "split"
						? { x: -1, y: 0 } // split's feather handle sits along -local-x (negative normal)
						: { x: 0, y: 1 }; // box-like feather handle sits below the shape (+local-y)
				maskUpdates.feather = computeFeatherUpdate({
					startFeather: startMask.feather,
					deltaX: local.x,
					deltaY: local.y,
					directionX: direction.x,
					directionY: direction.y,
					shortSide: Math.min(bounds.width, bounds.height),
				}).feather;
			} else {
				// Delta in mask-local space (undo element + mask rotation).
				const local = rotateVector({
					x: deltaX,
					y: deltaY,
					degrees: -(bounds.rotation + startMask.rotation),
				});
				switch (handle) {
					case "left":
					case "right": {
						const signX = handle === "right" ? 1 : -1;
						maskUpdates.width = clampDimension(
							startMask.width + (2 * signX * local.x) / bounds.width,
						);
						break;
					}
					case "top":
					case "bottom": {
						const signY = handle === "bottom" ? 1 : -1;
						maskUpdates.height = clampDimension(
							startMask.height + (2 * signY * local.y) / bounds.height,
						);
						break;
					}
					default: {
						// Corners: independent width + height (non-uniform resize).
						const signX = handle.endsWith("right") ? 1 : -1;
						maskUpdates.width = clampDimension(
							startMask.width + (2 * signX * local.x) / bounds.width,
						);
						const signY = handle.startsWith("top") ? -1 : 1;
						maskUpdates.height = clampDimension(
							startMask.height + (2 * signY * local.y) / bounds.height,
						);
					}
				}
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
