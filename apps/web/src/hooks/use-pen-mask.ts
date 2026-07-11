// Adapted from OpenCut-app/OpenCut (pre-rewrite tag, MIT) —
// masks/freeform/definition.ts (append/insert/param-update) and
// commands/timeline/element/masks/*. Reimplemented on our preview/commit drag
// pattern and generic updateElements undo path (no dedicated command classes,
// matching the analytic mask handles).
import { useCallback, useRef, useSyncExternalStore } from "react";
import { useEditor } from "@/hooks/use-editor";
import {
	getVisibleElementsWithBounds,
	type ElementBounds,
	type ElementWithBounds,
} from "@/lib/preview/element-bounds";
import { screenToCanvas } from "@/lib/preview/preview-coords";
import { isVisualElement } from "@/lib/timeline/element-utils";
import { getMaskCenterCanvas, rotateVector } from "@/hooks/use-mask-handles";
import {
	canvasPointToLocal,
	findClosestPointOnFreeformSegment,
	getClosedStateAfterPointRemoval,
	insertPointIntoFreeformSegment,
	localPointToCanvas,
	removeFreeformPathPoints,
	type CanvasPoint,
	type FreeformTransform,
} from "@/lib/effects/masks/freeform-path";
import { resolveCustomMask } from "@/lib/effects/definitions/custom-mask";
import { usePenMaskStore } from "@/stores/pen-mask-store";
import { generateUUID } from "@/utils/id";
import type { MaskPathPoint, MaskShape } from "@/types/rendering";

/** Pixel radius (canvas space) for clicking the first anchor to close a path. */
const CLOSE_HIT_RADIUS = 12;

type TangentSide = "in" | "out";

type PenDrag =
	| { kind: "anchor"; pointId: string }
	| { kind: "tangent"; pointId: string; side: TangentSide }
	| { kind: "path" };

interface PenDragState {
	trackId: string;
	elementId: string;
	drag: PenDrag;
	startCanvasX: number;
	startCanvasY: number;
	startMask: MaskShape;
	bounds: ElementBounds;
}

/** Canvas-space transform for a custom mask, layering element rotation on top. */
export function getPenMaskTransform({
	mask,
	bounds,
}: {
	mask: Pick<MaskShape, "centerX" | "centerY" | "rotation" | "scale">;
	bounds: ElementBounds;
}): FreeformTransform {
	return {
		center: getMaskCenterCanvas({
			mask: { centerX: mask.centerX ?? 0, centerY: mask.centerY ?? 0 },
			bounds,
		}),
		rotationDeg: (mask.rotation ?? 0) + bounds.rotation,
		scale: mask.scale ?? 1,
		width: bounds.width,
		height: bounds.height,
	};
}

function updatePoint({
	points,
	pointId,
	updater,
}: {
	points: MaskPathPoint[];
	pointId: string;
	updater: (point: MaskPathPoint) => MaskPathPoint;
}): MaskPathPoint[] {
	return points.map((point) => (point.id === pointId ? updater(point) : point));
}

export function usePenMask({
	canvasRef,
}: {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
	const editor = useEditor();
	const dragStateRef = useRef<PenDragState | null>(null);

	const drawingElementId = usePenMaskStore((s) => s.drawingElementId);
	const selectedPointIds = usePenMaskStore((s) => s.selectedPointIds);
	const setSelectedPoints = usePenMaskStore((s) => s.setSelectedPoints);
	const stopDrawing = usePenMaskStore((s) => s.stopDrawing);

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

	const rawMask: MaskShape | null =
		selectedWithBounds &&
		isVisualElement(selectedWithBounds.element) &&
		selectedWithBounds.element.mask?.type === "custom"
			? selectedWithBounds.element.mask
			: null;

	const mask = rawMask ? resolveCustomMask({ mask: rawMask }) : null;
	const isDrawing =
		!!selectedWithBounds && drawingElementId === selectedWithBounds.elementId;

	const toCanvas = useCallback(
		(event: React.PointerEvent | React.MouseEvent): CanvasPoint | null => {
			if (!canvasRef.current) return null;
			return screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
				canvas: canvasRef.current,
			});
		},
		[canvasRef],
	);

	const previewMask = useCallback(
		({ nextMask }: { nextMask: MaskShape }) => {
			if (!dragStateRef.current) return;
			editor.timeline.previewElements({
				updates: [
					{
						trackId: dragStateRef.current.trackId,
						elementId: dragStateRef.current.elementId,
						updates: { mask: nextMask },
					},
				],
			});
		},
		[editor],
	);

	const commitMask = useCallback(
		({ nextMask }: { nextMask: MaskShape }) => {
			if (!selectedWithBounds) return;
			editor.timeline.updateElements({
				updates: [
					{
						trackId: selectedWithBounds.trackId,
						elementId: selectedWithBounds.elementId,
						updates: { mask: nextMask },
					},
				],
			});
		},
		[editor, selectedWithBounds],
	);

	// --- Discrete (undoable via updateElements) -----------------------------

	/** Append an anchor at the clicked canvas point, or close the path if the
	 *  click lands on the first anchor. Returns true when it handled the click. */
	const placePointOrClose = useCallback(
		({ event }: { event: React.PointerEvent }): boolean => {
			if (!selectedWithBounds || !rawMask || !mask) return false;
			const canvasPoint = toCanvas(event);
			if (!canvasPoint) return false;
			const { bounds } = selectedWithBounds;
			const points = mask.points;

			// Close when clicking the first anchor of a >=3-point open path.
			if (points.length >= 3 && !mask.closed) {
				const transform = getPenMaskTransform({ mask: rawMask, bounds });
				const first = points[0];
				const firstCanvas = localPointToCanvas({
					point: { x: first.x, y: first.y },
					transform,
				});
				const dist = Math.hypot(
					canvasPoint.x - firstCanvas.x,
					canvasPoint.y - firstCanvas.y,
				);
				if (dist <= CLOSE_HIT_RADIUS) {
					commitMask({ nextMask: { ...rawMask, closed: true } });
					stopDrawing();
					return true;
				}
			}

			const newPoint: MaskPathPoint = {
				id: generateUUID(),
				x: 0,
				y: 0,
				inX: 0,
				inY: 0,
				outX: 0,
				outY: 0,
			};

			if (points.length === 0) {
				// Anchor the mask center at the first click, first point local (0,0).
				const offset = rotateVector({
					x: canvasPoint.x - bounds.cx,
					y: canvasPoint.y - bounds.cy,
					degrees: -bounds.rotation,
				});
				commitMask({
					nextMask: {
						...rawMask,
						centerX: bounds.width === 0 ? 0 : offset.x / bounds.width,
						centerY: bounds.height === 0 ? 0 : offset.y / bounds.height,
						rotation: 0,
						scale: 1,
						points: [newPoint],
					},
				});
				setSelectedPoints([newPoint.id]);
				return true;
			}

			const transform = getPenMaskTransform({ mask: rawMask, bounds });
			const local = canvasPointToLocal({ point: canvasPoint, transform });
			newPoint.x = local.x;
			newPoint.y = local.y;
			commitMask({
				nextMask: { ...rawMask, points: [...points, newPoint] },
			});
			setSelectedPoints([newPoint.id]);
			return true;
		},
		[
			selectedWithBounds,
			rawMask,
			mask,
			toCanvas,
			commitMask,
			setSelectedPoints,
			stopDrawing,
		],
	);

	const insertOnSegment = useCallback(
		({
			event,
			segmentIndex,
		}: {
			event: React.PointerEvent;
			segmentIndex: number;
		}) => {
			if (!selectedWithBounds || !rawMask || !mask) return;
			const canvasPoint = toCanvas(event);
			if (!canvasPoint) return;
			const transform = getPenMaskTransform({
				mask: rawMask,
				bounds: selectedWithBounds.bounds,
			});
			const closest = findClosestPointOnFreeformSegment({
				points: mask.points,
				segmentIndex,
				canvasPoint,
				transform,
				closed: mask.closed,
			});
			if (!closest) return;
			const pointId = generateUUID();
			const nextPoints = insertPointIntoFreeformSegment({
				points: mask.points,
				segmentIndex,
				pointId,
				t: closest.t,
				closed: mask.closed,
			});
			if (nextPoints.length === mask.points.length) return;
			commitMask({ nextMask: { ...rawMask, points: nextPoints } });
			setSelectedPoints([pointId]);
		},
		[
			selectedWithBounds,
			rawMask,
			mask,
			toCanvas,
			commitMask,
			setSelectedPoints,
		],
	);

	const deleteSelectedPoints = useCallback(() => {
		if (!rawMask || !mask || selectedPointIds.length === 0) return;
		const nextPoints = removeFreeformPathPoints({
			points: mask.points,
			pointIds: selectedPointIds,
		});
		if (nextPoints.length === mask.points.length) return;
		commitMask({
			nextMask: {
				...rawMask,
				points: nextPoints,
				closed: getClosedStateAfterPointRemoval({
					wasClosed: mask.closed,
					remainingPointCount: nextPoints.length,
				}),
			},
		});
		setSelectedPoints([]);
	}, [rawMask, mask, selectedPointIds, commitMask, setSelectedPoints]);

	const closePath = useCallback(() => {
		if (!rawMask || !mask || mask.points.length < 3 || mask.closed) return;
		commitMask({ nextMask: { ...rawMask, closed: true } });
		stopDrawing();
	}, [rawMask, mask, commitMask, stopDrawing]);

	const selectPoint = useCallback(
		({ pointId }: { pointId: string }) => {
			setSelectedPoints([pointId]);
		},
		[setSelectedPoints],
	);

	// --- Drags (previewElements during, commitPreview on up) ----------------

	const beginDrag = useCallback(
		({ event, drag }: { event: React.PointerEvent; drag: PenDrag }) => {
			if (!selectedWithBounds || !rawMask) return;
			const canvasPoint = toCanvas(event);
			if (!canvasPoint) return;
			event.stopPropagation();
			dragStateRef.current = {
				trackId: selectedWithBounds.trackId,
				elementId: selectedWithBounds.elementId,
				drag,
				startCanvasX: canvasPoint.x,
				startCanvasY: canvasPoint.y,
				startMask: rawMask,
				bounds: selectedWithBounds.bounds,
			};
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		},
		[selectedWithBounds, rawMask, toCanvas],
	);

	const onDragMove = useCallback(
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
			const { drag, startMask, bounds } = dragState;
			const startPoints = startMask.points ?? [];

			if (drag.kind === "path") {
				const local = rotateVector({
					x: deltaX,
					y: deltaY,
					degrees: -bounds.rotation,
				});
				const clamp = (value: number) => Math.max(-4, Math.min(4, value));
				previewMask({
					nextMask: {
						...startMask,
						centerX: clamp((startMask.centerX ?? 0) + local.x / bounds.width),
						centerY: clamp((startMask.centerY ?? 0) + local.y / bounds.height),
					},
				});
				return;
			}

			const transform = getPenMaskTransform({ mask: startMask, bounds });
			const currentCanvas = {
				x: dragState.startCanvasX + deltaX,
				y: dragState.startCanvasY + deltaY,
			};
			const local = canvasPointToLocal({ point: currentCanvas, transform });

			if (drag.kind === "anchor") {
				previewMask({
					nextMask: {
						...startMask,
						points: updatePoint({
							points: startPoints,
							pointId: drag.pointId,
							updater: (point) => ({ ...point, x: local.x, y: local.y }),
						}),
					},
				});
				return;
			}

			// Tangent handle: store as an offset from its anchor.
			previewMask({
				nextMask: {
					...startMask,
					points: updatePoint({
						points: startPoints,
						pointId: drag.pointId,
						updater: (point) =>
							drag.side === "in"
								? { ...point, inX: local.x - point.x, inY: local.y - point.y }
								: {
										...point,
										outX: local.x - point.x,
										outY: local.y - point.y,
									},
					}),
				},
			});
		},
		[canvasRef, previewMask],
	);

	const onDragEnd = useCallback(
		({ event }: { event: React.PointerEvent }) => {
			if (dragStateRef.current) {
				editor.timeline.commitPreview();
				dragStateRef.current = null;
			}
			(event.currentTarget as HTMLElement).releasePointerCapture(
				event.pointerId,
			);
		},
		[editor],
	);

	return {
		selectedWithBounds,
		rawMask,
		mask,
		isDrawing,
		selectedPointIds,
		placePointOrClose,
		insertOnSegment,
		deleteSelectedPoints,
		closePath,
		selectPoint,
		beginDrag,
		onDragMove,
		onDragEnd,
	};
}
