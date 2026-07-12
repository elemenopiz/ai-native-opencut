import type { CanvasRenderer } from "../canvas-renderer";

export type BaseNodeParams = object | undefined;

export class BaseNode<Params extends BaseNodeParams = BaseNodeParams> {
	params: Params;

	constructor(params?: Params) {
		this.params = params ?? ({} as Params);
	}

	children: BaseNode[] = [];

	add(child: BaseNode) {
		this.children.push(child);
		return this;
	}

	remove(child: BaseNode) {
		this.children = this.children.filter((c) => c !== child);
		return this;
	}

	/**
	 * Pre-render phase: fetch everything async (decoded video frames) BEFORE
	 * the paint pass, so render() — which must stay serial to preserve z-order
	 * — never awaits a decode. Children prepare in PARALLEL; per-media decode
	 * safety is enforced inside VideoCache (a per-sink task chain serializes
	 * getFrameAt/warm for one mediaId), not by callers, so parallel prepare of
	 * two clips of the same media is safe.
	 *
	 * Optional: render() still works without a prepare pass (nodes fall back
	 * to fetching inline), so direct callers of node.render keep working.
	 */
	async prepare({
		renderer,
		time,
	}: {
		renderer: CanvasRenderer;
		time: number;
	}): Promise<void> {
		await Promise.all(
			this.children.map((child) => child.prepare({ renderer, time })),
		);
	}

	async render({
		renderer,
		time,
	}: {
		renderer: CanvasRenderer;
		time: number;
	}): Promise<void> {
		for (const child of this.children) {
			await child.render({ renderer, time });
		}
	}
}
