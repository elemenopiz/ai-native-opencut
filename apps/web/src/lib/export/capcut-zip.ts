/**
 * Minimal ZIP writer (store method, no compression) used for CapCut draft
 * export. Media files are already compressed (mp4/jpg/mp3), so deflating
 * them again would waste CPU for near-zero gain. Produces a standard ZIP
 * (PKZIP 2.0, UTF-8 file names) readable by macOS Archive Utility, Windows
 * Explorer, and every unzip tool.
 */

export interface ZipEntry {
	/** Forward-slash separated path inside the archive. */
	path: string;
	data: Uint8Array;
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
/** General purpose bit 11: file name is UTF-8. */
const UTF8_FLAG = 0x0800;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let crc = i;
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
		table[i] = crc;
	}
	return table;
})();

function crc32({ data }: { data: Uint8Array }): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime({ date }: { date: Date }): {
	dosTime: number;
	dosDate: number;
} {
	const year = Math.max(1980, date.getFullYear());
	return {
		dosTime:
			(date.getHours() << 11) |
			(date.getMinutes() << 5) |
			Math.floor(date.getSeconds() / 2),
		dosDate:
			((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

export function createZip({
	entries,
	date = new Date(),
}: {
	entries: ZipEntry[];
	date?: Date;
}): Uint8Array {
	const encoder = new TextEncoder();
	const { dosTime, dosDate } = toDosDateTime({ date });

	interface PreparedEntry {
		nameBytes: Uint8Array;
		data: Uint8Array;
		crc: number;
		localHeaderOffset: number;
	}

	const prepared: PreparedEntry[] = [];
	let offset = 0;
	const chunks: Uint8Array[] = [];

	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.path);
		const crc = crc32({ data: entry.data });
		const header = new Uint8Array(30 + nameBytes.length);
		const view = new DataView(header.buffer);
		view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
		view.setUint16(4, VERSION_NEEDED, true);
		view.setUint16(6, UTF8_FLAG, true);
		view.setUint16(8, 0, true); // store (no compression)
		view.setUint16(10, dosTime, true);
		view.setUint16(12, dosDate, true);
		view.setUint32(14, crc, true);
		view.setUint32(18, entry.data.length, true);
		view.setUint32(22, entry.data.length, true);
		view.setUint16(26, nameBytes.length, true);
		view.setUint16(28, 0, true);
		header.set(nameBytes, 30);

		prepared.push({
			nameBytes,
			data: entry.data,
			crc,
			localHeaderOffset: offset,
		});
		chunks.push(header, entry.data);
		offset += header.length + entry.data.length;
	}

	const centralDirectoryOffset = offset;
	for (const entry of prepared) {
		const record = new Uint8Array(46 + entry.nameBytes.length);
		const view = new DataView(record.buffer);
		view.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
		view.setUint16(4, VERSION_NEEDED, true);
		view.setUint16(6, VERSION_NEEDED, true);
		view.setUint16(8, UTF8_FLAG, true);
		view.setUint16(10, 0, true);
		view.setUint16(12, dosTime, true);
		view.setUint16(14, dosDate, true);
		view.setUint32(16, entry.crc, true);
		view.setUint32(20, entry.data.length, true);
		view.setUint32(24, entry.data.length, true);
		view.setUint16(28, entry.nameBytes.length, true);
		view.setUint32(42, entry.localHeaderOffset, true);
		record.set(entry.nameBytes, 46);
		chunks.push(record);
		offset += record.length;
	}

	const endRecord = new Uint8Array(22);
	const endView = new DataView(endRecord.buffer);
	endView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
	endView.setUint16(8, prepared.length, true);
	endView.setUint16(10, prepared.length, true);
	endView.setUint32(12, offset - centralDirectoryOffset, true);
	endView.setUint32(16, centralDirectoryOffset, true);
	chunks.push(endRecord);

	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const result = new Uint8Array(total);
	let position = 0;
	for (const chunk of chunks) {
		result.set(chunk, position);
		position += chunk.length;
	}
	return result;
}
