import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { CanvasRenderer } from "../canvas-renderer";

/**
 * Two-phase render contract: prepare() fetches a clip's frame once, render()
 * draws the stashed frame without a second fetch, and callers that skip the
 * prepare pass (export/snapshot code that calls render directly) still get an
 * inline fetch — plus the realtime drop-policy flag must follow the renderer.
 */

type GetFrameAtArgs = {
	mediaId: string;
	file: File;
	time: number;
	tolerateStale?: boolean;
};

let getFrameAtCalls: GetFrameAtArgs[] = [];
let warmCalls: { mediaId: string; time: number }[] = [];

const mockCanvas = { width: 320, height: 240 } as unknown as HTMLCanvasElement;

// bun's mock.module is process-global: it replaces the module for every test
// file in the run, not just this one. Spread the real exports so files that
// need them (service.test.ts constructs `new VideoCache()`) keep working
// regardless of file order.
const actualVideoCacheModule = await import("@/services/video-cache/service");

mock.module("@/services/video-cache/service", () => ({
	...actualVideoCacheModule,
	WARM_LOOKAHEAD_SECONDS: 1.0,
	videoCache: {
		getFrameAt: async (args: GetFrameAtArgs) => {
			getFrameAtCalls.push(args);
			return { canvas: mockCanvas, timestamp: args.time, duration: 1 / 30 };
		},
		warm: async ({ mediaId, time }: { mediaId: string; time: number }) => {
			warmCalls.push({ mediaId, time });
		},
	},
}));

const { VideoNode } = await import("./video-node");

function makeRenderer({ realtime }: { realtime: boolean }): {
	renderer: CanvasRenderer;
	drawnSources: CanvasImageSource[];
} {
	const drawnSources: CanvasImageSource[] = [];
	const context = {
		save() {},
		restore() {},
		translate() {},
		rotate() {},
		drawImage(source: CanvasImageSource) {
			drawnSources.push(source);
		},
		globalAlpha: 1,
		globalCompositeOperation: "source-over",
	};
	const renderer = {
		width: 640,
		height: 360,
		fps: 30,
		realtime,
		context,
	} as unknown as CanvasRenderer;
	return { renderer, drawnSources };
}

function makeNode() {
	return new VideoNode({
		url: "blob:clip",
		file: new File(["stub"], "clip.mp4"),
		mediaId: "m1",
		duration: 10,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
	});
}

beforeEach(() => {
	getFrameAtCalls = [];
	warmCalls = [];
});

describe("VideoNode two-phase render", () => {
	it("prepare fetches once; render draws the stashed frame with no second fetch", async () => {
		const node = makeNode();
		const { renderer, drawnSources } = makeRenderer({ realtime: true });

		await node.prepare({ renderer, time: 1.0 });
		expect(getFrameAtCalls).toHaveLength(1);

		await node.render({ renderer, time: 1.0 });
		expect(getFrameAtCalls).toHaveLength(1);
		expect(drawnSources).toEqual([mockCanvas]);
	});

	it("repeated prepare for the same time reuses the in-flight fetch (composite double-paint)", async () => {
		const node = makeNode();
		const { renderer } = makeRenderer({ realtime: true });

		await Promise.all([
			node.prepare({ renderer, time: 1.0 }),
			node.prepare({ renderer, time: 1.0 }),
		]);
		await node.prepare({ renderer, time: 1.0 });

		expect(getFrameAtCalls).toHaveLength(1);
	});

	it("render without a prepare pass fetches inline (export/snapshot fallback)", async () => {
		const node = makeNode();
		const { renderer, drawnSources } = makeRenderer({ realtime: false });

		await node.render({ renderer, time: 2.0 });

		expect(getFrameAtCalls).toHaveLength(1);
		expect(drawnSources).toHaveLength(1);
	});

	it("render at a different time than prepared falls back to an inline fetch", async () => {
		const node = makeNode();
		const { renderer, drawnSources } = makeRenderer({ realtime: true });

		await node.prepare({ renderer, time: 1.0 });
		await node.render({ renderer, time: 1.0 + 1 / 30 });

		expect(getFrameAtCalls).toHaveLength(2);
		expect(getFrameAtCalls[1].time).toBeCloseTo(1.0 + 1 / 30, 5);
		expect(drawnSources).toHaveLength(1);
	});

	it("passes tolerateStale only for a realtime renderer", async () => {
		const node = makeNode();

		const live = makeRenderer({ realtime: true });
		await node.prepare({ renderer: live.renderer, time: 1.0 });
		expect(getFrameAtCalls[0].tolerateStale).toBe(true);

		const exact = makeRenderer({ realtime: false });
		await node.prepare({ renderer: exact.renderer, time: 2.0 });
		expect(getFrameAtCalls[1].tolerateStale).toBe(false);
	});

	it("out-of-range prepare warms an upcoming clip instead of fetching", async () => {
		const node = new VideoNode({
			url: "blob:clip",
			file: new File(["stub"], "clip.mp4"),
			mediaId: "m1",
			duration: 5,
			timeOffset: 10,
			trimStart: 0,
			trimEnd: 0,
			transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
			opacity: 1,
		});
		const { renderer, drawnSources } = makeRenderer({ realtime: true });

		// 0.5s before the clip starts: inside the warm lookahead.
		await node.prepare({ renderer, time: 9.5 });
		await node.render({ renderer, time: 9.5 });

		expect(getFrameAtCalls).toHaveLength(0);
		expect(warmCalls).toEqual([{ mediaId: "m1", time: 0 }]);
		expect(drawnSources).toHaveLength(0);
	});
});
