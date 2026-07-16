"use client";

/**
 * Timeline VU meter — L/R peak levels with decay + peak-hold + a latching
 * clip indicator, docked in the timeline toolbar (see timeline-toolbar.tsx:
 * ToolbarRightSection, placed beside the zoom controls — the toolbar is
 * always visible whenever the timeline is, and a compact two-bar meter
 * there doesn't crowd out any existing control, unlike inserting a new
 * always-open panel into the timeline body).
 *
 * Mechanism + numeric parameters: §4.2,
 * apps/web/docs/poach/palmier-delta-refresh-2026-07-14.md (idea-only —
 * GPL-3.0 source never consulted). Taps the *existing* playback audio graph
 * via editor.audio.getStereoPeakLevels() (AnalyserNode pair added to
 * AudioManager's master bus) rather than building a second decode path.
 *
 * Driven entirely off a canvas rAF loop reading imperative state — no
 * per-tick React state/store writes.
 */

import { useEffect, useRef } from "react";
import { useEditor } from "@/hooks/use-editor";
import {
	type VuChannelState,
	clearClipLatch,
	createInitialVuChannelState,
	dbToUnitRange,
	linearToDb,
	stepVuChannelState,
} from "@/lib/audio/vu-meter-math";

const METER_WIDTH_PX = 44;
const METER_HEIGHT_PX = 26;
const BAR_GAP_PX = 3;
const CLIP_STRIP_HEIGHT_PX = 3;
const DPR = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

function barColorForUnit(unit: number): string {
	if (unit >= dbToUnitRange(-3)) return "#ef4444"; // red: near/at clip
	if (unit >= dbToUnitRange(-12)) return "#eab308"; // yellow: hot
	return "#22c55e"; // green: nominal
}

interface MeterRuntimeState {
	left: VuChannelState;
	right: VuChannelState;
	lastFrameTime: number | null;
}

export function TimelineVuMeter() {
	const editor = useEditor();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const rafRef = useRef<number>(0);
	const stateRef = useRef<MeterRuntimeState>({
		left: createInitialVuChannelState(),
		right: createInitialVuChannelState(),
		lastFrameTime: null,
	});

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		canvas.width = METER_WIDTH_PX * DPR;
		canvas.height = METER_HEIGHT_PX * DPR;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.scale(DPR, DPR);

		const barWidth = (METER_WIDTH_PX - BAR_GAP_PX) / 2;
		const barAreaHeight = METER_HEIGHT_PX - CLIP_STRIP_HEIGHT_PX - 2;

		const drawChannel = ({
			x,
			state,
		}: {
			x: number;
			state: VuChannelState;
		}): void => {
			const levelUnit = dbToUnitRange(state.levelDb);
			const peakUnit = dbToUnitRange(state.peakDb);

			// Level bar, bottom-up.
			const levelHeight = levelUnit * barAreaHeight;
			ctx.fillStyle = barColorForUnit(levelUnit);
			ctx.fillRect(
				x,
				CLIP_STRIP_HEIGHT_PX + 2 + (barAreaHeight - levelHeight),
				barWidth,
				levelHeight,
			);

			// Peak-hold tick.
			const peakY =
				CLIP_STRIP_HEIGHT_PX + 2 + (barAreaHeight - peakUnit * barAreaHeight);
			ctx.fillStyle = peakUnit >= dbToUnitRange(-3) ? "#ef4444" : "#e5e7eb";
			ctx.fillRect(
				x,
				Math.max(CLIP_STRIP_HEIGHT_PX + 2, peakY - 1),
				barWidth,
				1.5,
			);

			// Clip-latch strip.
			ctx.fillStyle = state.clipped ? "#ef4444" : "rgba(255,255,255,0.08)";
			ctx.fillRect(x, 0, barWidth, CLIP_STRIP_HEIGHT_PX);
		};

		const draw = (now: number): void => {
			const runtime = stateRef.current;
			const dtSeconds =
				runtime.lastFrameTime === null
					? 0
					: (now - runtime.lastFrameTime) / 1000;
			runtime.lastFrameTime = now;

			const isPlaying = editor.playback.getIsPlaying();
			const peaks = editor.audio.getStereoPeakLevels();

			const leftInputDb =
				isPlaying && peaks ? linearToDb(peaks.left) : Number.NEGATIVE_INFINITY;
			const rightInputDb =
				isPlaying && peaks ? linearToDb(peaks.right) : Number.NEGATIVE_INFINITY;

			runtime.left = stepVuChannelState({
				state: runtime.left,
				inputDb: leftInputDb,
				dtSeconds,
			});
			runtime.right = stepVuChannelState({
				state: runtime.right,
				inputDb: rightInputDb,
				dtSeconds,
			});

			ctx.clearRect(0, 0, METER_WIDTH_PX, METER_HEIGHT_PX);
			drawChannel({ x: 0, state: runtime.left });
			drawChannel({ x: barWidth + BAR_GAP_PX, state: runtime.right });

			rafRef.current = requestAnimationFrame(draw);
		};

		rafRef.current = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(rafRef.current);
	}, [editor]);

	const handleClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		if (y > CLIP_STRIP_HEIGHT_PX + 1) return; // only the top clip strip is clickable

		const barWidth = (METER_WIDTH_PX - BAR_GAP_PX) / 2;
		const runtime = stateRef.current;
		if (x < barWidth) {
			runtime.left = clearClipLatch(runtime.left);
		} else if (x > barWidth + BAR_GAP_PX) {
			runtime.right = clearClipLatch(runtime.right);
		} else {
			// Clicked the gap between bars — clear both.
			runtime.left = clearClipLatch(runtime.left);
			runtime.right = clearClipLatch(runtime.right);
		}
	};

	return (
		<canvas
			ref={canvasRef}
			role="button"
			tabIndex={0}
			aria-label="Timeline VU meter — click the red strip to clear a clip indicator"
			title="L/R peak levels — click the top strip to clear a clip indicator"
			onClick={handleClick}
			style={{ width: METER_WIDTH_PX, height: METER_HEIGHT_PX }}
			className="cursor-pointer rounded-sm"
		/>
	);
}
