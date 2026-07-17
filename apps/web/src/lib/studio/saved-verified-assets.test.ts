import { describe, expect, test } from "bun:test";
import {
	parseSavedAssets,
	removeSavedAsset,
	type SavedVerifiedAsset,
	upsertSavedAsset,
} from "./saved-verified-assets";

const asset = (over: Partial<SavedVerifiedAsset> = {}): SavedVerifiedAsset => ({
	id: "1",
	uri: "asset://asset-abc",
	label: "Zak front",
	kind: "image",
	...over,
});

describe("upsertSavedAsset", () => {
	test("appends a new asset", () => {
		const next = upsertSavedAsset([], asset());
		expect(next).toHaveLength(1);
		expect(next[0]?.uri).toBe("asset://asset-abc");
	});

	test("re-saving the same URI unchanged is a no-op", () => {
		const list = [asset()];
		const next = upsertSavedAsset(list, asset({ id: "2" }));
		expect(next).toBe(list); // unchanged reference
		expect(next).toHaveLength(1);
	});

	test("re-saving with a different kind updates in place (keeps id, no dupe)", () => {
		const list = [asset({ label: "Verified image" })];
		const next = upsertSavedAsset(
			list,
			asset({ id: "2", kind: "video", label: "" }),
		);
		expect(next).toHaveLength(1);
		expect(next[0]?.id).toBe("1");
		expect(next[0]?.kind).toBe("video");
		// Auto-generated label follows the corrected kind…
		expect(next[0]?.label).toBe("Verified video");
	});

	test("kind correction keeps an existing custom label", () => {
		const list = [asset({ label: "Zak front" })];
		const next = upsertSavedAsset(
			list,
			asset({ id: "2", kind: "video", label: "" }),
		);
		expect(next[0]?.kind).toBe("video");
		expect(next[0]?.label).toBe("Zak front");
	});

	test("an explicit incoming label always wins", () => {
		const list = [asset({ label: "Zak front" })];
		const next = upsertSavedAsset(
			list,
			asset({ id: "2", kind: "video", label: "Zak full body" }),
		);
		expect(next[0]?.label).toBe("Zak full body");
	});

	test("a new asset with an empty label gets the auto label", () => {
		const next = upsertSavedAsset([], asset({ label: "" }));
		expect(next[0]?.label).toBe("Verified image");
	});

	test("rejects a non-asset:// uri", () => {
		const list: SavedVerifiedAsset[] = [];
		expect(upsertSavedAsset(list, asset({ uri: "https://x/y.jpg" }))).toBe(
			list,
		);
	});
});

describe("removeSavedAsset", () => {
	test("removes by id, leaves others", () => {
		const list = [
			asset({ id: "a" }),
			asset({ id: "b", uri: "asset://asset-b" }),
		];
		const next = removeSavedAsset(list, "a");
		expect(next).toHaveLength(1);
		expect(next[0]?.id).toBe("b");
	});
});

describe("parseSavedAssets", () => {
	test("round-trips a valid stored list", () => {
		const list = [asset()];
		expect(parseSavedAssets(JSON.stringify(list))).toEqual(list);
	});

	test("returns [] for null, garbage, or a non-array", () => {
		expect(parseSavedAssets(null)).toEqual([]);
		expect(parseSavedAssets("not json")).toEqual([]);
		expect(parseSavedAssets('{"foo":1}')).toEqual([]);
	});

	test("drops malformed entries (bad kind, non-asset uri, missing fields)", () => {
		const raw = JSON.stringify([
			asset(),
			{ id: "x", uri: "https://x/y.jpg", label: "raw", kind: "image" },
			{ id: "y", uri: "asset://asset-z", label: "z", kind: "audio" },
			{ uri: "asset://asset-w" },
		]);
		const parsed = parseSavedAssets(raw);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.uri).toBe("asset://asset-abc");
	});
});
