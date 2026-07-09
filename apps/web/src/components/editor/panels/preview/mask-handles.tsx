"use client";

// Adapted from OpenCut-app/opencut-classic (MIT). See THIRD_PARTY_NOTICES.
import { useMaskHandles, type MaskHandle } from "@/hooks/use-mask-handles";
import { useEditor } from "@/hooks/use-editor";
import type { ResolvedMaskShape } from "@/lib/effects/definitions/shape-mask";
import { canvasToOverlay, getDisplayScale } from "@/lib/preview/preview-coords";
import { cn } from "@/utils/ui";
import { getOverlayContext } from "./transform-handles";

const HANDLE_SIZE = 8;
const HANDLE_HIT_AREA_SIZE = 18;
const STAR_INNER_RADIUS_RATIO = 0.45;
const STAR_VERTEX_COUNT = 10;

const CORNER_HANDLES: MaskHandle[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
];
const EDGE_HANDLES: MaskHandle[] = ["top", "bottom"];

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

function getHandleLocalOffset({
	handle,
	halfWidth,
	halfHeight,
}: {
	handle: MaskHandle;
	halfWidth: number;
	halfHeight: number;
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

	// Mask center in canvas space: the fractional offset lives in element-local
	// space, so it rotates with the element.
	const centerOffset = rotateVector({
		x: selectedMask.centerX * bounds.width,
		y: selectedMask.centerY * bounds.height,
		degrees: bounds.rotation,
	});
	const maskCenter = {
		x: bounds.cx + centerOffset.x,
		y: bounds.cy + centerOffset.y,
	};
	const totalRotation = bounds.rotation + selectedMask.rotation;
	const halfWidth = (selectedMask.width * bounds.width) / 2;
	const halfHeight = (selectedMask.height * bounds.height) / 2;

	const center = toOverlay({ canvasX: maskCenter.x, canvasY: maskCenter.y });
	const outlineWidth = halfWidth * 2 * displayScale.x;
	const outlineHeight = halfHeight * 2 * displayScale.y;

	const handles =
		selectedMask.type === "cinematic-bars"
			? EDGE_HANDLES
			: CORNER_HANDLES;

	return (
		<div className="pointer-events-none absolute inset-0" aria-hidden>
			<MaskOutline
				mask={selectedMask}
				center={center}
				outlineWidth={outlineWidth}
				outlineHeight={outlineHeight}
				rotation={totalRotation}
			/>
			{[...handles, "move" as const].map((handle) => {
				const localOffset = getHandleLocalOffset({
					handle,
					halfWidth,
					halfHeight,
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
						onPointerDown={(event) =>
							handleMaskPointerDown({ event, handle })
						}
						onPointerMove={(event) => handleMaskPointerMove({ event })}
						onPointerUp={(event) => handleMaskPointerUp({ event })}
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

	if (mask.type === "star") {
		return (
			<svg
				className="pointer-events-none absolute overflow-visible"
				style={baseStyle}
				viewBox={`0 0 ${Math.max(outlineWidth, 1)} ${Math.max(outlineHeight, 1)}`}
				aria-hidden
			>
				<polygon
					points={getStarPolygonPoints({
						width: Math.max(outlineWidth, 1),
						height: Math.max(outlineHeight, 1),
					})}
					fill="none"
					stroke="var(--color-amber-400, #fbbf24)"
					strokeWidth={1.5}
					strokeDasharray="4 3"
					vectorEffect="non-scaling-stroke"
				/>
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
					handle === "move" ? "rounded-full" : "rounded-sm",
				)}
				style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }}
			/>
		</button>
	);
}
