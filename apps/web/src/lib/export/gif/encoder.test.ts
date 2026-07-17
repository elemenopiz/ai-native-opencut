import { describe, expect, test } from "bun:test";
import { GifEncoder, type GifFrameData } from "./encoder";

// ---------------------------------------------------------------------------
// Minimal GIF structure parser (TEST-ONLY, not shipped). Walks the block
// stream well enough to assert layout invariants; it is intentionally not a
// full/robust GIF reader.
// ---------------------------------------------------------------------------

interface ParsedGif {
	header: string;
	screenWidth: number;
	screenHeight: number;
	netscapeLoopCount: number | null;
	imageDescriptorCount: number;
	gceDelays: number[];
	trailerIsLastByte: boolean;
	subBlockLengthsOk: boolean;
	/** Byte ranges of each frame's compressed image-data sub-blocks. */
	imageDataBlocks: Uint8Array[][];
	/** LZW minimum code size transmitted before each frame's image data. */
	lzwMinCodeSizes: number[];
	/** Local color table bytes (RGB triples) for each frame, in order. */
	localColorTables: Uint8Array[];
}

function readSubBlocks(
	bytes: Uint8Array,
	offset: number,
): { blocks: Uint8Array[]; nextOffset: number; allLengthsOk: boolean } {
	const blocks: Uint8Array[] = [];
	let allLengthsOk = true;
	let o = offset;
	while (true) {
		const len = bytes[o];
		o += 1;
		if (len === 0) break;
		if (len > 255) allLengthsOk = false;
		blocks.push(bytes.subarray(o, o + len));
		o += len;
	}
	return { blocks, nextOffset: o, allLengthsOk };
}

function parseGif(bytes: Uint8Array): ParsedGif {
	const header = String.fromCharCode(...bytes.subarray(0, 6));
	const screenWidth = bytes[6] | (bytes[7] << 8);
	const screenHeight = bytes[8] | (bytes[9] << 8);

	let offset = 13; // header(6) + LSD(7), no GCT since GCT flag is always 0
	let netscapeLoopCount: number | null = null;
	let imageDescriptorCount = 0;
	const gceDelays: number[] = [];
	let trailerIsLastByte = false;
	let subBlockLengthsOk = true;
	const imageDataBlocks: Uint8Array[][] = [];
	const lzwMinCodeSizes: number[] = [];
	const localColorTables: Uint8Array[] = [];

	while (offset < bytes.length) {
		const marker = bytes[offset];
		if (marker === 0x21) {
			// Extension introducer
			const label = bytes[offset + 1];
			if (label === 0xff) {
				// Application extension
				const blockSize = bytes[offset + 2];
				const appId = String.fromCharCode(
					...bytes.subarray(offset + 3, offset + 3 + 8),
				);
				const authCode = String.fromCharCode(
					...bytes.subarray(offset + 11, offset + 14),
				);
				const o = offset + 2 + blockSize + 1;
				const { blocks, nextOffset } = readSubBlocks(bytes, o);
				if (appId === "NETSCAPE" && authCode === "2.0") {
					const dataBlock = blocks[0];
					if (dataBlock && dataBlock[0] === 0x01) {
						netscapeLoopCount = dataBlock[1] | (dataBlock[2] << 8);
					}
				}
				offset = nextOffset;
			} else if (label === 0xf9) {
				// Graphic Control Extension: introducer(1) + label(1) +
				// blockSize(1) + blockSize data bytes, then a trailing
				// zero-length sub-block acts as the terminator — read it
				// via readSubBlocks so the offset math stays in one place.
				const blockSize = bytes[offset + 2];
				const packed = bytes[offset + 3];
				const delay = bytes[offset + 4] | (bytes[offset + 5] << 8);
				gceDelays.push(delay);
				void packed;
				const { nextOffset } = readSubBlocks(bytes, offset + 3 + blockSize);
				offset = nextOffset;
			} else {
				// Unknown extension: skip generically via sub-blocks.
				const blockSize = bytes[offset + 2];
				const { nextOffset } = readSubBlocks(bytes, offset + 3 + blockSize);
				offset = nextOffset;
			}
		} else if (marker === 0x2c) {
			// Image Descriptor
			imageDescriptorCount++;
			const packed = bytes[offset + 9];
			const hasLct = (packed & 0x80) !== 0;
			const lctBits = (packed & 0x07) + 1;
			let o = offset + 10;
			if (hasLct) {
				const lctEntries = 1 << lctBits;
				localColorTables.push(bytes.subarray(o, o + lctEntries * 3));
				o += lctEntries * 3;
			}
			const minCodeSize = bytes[o];
			lzwMinCodeSizes.push(minCodeSize);
			o += 1;
			const { blocks, nextOffset, allLengthsOk } = readSubBlocks(bytes, o);
			imageDataBlocks.push(blocks);
			if (!allLengthsOk) subBlockLengthsOk = false;
			offset = nextOffset;
		} else if (marker === 0x3b) {
			trailerIsLastByte = offset === bytes.length - 1;
			offset = bytes.length;
		} else {
			throw new Error(
				`parseGif: unexpected block marker 0x${marker.toString(16)} at offset ${offset}`,
			);
		}
	}

	return {
		header,
		screenWidth,
		screenHeight,
		netscapeLoopCount,
		imageDescriptorCount,
		gceDelays,
		trailerIsLastByte,
		subBlockLengthsOk,
		imageDataBlocks,
		lzwMinCodeSizes,
		localColorTables,
	};
}

// ---------------------------------------------------------------------------
// Minimal LZW decoder (TEST-ONLY, mirror of the GIF LZW variant) used to
// round-trip frame 1's compressed data back to palette indices.
// ---------------------------------------------------------------------------

function lzwDecode(
	subBlocks: Uint8Array[],
	minCodeSize: number,
	expectedPixelCount: number,
): number[] {
	const data = subBlocks.reduce((total, b) => total + b.length, 0);
	const bytes = new Uint8Array(data);
	let o = 0;
	for (const b of subBlocks) {
		bytes.set(b, o);
		o += b.length;
	}

	let bitBuffer = 0;
	let bitCount = 0;
	let bytePos = 0;
	function readCode(size: number): number {
		while (bitCount < size) {
			bitBuffer |= bytes[bytePos] << bitCount;
			bytePos++;
			bitCount += 8;
		}
		const code = bitBuffer & ((1 << size) - 1);
		bitBuffer >>= size;
		bitCount -= size;
		return code;
	}

	const clearCode = 1 << minCodeSize;
	const endCode = clearCode + 1;
	let codeSize = minCodeSize + 1;
	let dict: number[][] = [];
	function resetDict() {
		dict = [];
		for (let i = 0; i < clearCode; i++) dict.push([i]);
		dict.push([]); // clear code placeholder
		dict.push([]); // end code placeholder
		codeSize = minCodeSize + 1;
	}
	resetDict();

	const output: number[] = [];
	let prevEntry: number[] | null = null;

	while (output.length < expectedPixelCount) {
		const code = readCode(codeSize);
		if (code === clearCode) {
			resetDict();
			prevEntry = null;
			continue;
		}
		if (code === endCode) break;

		let entry: number[];
		if (code < dict.length && dict[code].length > 0) {
			entry = dict[code];
		} else if (code === dict.length && prevEntry) {
			entry = [...prevEntry, prevEntry[0]];
		} else {
			throw new Error(`lzwDecode: invalid code ${code}`);
		}

		output.push(...entry);

		if (prevEntry) {
			dict.push([...prevEntry, entry[0]]);
			const lastIndex = dict.length - 1;
			if (lastIndex === (1 << codeSize) - 1 && codeSize < 12) {
				codeSize++;
			}
		}
		prevEntry = entry;
	}

	return output.slice(0, expectedPixelCount);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSolidFrame(
	width: number,
	height: number,
	r: number,
	g: number,
	b: number,
	a = 255,
): GifFrameData {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data[i * 4] = r;
		data[i * 4 + 1] = g;
		data[i * 4 + 2] = b;
		data[i * 4 + 3] = a;
	}
	return { width, height, data };
}

function makeGradientFrame(width: number, height: number): GifFrameData {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			data[i] = Math.floor((x / Math.max(1, width - 1)) * 255);
			data[i + 1] = Math.floor((y / Math.max(1, height - 1)) * 255);
			data[i + 2] = Math.floor(((x + y) / (width + height - 2 || 1)) * 255);
			data[i + 3] = 255;
		}
	}
	return { width, height, data };
}

function makeNoiseFrame(width: number, height: number): GifFrameData {
	const data = new Uint8ClampedArray(width * height * 4);
	// Deterministic PRNG (mulberry32) — no external dependency, reproducible.
	let seed = 42;
	function rand(): number {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	for (let i = 0; i < width * height; i++) {
		data[i * 4] = Math.floor(rand() * 256);
		data[i * 4 + 1] = Math.floor(rand() * 256);
		data[i * 4 + 2] = Math.floor(rand() * 256);
		data[i * 4 + 3] = 255;
	}
	return { width, height, data };
}

// ---------------------------------------------------------------------------
// Structure tests
// ---------------------------------------------------------------------------

describe("GifEncoder structure", () => {
	test("2x2 two-frame gif has correct header/screen/loop/trailer", () => {
		const width = 2;
		const height = 2;
		const fps = 10; // delay = 10 centiseconds
		const encoder = new GifEncoder({ width, height, fps, loop: true });
		encoder.addFrame(makeSolidFrame(width, height, 255, 0, 0));
		encoder.addFrame(makeSolidFrame(width, height, 0, 255, 0));
		const bytes = encoder.finish();

		const parsed = parseGif(bytes);
		expect(parsed.header).toBe("GIF89a");
		expect(parsed.screenWidth).toBe(width);
		expect(parsed.screenHeight).toBe(height);
		expect(parsed.netscapeLoopCount).toBe(0);
		expect(parsed.imageDescriptorCount).toBe(2);
		expect(parsed.gceDelays).toEqual([10, 10]);
		expect(parsed.trailerIsLastByte).toBe(true);
		expect(parsed.subBlockLengthsOk).toBe(true);
		expect(bytes[bytes.length - 1]).toBe(0x3b);
	});

	test("loop: false omits the NETSCAPE loop extension", () => {
		const encoder = new GifEncoder({
			width: 2,
			height: 2,
			fps: 10,
			loop: false,
		});
		encoder.addFrame(makeSolidFrame(2, 2, 1, 2, 3));
		const bytes = encoder.finish();
		const parsed = parseGif(bytes);
		expect(parsed.netscapeLoopCount).toBeNull();
	});

	test("fps determines GCE delay in centiseconds (round(100/fps))", () => {
		const encoder = new GifEncoder({ width: 1, height: 1, fps: 24 });
		encoder.addFrame(makeSolidFrame(1, 1, 10, 20, 30));
		const bytes = encoder.finish();
		const parsed = parseGif(bytes);
		expect(parsed.gceDelays).toEqual([Math.round(100 / 24)]);
	});

	test("image descriptor count matches number of addFrame calls", () => {
		const encoder = new GifEncoder({ width: 1, height: 1, fps: 15 });
		for (let i = 0; i < 5; i++) {
			encoder.addFrame(makeSolidFrame(1, 1, i, i, i));
		}
		const bytes = encoder.finish();
		const parsed = parseGif(bytes);
		expect(parsed.imageDescriptorCount).toBe(5);
		expect(parsed.gceDelays).toHaveLength(5);
	});
});

// ---------------------------------------------------------------------------
// Functional / round-trip tests
// ---------------------------------------------------------------------------

describe("GifEncoder functional", () => {
	test("solid-color frames survive quantization losslessly", () => {
		const width = 2;
		const height = 2;
		const color: [number, number, number] = [200, 50, 100];
		const encoder = new GifEncoder({ width, height, fps: 10 });
		encoder.addFrame(makeSolidFrame(width, height, ...color));
		encoder.addFrame(makeSolidFrame(width, height, 0, 0, 0));
		const bytes = encoder.finish();
		const parsed = parseGif(bytes);

		const frame0Blocks = parsed.imageDataBlocks[0];
		const frame0MinCodeSize = parsed.lzwMinCodeSizes[0];
		const indices = lzwDecode(frame0Blocks, frame0MinCodeSize, width * height);
		expect(indices).toEqual([0, 0, 0, 0]);

		const lct = parsed.localColorTables[0];
		const decodedColor: [number, number, number] = [lct[0], lct[1], lct[2]];
		expect(decodedColor).toEqual(color);
	});

	test(">256-distinct-color gradient frame still produces a legal <=256 palette", () => {
		const width = 64;
		const height = 64; // 4096 pixels, far more than 256 distinct colors
		const encoder = new GifEncoder({ width, height, fps: 12 });
		encoder.addFrame(makeGradientFrame(width, height));
		const bytes = encoder.finish();
		const parsed = parseGif(bytes);

		expect(parsed.imageDescriptorCount).toBe(1);
		const lctBytes = parsed.localColorTables[0];
		expect(lctBytes.length % 3).toBe(0);
		const tableEntryCount = lctBytes.length / 3;
		// Table size must be a power of two <= 256 (GIF LCT size field).
		expect(tableEntryCount).toBeLessThanOrEqual(256);
		expect(Math.log2(tableEntryCount) % 1).toBe(0);
		expect(parsed.subBlockLengthsOk).toBe(true);

		// Full round-trip: decode indices, resolve through the LCT, and
		// confirm every decoded index actually addresses a palette slot.
		const indices = lzwDecode(
			parsed.imageDataBlocks[0],
			parsed.lzwMinCodeSizes[0],
			width * height,
		);
		expect(indices).toHaveLength(width * height);
		for (const idx of indices) {
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(idx).toBeLessThan(tableEntryCount);
		}
	});

	test("mismatched ImageData dimensions throws", () => {
		const encoder = new GifEncoder({ width: 4, height: 4, fps: 10 });
		expect(() => encoder.addFrame(makeSolidFrame(2, 2, 1, 1, 1))).toThrow();
	});

	test("addFrame after finish() throws", () => {
		const encoder = new GifEncoder({ width: 2, height: 2, fps: 10 });
		encoder.addFrame(makeSolidFrame(2, 2, 1, 1, 1));
		encoder.finish();
		expect(() => encoder.addFrame(makeSolidFrame(2, 2, 2, 2, 2))).toThrow();
	});

	test("constructor rejects non-positive width/height/fps", () => {
		expect(() => new GifEncoder({ width: 0, height: 2, fps: 10 })).toThrow();
		expect(() => new GifEncoder({ width: 2, height: -1, fps: 10 })).toThrow();
		expect(() => new GifEncoder({ width: 2, height: 2, fps: 0 })).toThrow();
	});

	test("perf sanity: 640x360 noise frame encodes in under 2s", () => {
		const width = 640;
		const height = 360;
		const encoder = new GifEncoder({ width, height, fps: 15 });
		const frame = makeNoiseFrame(width, height);
		const start = performance.now();
		encoder.addFrame(frame);
		const bytes = encoder.finish();
		const elapsedMs = performance.now() - start;
		expect(elapsedMs).toBeLessThan(2000);
		expect(bytes.length).toBeGreaterThan(0);
	});
});
