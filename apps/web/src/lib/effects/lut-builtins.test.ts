import { describe, expect, test } from "bun:test";
import {
	BUILTIN_LUT_LOOKS,
	BUILTIN_LUT_SIZE,
	buildCubeText,
	generateBuiltinLutCubes,
} from "./lut-builtins";
import { parseCubeLut } from "./lut-cube-parser";
import {
	getLutPresetOptions,
	getLutTiledTexture,
	hasLutPreset,
	registerLutFromCubeText,
	subscribeLutRegistry,
	DEFAULT_LUT_ID,
} from "./lut-registry";
import {
	lutLabelFromFileName,
	MAX_CUBE_FILE_BYTES,
	validateCubeFile,
} from "./lut-upload";

describe("buildCubeText", () => {
	test("emits valid .cube text the registry parser accepts", () => {
		const text = buildCubeText({
			title: "Identity",
			size: 4,
			transform: (r, g, b) => [r, g, b],
		});
		const lut = parseCubeLut(text);
		expect(lut.size).toBe(4);
		expect(lut.title).toBe("Identity");
		expect(lut.data.length).toBe(4 * 4 * 4 * 3);
	});

	test("identity transform round-trips grid coordinates", () => {
		const size = 3;
		const text = buildCubeText({
			title: "Identity",
			size,
			transform: (r, g, b) => [r, g, b],
		});
		const lut = parseCubeLut(text);
		// Red varies fastest: the second row is r=0.5, g=0, b=0.
		expect(lut.data[3]).toBeCloseTo(0.5, 5);
		expect(lut.data[4]).toBeCloseTo(0, 5);
		expect(lut.data[5]).toBeCloseTo(0, 5);
		// Last row is white.
		const last = (size * size * size - 1) * 3;
		expect(lut.data[last]).toBeCloseTo(1, 5);
		expect(lut.data[last + 1]).toBeCloseTo(1, 5);
		expect(lut.data[last + 2]).toBeCloseTo(1, 5);
	});

	test("clamps transform outputs into [0, 1]", () => {
		const text = buildCubeText({
			title: "Wild",
			size: 2,
			transform: () => [-0.5, 2, 0.5],
		});
		const lut = parseCubeLut(text);
		expect(lut.data[0]).toBe(0);
		expect(lut.data[1]).toBe(1);
		expect(lut.data[2]).toBeCloseTo(0.5, 5);
	});
});

describe("built-in starter LUTs", () => {
	test("every built-in emits parseable .cube text at the expected size", () => {
		const cubes = generateBuiltinLutCubes();
		expect(cubes.length).toBe(BUILTIN_LUT_LOOKS.length);
		for (const { cubeText, label } of cubes) {
			const lut = parseCubeLut(cubeText);
			expect(lut.size).toBe(BUILTIN_LUT_SIZE);
			expect(lut.title).toBe(label);
		}
	});

	test("mono look is grayscale everywhere", () => {
		const mono = BUILTIN_LUT_LOOKS.find((look) => look.id === "builtin-mono");
		expect(mono).toBeDefined();
		const [r, g, b] = mono!.transform(0.8, 0.3, 0.1);
		expect(r).toBe(g);
		expect(g).toBe(b);
	});

	test("warm look pushes red up and blue down at mid-gray", () => {
		const warm = BUILTIN_LUT_LOOKS.find((look) => look.id === "builtin-warm");
		expect(warm).toBeDefined();
		const [r, , b] = warm!.transform(0.5, 0.5, 0.5);
		expect(r).toBeGreaterThan(0.5);
		expect(b).toBeLessThan(0.5);
	});
});

describe("lut-registry", () => {
	test("built-ins and the identity preset are registered at load", () => {
		const options = getLutPresetOptions();
		expect(options[0]).toEqual({ value: DEFAULT_LUT_ID, label: "None" });
		for (const look of BUILTIN_LUT_LOOKS) {
			expect(hasLutPreset(look.id)).toBe(true);
			expect(options.some((option) => option.value === look.id)).toBe(true);
		}
	});

	test("registerLutFromCubeText adds an option, notifies subscribers, and refreshes the snapshot", () => {
		const before = getLutPresetOptions();
		let notified = 0;
		const unsubscribe = subscribeLutRegistry(() => {
			notified += 1;
		});
		registerLutFromCubeText({
			id: "user-test",
			label: "Test Upload",
			cubeText: buildCubeText({
				title: "Test Upload",
				size: 2,
				transform: (r, g, b) => [r, g, b],
			}),
		});
		unsubscribe();

		expect(notified).toBe(1);
		const after = getLutPresetOptions();
		expect(after).not.toBe(before); // new snapshot reference for useSyncExternalStore
		expect(after.some((option) => option.value === "user-test")).toBe(true);
		expect(hasLutPreset("user-test")).toBe(true);
	});

	test("registerLutFromCubeText throws on malformed text without registering", () => {
		expect(() =>
			registerLutFromCubeText({
				id: "user-bad",
				label: "Bad",
				cubeText: "not a cube file",
			}),
		).toThrow();
		expect(hasLutPreset("user-bad")).toBe(false);
	});

	test("getLutTiledTexture falls back to identity for unknown ids", () => {
		const fallback = getLutTiledTexture("does-not-exist");
		expect(fallback).toBe(getLutTiledTexture(DEFAULT_LUT_ID));
	});
});

describe("validateCubeFile", () => {
	test("accepts a normal .cube file", () => {
		expect(validateCubeFile({ name: "My Look.CUBE", size: 1024 })).toBeNull();
	});

	test("rejects non-.cube extensions", () => {
		expect(validateCubeFile({ name: "look.png", size: 1024 })).toMatch(
			/\.cube/,
		);
	});

	test("rejects empty files", () => {
		expect(validateCubeFile({ name: "look.cube", size: 0 })).toMatch(/empty/);
	});

	test("rejects oversized files", () => {
		expect(
			validateCubeFile({ name: "look.cube", size: MAX_CUBE_FILE_BYTES + 1 }),
		).toMatch(/too large/);
	});
});

describe("lutLabelFromFileName", () => {
	test("strips the extension", () => {
		expect(lutLabelFromFileName("Golden Hour.cube")).toBe("Golden Hour");
	});

	test("falls back for degenerate names", () => {
		expect(lutLabelFromFileName(".cube")).toBe("Imported LUT");
	});
});
