import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EditorCore } from "@/core";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";

/**
 * Regression coverage for `addItemsToProjectMedia` — the "auto-save a completed
 * take to Assets" collaborator `routeCompletedTake` (use-studio-generation.ts)
 * depends on for invariant I1 (batch-of-1 auto-save) and its I3 board-pin
 * fallback. The contract under test: the function NEVER throws (a failed item
 * only increments `failed`), and `{added, failed}` accurately reflects what
 * happened per item — `routeCompletedTake` reads exactly these two counters to
 * decide whether to raise "Failed to save the generated take to Assets".
 *
 * Deliberately does NOT `mock.module("@/lib/media/processing", ...)`. That
 * module is also imported for REAL by normalize-media.test.ts, which already
 * documents (see its own header comment) that bun's `mock.module` corrupts
 * the module registry process-wide for every file in the same `bun test`
 * invocation — confirmed by hand here too: neither a captured-real-exports
 * spread nor a synchronous `require()` capture nor an `afterAll` restore
 * prevented this file's mock from breaking normalize-media.test.ts's real
 * `processMediaAssets` assertions whenever both ran together.
 *
 * BUG55 (C26 @7b671e15) made `processMediaAssets` correctly SKIP a file whose
 * probe is genuinely unreadable (`isUnreadableVideoProbe`: unparseable OR no
 * video track at all) instead of pushing a phantom asset — so the 3-byte
 * garbage "video/mp4" File this suite used to rely on no longer yields an
 * asset (mediabunny can't find a video track in 3 random bytes, so it's
 * correctly treated as unreadable and skipped). Fixed by feeding the fetch
 * stub the bytes of a REAL, tiny, byte-valid H.264 MP4 fixture instead of
 * garbage. Verified by hand under plain bun (no WebCodecs/VideoDecoder
 * global, same as this test run): mediabunny parses the container and reports
 * a real `videoCodec` ("avc") and `parseable: true` even though
 * `canDecode()` is false — so `isUnreadableVideoProbe` (parseable + codec
 * present) stays false, `processMediaAssets` does NOT skip it, and
 * `getVideoInfo` (container-metadata only, no actual frame decode) still
 * succeeds, so exactly one processed asset is pushed. `generateThumbnail`
 * (real frame decode) predictably fails under bun with no WebCodecs, but
 * that's caught by processing.ts's own try/catch and doesn't block the push
 * — matching the "degraded metadata, never throws" contract this suite
 * exists to protect. Since `addItemsToProjectMedia` itself coerces the
 * downloaded blob's type to a valid prefix for `item.kind` before handing it
 * to `processMediaAssets`, the "processing produced no asset" branch remains
 * unreachable from this function's own call site with a real fixture — so a
 * real `processMediaAssets` call exercises this test's actual contract (the
 * per-item try/catch/count loop) faithfully with zero mocking risk. The two
 * genuinely reachable failure modes below are the proxy download failing and
 * `editor.media.addMediaAsset` rejecting.
 *
 * `global.fetch` backs `fetchWithTimeout`'s proxy download and is restored in
 * afterEach per the 44b4e1ca leak-prevention pattern: mock.restore() /
 * property-reassignment doesn't self-heal across files in the same
 * `bun test` process.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// Real, tiny (~193KB), byte-valid H.264 MP4 — same fixture the w2 e2e suite
// uses (e2e/fixtures/w2/tiny_640x360_h264.mp4). mediabunny can demux its
// container and report a real codec without needing WebCodecs, which is what
// keeps processMediaAssets's probe from treating it as unreadable (see the
// file header).
const VALID_MP4_BYTES = readFileSync(
	join(
		import.meta.dir,
		"..",
		"..",
		"..",
		"..",
		"e2e/fixtures/w2/tiny_640x360_h264.mp4",
	),
);

function okBlobFetch(): typeof fetch {
	return (async () =>
		new Response(new Blob([VALID_MP4_BYTES], { type: "video/mp4" }), {
			status: 200,
		})) as unknown as typeof fetch;
}

function fakeEditor(
	addMediaAsset: (args: {
		projectId: string;
		asset: unknown;
	}) => Promise<string | undefined>,
): EditorCore {
	return { media: { addMediaAsset } } as unknown as EditorCore;
}

describe("addItemsToProjectMedia", () => {
	test("all-success: every item lands in Assets and is counted", async () => {
		globalThis.fetch = okBlobFetch();
		let nextId = 0;
		const editor = fakeEditor(async () => `media-${++nextId}`);

		const result = await addItemsToProjectMedia({
			editor,
			projectId: "proj-1",
			items: [
				{ url: "https://mock/a.mp4", name: "take-a", kind: "video" },
				{ url: "https://mock/b.mp4", name: "take-b", kind: "video" },
			],
			source: "ai",
		});

		expect(result).toEqual({
			added: 2,
			failed: 0,
			mediaIds: ["media-1", "media-2"],
		});
	});

	test("partial-failure: one item's proxy download failing still saves the rest, never throws", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			// First item's proxy download succeeds; the second's fails.
			if (calls === 1) {
				return new Response(
					new Blob([VALID_MP4_BYTES], { type: "video/mp4" }),
					{ status: 200 },
				);
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
		const editor = fakeEditor(async () => "media-ok");

		let result: Awaited<ReturnType<typeof addItemsToProjectMedia>> | undefined;
		let thrown: unknown;
		try {
			result = await addItemsToProjectMedia({
				editor,
				projectId: "proj-1",
				items: [
					{ url: "https://mock/good.mp4", name: "take-good", kind: "video" },
					{ url: "https://mock/bad.mp4", name: "take-bad", kind: "video" },
				],
				source: "ai",
			});
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeUndefined();
		expect(result).toEqual({
			added: 1,
			failed: 1,
			mediaIds: ["media-ok"],
		});
	});

	test("all-failure: every item's proxy download failing still resolves (never throws) with added:0", async () => {
		globalThis.fetch = (async () =>
			new Response("not found", { status: 404 })) as unknown as typeof fetch;
		const editor = fakeEditor(async () => "unused");

		let thrown: unknown;
		let result: Awaited<ReturnType<typeof addItemsToProjectMedia>> | undefined;
		try {
			result = await addItemsToProjectMedia({
				editor,
				projectId: "proj-1",
				items: [
					{ url: "https://mock/a.mp4", name: "take-a", kind: "video" },
					{ url: "https://mock/b.mp4", name: "take-b", kind: "video" },
				],
				source: "ai",
			});
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeUndefined();
		expect(result).toEqual({ added: 0, failed: 2, mediaIds: [] });
	});

	test("never throws even when editor.media.addMediaAsset itself rejects", async () => {
		globalThis.fetch = okBlobFetch();
		const editor = fakeEditor(async () => {
			throw new Error("addMediaAsset boom");
		});

		let thrown: unknown;
		let result: Awaited<ReturnType<typeof addItemsToProjectMedia>> | undefined;
		try {
			result = await addItemsToProjectMedia({
				editor,
				projectId: "proj-1",
				items: [{ url: "https://mock/a.mp4", name: "take-a", kind: "video" }],
				source: "ai",
			});
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeUndefined();
		expect(result).toEqual({ added: 0, failed: 1, mediaIds: [] });
	});
});
