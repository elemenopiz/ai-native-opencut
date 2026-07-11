/**
 * The preview canvas's backing store is downscaled while playing (playback
 * quality), so `canvas.width/height` no longer always equal the project's
 * canvas coordinate space that hit-testing and element bounds are computed in.
 * The preview publishes the logical size on `data-logical-width/height`; fall
 * back to the backing store for canvases that don't set it.
 */
function getLogicalCanvasSize(canvas: HTMLCanvasElement): {
	width: number;
	height: number;
} {
	return {
		width: Number(canvas.dataset.logicalWidth) || canvas.width,
		height: Number(canvas.dataset.logicalHeight) || canvas.height,
	};
}

export function screenToCanvas({
	clientX,
	clientY,
	canvas,
}: {
	clientX: number;
	clientY: number;
	canvas: HTMLCanvasElement;
}): { x: number; y: number } {
	const rect = canvas.getBoundingClientRect();
	const logical = getLogicalCanvasSize(canvas);
	const scaleX = logical.width / rect.width;
	const scaleY = logical.height / rect.height;
	return {
		x: (clientX - rect.left) * scaleX,
		y: (clientY - rect.top) * scaleY,
	};
}

export function canvasToOverlay({
	canvasX,
	canvasY,
	canvasRect,
	containerRect,
	canvasSize,
}: {
	canvasX: number;
	canvasY: number;
	canvasRect: DOMRect;
	containerRect: DOMRect;
	canvasSize: { width: number; height: number };
}): { x: number; y: number } {
	const scaleX = canvasRect.width / canvasSize.width;
	const scaleY = canvasRect.height / canvasSize.height;
	return {
		x: canvasRect.left - containerRect.left + canvasX * scaleX,
		y: canvasRect.top - containerRect.top + canvasY * scaleY,
	};
}

export function positionToOverlay({
	positionX,
	positionY,
	canvasRect,
	containerRect,
	canvasSize,
}: {
	positionX: number;
	positionY: number;
	canvasRect: DOMRect;
	containerRect: DOMRect;
	canvasSize: { width: number; height: number };
}): { x: number; y: number } {
	const scaleX = canvasRect.width / canvasSize.width;
	const scaleY = canvasRect.height / canvasSize.height;
	const centerScreenX =
		canvasRect.left - containerRect.left + (canvasSize.width / 2) * scaleX;
	const centerScreenY =
		canvasRect.top - containerRect.top + (canvasSize.height / 2) * scaleY;
	return {
		x: centerScreenX + positionX * scaleX,
		y: centerScreenY + positionY * scaleY,
	};
}

export function getDisplayScale({
	canvasRect,
	canvasSize,
}: {
	canvasRect: DOMRect;
	canvasSize: { width: number; height: number };
}): { x: number; y: number } {
	return {
		x: canvasRect.width / canvasSize.width,
		y: canvasRect.height / canvasSize.height,
	};
}

export function screenPixelsToLogicalThreshold({
	canvas,
	screenPixels,
}: {
	canvas: HTMLCanvasElement;
	screenPixels: number;
}): { x: number; y: number } {
	const canvasRect = canvas.getBoundingClientRect();
	const logical = getLogicalCanvasSize(canvas);
	return {
		x: screenPixels * (logical.width / canvasRect.width),
		y: screenPixels * (logical.height / canvasRect.height),
	};
}
