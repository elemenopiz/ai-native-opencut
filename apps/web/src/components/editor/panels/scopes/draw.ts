/**
 * Canvas2D renderers for the color scopes. Each takes the visible canvas 2D
 * context plus an engine result and paints one scope. Density-based scopes
 * (waveform, vectorscope) are rasterized into an `ImageData` at the engine's
 * native resolution on a shared offscreen canvas, then scaled onto the visible
 * canvas; the histogram is drawn directly with paths.
 */

import type {
	ChannelHistograms,
	Vectorscope,
	Waveform,
} from "@/lib/color/scopes";

/** Shared offscreen buffer for density rasterization (avoids per-frame allocs). */
let buffer: HTMLCanvasElement | null = null;
let bufferCtx: CanvasRenderingContext2D | null = null;

function getBuffer({ width, height }: { width: number; height: number }) {
	if (!buffer) buffer = document.createElement("canvas");
	if (buffer.width !== width) buffer.width = width;
	if (buffer.height !== height) buffer.height = height;
	if (!bufferCtx) bufferCtx = buffer.getContext("2d");
	return { canvas: buffer, ctx: bufferCtx };
}

/** Lift low densities so faint detail is visible (perceptual-ish). */
function toIntensity(count: number, max: number): number {
	if (count === 0 || max === 0) return 0;
	return 255 * (count / max) ** 0.42;
}

function clearBackground({
	ctx,
	width,
	height,
}: {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
}) {
	ctx.fillStyle = "#0a0a0a";
	ctx.fillRect(0, 0, width, height);
}

// --------------------------------------------------------------------------
// Idle state (no preview frame sampled yet)
// --------------------------------------------------------------------------

/**
 * Painted before the first preview frame samples in (and while resizing in
 * that state), so the scope reads as an instrument at rest instead of a
 * dead black rectangle. Five faint IRE-style reference lines (0/25/50/75/100)
 * — no color, no motion. The tick loop's drawWaveform/drawVectorscope/
 * drawHistogram calls take over the canvas permanently once a real frame
 * lands, so this never fights with live rendering.
 */
export function drawIdleGraticule({
	ctx,
	width,
	height,
}: {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
}) {
	clearBackground({ ctx, width, height });
	ctx.strokeStyle = "rgba(255,255,255,0.1)";
	ctx.lineWidth = 1;
	for (let i = 0; i <= 4; i++) {
		const y = Math.round((height * i) / 4) + 0.5;
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(width, y);
		ctx.stroke();
	}
}

// --------------------------------------------------------------------------
// Waveform (luma or RGB parade)
// --------------------------------------------------------------------------

export function drawWaveform({
	ctx,
	width,
	height,
	waveform,
	mode,
}: {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
	waveform: Waveform;
	mode: "luma" | "parade";
}) {
	clearBackground({ ctx, width, height });
	const { columns, levels, max } = waveform;

	if (mode === "luma") {
		drawChannelPanel({
			ctx,
			map: waveform.luma,
			columns,
			levels,
			max,
			x: 0,
			panelW: width,
			height,
			tint: [200, 235, 205],
		});
		return;
	}

	// Parade: three panels side by side, R | G | B.
	const panelW = width / 3;
	drawChannelPanel({
		ctx,
		map: waveform.r,
		columns,
		levels,
		max,
		x: 0,
		panelW,
		height,
		tint: [255, 70, 70],
	});
	drawChannelPanel({
		ctx,
		map: waveform.g,
		columns,
		levels,
		max,
		x: panelW,
		panelW,
		height,
		tint: [70, 255, 90],
	});
	drawChannelPanel({
		ctx,
		map: waveform.b,
		columns,
		levels,
		max,
		x: panelW * 2,
		panelW,
		height,
		tint: [80, 130, 255],
	});
}

function drawChannelPanel({
	ctx,
	map,
	columns,
	levels,
	max,
	x,
	panelW,
	height,
	tint,
}: {
	ctx: CanvasRenderingContext2D;
	map: Uint32Array;
	columns: number;
	levels: number;
	max: number;
	x: number;
	panelW: number;
	height: number;
	tint: [number, number, number];
}) {
	const { canvas, ctx: bctx } = getBuffer({ width: columns, height: levels });
	if (!bctx) return;
	const image = bctx.createImageData(columns, levels);
	const px = image.data;
	for (let col = 0; col < columns; col++) {
		const base = col * levels;
		for (let level = 0; level < levels; level++) {
			const intensity = toIntensity(map[base + level], max);
			if (intensity === 0) continue;
			const row = levels - 1 - level;
			const p = (row * columns + col) * 4;
			px[p] = (tint[0] * intensity) / 255;
			px[p + 1] = (tint[1] * intensity) / 255;
			px[p + 2] = (tint[2] * intensity) / 255;
			px[p + 3] = 255;
		}
	}
	bctx.putImageData(image, 0, 0);
	ctx.drawImage(canvas, 0, 0, columns, levels, x, 0, panelW, height);
}

// --------------------------------------------------------------------------
// Vectorscope
// --------------------------------------------------------------------------

export function drawVectorscope({
	ctx,
	width,
	height,
	scope,
}: {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
	scope: Vectorscope;
}) {
	clearBackground({ ctx, width, height });
	const { size, density, max } = scope;

	// Density → green phosphor raster.
	const { canvas, ctx: bctx } = getBuffer({ width: size, height: size });
	if (bctx) {
		const image = bctx.createImageData(size, size);
		const px = image.data;
		for (let i = 0; i < density.length; i++) {
			const intensity = toIntensity(density[i], max);
			if (intensity === 0) continue;
			const p = i * 4;
			px[p] = intensity * 0.55;
			px[p + 1] = intensity;
			px[p + 2] = intensity * 0.6;
			px[p + 3] = 255;
		}
		bctx.putImageData(image, 0, 0);
		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(canvas, 0, 0, size, size, 0, 0, width, height);
	}

	// Graticule: center crosshair + 75%-bar color targets.
	const cx = width / 2;
	const cy = height / 2;
	ctx.strokeStyle = "rgba(255,255,255,0.12)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(cx, 0);
	ctx.lineTo(cx, height);
	ctx.moveTo(0, cy);
	ctx.lineTo(width, cy);
	ctx.stroke();
	ctx.beginPath();
	ctx.arc(cx, cy, Math.min(width, height) * 0.42, 0, Math.PI * 2);
	ctx.stroke();

	ctx.font = "9px ui-monospace, monospace";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	for (const target of scope.targets) {
		const tx = target.x * width;
		const ty = target.y * height;
		ctx.strokeStyle = "rgba(255,255,255,0.5)";
		ctx.strokeRect(tx - 4, ty - 4, 8, 8);
		ctx.fillStyle = "rgba(255,255,255,0.7)";
		ctx.fillText(target.label, tx, ty - 10);
	}
}

// --------------------------------------------------------------------------
// Histogram (RGB overlay)
// --------------------------------------------------------------------------

export function drawHistogram({
	ctx,
	width,
	height,
	histograms,
}: {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
	histograms: ChannelHistograms;
}) {
	clearBackground({ ctx, width, height });
	const { r, g, b, maxRgbBin } = histograms;
	if (maxRgbBin === 0) return;

	// Faint quarter gridlines.
	ctx.strokeStyle = "rgba(255,255,255,0.08)";
	ctx.lineWidth = 1;
	for (let i = 1; i < 4; i++) {
		const x = (width * i) / 4;
		ctx.beginPath();
		ctx.moveTo(x, 0);
		ctx.lineTo(x, height);
		ctx.stroke();
	}

	const channels: Array<{ data: Uint32Array; color: string }> = [
		{ data: r, color: "rgba(255,70,70,0.85)" },
		{ data: g, color: "rgba(70,220,90,0.85)" },
		{ data: b, color: "rgba(90,140,255,0.85)" },
	];

	ctx.globalCompositeOperation = "lighter";
	for (const { data, color } of channels) {
		ctx.beginPath();
		ctx.moveTo(0, height);
		for (let bin = 0; bin < 256; bin++) {
			const x = (bin / 255) * width;
			const y = height - (data[bin] / maxRgbBin) * height;
			ctx.lineTo(x, y);
		}
		ctx.lineTo(width, height);
		ctx.closePath();
		ctx.fillStyle = color;
		ctx.fill();
	}
	ctx.globalCompositeOperation = "source-over";
}
