"use client";

import { ImagePlus } from "lucide-react";
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
	/** Fixed-width Palmier thumbnail (~150px, 16:9) instead of stretching to
	 *  fill its flex parent. Default true; pass false for a caller (e.g. a
	 *  narrow grid column) that needs the slot to fill its own container. */
	fixedWidth?: boolean;
}

/**
 * A single image-frame slot — drag from Assets, drop a file, or click to browse.
 * Used for the First and Last frames, and each multiframe keyframe. Images
 * only (a frame is a still). Palmier styling: a labeled header above a fixed
 * ~150px-wide 16:9 rounded-lg thumbnail, with a small circular ✕ badge on a
 * filled frame and a dashed border + add-image glyph on an empty one.
 */
export function FrameSlot({
	label,
	hint,
	value,
	onChange,
	disabled,
	fixedWidth = true,
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
		<div
			className={cn(
				"space-y-1.5",
				fixedWidth ? "w-[150px] shrink-0" : "flex-1",
			)}
		>
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
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
						className="aspect-video w-full rounded-lg border border-border/60 object-cover"
					/>
					<button
						type="button"
						onClick={() => onChange(null)}
						className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-border/60 bg-background text-[11px] leading-none text-foreground shadow-sm"
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
						"flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-2 text-center transition-colors",
						dragOver
							? "border-foreground/60 bg-foreground/5"
							: "border-border/60 hover:border-foreground/40",
						disabled && "cursor-not-allowed opacity-50",
					)}
				>
					<ImagePlus className="size-4 text-muted-foreground" />
					<span className="text-[10px] font-medium text-muted-foreground">
						{uploading ? "Adding…" : "Drag / drop / click"}
					</span>
					{hint && (
						<span className="text-[9px] text-muted-foreground">{hint}</span>
					)}
				</button>
			)}
		</div>
	);
}
