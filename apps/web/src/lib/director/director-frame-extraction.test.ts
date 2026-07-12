import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import type { GenerationSpec, Take } from "@/types/timeline";
import { LAST_FRAME_EPSILON_S, type FullFrame } from "@/lib/media/last-frame";
import { createDirectorApi } from "./director-api";

/**
 * The `extractFrame` and `chainFrom` verbs: pull a full-res still from a slot's
 * take (or a library asset) into the library with provenance, and seed the next
 * slot on the prior slot's last frame. Browser-bound decode + upload are injected
 * via the `frames` seam so this runs headless — same pattern as `references`.
 */

const FRAME: FullFrame = {
	dataUrl: "data:image/png;base64,SGk=",
	width: 1920,
	height: 1080,
};

function videoAsset(id: string, name: string, duration: number) {
	return {
		id,
		name,
		type: "video" as const,
		duration,
		url: `blob:${id}`,
		file: new File([new Uint8Array([1, 2, 3])], name, { type: "video/mp4" }),
	};
}

function spec(prompt: string): GenerationSpec {
	return {
		prompt,
		mode: "text-to-video",
		resolution: "720p",
		orientation: "landscape",
		duration: 6,
	};
}

function readyTake(id: string, mediaId: string): Take {
	return {
		id,
		status: "ready",
		mediaId,
		spec: spec("x"),
		createdAt: 0,
	};
}

function makeEditor() {
	const slotA = {
		id: "slotA",
		type: "video" as const,
		name: "Shot A",
		startTime: 0,
		duration: 6,
		trimStart: 0,
		trimEnd: 0,
		mediaId: "mA",
		generation: spec("a shot"),
		takes: [readyTake("tk_a", "mA")],
		activeTakeId: "tk_a",
	};
	const slotB = {
		id: "slotB",
		type: "video" as const,
		name: "Shot B",
		startTime: 6,
		duration: 6,
		trimStart: 0,
		trimEnd: 0,
		mediaId: "mB",
		generation: spec("b shot"),
		takes: [] as Take[],
	};
	const tracks = [{ id: "t1", type: "video", elements: [slotA, slotB] }];
	const assets: Record<string, ReturnType<typeof videoAsset>> = {
		mA: videoAsset("mA", "a.mp4", 6),
		mB: videoAsset("mB", "b.mp4", 6),
	};
	const added: { projectId: string; asset: Record<string, unknown> }[] = [];
	const setSpecCalls: { elementId: string; spec: GenerationSpec }[] = [];

	const editor = {
		timeline: {
			getTotalDuration: () => 12,
			getTracks: () => tracks,
			setSlotSpec: (input: { elementId: string; spec: GenerationSpec }) => {
				setSpecCalls.push(input);
				const el = tracks[0].elements.find((e) => e.id === input.elementId);
				if (el) el.generation = input.spec;
			},
		},
		command: { canUndo: () => false, canRedo: () => false },
		media: {
			getAssetById: (id: string) => assets[id],
			getAssets: () => Object.values(assets),
			addMediaAsset: async (input: {
				projectId: string;
				asset: Record<string, unknown>;
			}) => {
				added.push(input);
				return "frame_media_1";
			},
		},
		project: {
			getActive: () => ({ metadata: { id: "proj_1" } }),
			getActiveOrNull: () => ({ metadata: { id: "proj_1" } }),
		},
	} as unknown as EditorCore;

	return { editor, added, setSpecCalls };
}

describe("extractFrame verb", () => {
	it("extracts a slot take's last frame, adds it with provenance, returns a hosted url", async () => {
		const { editor, added } = makeEditor();
		const decodeCalls: number[] = [];
		const director = createDirectorApi(editor, {
			frames: {
				decode: async (_source, timeSec) => {
					decodeCalls.push(timeSec);
					return FRAME;
				},
				upload: async () => "https://cdn.test/frame.png",
			},
		});

		const res = await director.extractFrame({
			slotId: "slotA",
			position: "last",
		});

		expect(res.ok).toBe(true);
		expect(res.data).toEqual({
			mediaId: "frame_media_1",
			url: "https://cdn.test/frame.png",
		});
		// Last frame of a 6s source = 6 - epsilon.
		expect(decodeCalls[0]).toBeCloseTo(6 - LAST_FRAME_EPSILON_S, 10);
		expect(added).toHaveLength(1);
		expect(added[0].asset.derivedFrom).toEqual({
			assetId: "mA",
			sourceTimeSec: 6 - LAST_FRAME_EPSILON_S,
			label: "last frame",
		});
		expect(added[0].asset.name).toBe("Shot A — last frame");
	});

	it("extracts a first frame from a library media id at t=0", async () => {
		const { editor } = makeEditor();
		const decodeCalls: number[] = [];
		const director = createDirectorApi(editor, {
			frames: {
				decode: async (_s, t) => {
					decodeCalls.push(t);
					return FRAME;
				},
				upload: async () => "https://cdn.test/first.png",
			},
		});

		const res = await director.extractFrame({
			mediaId: "mB",
			position: "first",
		});

		expect(res.ok).toBe(true);
		expect(decodeCalls[0]).toBe(0);
		expect(res.data?.url).toBe("https://cdn.test/first.png");
	});

	it("decodes an explicit atTimeSec position", async () => {
		const { editor } = makeEditor();
		const decodeCalls: number[] = [];
		const director = createDirectorApi(editor, {
			frames: {
				decode: async (_s, t) => {
					decodeCalls.push(t);
					return FRAME;
				},
				upload: async () => "https://cdn.test/at.png",
			},
		});

		const res = await director.extractFrame({
			mediaId: "mA",
			position: { atTimeSec: 3.5 },
		});

		expect(res.ok).toBe(true);
		expect(decodeCalls[0]).toBe(3.5);
	});

	it("fails when the slot has no rendered take", async () => {
		const { editor } = makeEditor();
		const director = createDirectorApi(editor, {
			frames: { decode: async () => FRAME, upload: async () => "u" },
		});

		const res = await director.extractFrame({
			slotId: "slotB",
			position: "last",
		});
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/no rendered take/i);
	});

	it("fails for an unknown slot/media", async () => {
		const { editor } = makeEditor();
		const director = createDirectorApi(editor, {
			frames: { decode: async () => FRAME, upload: async () => "u" },
		});
		const res = await director.extractFrame({
			slotId: "nope",
			position: "first",
		});
		expect(res.ok).toBe(false);
	});
});

describe("chainFrom verb", () => {
	it("stamps the target slot's spec with the source slot's last frame as an i2v first frame", async () => {
		const { editor, setSpecCalls } = makeEditor();
		const director = createDirectorApi(editor, {
			frames: {
				decode: async () => FRAME,
				upload: async () => "https://cdn.test/chain.png",
			},
		});

		const res = await director.chainFrom({
			fromSlotId: "slotA",
			toSlotId: "slotB",
		});

		expect(res.ok).toBe(true);
		expect(res.data?.toSlotId).toBe("slotB");
		expect(res.data?.url).toBe("https://cdn.test/chain.png");

		expect(setSpecCalls).toHaveLength(1);
		expect(setSpecCalls[0].elementId).toBe("slotB");
		expect(setSpecCalls[0].spec.referenceImageUrl).toBe(
			"https://cdn.test/chain.png",
		);
		expect(setSpecCalls[0].spec.mode).toBe("image-to-video");
		// The original prompt is preserved.
		expect(setSpecCalls[0].spec.prompt).toBe("b shot");
	});

	it("rejects chaining a slot to itself", async () => {
		const { editor, setSpecCalls } = makeEditor();
		const director = createDirectorApi(editor, {
			frames: { decode: async () => FRAME, upload: async () => "u" },
		});
		const res = await director.chainFrom({
			fromSlotId: "slotA",
			toSlotId: "slotA",
		});
		expect(res.ok).toBe(false);
		expect(setSpecCalls).toHaveLength(0);
	});

	it("fails when the source slot has no take to extract", async () => {
		const { editor, setSpecCalls } = makeEditor();
		const director = createDirectorApi(editor, {
			frames: { decode: async () => FRAME, upload: async () => "u" },
		});
		const res = await director.chainFrom({
			fromSlotId: "slotB",
			toSlotId: "slotA",
		});
		expect(res.ok).toBe(false);
		expect(setSpecCalls).toHaveLength(0);
	});
});

describe("catalog registration", () => {
	it("registers extractFrame and chainFrom as mutating reel:write verbs", async () => {
		const { toolCatalog, scopeForTool } = await import("./tool-catalog");
		const names = toolCatalog().map((t) => t.name);
		expect(names).toContain("extractFrame");
		expect(names).toContain("chainFrom");
		for (const n of ["extractFrame", "chainFrom"]) {
			expect(toolCatalog().find((t) => t.name === n)?.mutating).toBe(true);
			expect(scopeForTool(n)).toBe("reel:write");
		}
	});

	it("routes the extractFrame handler with position coercion", async () => {
		const { toolCatalog } = await import("./tool-catalog");
		const { editor } = makeEditor();
		const decodeCalls: number[] = [];
		const director = createDirectorApi(editor, {
			frames: {
				decode: async (_s, t) => {
					decodeCalls.push(t);
					return FRAME;
				},
				upload: async () => "https://cdn.test/x.png",
			},
		});
		const entry = toolCatalog().find((t) => t.name === "extractFrame");
		const res = await entry?.handler(director, {
			mediaId: "mA",
			position: 2,
		});
		expect(res?.ok).toBe(true);
		expect(decodeCalls[0]).toBe(2);
	});
});
