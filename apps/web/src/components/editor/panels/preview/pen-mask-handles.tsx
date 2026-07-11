"use client";

// Adapted from OpenCut-app/OpenCut (pre-rewrite tag, MIT) —
// masks/preview/components/mask-handles.tsx (freeform overlay). Renders the
// pen path plus draggable anchors / bezier tangent handles / segment insert
// targets over the preview canvas. Preview-only chrome: nothing here composites
// into export (the mask itself does, via the render pipeline).
import { useEffect } from "react";
import { usePenMask, getPenMaskTransform } from "@/hooks/use-pen-mask";
import { useEditor } from "@/hooks/use-editor";
import {
	getFreeformAnchors,
	type FreeformAnchor,
} from "@/lib/effects/masks/freeform-path";
import { canvasToOverlay } from "@/lib/preview/preview-coords";
import { cn } from "@/utils/ui";
import { getOverlayContext } from "./transform-handles";

const ANCHOR_HIT_SIZE = 16;
const ANCHOR_DOT_SIZE = 9;
const HANDLE_DOT_SIZE = 8;
const SEGMENT_HIT_WIDTH = 14;
const STROKE = "var(--color-amber-400, #fbbf24)";

interface OverlayAnchor {
	id: string;
	anchor: { x: number; y: number };
	inHandle: { x: number; y: number };
	outHandle: { x: number; y: number };
}

function buildPathData({
	anchors,
	closed,
}: {
	anchors: OverlayAnchor[];
	closed: boolean;
}): string {
	if (anchors.length === 0) return "";
	const parts = [`M ${anchors[0].anchor.x},${anchors[0].anchor.y}`];
	for (let i = 1; i < anchors.length; i++) {
		const prev = anchors[i - 1];
		const cur = anchors[i];
		parts.push(
			`C ${prev.outHandle.x},${prev.outHandle.y} ${cur.inHandle.x},${cur.inHandle.y} ${cur.anchor.x},${cur.anchor.y}`,
		);
	}
	if (closed && anchors.length > 1) {
		const last = anchors[anchors.length - 1];
		const first = anchors[0];
		parts.push(
			`C ${last.outHandle.x},${last.outHandle.y} ${first.inHandle.x},${first.inHandle.y} ${first.anchor.x},${first.anchor.y} Z`,
		);
	}
	return parts.join(" ");
}

function segmentPathData({
	anchors,
	index,
	closed,
}: {
	anchors: OverlayAnchor[];
	index: number;
	closed: boolean;
}): string {
	const start = anchors[index];
	const end = anchors[(index + 1) % anchors.length];
	if (!start || !end) return "";
	if (!closed && index >= anchors.length - 1) return "";
	return `M ${start.anchor.x},${start.anchor.y} C ${start.outHandle.x},${start.outHandle.y} ${end.inHandle.x},${end.inHandle.y} ${end.anchor.x},${end.anchor.y}`;
}

export function PenMaskHandles({
	canvasRef,
	containerRef,
}: {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
	containerRef: React.RefObject<HTMLDivElement | null>;
}) {
	const {
		selectedWithBounds,
		rawMask,
		mask,
		isDrawing,
		selectedPointIds,
		placePointOrClose,
		insertOnSegment,
		deleteSelectedPoints,
		selectPoint,
		beginDrag,
		onDragMove,
		onDragEnd,
	} = usePenMask({ canvasRef });

	const editor = useEditor();
	const canvasSize = editor.project.getActive().settings.canvasSize;

	// Delete/Backspace removes the selected anchors (ignored while typing).
	useEffect(() => {
		if (selectedPointIds.length === 0) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			const target = event.target as HTMLElement | null;
			const tag = target?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
				return;
			}
			event.preventDefault();
			deleteSelectedPoints();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [selectedPointIds, deleteSelectedPoints]);

	if (!selectedWithBounds || !rawMask || !mask) return null;

	const overlayContext = getOverlayContext({ canvasRef, containerRef });
	if (!overlayContext) return null;

	const { bounds } = selectedWithBounds;
	const { canvasRect, containerRect } = overlayContext;

	const toOverlay = ({ x, y }: { x: number; y: number }) =>
		canvasToOverlay({
			canvasX: x,
			canvasY: y,
			canvasRect,
			containerRect,
			canvasSize,
		});

	const transform = getPenMaskTransform({ mask: rawMask, bounds });
	const canvasAnchors: FreeformAnchor[] = getFreeformAnchors({
		points: mask.points,
		transform,
	});
	const anchors: OverlayAnchor[] = canvasAnchors.map((a) => ({
		id: a.id,
		anchor: toOverlay(a.anchor),
		inHandle: toOverlay(a.inHandle),
		outHandle: toOverlay(a.outHandle),
	}));

	const pathData = buildPathData({ anchors, closed: mask.closed });
	const center = toOverlay(transform.center);
	const showMoveHandle = !isDrawing && mask.points.length > 0;
	const showSegmentInserts = !isDrawing && mask.closed;

	return (
		<div className="pointer-events-none absolute inset-0" aria-hidden>
			{/* Draw-mode click catcher: append an anchor or close the path. */}
			{isDrawing && (
				<div
					className="absolute inset-0 cursor-crosshair"
					style={{ pointerEvents: "auto" }}
					onPointerDown={(event) => placePointOrClose({ event })}
				/>
			)}

			<svg
				className="pointer-events-none absolute inset-0 overflow-visible"
				width="100%"
				height="100%"
				aria-hidden
				role="presentation"
			>
				<title>Pen mask path</title>
				{pathData && (
					<path
						d={pathData}
						fill="none"
						stroke={STROKE}
						strokeWidth={1.5}
						strokeDasharray={mask.closed ? undefined : "4 3"}
						vectorEffect="non-scaling-stroke"
					/>
				)}
				{showSegmentInserts &&
					anchors.map((startAnchor, index) => {
						const d = segmentPathData({ anchors, index, closed: true });
						if (!d) return null;
						return (
							<path
								key={`segment-${startAnchor.id}`}
								d={d}
								fill="none"
								stroke="transparent"
								strokeWidth={SEGMENT_HIT_WIDTH}
								style={{ pointerEvents: "stroke", cursor: "copy" }}
								onPointerDown={(event) =>
									insertOnSegment({ event, segmentIndex: index })
								}
							/>
						);
					})}
				{/* Tangent guide lines for the selected anchor(s). */}
				{!isDrawing &&
					anchors
						.filter((a) => selectedPointIds.includes(a.id))
						.flatMap((a) => [
							<line
								key={`in-line-${a.id}`}
								x1={a.anchor.x}
								y1={a.anchor.y}
								x2={a.inHandle.x}
								y2={a.inHandle.y}
								stroke={STROKE}
								strokeWidth={1}
								strokeOpacity={0.7}
								vectorEffect="non-scaling-stroke"
							/>,
							<line
								key={`out-line-${a.id}`}
								x1={a.anchor.x}
								y1={a.anchor.y}
								x2={a.outHandle.x}
								y2={a.outHandle.y}
								stroke={STROKE}
								strokeWidth={1}
								strokeOpacity={0.7}
								vectorEffect="non-scaling-stroke"
							/>,
						])}
			</svg>

			{showMoveHandle && (
				<PenHandleButton
					x={center.x}
					y={center.y}
					variant="move"
					onPointerDown={(event) =>
						beginDrag({ event, drag: { kind: "path" } })
					}
					onPointerMove={(event) => onDragMove({ event })}
					onPointerUp={(event) => onDragEnd({ event })}
				/>
			)}

			{/* Anchors. In draw mode they are non-interactive (the catcher handles
			    clicks); otherwise they select + drag. */}
			{anchors.map((a, index) => (
				<PenHandleButton
					key={`anchor-${a.id}`}
					x={a.anchor.x}
					y={a.anchor.y}
					variant={
						selectedPointIds.includes(a.id) ? "anchor-selected" : "anchor"
					}
					emphasized={isDrawing && index === 0}
					interactive={!isDrawing}
					onPointerDown={(event) => {
						selectPoint({ pointId: a.id });
						beginDrag({ event, drag: { kind: "anchor", pointId: a.id } });
					}}
					onPointerMove={(event) => onDragMove({ event })}
					onPointerUp={(event) => onDragEnd({ event })}
				/>
			))}

			{/* Tangent handles for the selected anchor(s). */}
			{!isDrawing &&
				anchors
					.filter((a) => selectedPointIds.includes(a.id))
					.flatMap((a) => [
						<PenHandleButton
							key={`in-${a.id}`}
							x={a.inHandle.x}
							y={a.inHandle.y}
							variant="tangent"
							onPointerDown={(event) =>
								beginDrag({
									event,
									drag: { kind: "tangent", pointId: a.id, side: "in" },
								})
							}
							onPointerMove={(event) => onDragMove({ event })}
							onPointerUp={(event) => onDragEnd({ event })}
						/>,
						<PenHandleButton
							key={`out-${a.id}`}
							x={a.outHandle.x}
							y={a.outHandle.y}
							variant="tangent"
							onPointerDown={(event) =>
								beginDrag({
									event,
									drag: { kind: "tangent", pointId: a.id, side: "out" },
								})
							}
							onPointerMove={(event) => onDragMove({ event })}
							onPointerUp={(event) => onDragEnd({ event })}
						/>,
					])}
		</div>
	);
}

type PenHandleVariant = "anchor" | "anchor-selected" | "tangent" | "move";

function PenHandleButton({
	x,
	y,
	variant,
	emphasized = false,
	interactive = true,
	onPointerDown,
	onPointerMove,
	onPointerUp,
}: {
	x: number;
	y: number;
	variant: PenHandleVariant;
	emphasized?: boolean;
	interactive?: boolean;
	onPointerDown: (event: React.PointerEvent) => void;
	onPointerMove: (event: React.PointerEvent) => void;
	onPointerUp: (event: React.PointerEvent) => void;
}) {
	const isTangent = variant === "tangent";
	const dotSize = isTangent ? HANDLE_DOT_SIZE : ANCHOR_DOT_SIZE;
	const size = emphasized ? dotSize + 3 : dotSize;

	return (
		<button
			type="button"
			className={cn(
				"absolute flex items-center justify-center outline-none",
				variant === "move" ? "cursor-move" : "cursor-pointer",
			)}
			style={{
				left: x - ANCHOR_HIT_SIZE / 2,
				top: y - ANCHOR_HIT_SIZE / 2,
				width: ANCHOR_HIT_SIZE,
				height: ANCHOR_HIT_SIZE,
				pointerEvents: interactive ? "auto" : "none",
			}}
			onPointerDown={interactive ? onPointerDown : undefined}
			onPointerMove={interactive ? onPointerMove : undefined}
			onPointerUp={interactive ? onPointerUp : undefined}
			onPointerLeave={interactive ? onPointerUp : undefined}
			onKeyDown={(event) => event.key === "Enter" && event.preventDefault()}
		>
			<div
				className={cn(
					"border border-amber-400",
					variant === "move" && "rotate-45 bg-amber-400/70",
					variant === "anchor" && "rounded-sm bg-background",
					variant === "anchor-selected" && "rounded-sm bg-amber-400",
					isTangent && "rounded-full bg-background",
				)}
				style={{ width: size, height: size }}
			/>
		</button>
	);
}
