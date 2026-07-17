// Self-contained, dependency-free GIF89a animated-GIF encoder.
//
// Clean-room implementation written directly from the GIF89a specification
// (CompuServe, "Graphics Interchange Format, Version 89a", 1990) — no code
// or structure was copied from any existing GIF encoder/decoder library.
// Section numbers cited in comments below refer to that spec.
//
// Byte layout, top to bottom of the produced file:
//   Header                                (section 17)
//   Logical Screen Descriptor             (section 18)
//   [NETSCAPE2.0 Application Extension]   (unofficial de facto standard
//                                          for infinite looping, layered
//                                          on the Application Extension
//                                          block defined in section 26)
//   per frame:
//     Graphic Control Extension           (section 23)
//     Image Descriptor + Local Color Table(sections 20, 21)
//     Image Data (LZW compressed)         (section 22, Appendix F)
//   Trailer                               (section 27)
//
// See quantize.ts for the color-quantization alpha/dithering policy, and
// lzw.ts for the LZW compression details.

import { ByteSink, packSubBlocks } from "./bytes";
import { medianCutQuantize } from "./quantize";
import { lzwEncode } from "./lzw";

/**
 * Structural subset of DOM `ImageData` — deliberately not `ImageData`
 * itself so this module has zero DOM lib dependency and works in plain
 * Node/bun test environments (no `ImageData` global there). A real
 * `ImageData` satisfies this type as-is.
 */
export interface GifFrameData {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8ClampedArray;
}

export interface GifEncoderOptions {
	width: number;
	height: number;
	fps: number;
	/** Infinite loop via NETSCAPE2.0 extension. Defaults to true. */
	loop?: boolean;
}

const GIF_TRAILER = 0x3b;
const EXTENSION_INTRODUCER = 0x21;
const APPLICATION_EXTENSION_LABEL = 0xff;
const GRAPHIC_CONTROL_LABEL = 0xf9;
const IMAGE_SEPARATOR = 0x2c;
const BLOCK_TERMINATOR = 0x00;

/** Disposal method 1 = "do not dispose" (spec section 23, packed field). */
const DISPOSAL_DO_NOT_DISPOSE = 1;

/** Bits needed to index a palette of the given length, clamped to [1, 8]. */
function colorTableBits(paletteLength: number): number {
	let bits = 1;
	while (1 << bits < paletteLength) bits++;
	return Math.min(8, Math.max(1, bits));
}

export class GifEncoder {
	readonly width: number;
	readonly height: number;
	private readonly fps: number;
	private readonly loop: boolean;
	private readonly delayCentiseconds: number;
	private readonly sink = new ByteSink();
	private finished = false;
	private finishedBytes: Uint8Array | null = null;

	constructor(opts: GifEncoderOptions) {
		if (!Number.isInteger(opts.width) || opts.width <= 0) {
			throw new Error(
				`GifEncoder: width must be a positive integer, got ${opts.width}`,
			);
		}
		if (!Number.isInteger(opts.height) || opts.height <= 0) {
			throw new Error(
				`GifEncoder: height must be a positive integer, got ${opts.height}`,
			);
		}
		if (opts.width > 0xffff || opts.height > 0xffff) {
			throw new Error(
				"GifEncoder: width/height must fit in 16 bits " +
					`(GIF89a Logical Screen Descriptor), got ${opts.width}x${opts.height}`,
			);
		}
		if (!Number.isFinite(opts.fps) || opts.fps <= 0) {
			throw new Error(`GifEncoder: fps must be positive, got ${opts.fps}`);
		}

		this.width = opts.width;
		this.height = opts.height;
		this.fps = opts.fps;
		this.loop = opts.loop ?? true;
		// GIF delay units are centiseconds (1/100s); spec section 23.
		this.delayCentiseconds = Math.round(100 / this.fps);

		this.writeHeaderAndLogicalScreenDescriptor();
		if (this.loop) this.writeNetscapeLoopExtension();
	}

	addFrame(frame: GifFrameData): void {
		if (this.finished) {
			throw new Error(
				"GifEncoder: cannot addFrame() after finish() has been called",
			);
		}
		if (frame.width !== this.width || frame.height !== this.height) {
			throw new Error(
				`GifEncoder: frame dimensions ${frame.width}x${frame.height} ` +
					`do not match encoder dimensions ${this.width}x${this.height}`,
			);
		}
		const expectedLength = this.width * this.height * 4;
		if (frame.data.length !== expectedLength) {
			throw new Error(
				`GifEncoder: frame data length ${frame.data.length} does not ` +
					`match expected RGBA byte length ${expectedLength} for a ` +
					`${this.width}x${this.height} frame`,
			);
		}

		const pixelCount = this.width * this.height;
		const { palette, indices } = medianCutQuantize(frame.data, pixelCount, 256);

		this.writeGraphicControlExtension();
		this.writeImageDescriptorAndLocalColorTable(palette);
		this.writeImageData(indices, palette.length);
	}

	finish(): Uint8Array {
		if (!this.finished) {
			this.sink.writeByte(GIF_TRAILER); // spec section 27
			this.finished = true;
			this.finishedBytes = this.sink.toBytes();
		}
		// biome-ignore lint/style/noNonNullAssertion: set unconditionally above
		return this.finishedBytes!;
	}

	// ---- section 17: Header ----------------------------------------------
	private writeHeaderAndLogicalScreenDescriptor(): void {
		this.sink.writeAscii("GIF89a");

		// ---- section 18: Logical Screen Descriptor ----
		this.sink.writeUint16LE(this.width);
		this.sink.writeUint16LE(this.height);
		// Packed fields byte:
		//   bit 7:    Global Color Table Flag = 0 (we only ever emit Local
		//             Color Tables, one per frame, per the task contract)
		//   bits 6-4: Color Resolution = 7 (111b), i.e. "colors were
		//             chosen from a 2^8 per-primary palette" — informational
		//             only, no decoder behavior depends on it
		//   bit 3:    Sort Flag = 0 (no Global Color Table to sort)
		//   bits 2-0: Size of Global Color Table = 0 (unused, no GCT)
		const packed = (0 << 7) | (0b111 << 4) | (0 << 3) | 0;
		this.sink.writeByte(packed);
		this.sink.writeByte(0x00); // Background Color Index (unused, no GCT)
		this.sink.writeByte(0x00); // Pixel Aspect Ratio: 0 = unspecified
	}

	// NETSCAPE2.0 Application Extension: not part of GIF89a proper, but the
	// universally-implemented de facto mechanism for infinite animation
	// looping, built on the generic Application Extension block (spec
	// section 26).
	private writeNetscapeLoopExtension(): void {
		this.sink.writeByte(EXTENSION_INTRODUCER);
		this.sink.writeByte(APPLICATION_EXTENSION_LABEL);
		this.sink.writeByte(0x0b); // Block Size: 11 bytes follow (8 + 3)
		this.sink.writeAscii("NETSCAPE"); // Application Identifier (8 bytes)
		this.sink.writeAscii("2.0"); // Application Authentication Code (3 bytes)
		// Application Data sub-block: length 3, Sub-block ID 0x01 ("loop
		// count follows"), then a 16-bit loop count. 0 = loop forever.
		this.sink.writeByte(0x03);
		this.sink.writeByte(0x01);
		this.sink.writeUint16LE(0x0000);
		this.sink.writeByte(BLOCK_TERMINATOR);
	}

	// ---- section 23: Graphic Control Extension ----------------------------
	private writeGraphicControlExtension(): void {
		this.sink.writeByte(EXTENSION_INTRODUCER);
		this.sink.writeByte(GRAPHIC_CONTROL_LABEL);
		this.sink.writeByte(0x04); // Block Size: 4 bytes follow
		// Packed fields byte:
		//   bits 7-5: Reserved = 000
		//   bits 4-2: Disposal Method = 1 ("do not dispose", per contract)
		//   bit 1:    User Input Flag = 0
		//   bit 0:    Transparent Color Flag = 0 (no transparency; frames
		//             are fully composited per the quantizer's alpha policy)
		const packed = (DISPOSAL_DO_NOT_DISPOSE << 2) | (0 << 1) | 0;
		this.sink.writeByte(packed);
		this.sink.writeUint16LE(this.delayCentiseconds);
		this.sink.writeByte(0x00); // Transparent Color Index (unused)
		this.sink.writeByte(BLOCK_TERMINATOR);
	}

	// ---- sections 20 + 21: Image Descriptor + Local Color Table ----------
	private writeImageDescriptorAndLocalColorTable(
		palette: Array<[number, number, number]>,
	): void {
		this.sink.writeByte(IMAGE_SEPARATOR);
		this.sink.writeUint16LE(0); // Image Left Position
		this.sink.writeUint16LE(0); // Image Top Position
		this.sink.writeUint16LE(this.width);
		this.sink.writeUint16LE(this.height);

		const bits = colorTableBits(palette.length);
		const tableEntryCount = 1 << bits;
		// Packed fields byte:
		//   bit 7:    Local Color Table Flag = 1 (every frame carries its
		//             own LCT — safest choice for arbitrary video frames,
		//             per the task contract)
		//   bit 6:    Interlace Flag = 0
		//   bit 5:    Sort Flag = 0
		//   bits 4-3: Reserved = 00
		//   bits 2-0: Size of Local Color Table = bits - 1 (table holds
		//             2^(N+1) entries)
		const packed = (1 << 7) | (0 << 6) | (0 << 5) | (0 << 3) | (bits - 1);
		this.sink.writeByte(packed);

		// Local Color Table: tableEntryCount * 3 bytes (R, G, B). Real
		// palette entries first, padded with black for unused slots up to
		// the power-of-two table size the packed field declares.
		const lct = new Uint8Array(tableEntryCount * 3);
		for (let i = 0; i < palette.length; i++) {
			const [r, g, b] = palette[i];
			lct[i * 3] = r;
			lct[i * 3 + 1] = g;
			lct[i * 3 + 2] = b;
		}
		this.sink.writeBytes(lct);
	}

	// ---- section 22 + Appendix F: Table Based Image Data ------------------
	private writeImageData(indices: Uint8Array, paletteLength: number): void {
		const bits = colorTableBits(paletteLength);
		// LZW Minimum Code Size must be >= 2 even for 2-color images
		// (spec section 22 / Appendix F).
		const minCodeSize = Math.max(2, bits);
		this.sink.writeByte(minCodeSize);
		const compressed = lzwEncode(indices, minCodeSize);
		this.sink.writeBytes(packSubBlocks(compressed));
	}
}
