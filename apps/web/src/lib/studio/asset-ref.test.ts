import { describe, expect, test } from "bun:test";
import { isAssetRef, normalizeAssetUri } from "./asset-ref";

describe("isAssetRef", () => {
	test("true only for the asset:// scheme", () => {
		expect(isAssetRef("asset://asset-20260715220651-2f74b")).toBe(true);
		expect(isAssetRef("https://r2.example.com/face.jpg")).toBe(false);
		expect(isAssetRef("asset-20260715220651-2f74b")).toBe(false);
		expect(isAssetRef("")).toBe(false);
	});
});

describe("normalizeAssetUri", () => {
	test("passes a full asset:// URI through unchanged", () => {
		expect(normalizeAssetUri("asset://asset-20260715220651-2f74b")).toBe(
			"asset://asset-20260715220651-2f74b",
		);
	});

	test("prefixes the scheme onto a bare asset- id", () => {
		expect(normalizeAssetUri("asset-20260715220651-khqx6")).toBe(
			"asset://asset-20260715220651-khqx6",
		);
	});

	test("trims surrounding whitespace (paste artifacts)", () => {
		expect(normalizeAssetUri("  asset://asset-abc  ")).toBe(
			"asset://asset-abc",
		);
		expect(normalizeAssetUri("\tasset-abc\n")).toBe("asset://asset-abc");
	});

	test("rejects anything that isn't an asset reference", () => {
		expect(normalizeAssetUri("")).toBeNull();
		expect(normalizeAssetUri("   ")).toBeNull();
		expect(normalizeAssetUri("https://r2.example.com/face.jpg")).toBeNull();
		// a group id is not a usable generation reference — must be a specific asset
		expect(normalizeAssetUri("group-20260715220249-fmmkm")).toBeNull();
		expect(normalizeAssetUri("just some text")).toBeNull();
	});
});
