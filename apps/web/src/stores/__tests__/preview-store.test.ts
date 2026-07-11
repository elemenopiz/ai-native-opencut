import { describe, expect, test } from "bun:test";
import {
	DEFAULT_GRID_CONFIG,
	GRID_MAX,
	GRID_MIN,
	clampGridValue,
	computeGridLines,
	migratePreviewState,
} from "@/stores/preview-store";

// The "Show grid" context-menu item used to be a dead stub, and
// `layout-guide-overlay.tsx` was never mounted (see poach recon lane 03).
// These pin the pure geometry + migration logic that back the fix.

describe("computeGridLines", () => {
	test("default 3x3 grid has 2 interior lines each way, evenly spaced", () => {
		const { verticals, horizontals } = computeGridLines(DEFAULT_GRID_CONFIG);
		expect(verticals).toHaveLength(2);
		expect(verticals[0]).toBeCloseTo(33.333, 2);
		expect(verticals[1]).toBeCloseTo(66.667, 2);
		expect(horizontals).toEqual(verticals);
	});

	test("1x1 grid has no interior lines", () => {
		const { verticals, horizontals } = computeGridLines({ rows: 1, cols: 1 });
		expect(verticals).toEqual([]);
		expect(horizontals).toEqual([]);
	});

	test("asymmetric rows/cols produce independent line counts", () => {
		const { verticals, horizontals } = computeGridLines({ rows: 2, cols: 4 });
		expect(verticals).toHaveLength(3);
		expect(horizontals).toHaveLength(1);
		expect(horizontals).toEqual([50]);
	});

	test("24x24 (max) grid produces 23 lines each way", () => {
		const { verticals, horizontals } = computeGridLines({
			rows: GRID_MAX,
			cols: GRID_MAX,
		});
		expect(verticals).toHaveLength(GRID_MAX - 1);
		expect(horizontals).toHaveLength(GRID_MAX - 1);
	});
});

describe("clampGridValue", () => {
	test("clamps below GRID_MIN up to GRID_MIN", () => {
		expect(clampGridValue(0)).toBe(GRID_MIN);
		expect(clampGridValue(-5)).toBe(GRID_MIN);
	});

	test("clamps above GRID_MAX down to GRID_MAX", () => {
		expect(clampGridValue(100)).toBe(GRID_MAX);
	});

	test("rounds fractional values", () => {
		expect(clampGridValue(3.4)).toBe(3);
		expect(clampGridValue(3.6)).toBe(4);
	});

	test("passes through in-range integers unchanged", () => {
		expect(clampGridValue(5)).toBe(5);
	});
});

describe("migratePreviewState", () => {
	test("undefined persisted state falls back to defaults", () => {
		expect(migratePreviewState(undefined)).toEqual({
			activeGuideId: null,
			gridConfig: DEFAULT_GRID_CONFIG,
			overlays: { bookmarks: true },
		});
	});

	test("v2 shape (layoutGuide.platform) migrates into activeGuideId", () => {
		const migrated = migratePreviewState({
			layoutGuide: { platform: "tiktok" },
			overlays: { bookmarks: false },
		});
		expect(migrated.activeGuideId).toBe("tiktok");
		expect(migrated.overlays).toEqual({ bookmarks: false });
		expect(migrated.gridConfig).toEqual(DEFAULT_GRID_CONFIG);
	});

	test("v2 shape with no active guide migrates to null, not undefined", () => {
		const migrated = migratePreviewState({
			layoutGuide: { platform: null },
		});
		expect(migrated.activeGuideId).toBeNull();
	});

	test("v3 shape (already migrated) round-trips unchanged", () => {
		const v3State = {
			activeGuideId: "grid" as const,
			gridConfig: { rows: 5, cols: 7 },
			overlays: { bookmarks: true },
		};
		expect(migratePreviewState(v3State)).toEqual(v3State);
	});

	test("v3 activeGuideId takes precedence over a stale layoutGuide field", () => {
		const migrated = migratePreviewState({
			activeGuideId: "grid",
			layoutGuide: { platform: "tiktok" },
		});
		expect(migrated.activeGuideId).toBe("grid");
	});
});
