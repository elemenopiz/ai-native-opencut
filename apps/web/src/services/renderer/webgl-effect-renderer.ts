import { createOffscreenCanvas } from "./canvas-utils";
import { perfStats } from "./perf-stats";
import { applyMultiPassEffect } from "./webgl-utils";
import type { EffectPassData } from "./webgl-utils";

export interface ApplyEffectParams {
	source: CanvasImageSource;
	width: number;
	height: number;
	passes: EffectPassData[];
}

let gl: WebGLRenderingContext | null = null;
let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
const programCache = new Map<string, WebGLProgram>();
const textureCache = new Map<string, WebGLTexture>();

// The shared GL canvas only ever grows. Shrinking or reshaping it per element
// forced a GPU surface reallocation whenever two differently sized elements
// rendered in the same frame (60x/sec during playback). Rendering happens in a
// gl.viewport(0, 0, w, h) subregion instead — GL's origin is bottom-left, so in
// image space that subregion is the BOTTOM-left corner; applyEffect blits only
// that subrect out. Shader math is unaffected: texcoords sample exact-size
// input/intermediate textures and u_resolution is the passed size, never the
// canvas size.
function getOrCreateCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): OffscreenCanvas | HTMLCanvasElement {
	if (!canvas) {
		canvas = createOffscreenCanvas({ width, height });
		gl = canvas.getContext("webgl", {
			premultipliedAlpha: false,
		}) as WebGLRenderingContext | null;
		if (!gl) {
			throw new Error("WebGL not supported");
		}
	}
	if (canvas.width < width || canvas.height < height) {
		canvas.width = Math.max(canvas.width, width);
		canvas.height = Math.max(canvas.height, height);
	}
	return canvas;
}

// Output canvases are pooled per exact size as a ping-pong pair instead of
// being allocated per call (previously several fresh OffscreenCanvases per
// element per frame). Invariant: a returned canvas stays valid until the
// SECOND subsequent applyEffect call at the same size. That makes chained
// calls safe — pass N's output is pass N+1's source (or, on visual-node's
// mask path, is bound as an aux texture) and the next call writes to the
// OTHER canvas of the pair. Callers must consume (drawImage) the result
// before issuing two more same-size calls and must never hold it across
// frames; every current call site (visual-node, text-node, effect-layer-node,
// composite-effect-node) draws the result into its target immediately.
interface OutputPool {
	pair: [
		OffscreenCanvas | HTMLCanvasElement | null,
		OffscreenCanvas | HTMLCanvasElement | null,
	];
	flip: 0 | 1;
	lastUse: number;
}

const OUTPUT_POOL_LIMIT = 8;
const outputPools = new Map<string, OutputPool>();
let outputPoolClock = 0;

function getPooledOutputCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): OffscreenCanvas | HTMLCanvasElement {
	const key = `${width}x${height}`;
	let pool = outputPools.get(key);
	if (!pool) {
		if (outputPools.size >= OUTPUT_POOL_LIMIT) {
			let oldestKey: string | null = null;
			let oldestUse = Number.POSITIVE_INFINITY;
			for (const [poolKey, candidate] of outputPools) {
				if (candidate.lastUse < oldestUse) {
					oldestUse = candidate.lastUse;
					oldestKey = poolKey;
				}
			}
			if (oldestKey !== null) {
				outputPools.delete(oldestKey);
			}
		}
		pool = { pair: [null, null], flip: 0, lastUse: 0 };
		outputPools.set(key, pool);
	}
	pool.lastUse = ++outputPoolClock;
	let output = pool.pair[pool.flip];
	if (!output) {
		output = createOffscreenCanvas({ width, height });
		pool.pair[pool.flip] = output;
	}
	pool.flip = pool.flip === 0 ? 1 : 0;
	return output;
}

function applyEffect({
	source,
	width,
	height,
	passes,
}: ApplyEffectParams): OffscreenCanvas | HTMLCanvasElement {
	const targetCanvas = getOrCreateCanvas({ width, height });
	const context = gl;
	if (!context) {
		throw new Error("WebGL context not initialized");
	}

	applyMultiPassEffect({
		context,
		source,
		width,
		height,
		passes,
		programCache,
		textureCache,
	});

	const outputCanvas = getPooledOutputCanvas({ width, height });
	const outputCtx = outputCanvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (outputCtx) {
		// Reused canvas may hold a previous frame; drawImage composites
		// source-over, so transparent result pixels would leak stale content
		// without an explicit clear.
		outputCtx.clearRect(0, 0, width, height);
		outputCtx.drawImage(
			targetCanvas,
			0,
			targetCanvas.height - height,
			width,
			height,
			0,
			0,
			width,
			height,
		);
	}
	return outputCanvas;
}

export const webglEffectRenderer = {
	applyEffect: (params: ApplyEffectParams) => {
		if (!perfStats.enabled) return applyEffect(params);
		const start = performance.now();
		const result = applyEffect(params);
		perfStats.addEffectTime({ ms: performance.now() - start });
		return result;
	},
};
