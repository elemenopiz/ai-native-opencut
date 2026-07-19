import { describe, expect, it, mock } from "bun:test";
import { makeFakeEditor } from "./fake-editor";
import type { GenerateExecutor } from "./types";

/**
 * `removeBackground` (poach plan item #3, `docs/poach/vyra-poach-plan.md` §3)
 * — wires the EXISTING AI matting pipeline (`lib/studio/background-removal.ts`,
 * shared with `BackgroundRemovalDialog`'s caller) behind a Director verb.
 *
 * Two seams are faked, mirroring `director-media-search.test.ts`'s
 * mock.module-then-dynamic-import convention (real network/browser calls never
 * run in a headless test):
 *  1. The matting call itself — injected via `createDirectorApi`'s
 *     `removeBackground` option (the SAME DI pattern as `references.derive`).
 *  2. The library-ingestion step (`addItemsToProjectMedia`, the exact helper
 *     `ai-toolbar.tsx`'s "Add to Timeline" already uses for this identical
 *     `processedUrl`) — mocked at the module boundary since it isn't
 *     `editor`-injected (matches `analyzeMediaSilence`'s treatment in
 *     `adapter-defaults.test.ts`).
 */

const addItemsToProjectMediaSpy = mock(
	async (_input: {
		editor: unknown;
		projectId: string;
		items: { url: string; name: string; kind: string }[];
		source?: "ai";
	}) => ({ added: 1, failed: 0, mediaIds: ["media_matted_1"] }),
);
mock.module("@/lib/studio/add-to-editor", () => ({
	addItemsToProjectMedia: addItemsToProjectMediaSpy,
}));

const { createDirectorApi } = await import("./director-api");

const okExecutor: GenerateExecutor = {
	run: async () => ({ status: "ready", mediaId: "media_ready_1" }),
};

const stubFile = new File(["x"], "source.png", { type: "image/png" });

/** The fields every visual element needs beyond {type, mediaId, name} — the
 *  fake editor's `insertElement` is typed against the REAL `EditorCore`
 *  timeline surface, which requires a full valid element. */
const visualBase = {
	startTime: 0,
	duration: 5,
	trimStart: 0,
	trimEnd: 0,
	transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
	opacity: 1,
};

function makeEditorWithImageAsset() {
	const fake = makeFakeEditor();
	(fake.editor as unknown as { media: unknown }).media = {
		...fake.editor.media,
		getAssetById: (id: string) =>
			id === "asset_1"
				? { id: "asset_1", name: "hero.png", type: "image", file: stubFile }
				: undefined,
	};
	const elementId = fake.editor.timeline.insertElement({
		element: {
			type: "image",
			mediaId: "asset_1",
			name: "hero.png",
			...visualBase,
		},
		placement: { mode: "auto", trackType: "video" },
	});
	return { fake, elementId };
}

describe("removeBackground — happy path", () => {
	it("mattes the image, ingests the result via addItemsToProjectMedia, returns the new mediaId", async () => {
		addItemsToProjectMediaSpy.mockClear();
		const { fake, elementId } = makeEditorWithImageAsset();
		const removeBackgroundStub = mock(async (source: File | string) => {
			expect(source).toBe(stubFile);
			return {
				originalUrl: "blob:original",
				processedUrl: "https://cdn.example.com/matted.png",
				width: 512,
				height: 512,
			};
		});
		const d = createDirectorApi(fake.editor, {
			executor: okExecutor,
			removeBackground: removeBackgroundStub,
		});

		const result = await d.removeBackground({ itemId: elementId });

		expect(result.ok).toBe(true);
		expect(result.data).toEqual({
			mediaId: "media_matted_1",
			url: "https://cdn.example.com/matted.png",
			width: 512,
			height: 512,
		});
		expect(removeBackgroundStub).toHaveBeenCalledTimes(1);
		expect(addItemsToProjectMediaSpy).toHaveBeenCalledTimes(1);
		const call = addItemsToProjectMediaSpy.mock.calls[0]?.[0] as {
			items: { url: string; kind: string }[];
			source?: string;
		};
		expect(call.items[0]?.url).toBe("https://cdn.example.com/matted.png");
		expect(call.items[0]?.kind).toBe("image");
		expect(call.source).toBe("ai");
	});
});

describe("removeBackground — failure paths", () => {
	it("item-not-found uses the structured lookup contract (poach plan item #1)", async () => {
		const fake = makeFakeEditor();
		const d = createDirectorApi(fake.editor);

		const result = await d.removeBackground({ itemId: "no_such_item" });

		expect(result.ok).toBe(false);
		expect(result.code).toBe("ITEM_NOT_FOUND");
	});

	it("refuses a non-image target (video) with a clear message", async () => {
		const fake = makeFakeEditor();
		const videoId = fake.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: "asset_1",
				name: "clip.mp4",
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});
		const d = createDirectorApi(fake.editor);

		const result = await d.removeBackground({ itemId: videoId });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("video");
		expect(result.message).toContain("extractFrame");
	});

	it("media-not-found (dangling mediaId) uses the structured lookup contract", async () => {
		const fake = makeFakeEditor();
		const elementId = fake.editor.timeline.insertElement({
			element: {
				type: "image",
				mediaId: "asset_missing",
				name: "hero.png",
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});
		const d = createDirectorApi(fake.editor);

		const result = await d.removeBackground({ itemId: elementId });

		expect(result.ok).toBe(false);
		expect(result.code).toBe("MEDIA_NOT_FOUND");
	});

	it("surfaces a pipeline failure without throwing", async () => {
		const { fake, elementId } = makeEditorWithImageAsset();
		const d = createDirectorApi(fake.editor, {
			removeBackground: async () => {
				throw new Error("backend unreachable");
			},
		});

		const result = await d.removeBackground({ itemId: elementId });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("backend unreachable");
	});

	it("surfaces an ingestion failure (addItemsToProjectMedia added 0)", async () => {
		addItemsToProjectMediaSpy.mockClear();
		addItemsToProjectMediaSpy.mockImplementationOnce(async () => ({
			added: 0,
			failed: 1,
			mediaIds: [],
		}));
		const { fake, elementId } = makeEditorWithImageAsset();
		const d = createDirectorApi(fake.editor, {
			removeBackground: async () => ({
				originalUrl: "blob:original",
				processedUrl: "https://cdn.example.com/matted.png",
				width: 10,
				height: 10,
			}),
		});

		const result = await d.removeBackground({ itemId: elementId });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("couldn't add the result");
	});
});
