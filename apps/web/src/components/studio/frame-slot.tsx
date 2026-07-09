"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import {
	assetFileFromDrag,
	uploadReferenceFile,
} from "@/lib/studio/reference-upload";

interface FrameSlotProps {
	label: string;
	hint?: string;
	value: string | null;
	onChange: (url: string | null) => void;
	disabled?: boolean;
}

/**
 * A single image-frame slot — drag from Assets, drop a file, or click to browse.
 * Used for the First and Last frames. Images only (a frame is a still).
 */
export function FrameSlot({
	label,
	hint,
	value,
	onChange,
	disabled,
}: FrameSlotProps) {
	const editor = useEditor();
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragOver, setDragOver] = useState(false);
	const [uploading, setUploading] = useState(false);

	async function take(file: File) {
		if (!file.type.startsWith("image/")) {
			toast.error("A frame must be an image.");
			return;
		}
		setUploading(true);
		try {
			const { url } = await uploadReferenceFile(file);
			onChange(url);
		} catch (err) {
			toast.error(
				`Couldn't add ${label.toLowerCase()}: ${err instanceof Error ? err.message : "upload failed"}`,
			);
		} finally {
			setUploading(false);
		}
	}

	function onDrop(e: React.DragEvent) {
		e.preventDefault();
		setDragOver(false);
		if (e.dataTransfer.files?.length) {
			void take(e.dataTransfer.files[0]);
			return;
		}
		const asset = assetFileFromDrag(editor, e.dataTransfer);
		if (asset) {
			if (asset.kind !== "image") {
				toast.error("A frame must be an image.");
				return;
			}
			void take(asset.file);
		}
	}

	return (
		<div className="flex-1 space-y-1">
			<span className="text-[10px] text-muted-foreground">{label}</span>
			<input
				ref={inputRef}
				type="file"
				accept="image/*"
				className="hidden"
				onChange={(e) => {
					if (e.target.files?.[0]) void take(e.target.files[0]);
					e.target.value = "";
				}}
			/>
			{value ? (
				<div className="relative">
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img
						src={value}
						alt={label}
						className="aspect-video w-full rounded-md border border-border object-cover"
					/>
					<button
						type="button"
						onClick={() => onChange(null)}
						className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/70 text-xs leading-none text-white"
						aria-label={`Remove ${label}`}
					>
						×
					</button>
				</div>
			) : (
				<button
					type="button"
					disabled={disabled}
					onClick={() => inputRef.current?.click()}
					onDragOver={(e) => {
						e.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={onDrop}
					className={cn(
						"flex aspect-video w-full flex-col items-center justify-center rounded-md border border-dashed px-2 text-center transition-colors",
						dragOver
							? "border-primary bg-primary/5"
							: "border-border hover:border-foreground/50",
						disabled && "cursor-not-allowed opacity-50",
					)}
				>
					<span className="text-[11px] font-medium">
						{uploading ? "Adding…" : "Drag / drop / click"}
					</span>
					{hint && (
						<span className="mt-0.5 text-[9px] text-muted-foreground">
							{hint}
						</span>
					)}
				</button>
			)}
		</div>
	);
}
