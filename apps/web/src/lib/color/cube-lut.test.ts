import { describe, expect, test } from "bun:test";
import {
	bakeLutAtlas,
	cubeTextToLutParam,
	deserializeLut,
	parseCubeLut,
	serializeLut,
} from "./cube-lut";

// A 2x2x2 identity LUT (red index fastest), with comments, a title and blanks.
const IDENTITY_2 = `# a comment
TITLE "Identity 2"

LUT_3D_SIZE 2
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0

0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;

describe("parseCubeLut", () => {
	test("parses a 3D LUT with title, domain and comments", () => {
		const lut = parseCubeLut({ text: IDENTITY_2 });
		expect(lut.kind).toBe("3d");
		expect(lut.title).toBe("Identity 2");
		expect(lut.size).toBe(2);
		expect(lut.domainMin).toEqual([0, 0, 0]);
		expect(lut.domainMax).toEqual([1, 1, 1]);
		expect(lut.data.length).toBe(2 * 2 * 2 * 3);
		// First row is black, last row is white.
		expect(Array.from(lut.data.slice(0, 3))).toEqual([0, 0, 0]);
		expect(Array.from(lut.data.slice(-3))).toEqual([1, 1, 1]);
	});

	test("rejects 1D LUTs clearly", () => {
		expect(() => parseCubeLut({ text: "LUT_1D_SIZE 4\n" })).toThrow(/1D LUTs/);
	});

	test("throws on missing LUT_3D_SIZE", () => {
		expect(() => parseCubeLut({ text: "0 0 0\n" })).toThrow(/LUT_3D_SIZE/);
	});

	test("throws when the row count does not match the declared size", () => {
		const bad = "LUT_3D_SIZE 2\n0 0 0\n1 1 1\n";
		expect(() => parseCubeLut({ text: bad })).toThrow(/expected 8 data rows/);
	});

	test("throws on an out-of-range size", () => {
		expect(() => parseCubeLut({ text: "LUT_3D_SIZE 1\n" })).toThrow(
			/LUT_3D_SIZE/,
		);
	});

	test("throws on a non-numeric data row", () => {
		const bad = "LUT_3D_SIZE 2\n0 0 0\nfoo bar baz\n";
		expect(() => parseCubeLut({ text: bad })).toThrow(/unrecognized line/);
	});
});

describe("bakeLutAtlas", () => {
	test("lays out blue slices horizontally (size^2 x size)", () => {
		const atlas = bakeLutAtlas({ lut: parseCubeLut({ text: IDENTITY_2 }) });
		expect(atlas.width).toBe(4);
		expect(atlas.height).toBe(2);
		expect(atlas.pixels.length).toBe(4 * 2 * 4);

		const px = (x: number, y: number) => {
			const i = (y * atlas.width + x) * 4;
			return [
				atlas.pixels[i],
				atlas.pixels[i + 1],
				atlas.pixels[i + 2],
				atlas.pixels[i + 3],
			];
		};
		// (b=0,g=0,r=0) black at x=0,y=0
		expect(px(0, 0)).toEqual([0, 0, 0, 255]);
		// (b=0,g=0,r=1) red at x=1,y=0
		expect(px(1, 0)).toEqual([255, 0, 0, 255]);
		// (b=1,g=0,r=0) blue at x=2,y=0
		expect(px(2, 0)).toEqual([0, 0, 255, 255]);
		// (b=1,g=1,r=1) white at x=3,y=1
		expect(px(3, 1)).toEqual([255, 255, 255, 255]);
		// (b=0,g=1,r=0) green at x=0,y=1
		expect(px(0, 1)).toEqual([0, 255, 0, 255]);
	});
});

describe("serialize / deserialize round-trip", () => {
	test("round-trips atlas pixels and metadata", () => {
		const atlas = bakeLutAtlas({ lut: parseCubeLut({ text: IDENTITY_2 }) });
		const serialized = serializeLut({ atlas, name: "Identity 2" });
		const decoded = deserializeLut({ serialized });
		expect(decoded.name).toBe("Identity 2");
		expect(decoded.size).toBe(2);
		expect(decoded.width).toBe(4);
		expect(decoded.height).toBe(2);
		expect(decoded.domainMin).toEqual([0, 0, 0]);
		expect(decoded.domainMax).toEqual([1, 1, 1]);
		expect(Array.from(decoded.pixels)).toEqual(Array.from(atlas.pixels));
	});

	test("cubeTextToLutParam falls back to the file name when no TITLE", () => {
		const noTitle = IDENTITY_2.replace('TITLE "Identity 2"\n', "");
		const { name } = cubeTextToLutParam({
			text: noTitle,
			fileName: "MyLook.cube",
		});
		expect(name).toBe("MyLook");
	});

	test("deserialize rejects a corrupt payload", () => {
		const bad = JSON.stringify({
			name: "x",
			size: 2,
			width: 4,
			height: 2,
			domainMin: [0, 0, 0],
			domainMax: [1, 1, 1],
			pixelsBase64: "AAAA",
		});
		expect(() => deserializeLut({ serialized: bad })).toThrow(/Corrupt LUT/);
	});
});
