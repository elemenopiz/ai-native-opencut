import { useEffect, useState, useRef } from "react";
import { hasDragData } from "@/lib/drag-data";

interface UseFileUploadOptions {
	accept?: string;
	multiple?: boolean;
	onFilesSelected?: (files: FileList) => void;
	// When true, a second hidden <input webkitdirectory> is kept in sync so
	// callers can offer a "choose a folder" picker via openDirectoryPicker().
	// Purely additive — omitting it leaves the existing single/multi-file
	// picker behavior untouched.
	directory?: boolean;
	onDirectoryFilesSelected?: (files: FileList) => void;
}

// webkitdirectory isn't part of React's JSX.IntrinsicElements typing for
// <input>, so it's set imperatively on the element ref (mirrors how .accept
// and .multiple are set on the primary input above).
interface HTMLInputElementWithDirectory extends HTMLInputElement {
	webkitdirectory: boolean;
}

function containsFiles(dataTransfer: DataTransfer): boolean {
	return !hasDragData({ dataTransfer }) && dataTransfer.types.includes("Files");
}

export function useFileUpload({
	accept,
	multiple,
	onFilesSelected,
	directory,
	onDirectoryFilesSelected,
}: UseFileUploadOptions = {}) {
	const [isDragOver, setIsDragOver] = useState(false);
	const dragCounterRef = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const directoryInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const el =
			directoryInputRef.current as HTMLInputElementWithDirectory | null;
		if (!el) return;
		el.webkitdirectory = Boolean(directory);
		el.setAttribute("webkitdirectory", "");
		el.multiple = true;
	}, [directory]);

	function openFilePicker() {
		if (!inputRef.current) return;

		inputRef.current.accept = accept || "*";
		inputRef.current.multiple = multiple || false;
		inputRef.current.click();
	}

	function openDirectoryPicker() {
		if (!directoryInputRef.current) return;
		directoryInputRef.current.click();
	}

	function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
		const files = event.target.files;
		if (files && files.length > 0 && onFilesSelected) {
			onFilesSelected(files);
		}

		if (event.target) {
			event.target.value = "";
		}
	}

	function handleDirectoryFileChange(
		event: React.ChangeEvent<HTMLInputElement>,
	) {
		const files = event.target.files;
		if (files && files.length > 0 && onDirectoryFilesSelected) {
			onDirectoryFilesSelected(files);
		}

		if (event.target) {
			event.target.value = "";
		}
	}

	function handleDragEnter(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;

		dragCounterRef.current += 1;
		setIsDragOver(true);
	}

	function handleDragOver(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;
	}

	function handleDragLeave(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;

		dragCounterRef.current -= 1;
		if (dragCounterRef.current === 0) {
			setIsDragOver(false);
		}
	}

	function handleDrop(e: React.DragEvent) {
		e.preventDefault();
		setIsDragOver(false);
		dragCounterRef.current = 0;

		if (onFilesSelected && containsFiles(e.dataTransfer)) {
			const files = e.dataTransfer.files;
			const shouldUseMultiple = multiple ?? false;

			if (shouldUseMultiple) {
				onFilesSelected(files);
			} else if (files.length > 0) {
				const dataTransfer = new DataTransfer();
				dataTransfer.items.add(files[0]);
				onFilesSelected(dataTransfer.files);
			}
		}
	}

	return {
		isDragOver,
		openFilePicker,
		fileInputProps: {
			ref: inputRef,
			type: "file",
			style: { display: "none" },
			onChange: handleFileChange,
		},
		dragProps: {
			onDragEnter: handleDragEnter,
			onDragOver: handleDragOver,
			onDragLeave: handleDragLeave,
			onDrop: handleDrop,
		},
		// Folder-upload additions (additive; unused unless a caller opts in).
		// The dropped-entries side is intentionally NOT wrapped here — callers
		// that want structure-preserving folder drop should call
		// extractDroppedEntries(e.dataTransfer) from "@/lib/media/folder-upload"
		// directly inside their own onDrop, keeping this hook thin. This
		// hook's dragProps.onDrop above still fires for the isDragOver/counter
		// bookkeeping; a caller wiring folder drop wraps onDrop to also read
		// e.dataTransfer for extractDroppedEntries.
		openDirectoryPicker,
		directoryInputProps: {
			ref: directoryInputRef,
			type: "file",
			style: { display: "none" },
			onChange: handleDirectoryFileChange,
		},
	};
}
