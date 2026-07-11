"use client";

// Adapted from OpenCut-app/opencut-classic (MIT). See THIRD_PARTY_NOTICES.
import {
	useMaskHandles,
	getMaskCenterCanvas,
	rotateVector,
	type MaskHandle,
} from "@/hooks/use-mask-handles";
import { useEditor } from "@/hooks/use-editor";
import type { ResolvedMaskShape } from "@/lib/effects/definitions/shape-mask";
import { canvasToOverlay, getDisplayScale } from "@/lib/preview/preview-coords";
import { cn } from "@/utils/ui";
import { getOverlayContext } from "./transform-handles";

const HANDLE_SIZE = 8;
const HANDLE_HIT_AREA_SIZE = 18;
const STAR_INNER_RADIUS_RATIO = 0.45;
const STAR_VERTEX_COUNT = 10;
// Screen-space (overlay pixel) offset for the floating rotation/feather icon
// handles, converted to canvas units via displayScale so it stays a constant
// visual size regardless of zoom.
const ICON_HANDLE_OFFSET_SCREEN_PX = 24;
// How far the split mask's guide line extends past the mask center, in
// multiples of the canvas's largest dimension — just needs to comfortably
// span the visible preview regardless of pan/zoom.
const SPLIT_LINE_EXTENT_MULTIPLIER = 4;

const CORNER_HANDLES: MaskHandle[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
];
const WIDTH_EDGE_HANDLES: MaskHandle[] = ["left", "right"];
const BARS_EDGE_HANDLES: MaskHandle[] = ["top", "bottom"];

function getHandleLocalOffset({
	handle,
	halfWidth,
	halfHeight,
	iconOffset,
	featherOffset,
}: {
	handle: MaskHandle;
	halfWidth: number;
	halfHeight: number;
	iconOffset: number;
	featherOffset: number;
}): { x: number; y: number } {
	switch (handle) {
		case "top-left":
			return { x: -halfWidth, y: -halfHeight };
		case "top-right":
			return { x: halfWidth, y: -halfHeight };
		case "bottom-left":
			return { x: -halfWidth, y: halfHeight };
		case "bottom-right":
			return { x: halfWidth, y: halfHeight };
		case "top":
			return { x: 0, y: -halfHeight };
		case "bottom":
			return { x: 0, y: halfHeight };
		case "left":
			return { x: -halfWidth, y: 0 };
		case "right":
			return { x: halfWidth, y: 0 };
		case "rotation":
			return { x: 0, y: -halfHeight - iconOffset };
		case "feather":
			return { x: 0, y: halfHeight + featherOffset };
		case "move":
			return { x: 0, y: 0 };
	}
}

function getHandleCursor({ handle }: { handle: MaskHandle }): string {
	switch (handle) {
		case "top-left":
		case "bottom-right":
			return "cursor-nwse-resize";
		case "top-right":
		case "bottom-left":
			return "cursor-nesw-resize";
		case "top":
		case "bottom":
			return "cursor-ns-resize";
		case "left":
		case "right":
			return "cursor-ew-resize";
		case "rotation":
			return "cursor-crosshair";
		case "feather":
			return "cursor-ns-resize";
		case "move":
			return "cursor-move";
	}
}

function getStarPolygonPoints({
	width,
	height,
}: {
	width: number;
	height: number;
}): string {
	const points: string[] = [];
	for (let index = 0; index < STAR_VERTEX_COUNT; index++) {
		const isOuterVertex = index % 2 === 0;
		const ratio = isOuterVertex ? 1 : STAR_INNER_RADIUS_RATIO;
		const angle = (index * Math.PI) / (STAR_VERTEX_COUNT / 2) - Math.PI / 2;
		const x = width / 2 + (width / 2) * ratio * Math.cos(angle);
		const y = height / 2 + (height / 2) * ratio * Math.sin(angle);
		points.push(`${x},${y}`);
	}
	return points.join(" ");
}

/** SVG path for a heart, matching the proportions of the heart mask's SDF
 * (see buildHeartPath in opencut-classic's masks/builtin/definitions/heart.ts). */
function getHeartPathData({
	width,
	height,
}: {
	width: number;
	height: number;
}): string {
	const cx = width / 2;
	const cy = height / 2;
	const halfWidth = width / 2;
	const halfHeight = height / 2;
	return [
		`M ${cx},${cy - halfHeight * 0.475}`,
		`C ${cx + halfWidth},${cy - halfHeight * 1.225} ${cx + halfWidth},${cy - halfHeight * 0.125} ${cx},${cy + halfHeight * 0.725}`,
		`C ${cx - halfWidth},${cy - halfHeight * 0.125} ${cx - halfWidth},${cy - halfHeight * 1.225} ${cx},${cy - halfHeight * 0.475}`,
		"Z",
	].join(" ");
}

/** SVG path for a 4-point diamond (rhombus), matching sdDiamond's boundary. */
function getDiamondPathData({
	width,
	height,
}: {
	width: number;
	height: number;
}): string {
	return `M ${width / 2},0 L ${width},${height / 2} L ${width / 2},${height} L 0,${height / 2} Z`;
}

export function MaskHandles({
	canvasRef,
	containerRef,
}: {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
	containerRef: React.RefObject<HTMLDivElement | null>;
}) {
	const {
		selectedWithBounds,
		selectedMask,
		handleMaskPointerDown,
		handleMaskPointerMove,
		handleMaskPointerUp,
	} = useMaskHandles({ canvasRef });

	const editor = useEditor();
	const canvasSize = editor.project.getActive().settings.canvasSize;

	if (!selectedWithBounds || !selectedMask) return null;

	const overlayContext = getOverlayContext({ canvasRef, containerRef });
	if (!overlayContext) return null;

	const { bounds } = selectedWithBounds;
	const { canvasRect, containerRect } = overlayContext;
	const displayScale = getDisplayScale({ canvasRect, canvasSize });

	const toOverlay = ({
		canvasX,
		canvasY,
	}: {
		canvasX: number;
		canvasY: number;
	}) =>
		canvasToOverlay({
			canvasX,
			canvasY,
			canvasRect,
			containerRect,
			canvasSize,
		});

	const maskCenter = getMaskCenterCanvas({ mask: selectedMask, bounds });
	const totalRotation = bounds.rotation + selectedMask.rotation;
	const center = toOverlay({ canvasX: maskCenter.x, canvasY: maskCenter.y });

	const shortSideCanvas = Math.min(bounds.width, bounds.height);
	const iconOffsetCanvas = ICON_HANDLE_OFFSET_SCREEN_PX / displayScale.x;
	const featherOffsetCanvas =
		iconOffsetCanvas + selectedMask.feather * (shortSideCanvas * 0.5);

	const handlePointerHandlers = (handle: MaskHandle) => ({
		onPointerDown: (event: React.PointerEvent) =>
			handleMaskPointerDown({ event, handle }),
		onPointerMove: (event: React.PointerEvent) =>
			handleMaskPointerMove({ event }),
		onPointerUp: (event: React.PointerEvent) => handleMaskPointerUp({ event }),
	});

	if (selectedMask.type === "split") {
		// Split has no width/height — its interaction is a rotatable line
		// through the mask center, not a bounding box.
		const angleRad = (totalRotation * Math.PI) / 180;
		const normal = { x: Math.cos(angleRad), y: Math.sin(angleRad) };
		const lineDir = { x: -normal.y, y: normal.x };
		const extent =
			Math.max(canvasSize.width, canvasSize.height) *
			SPLIT_LINE_EXTENT_MULTIPLIER;
		const lineStart = toOverlay({
			canvasX: maskCenter.x - lineDir.x * extent,
			canvasY: maskCenter.y - lineDir.y * extent,
		});
		const lineEnd = toOverlay({
			canvasX: maskCenter.x + lineDir.x * extent,
			canvasY: maskCenter.y + lineDir.y * extent,
		});
		const rotationScreen = toOverlay({
			canvasX: maskCenter.x + normal.x * iconOffsetCanvas,
			canvasY: maskCenter.y + normal.y * iconOffsetCanvas,
		});
		const featherScreen = toOverlay({
			canvasX: maskCenter.x - normal.x * featherOffsetCanvas,
			canvasY: maskCenter.y - normal.y * featherOffsetCanvas,
		});

		return (
			<div className="pointer-events-none absolute inset-0" aria-hidden>
				<svg
					className="pointer-events-none absolute inset-0 overflow-visible"
					width="100%"
					height="100%"
					aria-hidden
					role="presentation"
				>
					<title>Split mask guide line</title>
					<line
						x1={lineStart.x}
						y1={lineStart.y}
						x2={lineEnd.x}
						y2={lineEnd.y}
						stroke="var(--color-amber-400, #fbbf24)"
						strokeWidth={1.5}
						strokeDasharray="4 3"
						vectorEffect="non-scaling-stroke"
					/>
				</svg>
				<MaskHandleButton
					handle="move"
					screen={center}
					{...handlePointerHandlers("move")}
				/>
				<MaskHandleButton
					handle="rotation"
					screen={rotationScreen}
					{...handlePointerHandlers("rotation")}
				/>
				<MaskHandleButton
					handle="feather"
					screen={featherScreen}
					{...handlePointerHandlers("feather")}
				/>
			</div>
		);
	}

	const halfWidth = (selectedMask.width * bounds.width) / 2;
	const halfHeight = (selectedMask.height * bounds.height) / 2;
	const outlineWidth = halfWidth * 2 * displayScale.x;
	const outlineHeight = halfHeight * 2 * displayScale.y;

	const isBars = selectedMask.type === "cinematic-bars";
	const handles: MaskHandle[] = [
		"move",
		...(isBars
			? BARS_EDGE_HANDLES
			: [...CORNER_HANDLES, ...WIDTH_EDGE_HANDLES]),
		"rotation",
		"feather",
	];

	return (
		<div className="pointer-events-none absolute inset-0" aria-hidden>
			<MaskOutline
				mask={selectedMask}
				center={center}
				outlineWidth={outlineWidth}
				outlineHeight={outlineHeight}
				rotation={totalRotation}
			/>
			{handles.map((handle) => {
				const localOffset = getHandleLocalOffset({
					handle,
					halfWidth,
					halfHeight,
					iconOffset: iconOffsetCanvas,
					featherOffset: featherOffsetCanvas,
				});
				const rotated = rotateVector({
					x: localOffset.x,
					y: localOffset.y,
					degrees: totalRotation,
				});
				const screen = toOverlay({
					canvasX: maskCenter.x + rotated.x,
					canvasY: maskCenter.y + rotated.y,
				});
				return (
					<MaskHandleButton
						key={handle}
						handle={handle}
						screen={screen}
						{...handlePointerHandlers(handle)}
					/>
				);
			})}
		</div>
	);
}

function MaskOutline({
	mask,
	center,
	outlineWidth,
	outlineHeight,
	rotation,
}: {
	mask: ResolvedMaskShape;
	center: { x: number; y: number };
	outlineWidth: number;
	outlineHeight: number;
	rotation: number;
}) {
	const baseStyle: React.CSSProperties = {
		left: center.x - outlineWidth / 2,
		top: center.y - outlineHeight / 2,
		width: outlineWidth,
		height: outlineHeight,
		transform: `rotate(${rotation}deg)`,
		transformOrigin: "center center",
		boxSizing: "border-box",
		opacity: 0.9,
	};

	if (
		mask.type === "star" ||
		mask.type === "heart" ||
		mask.type === "diamond"
	) {
		const width = Math.max(outlineWidth, 1);
		const height = Math.max(outlineHeight, 1);
		return (
			<svg
				className="pointer-events-none absolute overflow-visible"
				style={baseStyle}
				viewBox={`0 0 ${width} ${height}`}
				aria-hidden
			>
				{mask.type === "star" && (
					<polygon
						points={getStarPolygonPoints({ width, height })}
						fill="none"
						stroke="var(--color-amber-400, #fbbf24)"
						strokeWidth={1.5}
						strokeDasharray="4 3"
						vectorEffect="non-scaling-stroke"
					/>
				)}
				{mask.type === "heart" && (
					<path
						d={getHeartPathData({ width, height })}
						fill="none"
						stroke="var(--color-amber-400, #fbbf24)"
						strokeWidth={1.5}
						strokeDasharray="4 3"
						vectorEffect="non-scaling-stroke"
					/>
				)}
				{mask.type === "diamond" && (
					<path
						d={getDiamondPathData({ width, height })}
						fill="none"
						stroke="var(--color-amber-400, #fbbf24)"
						strokeWidth={1.5}
						strokeDasharray="4 3"
						vectorEffect="non-scaling-stroke"
					/>
				)}
			</svg>
		);
	}

	return (
		<div
			className={cn(
				"pointer-events-none absolute border border-dashed border-amber-400",
				mask.type === "ellipse" && "rounded-[50%]",
			)}
			style={{
				...baseStyle,
				...(mask.type === "cinematic-bars" && {
					borderLeft: "none",
					borderRight: "none",
				}),
			}}
		/>
	);
}

function MaskHandleButton({
	handle,
	screen,
	onPointerDown,
	onPointerMove,
	onPointerUp,
}: {
	handle: MaskHandle;
	screen: { x: number; y: number };
	onPointerDown: (event: React.PointerEvent) => void;
	onPointerMove: (event: React.PointerEvent) => void;
	onPointerUp: (event: React.PointerEvent) => void;
}) {
	return (
		<button
			type="button"
			className={cn(
				"absolute flex items-center justify-center outline-none",
				getHandleCursor({ handle }),
			)}
			style={{
				left: screen.x - HANDLE_HIT_AREA_SIZE / 2,
				top: screen.y - HANDLE_HIT_AREA_SIZE / 2,
				width: HANDLE_HIT_AREA_SIZE,
				height: HANDLE_HIT_AREA_SIZE,
				pointerEvents: "auto",
			}}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerLeave={onPointerUp}
			onKeyDown={(event) => event.key === "Enter" && event.preventDefault()}
			onKeyUp={(event) => event.key === "Enter" && event.preventDefault()}
		>
			<div
				className={cn(
					"bg-amber-400",
					handle === "move" && "rounded-full",
					handle === "rotation" &&
						"rounded-full border-2 border-amber-400 bg-transparent",
					handle === "feather" && "rotate-45",
					handle !== "move" &&
						handle !== "rotation" &&
						handle !== "feather" &&
						"rounded-sm",
				)}
				style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }}
			/>
		</button>
	);
}
