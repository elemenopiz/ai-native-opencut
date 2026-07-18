"use client";

import { useEffect, useRef, useState } from "react";
import { useContainerSize } from "@/hooks/use-container-size";
import { usePreviewCanvasStore } from "@/stores/preview-canvas-store";
import { sampleCanvasImageData } from "@/lib/color/sample-canvas";
import {
	computeHistograms,
	computeScopeSummary,
	computeVectorscope,
	computeWaveform,
	type ScopeSummary,
} from "@/lib/color/scopes";
import { useAutoColorCorrection } from "@/hooks/use-auto-color-correction";
import {
	drawHistogram,
	drawIdleGraticule,
	drawVectorscope,
	drawWaveform,
} from "./draw";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/utils/ui";

type ScopeType = "waveform" | "parade" | "vectorscope" | "histogram";

const SCOPE_TABS: Array<{ id: ScopeType; label: string }> = [
	{ id: "waveform", label: "Waveform" },
	{ id: "parade", label: "RGB Parade" },
	{ id: "vectorscope", label: "Vectorscope" },
	{ id: "histogram", label: "Histogram" },
];

/** Target ~12fps sampling so live playback isn't starved. */
const SAMPLE_INTERVAL_MS = 80;
/** Readout numbers refresh slower than the raster for legibility. */
const READOUT_INTERVAL_MS = 400;
/** Preview is downsampled to this longest edge before analysis. */
const ANALYSIS_MAX_SIZE = 320;

/**
 * Live color-scopes panel: samples the composited preview frame on a throttled
 * loop and renders a waveform, RGB parade, vectorscope, or histogram, plus a
 * real auto color-correction action derived from the same measurements.
 */
export function ScopesPanel() {
	const [scopeType, setScopeType] = useState<ScopeType>("waveform");
	const [summary, setSummary] = useState<ScopeSummary | null>(null);
	const [lookProfile, setLookProfile] = useState<string>("none");

	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const scopeTypeRef = useRef<ScopeType>(scopeType);
	scopeTypeRef.current = scopeType;

	const { width, height } = useContainerSize({ containerRef });
	const { analyzeAndCorrect, appliedProfile, profiles } =
		useAutoColorCorrection();
	const [isCorrecting, setIsCorrecting] = useState(false);

	// Keep the backing store sized to its display box (device-pixel crisp).
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || width === 0 || height === 0) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
	}, [width, height]);

	// Idle graticule: before the first sampled frame (or while resizing in
	// that state) the tick loop below never touches the canvas, since it
	// bails whenever there's no preview source yet. Paint quiet reference
	// lines instead of leaving it a dead black rect. Once `summary` is set
	// for the first time this effect stops running for good — the tick
	// loop owns the canvas from there on.
	useEffect(() => {
		if (summary) return;
		const canvas = canvasRef.current;
		if (!canvas || canvas.width === 0 || canvas.height === 0) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		drawIdleGraticule({ ctx, width: canvas.width, height: canvas.height });
	}, [summary, width, height]);

	// Throttled sample + draw loop; pauses while the tab/panel is hidden.
	useEffect(() => {
		let raf = 0;
		let lastSample = 0;
		let lastReadout = 0;

		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			if (document.hidden) return;
			if (now - lastSample < SAMPLE_INTERVAL_MS) return;
			lastSample = now;

			const canvas = canvasRef.current;
			const source = usePreviewCanvasStore.getState().canvasEl;
			if (!canvas || !source) return;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;

			const imageData = sampleCanvasImageData({
				source,
				maxSize: ANALYSIS_MAX_SIZE,
			});
			if (!imageData) return;
			const pixels = {
				data: imageData.data,
				width: imageData.width,
				height: imageData.height,
			};
			const w = canvas.width;
			const h = canvas.height;
			const type = scopeTypeRef.current;

			if (type === "histogram") {
				drawHistogram({
					ctx,
					width: w,
					height: h,
					histograms: computeHistograms(pixels),
				});
			} else if (type === "vectorscope") {
				drawVectorscope({
					ctx,
					width: w,
					height: h,
					scope: computeVectorscope(pixels),
				});
			} else {
				drawWaveform({
					ctx,
					width: w,
					height: h,
					waveform: computeWaveform(pixels),
					mode: type === "parade" ? "parade" : "luma",
				});
			}

			if (now - lastReadout >= READOUT_INTERVAL_MS) {
				lastReadout = now;
				setSummary(computeScopeSummary(pixels));
			}
		};

		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);

	const handleCorrect = async () => {
		setIsCorrecting(true);
		try {
			await analyzeAndCorrect(lookProfile === "none" ? undefined : lookProfile);
		} finally {
			setIsCorrecting(false);
		}
	};

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* Scope switcher */}
			<div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
				{SCOPE_TABS.map((tab) => (
					<button
						key={tab.id}
						type="button"
						onClick={() => setScopeType(tab.id)}
						className={cn(
							"rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
							scopeType === tab.id
								? "bg-accent text-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{tab.label}
					</button>
				))}
			</div>

			{/* Live scope raster */}
			<div ref={containerRef} className="relative min-h-0 flex-1 bg-[#0a0a0a]">
				<canvas ref={canvasRef} className="absolute inset-0 block size-full" />
				{!summary && (
					<div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-xs">
						Waiting for a preview frame…
					</div>
				)}
			</div>

			{/* Measured readout */}
			<ScopeReadout summary={summary} />

			{/* Auto color-correction, driven by the same measurements */}
			<div className="flex shrink-0 items-center gap-2 border-t p-2">
				{/* Demoted to `outline` so the filled `primary` Auto Correct button
					reads as the one actionable choice — the Look picker is a quiet
					input to that action, not a competing CTA. */}
				<Select value={lookProfile} onValueChange={setLookProfile}>
					<SelectTrigger variant="outline" className="h-8 flex-1 text-xs">
						<SelectValue placeholder="Look" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="none">Auto (measured only)</SelectItem>
						{profiles.map((p) => (
							<SelectItem key={p.name} value={p.name}>
								{p.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Button
					variant="primary"
					size="sm"
					className="h-8 text-xs"
					disabled={isCorrecting}
					onClick={handleCorrect}
				>
					{isCorrecting ? "Correcting…" : "Auto Correct"}
				</Button>
			</div>
			{appliedProfile && (
				<div className="text-muted-foreground shrink-0 px-2 pb-2 text-[11px]">
					Applied: {appliedProfile}
				</div>
			)}
		</div>
	);
}

function ScopeReadout({ summary }: { summary: ScopeSummary | null }) {
	if (!summary) {
		return (
			<div className="text-muted-foreground shrink-0 border-t px-2 py-1.5 text-[11px]">
				No signal
			</div>
		);
	}
	const pct = (n: number) => `${Math.round(n * 100)}%`;
	const temp = summary.temperatureEstimate;
	const tempLabel =
		temp > 0.01 ? "cool/blue" : temp < -0.01 ? "warm" : "neutral";

	return (
		<div className="text-muted-foreground grid shrink-0 grid-cols-2 gap-x-4 gap-y-0.5 border-t px-2 py-1.5 font-mono text-[11px]">
			<span>Luma mean {pct(summary.luma.mean)}</span>
			<span>WB {tempLabel}</span>
			<span>Black {pct(summary.luma.blackPoint)}</span>
			<span>White {pct(summary.luma.whitePoint)}</span>
			<span>Clip lo {pct(summary.luma.clipLow)}</span>
			<span>Clip hi {pct(summary.luma.clipHigh)}</span>
		</div>
	);
}
