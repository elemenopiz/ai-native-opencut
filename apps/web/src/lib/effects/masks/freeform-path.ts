// Adapted from OpenCut-app/OpenCut (pre-rewrite tag, MIT) —
// apps/web/src/masks/freeform/path.ts. Pure pen-path geometry: cubic-bezier
// evaluation, element-local <-> canvas transforms, de Casteljau mid-segment
// insertion, and closed-path flattening for rasterization / hit-testing.
// Their `ElementBounds`-driven transforms are refactored to take an explicit
// center point so the same math serves both element-pixel rasterization and
// on-canvas overlay interaction (which must also layer element rotation).
import type { MaskPathPoint } from "@/types/rendering";

export interface CanvasPoint {
	x: number;
	y: number;
}

/** Anchor + its two tangent handles, all in the target coordinate space. */
export interface FreeformAnchor {
	id: string;
	anchor: CanvasPoint;
	inHandle: CanvasPoint;
	outHandle: CanvasPoint;
}

export interface FreeformSegment {
	index: number;
	startPointId: string;
	endPointId: string;
	start: CanvasPoint;
	startOut: CanvasPoint;
	endIn: CanvasPoint;
	end: CanvasPoint;
	/** SVG cubic path data ("M .. C ..") for this single segment. */
	pathData: string;
}

/** How a pen path's local fractional points map into a coordinate space. */
export interface FreeformTransform {
	/** Space-origin of the mask center (element-pixel or canvas-pixel). */
	center: CanvasPoint;
	/** Total rotation in degrees (mask rotation, plus element rotation for overlays). */
	rotationDeg: number;
	/** Uniform path scale. */
	scale: number;
	/** Element width/height in pixels (local fractions multiply these). */
	width: number;
	height: number;
}

function rotateVector({
	x,
	y,
	degrees,
}: {
	x: number;
	y: number;
	degrees: number;
}): CanvasPoint {
	const rad = (degrees * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** Element-local fractional point -> target-space canvas point. */
export function localPointToCanvas({
	point,
	transform,
}: {
	point: { x: number; y: number };
	transform: FreeformTransform;
}): CanvasPoint {
	const scaledLocal = {
		x: point.x * transform.width * transform.scale,
		y: point.y * transform.height * transform.scale,
	};
	const rotated = rotateVector({
		x: scaledLocal.x,
		y: scaledLocal.y,
		degrees: transform.rotationDeg,
	});
	return {
		x: transform.center.x + rotated.x,
		y: transform.center.y + rotated.y,
	};
}

/** Inverse of {@link localPointToCanvas}. */
export function canvasPointToLocal({
	point,
	transform,
}: {
	point: CanvasPoint;
	transform: FreeformTransform;
}): { x: number; y: number } {
	const translated = {
		x: point.x - transform.center.x,
		y: point.y - transform.center.y,
	};
	const rotated = rotateVector({
		x: translated.x,
		y: translated.y,
		degrees: -transform.rotationDeg,
	});
	const denomX = transform.width * transform.scale;
	const denomY = transform.height * transform.scale;
	return {
		x: denomX === 0 ? 0 : rotated.x / denomX,
		y: denomY === 0 ? 0 : rotated.y / denomY,
	};
}

/** Every anchor + its in/out tangent handle mapped into the target space. */
export function getFreeformAnchors({
	points,
	transform,
}: {
	points: MaskPathPoint[];
	transform: FreeformTransform;
}): FreeformAnchor[] {
	return points.map((point) => ({
		id: point.id,
		anchor: localPointToCanvas({
			point: { x: point.x, y: point.y },
			transform,
		}),
		inHandle: localPointToCanvas({
			point: { x: point.x + point.inX, y: point.y + point.inY },
			transform,
		}),
		outHandle: localPointToCanvas({
			point: { x: point.x + point.outX, y: point.y + point.outY },
			transform,
		}),
	}));
}

export function getFreeformSegmentCount({
	points,
	closed,
}: {
	points: MaskPathPoint[];
	closed: boolean;
}): number {
	if (points.length < 2) {
		return 0;
	}
	return closed ? points.length : points.length - 1;
}

export function getFreeformSegments({
	points,
	transform,
	closed,
}: {
	points: MaskPathPoint[];
	transform: FreeformTransform;
	closed: boolean;
}): FreeformSegment[] {
	const anchors = getFreeformAnchors({ points, transform });
	const segmentCount = getFreeformSegmentCount({ points, closed });

	return Array.from({ length: segmentCount }, (_, index) => {
		const start = anchors[index];
		const end = anchors[(index + 1) % anchors.length];
		return {
			index,
			startPointId: start.id,
			endPointId: end.id,
			start: start.anchor,
			startOut: start.outHandle,
			endIn: end.inHandle,
			end: end.anchor,
			pathData: `M ${start.anchor.x},${start.anchor.y} C ${start.outHandle.x},${start.outHandle.y} ${end.inHandle.x},${end.inHandle.y} ${end.anchor.x},${end.anchor.y}`,
		};
	});
}

function clampUnit(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function distanceSquared({ a, b }: { a: CanvasPoint; b: CanvasPoint }): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

function lerpPoint({
	a,
	b,
	t,
}: {
	a: CanvasPoint;
	b: CanvasPoint;
	t: number;
}): CanvasPoint {
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function evaluateCubicBezier({
	p0,
	p1,
	p2,
	p3,
	t,
}: {
	p0: CanvasPoint;
	p1: CanvasPoint;
	p2: CanvasPoint;
	p3: CanvasPoint;
	t: number;
}): CanvasPoint {
	const u = 1 - t;
	return {
		x:
			u ** 3 * p0.x +
			3 * u ** 2 * t * p1.x +
			3 * u * t ** 2 * p2.x +
			t ** 3 * p3.x,
		y:
			u ** 3 * p0.y +
			3 * u ** 2 * t * p1.y +
			3 * u * t ** 2 * p2.y +
			t ** 3 * p3.y,
	};
}

/**
 * Nearest parameter `t` on a segment's cubic bezier to `canvasPoint`, via a
 * coarse sample sweep then a shrinking local refinement (ported verbatim from
 * pre-rewrite `findClosestPointOnFreeformSegment`). Used for click-to-insert.
 */
export function findClosestPointOnFreeformSegment({
	points,
	segmentIndex,
	canvasPoint,
	transform,
	closed,
}: {
	points: MaskPathPoint[];
	segmentIndex: number;
	canvasPoint: CanvasPoint;
	transform: FreeformTransform;
	closed: boolean;
}): { t: number; point: CanvasPoint } | null {
	const segment = getFreeformSegments({ points, transform, closed }).find(
		(candidate) => candidate.index === segmentIndex,
	);
	if (!segment) {
		return null;
	}

	const sampleCount = 24;
	let bestT = 0;
	let bestDistanceSquared = distanceSquared({
		a: canvasPoint,
		b: segment.start,
	});

	for (let step = 0; step <= sampleCount; step++) {
		const t = step / sampleCount;
		const point = evaluateCubicBezier({
			p0: segment.start,
			p1: segment.startOut,
			p2: segment.endIn,
			p3: segment.end,
			t,
		});
		const d = distanceSquared({ a: canvasPoint, b: point });
		if (d < bestDistanceSquared) {
			bestDistanceSquared = d;
			bestT = t;
		}
	}

	let searchStep = 1 / sampleCount;
	for (let iteration = 0; iteration < 8; iteration++) {
		const candidates = [bestT - searchStep, bestT, bestT + searchStep]
			.map(clampUnit)
			.map((t) => ({
				t,
				point: evaluateCubicBezier({
					p0: segment.start,
					p1: segment.startOut,
					p2: segment.endIn,
					p3: segment.end,
					t,
				}),
			}));
		for (const candidate of candidates) {
			const d = distanceSquared({ a: canvasPoint, b: candidate.point });
			if (d < bestDistanceSquared) {
				bestDistanceSquared = d;
				bestT = candidate.t;
			}
		}
		searchStep /= 2;
	}

	const clampedT = Math.min(0.999, Math.max(0.001, bestT));
	return {
		t: clampedT,
		point: evaluateCubicBezier({
			p0: segment.start,
			p1: segment.startOut,
			p2: segment.endIn,
			p3: segment.end,
			t: clampedT,
		}),
	};
}

function getSegmentIndices({
	points,
	segmentIndex,
	closed,
}: {
	points: MaskPathPoint[];
	segmentIndex: number;
	closed: boolean;
}): { startIndex: number; endIndex: number } | null {
	const segmentCount = getFreeformSegmentCount({ points, closed });
	if (segmentIndex < 0 || segmentIndex >= segmentCount) {
		return null;
	}
	return {
		startIndex: segmentIndex,
		endIndex: (segmentIndex + 1) % points.length,
	};
}

/**
 * Split a segment at parameter `t` via de Casteljau, inserting a new anchor and
 * retangenting its neighbours so the visible curve is unchanged. Ported verbatim
 * from pre-rewrite `insertPointIntoFreeformSegment` (points are element-local).
 */
export function insertPointIntoFreeformSegment({
	points,
	segmentIndex,
	pointId,
	t,
	closed,
}: {
	points: MaskPathPoint[];
	segmentIndex: number;
	pointId: string;
	t: number;
	closed: boolean;
}): MaskPathPoint[] {
	const indices = getSegmentIndices({ points, segmentIndex, closed });
	if (!indices) {
		return points;
	}

	const startPoint = points[indices.startIndex];
	const endPoint = points[indices.endIndex];
	const clampedT = Math.min(0.999, Math.max(0.001, t));
	const p0 = { x: startPoint.x, y: startPoint.y };
	const p1 = {
		x: startPoint.x + startPoint.outX,
		y: startPoint.y + startPoint.outY,
	};
	const p2 = { x: endPoint.x + endPoint.inX, y: endPoint.y + endPoint.inY };
	const p3 = { x: endPoint.x, y: endPoint.y };
	const p01 = lerpPoint({ a: p0, b: p1, t: clampedT });
	const p12 = lerpPoint({ a: p1, b: p2, t: clampedT });
	const p23 = lerpPoint({ a: p2, b: p3, t: clampedT });
	const p012 = lerpPoint({ a: p01, b: p12, t: clampedT });
	const p123 = lerpPoint({ a: p12, b: p23, t: clampedT });
	const splitPoint = lerpPoint({ a: p012, b: p123, t: clampedT });

	const nextPoints = [...points];
	nextPoints[indices.startIndex] = {
		...startPoint,
		outX: p01.x - startPoint.x,
		outY: p01.y - startPoint.y,
	};
	nextPoints[indices.endIndex] = {
		...endPoint,
		inX: p23.x - endPoint.x,
		inY: p23.y - endPoint.y,
	};
	nextPoints.splice(indices.endIndex, 0, {
		id: pointId,
		x: splitPoint.x,
		y: splitPoint.y,
		inX: p012.x - splitPoint.x,
		inY: p012.y - splitPoint.y,
		outX: p123.x - splitPoint.x,
		outY: p123.y - splitPoint.y,
	});
	return nextPoints;
}

export function removeFreeformPathPoints({
	points,
	pointIds,
}: {
	points: MaskPathPoint[];
	pointIds: string[];
}): MaskPathPoint[] {
	if (pointIds.length === 0) {
		return points;
	}
	const toRemove = new Set(pointIds);
	return points.filter((point) => !toRemove.has(point.id));
}

/** A path stays closed only while it still has enough points to enclose area. */
export function getClosedStateAfterPointRemoval({
	wasClosed,
	remainingPointCount,
}: {
	wasClosed: boolean;
	remainingPointCount: number;
}): boolean {
	return wasClosed && remainingPointCount >= 3;
}

/**
 * Flatten the closed path into a polygon of canvas points by sampling each
 * cubic segment. The pure basis for both `Path2D` rasterization and the unit-
 * testable point-in-path coverage check (bun has no Canvas2D / Path2D).
 */
export function flattenFreeformPath({
	points,
	transform,
	samplesPerSegment = 16,
}: {
	points: MaskPathPoint[];
	transform: FreeformTransform;
	samplesPerSegment?: number;
}): CanvasPoint[] {
	const segments = getFreeformSegments({ points, transform, closed: true });
	if (segments.length === 0) {
		return [];
	}
	const polygon: CanvasPoint[] = [];
	for (const segment of segments) {
		// Sample [0, samplesPerSegment) — the segment endpoint is the next
		// segment's start, so skipping the last sample avoids duplicate vertices.
		for (let step = 0; step < samplesPerSegment; step++) {
			const t = step / samplesPerSegment;
			polygon.push(
				evaluateCubicBezier({
					p0: segment.start,
					p1: segment.startOut,
					p2: segment.endIn,
					p3: segment.end,
					t,
				}),
			);
		}
	}
	return polygon;
}

/** Even-odd ray-cast point-in-polygon test. */
export function isPointInPolygon({
	polygon,
	x,
	y,
}: {
	polygon: CanvasPoint[];
	x: number;
	y: number;
}): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;
		const intersects =
			yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
		if (intersects) {
			inside = !inside;
		}
	}
	return inside;
}

/** SVG path data ("M .. C .. [Z]") for the whole path, for overlay strokes. */
export function buildFreeformSvgPath({
	points,
	transform,
	closed,
}: {
	points: MaskPathPoint[];
	transform: FreeformTransform;
	closed: boolean;
}): string {
	if (points.length === 0) {
		return "";
	}
	const anchors = getFreeformAnchors({ points, transform });
	const parts = [`M ${anchors[0].anchor.x},${anchors[0].anchor.y}`];
	for (let index = 1; index < anchors.length; index++) {
		const previous = anchors[index - 1];
		const current = anchors[index];
		parts.push(
			`C ${previous.outHandle.x},${previous.outHandle.y} ${current.inHandle.x},${current.inHandle.y} ${current.anchor.x},${current.anchor.y}`,
		);
	}
	if (closed && anchors.length > 1) {
		const last = anchors[anchors.length - 1];
		const first = anchors[0];
		parts.push(
			`C ${last.outHandle.x},${last.outHandle.y} ${first.inHandle.x},${first.inHandle.y} ${first.anchor.x},${first.anchor.y}`,
		);
		parts.push("Z");
	}
	return parts.join(" ");
}

/**
 * Build a browser `Path2D` for the closed path in the given space. Browser-only
 * (Path2D is unavailable under bun); the unit-testable equivalent is
 * {@link flattenFreeformPath} + {@link isPointInPolygon}.
 */
export function buildFreeformPath2D({
	points,
	transform,
	closed,
}: {
	points: MaskPathPoint[];
	transform: FreeformTransform;
	closed: boolean;
}): Path2D {
	const path = new Path2D();
	if (points.length === 0) {
		return path;
	}
	const anchors = getFreeformAnchors({ points, transform });
	path.moveTo(anchors[0].anchor.x, anchors[0].anchor.y);
	for (let index = 1; index < anchors.length; index++) {
		const previous = anchors[index - 1];
		const current = anchors[index];
		path.bezierCurveTo(
			previous.outHandle.x,
			previous.outHandle.y,
			current.inHandle.x,
			current.inHandle.y,
			current.anchor.x,
			current.anchor.y,
		);
	}
	if (closed && anchors.length > 1) {
		const last = anchors[anchors.length - 1];
		const first = anchors[0];
		path.bezierCurveTo(
			last.outHandle.x,
			last.outHandle.y,
			first.inHandle.x,
			first.inHandle.y,
			first.anchor.x,
			first.anchor.y,
		);
		path.closePath();
	}
	return path;
}

/**
 * The element-pixel-space transform used for rasterization: the mask center is
 * `(width/2 + centerX*width, height/2 + centerY*height)` and only the mask's
 * own rotation applies (element rotation is handled by the compositor, not the
 * mask texture). Mirrors pre-rewrite's `renderer.body.buildPath` bounds.
 */
export function getRasterTransform({
	centerX,
	centerY,
	rotationDeg,
	scale,
	width,
	height,
}: {
	centerX: number;
	centerY: number;
	rotationDeg: number;
	scale: number;
	width: number;
	height: number;
}): FreeformTransform {
	return {
		center: {
			x: width / 2 + centerX * width,
			y: height / 2 + centerY * height,
		},
		rotationDeg,
		scale,
		width,
		height,
	};
}
