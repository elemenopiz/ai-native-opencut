import { describe, expect, it } from "bun:test";
import { shouldDeferIndexing } from "@/hooks/use-embedding-indexer";

/**
 * BUG14 mitigation unit test (see docs/perf/bug14-import-stall-profile-2026-07-17.md).
 *
 * `shouldDeferIndexing` is the pure guard that keeps the CLIP auto-indexer
 * from starting frame-sampling seeks on an asset whose own auto-proxy job is
 * still generating — both hit the same original (often un-proxied 4K/HEVC)
 * file's decode pipeline on/near the main thread at once.
 */
function fakeEditor(isProxyGenerating: boolean) {
	return {
		media: {
			isProxyGenerating: () => isProxyGenerating,
		},
	};
}

describe("shouldDeferIndexing", () => {
	it("defers when the asset's proxy is actively generating", () => {
		const editor = fakeEditor(true);
		expect(shouldDeferIndexing({ assetId: "asset-1", editor })).toBe(true);
	});

	it("does not defer when no proxy job is running for the asset", () => {
		const editor = fakeEditor(false);
		expect(shouldDeferIndexing({ assetId: "asset-1", editor })).toBe(false);
	});
});
