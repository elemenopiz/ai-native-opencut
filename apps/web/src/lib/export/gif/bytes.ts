// Low-level byte-buffer helpers for GIF89a encoding.
//
// Clean-room: written directly from the GIF89a specification
// (CompuServe, "Graphics Interchange Format, Version 89a", 1990),
// not derived from any third-party encoder's source.

/**
 * Append-only byte sink. Chunks are accumulated and concatenated once,
 * at `toBytes()` time, so appending stays O(1) amortized per call
 * instead of repeatedly reallocating a single growing array.
 */
export class ByteSink {
	private chunks: Uint8Array[] = [];
	private totalLength = 0;

	writeByte(byte: number): void {
		this.chunks.push(Uint8Array.of(byte & 0xff));
		this.totalLength += 1;
	}

	writeBytes(bytes: Uint8Array | ReadonlyArray<number>): void {
		const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
		if (arr.length === 0) return;
		this.chunks.push(arr);
		this.totalLength += arr.length;
	}

	/** Writes an ASCII string byte-for-byte (used for header/identifiers). */
	writeAscii(text: string): void {
		const arr = new Uint8Array(text.length);
		for (let i = 0; i < text.length; i++) arr[i] = text.charCodeAt(i) & 0xff;
		this.writeBytes(arr);
	}

	/** GIF89a integers are stored little-endian throughout (spec section 4). */
	writeUint16LE(value: number): void {
		this.writeBytes([value & 0xff, (value >> 8) & 0xff]);
	}

	get length(): number {
		return this.totalLength;
	}

	toBytes(): Uint8Array {
		const out = new Uint8Array(this.totalLength);
		let offset = 0;
		for (const chunk of this.chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}
}

/**
 * Packages a raw byte stream into GIF "data sub-blocks": each sub-block is
 * a length byte (1-255) followed by that many data bytes, and the whole
 * run is terminated by a zero-length "Block Terminator" byte.
 * GIF89a spec section 15 (Data Sub-blocks) + section 16 (Block Terminator).
 */
export function packSubBlocks(data: Uint8Array): Uint8Array {
	const maxChunk = 255;
	const numChunks = Math.ceil(data.length / maxChunk);
	// numChunks * (1 length byte + up to 255 data bytes) + 1 terminator byte.
	const out = new Uint8Array(data.length + numChunks + 1);
	let outOffset = 0;
	let inOffset = 0;
	while (inOffset < data.length) {
		const chunkLen = Math.min(maxChunk, data.length - inOffset);
		out[outOffset++] = chunkLen;
		out.set(data.subarray(inOffset, inOffset + chunkLen), outOffset);
		outOffset += chunkLen;
		inOffset += chunkLen;
	}
	out[outOffset++] = 0x00; // Block Terminator
	return out.subarray(0, outOffset);
}
