import { describe, expect, it } from "bun:test";
import {
	extractDroppedEntries,
	filesFromDirectoryInput,
} from "@/lib/media/folder-upload";

// File doesn't support webkitRelativePath in its constructor; browsers set
// it as a read-only own property on the instances produced by a
// webkitdirectory <input>. Reproduce that shape for fabricated Files.
function fileWithRelativePath(name: string, relativePath: string): File {
	const file = new File(["content"], name, { type: "video/mp4" });
	Object.defineProperty(file, "webkitRelativePath", {
		value: relativePath,
		writable: false,
	});
	return file;
}

function fakeFileList(files: File[]): FileList {
	const list = {
		length: files.length,
		item(index: number) {
			return files[index] ?? null;
		},
	};
	files.forEach((file, i) => {
		(list as unknown as Record<number, File>)[i] = file;
	});
	return list as unknown as FileList;
}

describe("filesFromDirectoryInput", () => {
	it("splits webkitRelativePath into folder segments, excluding the filename", () => {
		const file = fileWithRelativePath("clip.mp4", "Trip/Day1/clip.mp4");
		const [entry] = filesFromDirectoryInput(fakeFileList([file]));

		expect(entry.path).toEqual(["Trip", "Day1"]);
		expect(entry.file).toBe(file);
	});

	it("preserves deeply nested paths", () => {
		const file = fileWithRelativePath("a.png", "Root/2024/summer/beach/a.png");
		const [entry] = filesFromDirectoryInput(fakeFileList([file]));

		expect(entry.path).toEqual(["Root", "2024", "summer", "beach"]);
	});

	it("keeps the picked folder itself as the single path segment for a direct child", () => {
		const file = fileWithRelativePath("readme.txt", "Trip/readme.txt");
		const [entry] = filesFromDirectoryInput(fakeFileList([file]));

		expect(entry.path).toEqual(["Trip"]);
	});

	it("returns an empty path when webkitRelativePath is missing", () => {
		const file = new File(["content"], "flat.mp4", { type: "video/mp4" });
		const [entry] = filesFromDirectoryInput(fakeFileList([file]));

		expect(entry.path).toEqual([]);
		expect(entry.file).toBe(file);
	});

	it("handles a mix of nested and flat files in one FileList", () => {
		const nested = fileWithRelativePath("clip.mp4", "Trip/Day1/clip.mp4");
		const flat = new File(["x"], "solo.mp4", { type: "video/mp4" });

		const entries = filesFromDirectoryInput(fakeFileList([nested, flat]));

		expect(entries).toHaveLength(2);
		expect(entries[0].path).toEqual(["Trip", "Day1"]);
		expect(entries[1].path).toEqual([]);
	});
});

// --- extractDroppedEntries -------------------------------------------------

type EntryStub = {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file?: (ok: (file: File) => void, err?: (e: unknown) => void) => void;
	createReader?: () => {
		readEntries: (
			ok: (entries: EntryStub[]) => void,
			err?: (e: unknown) => void,
		) => void;
	};
};

function fileEntry(name: string, file: File): EntryStub {
	return {
		isFile: true,
		isDirectory: false,
		name,
		file: (ok) => ok(file),
	};
}

function dirEntry(name: string, children: EntryStub[]): EntryStub {
	// Simulate readEntries' real-world batching contract: it must be called
	// repeatedly, returning progressively smaller batches, until an empty
	// array signals completion.
	let delivered = false;
	return {
		isFile: false,
		isDirectory: true,
		name,
		createReader: () => ({
			readEntries: (ok) => {
				if (delivered) {
					ok([]);
					return;
				}
				delivered = true;
				ok(children);
			},
		}),
	};
}

function fakeDataTransfer(items: unknown[], files: File[] = []): DataTransfer {
	const itemList = {
		length: items.length,
	} as unknown as DataTransferItemList;
	items.forEach((item, i) => {
		(itemList as unknown as Record<number, unknown>)[i] = item;
	});

	const fileList = fakeFileList(files);

	return {
		items: itemList,
		files: fileList,
	} as unknown as DataTransfer;
}

describe("extractDroppedEntries", () => {
	it("falls back to dataTransfer.files (flat, path []) when items lack webkitGetAsEntry", async () => {
		const a = new File(["a"], "a.mp4", { type: "video/mp4" });
		const b = new File(["b"], "b.mp4", { type: "video/mp4" });

		// Items with no webkitGetAsEntry function at all (older browsers).
		const dataTransfer = fakeDataTransfer([{}, {}], [a, b]);

		const entries = await extractDroppedEntries(dataTransfer);

		expect(entries).toHaveLength(2);
		expect(entries.every((e) => e.path.length === 0)).toBe(true);
		expect(entries.map((e) => e.file)).toEqual([a, b]);
	});

	it("falls back to a flat list when dataTransfer.items is empty", async () => {
		const a = new File(["a"], "a.mp4", { type: "video/mp4" });
		const dataTransfer = fakeDataTransfer([], [a]);

		const entries = await extractDroppedEntries(dataTransfer);

		expect(entries).toEqual([{ file: a, path: [] }]);
	});

	it("recurses nested directories via a batched readEntries loop", async () => {
		const clip = new File(["v"], "clip.mp4", { type: "video/mp4" });
		const note = new File(["n"], "note.txt", { type: "text/plain" });
		const root = new File(["r"], "root.mp4", { type: "video/mp4" });

		// Trip/Day1/clip.mp4, Trip/Day1/note.txt, Trip/root.mp4
		const day1 = dirEntry("Day1", [
			fileEntry("clip.mp4", clip),
			fileEntry("note.txt", note),
		]);
		const trip = dirEntry("Trip", [day1, fileEntry("root.mp4", root)]);

		const item = {
			webkitGetAsEntry: () => trip,
		};
		const dataTransfer = fakeDataTransfer([item]);

		const entries = await extractDroppedEntries(dataTransfer);

		const byName = Object.fromEntries(
			entries.map((e) => [e.file.name, e.path]),
		);
		expect(byName["clip.mp4"]).toEqual(["Trip", "Day1"]);
		expect(byName["note.txt"]).toEqual(["Trip", "Day1"]);
		expect(byName["root.mp4"]).toEqual(["Trip"]);
		expect(entries).toHaveLength(3);
	});

	it("skips a bad entry without throwing or losing its siblings", async () => {
		const good = new File(["g"], "good.mp4", { type: "video/mp4" });

		const badFile: EntryStub = {
			isFile: true,
			isDirectory: false,
			name: "bad.mp4",
			file: (_ok, err) => err?.(new Error("boom")),
		};
		const folder = dirEntry("Folder", [badFile, fileEntry("good.mp4", good)]);

		const item = { webkitGetAsEntry: () => folder };
		const dataTransfer = fakeDataTransfer([item]);

		const entries = await extractDroppedEntries(dataTransfer);

		expect(entries).toEqual([{ file: good, path: ["Folder"] }]);
	});

	it("returns an empty list without throwing when webkitGetAsEntry returns null", async () => {
		const item = { webkitGetAsEntry: () => null };
		const dataTransfer = fakeDataTransfer([item]);

		const entries = await extractDroppedEntries(dataTransfer);

		expect(entries).toEqual([]);
	});
});
