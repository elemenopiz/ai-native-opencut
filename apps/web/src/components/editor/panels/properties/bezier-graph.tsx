"use client";

// Adapted from OpenCut-app/OpenCut's `timeline/components/graph-editor/bezier-graph.tsx`
// (pre-rewrite tag, MIT). See THIRD_PARTY_NOTICES.md. Ported to bind directly
// to our `CubicBezierControlPoints` tuple (we store the bezier straight on the
// keyframe) instead of their per-keyframe drag-handle model, so their
// `curve-bridge.ts` handle<->bezier conversion doesn't apply here.

import { useRef, useState, type PointerEvent } from "react";
import { useShiftKey } from "@/hooks/use-shift-key";
import {
	clampBezierHandleX,
	sampleBezierCurvePoints,
	updateBezierHandle,
	type BezierHandleId,
} from "@/lib/animation";
import { cn } from "@/utils/ui";
import type { CubicBezierControlPoints } from "@/types/animation";

const GRAPH_WIDTH = 140;
const GRAPH_HEIGHT = 94;
const GRAPH_PADDING = 12;
const SVG_WIDTH = GRAPH_WIDTH + GRAPH_PADDING * 2;
const SVG_HEIGHT = GRAPH_HEIGHT + GRAPH_PADDING * 2;
const HANDLE_RADIUS = 3.5;
const ENDPOINT_RADIUS = 2;
const CURVE_SEGMENTS = 64;

export const BEZIER_GRAPH_MIN_HEIGHT = SVG_HEIGHT;

function toSvgX({ value }: { value: number }): number {
	return GRAPH_PADDING + value * GRAPH_WIDTH;
}

function toSvgY({ value }: { value: number }): number {
	return GRAPH_PADDING + (1 - value) * GRAPH_HEIGHT;
}

function fromSvgX({ svgX }: { svgX: number }): number {
	return clampBezierHandleX({ value: (svgX - GRAPH_PADDING) / GRAPH_WIDTH });
}

function fromSvgY({ svgY }: { svgY: number }): number {
	return 1 - (svgY - GRAPH_PADDING) / GRAPH_HEIGHT;
}

/** Clamp a handle's *screen* position so it stays paintable inside the SVG
 * viewbox even when its underlying y value overshoots past [0, 1] (the value
 * itself is preserved — this only affects where the dot is drawn). */
function clampHandleScreenY({ svgY }: { svgY: number }): number {
	return Math.max(HANDLE_RADIUS, Math.min(SVG_HEIGHT - HANDLE_RADIUS, svgY));
}

function curvePath({ bezier }: { bezier: CubicBezierControlPoints }): string {
	const points = sampleBezierCurvePoints({ bezier, segments: CURVE_SEGMENTS });
	return `M${points
		.map(({ x, y }) => `${toSvgX({ value: x })},${toSvgY({ value: y })}`)
		.join("L")}`;
}

export function BezierGraph({
	value,
	onChange,
	onChangeEnd,
	onCancel,
}: {
	value: CubicBezierControlPoints;
	onChange?: (value: CubicBezierControlPoints) => void;
	onChangeEnd?: (value: CubicBezierControlPoints) => void;
	onCancel?: () => void;
}) {
	const svgRef = useRef<SVGSVGElement>(null);
	const [activeHandle, setActiveHandle] = useState<BezierHandleId | null>(null);
	const isShiftPressedRef = useShiftKey();
	// Kept in sync with the latest dragged value so `onPointerUp` can commit it
	// even if `value` hasn't round-tripped back through props yet.
	const latestValueRef = useRef(value);
	latestValueRef.current = value;

	function getPointerPosition({ event }: { event: PointerEvent }): {
		x: number;
		y: number;
	} {
		const svg = svgRef.current;
		if (!svg) return { x: 0, y: 0 };
		const rect = svg.getBoundingClientRect();
		return {
			x: (event.clientX - rect.left) * (SVG_WIDTH / rect.width),
			y: (event.clientY - rect.top) * (SVG_HEIGHT / rect.height),
		};
	}

	function onHandlePointerDown({ handle }: { handle: BezierHandleId }) {
		return (event: PointerEvent<SVGCircleElement>) => {
			event.preventDefault();
			event.stopPropagation();
			setActiveHandle(handle);
			event.currentTarget.setPointerCapture(event.pointerId);
		};
	}

	function onPointerMove({ event }: { event: PointerEvent<SVGSVGElement> }) {
		if (!activeHandle) return;
		const pointerPos = getPointerPosition({ event });
		const next = updateBezierHandle({
			bezier: value,
			handle: activeHandle,
			x: fromSvgX({ svgX: pointerPos.x }),
			y: fromSvgY({ svgY: pointerPos.y }),
			isSnapEnabled: !isShiftPressedRef.current,
		});
		latestValueRef.current = next;
		onChange?.(next);
	}

	function onPointerUp() {
		if (!activeHandle) return;
		setActiveHandle(null);
		onChangeEnd?.(latestValueRef.current);
	}

	function onPointerCancel() {
		if (!activeHandle) return;
		setActiveHandle(null);
		onCancel?.();
	}

	const path = curvePath({ bezier: value });
	const c1 = { x: toSvgX({ value: value[0] }), y: toSvgY({ value: value[1] }) };
	const c2 = { x: toSvgX({ value: value[2] }), y: toSvgY({ value: value[3] }) };
	const c1Clamped = { x: c1.x, y: clampHandleScreenY({ svgY: c1.y }) };
	const c2Clamped = { x: c2.x, y: clampHandleScreenY({ svgY: c2.y }) };
	const p0 = { x: toSvgX({ value: 0 }), y: toSvgY({ value: 0 }) };
	const p1 = { x: toSvgX({ value: 1 }), y: toSvgY({ value: 1 }) };

	return (
		<svg
			ref={svgRef}
			viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
			className="bg-foreground/3 w-full cursor-crosshair select-none touch-none"
			onPointerMove={(event) => onPointerMove({ event })}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
		>
			<title>Bezier curve editor</title>
			<line
				x1={p0.x}
				y1={p0.y}
				x2={p1.x}
				y2={p1.y}
				className="stroke-foreground/8"
				strokeWidth={1}
				strokeDasharray="3 3"
			/>
			<line
				x1={p0.x}
				y1={p0.y}
				x2={c1Clamped.x}
				y2={c1Clamped.y}
				className="stroke-primary/30"
				strokeWidth={1}
			/>
			<line
				x1={p1.x}
				y1={p1.y}
				x2={c2Clamped.x}
				y2={c2Clamped.y}
				className="stroke-primary/30"
				strokeWidth={1}
			/>
			<path
				d={path}
				fill="none"
				className="stroke-primary"
				strokeWidth={2}
				strokeLinecap="round"
			/>
			<circle
				cx={p0.x}
				cy={p0.y}
				r={ENDPOINT_RADIUS}
				className="fill-foreground/20"
			/>
			<circle
				cx={p1.x}
				cy={p1.y}
				r={ENDPOINT_RADIUS}
				className="fill-foreground/20"
			/>
			<circle
				cx={c1Clamped.x}
				cy={c1Clamped.y}
				r={HANDLE_RADIUS}
				className={cn(
					"fill-primary cursor-grab",
					activeHandle === "c1" && "cursor-grabbing",
				)}
				onPointerDown={onHandlePointerDown({ handle: "c1" })}
			/>
			<circle
				cx={c2Clamped.x}
				cy={c2Clamped.y}
				r={HANDLE_RADIUS}
				className={cn(
					"fill-primary cursor-grab",
					activeHandle === "c2" && "cursor-grabbing",
				)}
				onPointerDown={onHandlePointerDown({ handle: "c2" })}
			/>
		</svg>
	);
}

/** Small (non-interactive) curve preview used for the picker's trigger button
 * and the preset-grid thumbnails. */
export function BezierCurveThumb({
	value,
	width = 40,
	height = 22,
}: {
	value: CubicBezierControlPoints;
	width?: number;
	height?: number;
}) {
	const paddingX = width * 0.1;
	const paddingY = height * 0.15;
	const points = sampleBezierCurvePoints({ bezier: value, segments: 24 });
	const path = `M${points
		.map(
			({ x, y }) =>
				`${paddingX + x * (width - paddingX * 2)},${paddingY + (1 - y) * (height - paddingY * 2)}`,
		)
		.join("L")}`;

	return (
		<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
			<title>Curve preview</title>
			<path
				d={path}
				fill="none"
				className="stroke-current"
				strokeWidth={1.5}
				strokeLinecap="round"
			/>
		</svg>
	);
}
