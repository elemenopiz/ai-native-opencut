import { describe, expect, test } from "bun:test";
import { ShapeNode, type ShapeNodeParams } from "../shape-node";
import type { CanvasRenderer } from "../../canvas-renderer";
import type { ShapeElement, ShapeFill } from "@/types/timeline";

/**
 * ShapeNode draws with plain Canvas2D calls (no intrinsic bitmap source, so
 * it can't reuse VisualNode's contain-fit `renderVisual`) — there's no
 * OffscreenCanvas/document in the bun test runtime, so these tests drive
 * `render()` against a hand-rolled context that just records every call,
 * rather than a real canvas. This mirrors how `scene-builder.test.ts` avoids
 * needing a real decoder: assert on the shape of the work requested, not on
 * decoded pixels.
 */

class FakeGradient {
	stops: Array<{ offset: number; color: string }> = [];
	constructor(
		public x0: number,
		public y0: number,
		public x1: number,
		public y1: number,
	) {}
	addColorStop(offset: number, color: string) {
		this.stops.push({ offset, color });
	}
}

class FakeCtx {
	fillStyle: string | FakeGradient = "";
	strokeStyle = "";
	lineWidth = 1;
	globalAlpha = 1;
	globalCompositeOperation = "source-over";
	calls: Array<{ method: string; args: unknown[] }> = [];

	private record(method: string, args: unknown[]) {
		this.calls.push({ method, args });
	}

	save() {
		this.record("save", []);
	}
	restore() {
		this.record("restore", []);
	}
	translate(x: number, y: number) {
		this.record("translate", [x, y]);
	}
	scale(x: number, y: number) {
		this.record("scale", [x, y]);
	}
	rotate(a: number) {
		this.record("rotate", [a]);
	}
	beginPath() {
		this.record("beginPath", []);
	}
	roundRect(x: number, y: number, w: number, h: number, r: number) {
		this.record("roundRect", [x, y, w, h, r]);
	}
	ellipse(
		x: number,
		y: number,
		rx: number,
		ry: number,
		rotation: number,
		start: number,
		end: number,
	) {
		this.record("ellipse", [x, y, rx, ry, rotation, start, end]);
	}
	moveTo(x: number, y: number) {
		this.record("moveTo", [x, y]);
	}
	lineTo(x: number, y: number) {
		this.record("lineTo", [x, y]);
	}
	fill() {
		this.record("fill", []);
	}
	stroke() {
		this.record("stroke", []);
	}
	createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
		this.record("createLinearGradient", [x0, y0, x1, y1]);
		return new FakeGradient(x0, y0, x1, y1);
	}

	callsFor(method: string) {
		return this.calls.filter((c) => c.method === method);
	}
}

function makeRenderer({
	ctx,
	width = 1280,
	height = 720,
}: {
	ctx: FakeCtx;
	width?: number;
	height?: number;
}): CanvasRenderer {
	return { context: ctx, width, height } as unknown as CanvasRenderer;
}

function makeShapeElement(
	overrides: Partial<ShapeElement> = {},
): ShapeNodeParams {
	const base: ShapeElement = {
		id: "shape-1",
		name: "Shape",
		type: "shape",
		shapeKind: "rect",
		width: 200,
		height: 100,
		fill: { type: "solid", color: "#ff0000" },
		duration: 5,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: { position: { x: 0, y: 0 }, scale: 1, rotate: 0 },
		opacity: 1,
		...overrides,
	};
	return { ...base, canvasCenter: { x: 640, y: 360 } };
}

describe("ShapeNode.render — geometry + fill", () => {
	test("a rect with a solid fill draws a rounded-rect path and fills it", async () => {
		const ctx = new FakeCtx();
		const node = new ShapeNode(
			makeShapeElement({
				shapeKind: "rect",
				width: 200,
				height: 100,
				cornerRadius: 20,
				fill: { type: "solid", color: "#ff0000" },
			}),
		);

		await node.render({ renderer: makeRenderer({ ctx }), time: 1 });

		expect(ctx.callsFor("roundRect")[0].args).toEqual([
			-100, -50, 200, 100, 20,
		]);
		expect(ctx.callsFor("fill")).toHaveLength(1);
		expect(ctx.callsFor("stroke")).toHaveLength(0);
		expect(ctx.fillStyle).toBe("#ff0000");
	});

	test("a rect with a gradient fill renders — correct gradient points and stops", async () => {
		const ctx = new FakeCtx();
		const fill: ShapeFill = {
			type: "linear-gradient",
			angle: 180, // "to bottom" — top of the box to bottom of the box.
			stops: [
				{ offset: 0, color: "rgba(0,0,0,0)" },
				{ offset: 1, color: "rgba(0,0,0,0.8)" },
			],
		};
		const node = new ShapeNode(
			makeShapeElement({ shapeKind: "rect", width: 300, height: 100, fill }),
		);

		await node.render({ renderer: makeRenderer({ ctx }), time: 0 });

		const [x0, y0, x1, y1] = ctx.callsFor("createLinearGradient")[0]
			.args as number[];
		expect(x0).toBeCloseTo(0);
		expect(y0).toBeCloseTo(-50);
		expect(x1).toBeCloseTo(0);
		expect(y1).toBeCloseTo(50);

		expect(ctx.fillStyle).toBeInstanceOf(FakeGradient);
		const gradient = ctx.fillStyle as FakeGradient;
		expect(gradient.stops).toEqual([
			{ offset: 0, color: "rgba(0,0,0,0)" },
			{ offset: 1, color: "rgba(0,0,0,0.8)" },
		]);
		expect(ctx.callsFor("fill")).toHaveLength(1);
	});

	test("an ellipse traces ctx.ellipse at half-width/half-height radii", async () => {
		const ctx = new FakeCtx();
		const node = new ShapeNode(
			makeShapeElement({ shapeKind: "ellipse", width: 120, height: 80 }),
		);

		await node.render({ renderer: makeRenderer({ ctx }), time: 0 });

		expect(ctx.callsFor("ellipse")[0].args).toEqual([
			0,
			0,
			60,
			40,
			0,
			0,
			Math.PI * 2,
		]);
	});

	test("a line draws the bbox diagonal and only strokes (no fill call)", async () => {
		const ctx = new FakeCtx();
		const node = new ShapeNode(
			makeShapeElement({
				shapeKind: "line",
				width: 200,
				height: 40,
				fill: { type: "solid", color: "#000000" },
				stroke: { color: "#00ff00", width: 4 },
			}),
		);

		await node.render({ renderer: makeRenderer({ ctx }), time: 0 });

		expect(ctx.callsFor("moveTo")[0].args).toEqual([-100, -20]);
		expect(ctx.callsFor("lineTo")[0].args).toEqual([100, 20]);
		expect(ctx.callsFor("fill")).toHaveLength(0);
		expect(ctx.callsFor("stroke")).toHaveLength(1);
		expect(ctx.strokeStyle).toBe("#00ff00");
		expect(ctx.lineWidth).toBe(4);
	});
});

describe("ShapeNode.render — transform, opacity, blend mode, timing", () => {
	test("position/scale/rotate and opacity are applied to the context", async () => {
		const ctx = new FakeCtx();
		const node = new ShapeNode(
			makeShapeElement({
				transform: { position: { x: 50, y: -20 }, scale: 2, rotate: 45 },
				opacity: 0.4,
			}),
		);

		await node.render({ renderer: makeRenderer({ ctx }), time: 0 });

		expect(ctx.callsFor("translate")[0].args).toEqual([690, 340]);
		expect(ctx.callsFor("scale")[0].args).toEqual([2, 2]);
		expect(ctx.callsFor("rotate")[0].args[0]).toBeCloseTo((45 * Math.PI) / 180);
		expect(ctx.globalAlpha).toBe(0.4);
	});

	test("rotate is skipped entirely when transform.rotate is 0", async () => {
		const ctx = new FakeCtx();
		const node = new ShapeNode(makeShapeElement());

		await node.render({ renderer: makeRenderer({ ctx }), time: 0 });

		expect(ctx.callsFor("rotate")).toHaveLength(0);
	});

	test("a non-default blend mode is forwarded to globalCompositeOperation", async () => {
		const ctx = new FakeCtx();
		const node = new ShapeNode(makeShapeElement({ blendMode: "multiply" }));

		await node.render({ renderer: makeRenderer({ ctx }), time: 0 });

		expect(ctx.globalCompositeOperation).toBe("multiply");
	});

	test("renders nothing before the element's start time or after it ends", async () => {
		const ctx = new FakeCtx();
		const node = new ShapeNode(makeShapeElement({ startTime: 2, duration: 3 }));

		await node.render({ renderer: makeRenderer({ ctx }), time: 1.999 });
		await node.render({ renderer: makeRenderer({ ctx }), time: 5 });

		expect(ctx.calls).toHaveLength(0);
	});
});
