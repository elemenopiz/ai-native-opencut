// GIF-flavored variable-code-size LZW compression.
//
// Clean-room implementation written directly from the algorithm described
// in GIF89a spec Appendix F ("The Variable-Length-Code LZW Compression"),
// not from any existing GIF encoder's source. Notable GIF-specific details
// (vs. textbook LZW) captured here:
//  - Codes are packed into bytes least-significant-bit first.
//  - A Clear Code (value 2^minCodeSize) resets the dictionary and code
//    width, and an End of Information Code (Clear Code + 1) terminates
//    the stream.
//  - Code width starts at minCodeSize + 1 bits and grows by one bit the
//    code *after* the dictionary's current width is exhausted (i.e. right
//    after the code equal to 2^codeSize - 1 is assigned), up to 12 bits.
//  - When the dictionary would need a 13-bit code (4096 entries used), a
//    Clear Code is emitted and the dictionary resets instead of growing
//    further.

const MAX_CODE_BITS = 12;
const MAX_DICT_SIZE = 1 << MAX_CODE_BITS; // 4096

/** Packs LSB-first variable-width codes into a byte stream. */
class BitWriter {
	private bitBuffer = 0;
	private bitCount = 0;
	private bytes: number[] = [];

	writeCode(code: number, size: number): void {
		this.bitBuffer |= code << this.bitCount;
		this.bitCount += size;
		while (this.bitCount >= 8) {
			this.bytes.push(this.bitBuffer & 0xff);
			this.bitBuffer >>= 8;
			this.bitCount -= 8;
		}
	}

	/** Flushes any partial trailing byte (zero-padded high bits). */
	finish(): Uint8Array {
		if (this.bitCount > 0) {
			this.bytes.push(this.bitBuffer & 0xff);
			this.bitBuffer = 0;
			this.bitCount = 0;
		}
		return Uint8Array.from(this.bytes);
	}
}

/**
 * Compresses a stream of palette indices using GIF's LZW variant.
 *
 * @param indices palette-index bytes, one per pixel (values must be
 *   < 2^minCodeSize)
 * @param minCodeSize the "LZW Minimum Code Size" transmitted ahead of the
 *   image data sub-blocks (GIF89a spec section 22); must be >= 2
 * @returns the raw compressed bit stream, NOT yet split into GIF
 *   sub-blocks (see `packSubBlocks` in bytes.ts for that step)
 */
export function lzwEncode(
	indices: Uint8Array,
	minCodeSize: number,
): Uint8Array {
	const clearCode = 1 << minCodeSize;
	const endCode = clearCode + 1;
	const firstAvailableCode = endCode + 1;

	const writer = new BitWriter();
	let codeSize = minCodeSize + 1;
	let nextCode = firstAvailableCode;
	// dict.get(prefixCode)?.get(nextByte) -> code for the sequence formed
	// by appending nextByte to the sequence that prefixCode represents.
	// Single-byte sequences need no dictionary entry: their code IS the
	// byte value itself (dictionary is pre-seeded with codes 0..clearCode-1
	// implicitly).
	let dict = new Map<number, Map<number, number>>();

	writer.writeCode(clearCode, codeSize);

	if (indices.length === 0) {
		writer.writeCode(endCode, codeSize);
		return writer.finish();
	}

	let prefixCode = indices[0];
	for (let i = 1; i < indices.length; i++) {
		const symbol = indices[i];
		const branch = dict.get(prefixCode);
		const existingCode = branch?.get(symbol);
		if (existingCode !== undefined) {
			prefixCode = existingCode;
			continue;
		}

		// Emit the code for the longest known prefix, then extend the
		// dictionary with prefix+symbol as a new code.
		writer.writeCode(prefixCode, codeSize);

		if (!branch) dict.set(prefixCode, new Map());
		// biome-ignore lint/style/noNonNullAssertion: set immediately above
		dict.get(prefixCode)!.set(symbol, nextCode);
		const assignedCode = nextCode;
		nextCode++;

		// Code width grows ("early change", GIF89a Appendix F): a GIF
		// decoder can only learn a new dictionary entry's *value* one
		// code after the encoder does (it needs the following code's
		// first symbol to complete the entry), so its dictionary is
		// permanently one entry "behind" the encoder's at the same
		// stream position. To keep both sides reading/writing the same
		// number of bits at the same position, the encoder must widen
		// codes one assignment earlier than the naive "dictionary is
		// full for this width" point (assignedCode === 2^codeSize,
		// rather than 2^codeSize - 1).
		if (assignedCode === 1 << codeSize && codeSize < MAX_CODE_BITS) {
			codeSize++;
		}

		if (nextCode >= MAX_DICT_SIZE) {
			writer.writeCode(clearCode, codeSize);
			dict = new Map();
			nextCode = firstAvailableCode;
			codeSize = minCodeSize + 1;
		}

		prefixCode = symbol;
	}

	writer.writeCode(prefixCode, codeSize);
	writer.writeCode(endCode, codeSize);
	return writer.finish();
}
