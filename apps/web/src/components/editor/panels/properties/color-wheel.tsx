"use client";

import { useCallback, useRef } from "react";
import { cn } from "@/utils/ui";

const NEUTRAL = "#808080";

function clamp01(v: number): number {
	return Math.max(0, Math.min(1, v));
}

/** Pure-hue RGB (0..1) for a hue angle in degrees, s=1, l=0.5. */
function hueToRgb(hueDeg: number): [number, number, number] {
	const h = ((hueDeg % 360) + 360) % 360;
	const c = 1;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	// map full-hue [0,1] where 0.5 = neutral component; scale to keep midpoint semantics
	return [r, g, b];
}

function toHex(n: number): string {
	return Math.round(clamp01(n) * 255)
		.toString(16)
		.padStart(2, "0");
}

/** angle (deg) + radius (0..1) → hex color that decodes to a tint around neutral gray. */
function polarToHex(angleDeg: number, radius: number): string {
	if (radius <= 0.001) return NEUTRAL;
	const [hr, hg, hb] = hueToRgb(angleDeg);
	// Blend from neutral 0.5 toward the pure hue by radius.
	const r = 0.5 + (hr - 0.5) * radius;
	const g = 0.5 + (hg - 0.5) * radius;
	const b = 0.5 + (hb - 0.5) * radius;
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Decode a hex value back into a puck position (x, y in [-1, 1]). */
function hexToPolar(hex: string): { x: number; y: number } {
	const matched = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
	if (!matched) return { x: 0, y: 0 };
	const int = parseInt(matched[1], 16);
	const r = (((int >> 16) & 0xff) / 255 - 0.5) * 2;
	const g = (((int >> 8) & 0xff) / 255 - 0.5) * 2;
	const b = ((int & 0xff) / 255 - 0.5) * 2;
	// Project RGB offset onto a hue circle (R at 0deg, G at 120, B at 240).
	const ax = r + g * Math.cos((120 * Math.PI) / 180) + b * Math.cos((240 * Math.PI) / 180);
	const ay = g * Math.sin((120 * Math.PI) / 180) + b * Math.sin((240 * Math.PI) / 180);
	// Screen y grows downward.
	return { x: clamp01(Math.abs(ax)) * Math.sign(ax), y: -clamp01(Math.abs(ay)) * Math.sign(ay) };
}

export function ColorWheel({
	value,
	onPreview,
	onCommit,
	size = 96,
}: {
	value: string;
	onPreview: (hex: string) => void;
	onCommit: () => void;
	size?: number;
}) {
	const ref = useRef<HTMLDivElement>(null);

	const pos = hexToPolar(value);

	const updateFromEvent = useCallback(
		(clientX: number, clientY: number) => {
			const el = ref.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			let nx = (clientX - cx) / (rect.width / 2);
			let ny = (clientY - cy) / (rect.height / 2);
			const radius = Math.min(1, Math.hypot(nx, ny));
			if (radius > 1) {
				nx /= radius;
				ny /= radius;
			}
			// screen y down → invert for standard angle; atan2(-ny, nx)
			const angle = (Math.atan2(-ny, nx) * 180) / Math.PI;
			onPreview(polarToHex(angle, radius));
		},
		[onPreview],
	);

	const handlePointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			e.currentTarget.setPointerCapture(e.pointerId);
			updateFromEvent(e.clientX, e.clientY);
		},
		[updateFromEvent],
	);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (e.buttons !== 1) return;
			updateFromEvent(e.clientX, e.clientY);
		},
		[updateFromEvent],
	);

	const handlePointerUp = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (e.currentTarget.hasPointerCapture(e.pointerId)) {
				e.currentTarget.releasePointerCapture(e.pointerId);
			}
			onCommit();
		},
		[onCommit],
	);

	const puckX = (pos.x * 0.5 + 0.5) * 100;
	const puckY = (-pos.y * 0.5 + 0.5) * 100;

	return (
		<div className="flex flex-col items-center gap-1.5">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: draggable color wheel puck */}
			<div
				ref={ref}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				className={cn(
					"relative cursor-crosshair rounded-full border border-border touch-none",
				)}
				style={{
					width: size,
					height: size,
					background:
						"radial-gradient(circle at center, rgba(255,255,255,0.9) 0%, rgba(128,128,128,0) 60%), conic-gradient(from 90deg, red, magenta, blue, cyan, lime, yellow, red)",
				}}
			>
				<div
					className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
					style={{
						left: `${puckX}%`,
						top: `${puckY}%`,
						backgroundColor: value === NEUTRAL ? "transparent" : value,
					}}
				/>
			</div>
			<button
				type="button"
				className="text-3xs text-muted-foreground hover:text-foreground"
				onClick={() => {
					onPreview(NEUTRAL);
					onCommit();
				}}
			>
				Reset
			</button>
		</div>
	);
}
