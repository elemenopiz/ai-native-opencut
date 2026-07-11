"use client";

import { useEffect, useRef } from "react";
import { perfStats } from "@/services/renderer/perf-stats";

/** Low HUD refresh rate — stats collection itself runs per frame. */
const HUD_UPDATE_INTERVAL_MS = 250;

/**
 * Compositor frame-time overlay for the preview panel. Enables the perf-stats
 * collector while mounted and paints via direct textContent writes on an
 * interval — never React state — so the HUD itself costs nothing per frame.
 */
export function PerfHud() {
	const textRef = useRef<HTMLPreElement>(null);

	useEffect(() => {
		perfStats.setEnabled({ enabled: true });

		const update = () => {
			const el = textRef.current;
			if (!el) return;
			const s = perfStats.getStats();
			el.textContent = [
				`fps     ${s.fps.toFixed(1)}`,
				`frame   ${s.avgFrameMs.toFixed(1)}ms avg  ${s.p95FrameMs.toFixed(1)}ms p95`,
				`decode  ${s.avgDecodeMs.toFixed(1)}ms`,
				`effects ${s.avgEffectMs.toFixed(1)}ms`,
				`blit    ${s.avgBlitMs.toFixed(2)}ms`,
				`long    ${s.longFrames} >16.7ms  ${s.veryLongFrames} >33.4ms`,
				`skipped ${s.framesSkipped}  errors ${s.renderErrors}`,
			].join("\n");
		};

		update();
		const interval = setInterval(update, HUD_UPDATE_INTERVAL_MS);
		return () => {
			clearInterval(interval);
			perfStats.setEnabled({ enabled: false });
		};
	}, []);

	return (
		<pre
			ref={textRef}
			className="pointer-events-none absolute top-2 left-2 z-10 rounded-sm bg-black/70 p-2 font-mono text-[10px] leading-4 text-green-400 select-none"
		/>
	);
}
