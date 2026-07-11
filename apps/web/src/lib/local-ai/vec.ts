/**
 * Vector-math helpers shared by the local-AI workers.
 *
 * Workers can't run under bun test (no real Worker/WebGPU), so math that
 * needs unit coverage lives here and gets imported into the worker bundle.
 */

/**
 * L2-normalize each vector so consumers can use a plain dot product as
 * cosine similarity. Zero vectors are returned unchanged (there is no
 * direction to preserve, and dividing by zero would poison every component).
 * Inputs are never mutated.
 */
export function l2Normalize(vectors: number[][]): number[][] {
	return vectors.map((vector) => {
		let sumSquares = 0;
		for (const value of vector) sumSquares += value * value;
		const norm = Math.sqrt(sumSquares);
		if (norm === 0) return vector.slice();
		return vector.map((value) => value / norm);
	});
}
