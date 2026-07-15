/**
 * A clip's timeline `duration` and `playbackRate` are independent fields —
 * the renderer consumes `duration * playbackRate` seconds of trimmed source
 * per `VisualNode.getSourceLocalTime`. Changing `playbackRate` alone (as the
 * speed UI used to do) leaves `duration` fixed, which silently changes how
 * much of the trimmed source is shown instead of stretching/compressing the
 * clip's timeline footprint. This keeps the consumed source span constant
 * and solves for the new `duration` instead, so slowing down extends the
 * clip and speeding up shortens it — matching standard NLE speed/duration
 * behavior.
 */
export function computeSpeedAdjustedDuration({
	duration,
	oldRate,
	newRate,
	minDuration,
	maxDuration,
}: {
	duration: number;
	oldRate: number;
	newRate: number;
	minDuration: number;
	maxDuration?: number | null;
}): number {
	if (newRate <= 0 || oldRate <= 0) return duration;

	const consumedSourceSpan = duration * oldRate;
	const rawDuration = consumedSourceSpan / newRate;
	const cappedDuration =
		maxDuration != null ? Math.min(rawDuration, maxDuration) : rawDuration;

	return Math.max(minDuration, cappedDuration);
}

/** Timeline start of the nearest element after `startTime` on the same
 *  track, or `null` if nothing follows (duration is then unbounded). */
export function getRightNeighborStart({
	elements,
	elementId,
	startTime,
}: {
	elements: { id: string; startTime: number }[];
	elementId: string;
	startTime: number;
}): number | null {
	const bound = elements
		.filter((el) => el.id !== elementId && el.startTime >= startTime)
		.reduce((min, el) => Math.min(min, el.startTime), Infinity);

	return Number.isFinite(bound) ? bound : null;
}
