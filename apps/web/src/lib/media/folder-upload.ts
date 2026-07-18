// Pure parsing helpers for whole-folder uploads: turning a webkitdirectory
// FileList or a dropped DataTransfer into a flat list of {file, path[]}
// entries, where `path` is the folder segments only (filename excluded).
//
// No React, no manager/editor access, no DOM globals beyond the args passed
// in — safe to unit test with fabricated File/DataTransfer-shaped objects.

export type DroppedEntry = {
	file: File;
	path: string[];
};

// webkitRelativePath is non-standard but universally supported by browsers
// that implement <input webkitdirectory>. Extend the File interface locally
// rather than reaching for `as any` at call sites.
interface FileWithRelativePath extends File {
	readonly webkitRelativePath?: string;
}

/**
 * Reads each file's `webkitRelativePath` (e.g. "Trip/Day1/clip.mp4") into a
 * folder-segment path (["Trip", "Day1"]). Files without a relative path
 * (or with one that has no directory component) get path [].
 */
export function filesFromDirectoryInput(files: FileList): DroppedEntry[] {
	const entries: DroppedEntry[] = [];

	for (let i = 0; i < files.length; i++) {
		const file = files[i] as FileWithRelativePath;
		if (!file) continue;

		const relativePath = file.webkitRelativePath;
		entries.push({ file, path: pathFromRelativePath(relativePath) });
	}

	return entries;
}

function pathFromRelativePath(relativePath: string | undefined): string[] {
	if (!relativePath) return [];

	const segments = relativePath.split("/").filter(Boolean);
	// Drop the trailing filename segment; keep only folder segments.
	return segments.slice(0, -1);
}

// --- Drag-and-drop directory traversal (DataTransferItem.webkitGetAsEntry) ---
// These entry types are non-standard (webkitGetAsEntry / FileSystemEntry
// family) but supported across Chromium/WebKit/Firefox. Declared locally so
// we don't need a project-wide ambient .d.ts.

interface FileSystemEntryLike {
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly name: string;
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
	readonly isFile: true;
	file(
		successCallback: (file: File) => void,
		errorCallback?: (error: unknown) => void,
	): void;
}

interface FileSystemDirectoryReaderLike {
	readEntries(
		successCallback: (entries: FileSystemEntryLike[]) => void,
		errorCallback?: (error: unknown) => void,
	): void;
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
	readonly isDirectory: true;
	createReader(): FileSystemDirectoryReaderLike;
}

interface DataTransferItemWithEntry extends DataTransferItem {
	webkitGetAsEntry?: () => FileSystemEntryLike | null;
}

function isDirectoryEntry(
	entry: FileSystemEntryLike,
): entry is FileSystemDirectoryEntryLike {
	return entry.isDirectory;
}

function isFileEntry(
	entry: FileSystemEntryLike,
): entry is FileSystemFileEntryLike {
	return entry.isFile;
}

function readAllDirectoryEntries(
	reader: FileSystemDirectoryReaderLike,
): Promise<FileSystemEntryLike[]> {
	return new Promise((resolve) => {
		const all: FileSystemEntryLike[] = [];

		function readBatch() {
			reader.readEntries(
				(batch) => {
					if (batch.length === 0) {
						resolve(all);
						return;
					}
					all.push(...batch);
					// readEntries only returns entries in batches; keep looping
					// until a batch comes back empty.
					readBatch();
				},
				() => resolve(all),
			);
		}

		readBatch();
	});
}

function readFileEntry(entry: FileSystemFileEntryLike): Promise<File | null> {
	return new Promise((resolve) => {
		entry.file(
			(file) => resolve(file),
			() => resolve(null),
		);
	});
}

async function walkEntry(
	entry: FileSystemEntryLike,
	parentPath: string[],
	out: DroppedEntry[],
): Promise<void> {
	try {
		if (isFileEntry(entry)) {
			const file = await readFileEntry(entry);
			if (file) out.push({ file, path: parentPath });
			return;
		}

		if (isDirectoryEntry(entry)) {
			const nextPath = [...parentPath, entry.name];
			const reader = entry.createReader();
			const children = await readAllDirectoryEntries(reader);
			for (const child of children) {
				// Never let one bad child entry abort its siblings.
				await walkEntry(child, nextPath, out).catch(() => {});
			}
		}
	} catch {
		// Skip individual bad entries rather than throwing.
	}
}

/**
 * Walks a drop's DataTransferItemList via webkitGetAsEntry, recursing into
 * directories (batched readEntries loop) and resolving files. Falls back to
 * a flat list from dataTransfer.files (path: []) when webkitGetAsEntry isn't
 * available. Never throws on an individual bad entry.
 */
export async function extractDroppedEntries(
	dataTransfer: DataTransfer,
): Promise<DroppedEntry[]> {
	const items = dataTransfer.items;

	if (!items || items.length === 0) {
		return flatFallback(dataTransfer);
	}

	const topLevelEntries: FileSystemEntryLike[] = [];
	let sawGetAsEntry = false;

	for (let i = 0; i < items.length; i++) {
		const item = items[i] as DataTransferItemWithEntry | undefined;
		if (!item) continue;

		if (typeof item.webkitGetAsEntry !== "function") continue;
		sawGetAsEntry = true;

		try {
			const entry = item.webkitGetAsEntry();
			if (entry) topLevelEntries.push(entry);
		} catch {
			// Skip this item; keep going.
		}
	}

	if (!sawGetAsEntry) {
		return flatFallback(dataTransfer);
	}

	const out: DroppedEntry[] = [];
	for (const entry of topLevelEntries) {
		await walkEntry(entry, [], out).catch(() => {});
	}

	return out;
}

function flatFallback(dataTransfer: DataTransfer): DroppedEntry[] {
	const files = dataTransfer.files;
	if (!files) return [];

	const entries: DroppedEntry[] = [];
	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		if (file) entries.push({ file, path: [] });
	}
	return entries;
}
