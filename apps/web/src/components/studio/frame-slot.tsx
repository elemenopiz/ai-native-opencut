"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, ImageAdd02Icon } from "@hugeicons/core-free-icons";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import {
	assetFileFromDrag,
	uploadReferenceFile,
} from "@/lib/studio/reference-upload";

interface FrameSlotProps {
	/** Accessible name, also used as the fallback data/aria label. Rendered
	 *  visually above the slot unless `hideLabel` is set. */
	label: string;
	hint?: string;
	value: string | null;
	onChange: (url: string | null) => void;
	disabled?: boolean;
	/** Fixed-width Palmier thumbnail (~150px, 16:9) instead of stretching to
	 *  fill its flex parent. Default true; pass false for a caller (e.g. a
	 *  narrow grid column) that needs the slot to fill its own container. */
	fixedWidth?: boolean;
	/** Hide the visual label row (caller renders its own labels row above a
	 *  group of slots instead) while keeping `label` for aria/testids.
	 *  Default false — existing callers keep today's visual behavior until
	 *  they opt in. */
	hideLabel?: boolean;
}

/**
 * A single image-frame slot — drag from Assets, drop a file, or click to browse.
 * Used for the First and Last frames, and each multiframe keyframe. Images
 * only (a frame is a still). Palmier styling: an aspect-[16/10] rounded-xl
 * dashed-border thumbnail, with an 18px circular ✕ badge on a filled frame
 * and a centered add-image glyph + hint on an empty one.
 */
export function FrameSlot({
	label,
	hint,
	value,
	onChange,
	disabled,
	fixedWidth = true,
	hideLabel = false,
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
			{!hideLabel && (
				<span className="text-[13px] font-semibold text-foreground/70">
					{label}
				</span>
			)}
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
						className="aspect-[16/10] w-full rounded-xl object-cover"
					/>
					<button
						type="button"
						onClick={() => onChange(null)}
						className="absolute right-1.5 top-1.5 flex size-[18px] items-center justify-center rounded-full bg-black/70 text-white/80"
						aria-label={`Remove ${label}`}
					>
						<HugeiconsIcon icon={Cancel01Icon} className="size-[11px]" />
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
						"flex aspect-[16/10] w-full flex-col items-center justify-center gap-1 rounded-xl border-[1.5px] border-dashed px-2 text-center transition-colors",
						dragOver
							? "border-foreground/40 bg-foreground/[0.04]"
							: "border-foreground/[0.18] hover:border-foreground/30",
						disabled && "cursor-not-allowed opacity-50",
					)}
				>
					{uploading ? (
						<Spinner className="size-4 text-muted-foreground" />
					) : (
						<HugeiconsIcon
							icon={ImageAdd02Icon}
							className="size-[17px] text-muted-foreground"
						/>
					)}
					<span className="text-[11.5px] text-muted-foreground">
						{uploading ? "Adding…" : "drag, drop, or click"}
					</span>
					{hint && (
						<span className="text-[11.5px] text-muted-foreground">{hint}</span>
					)}
				</button>
			)}
		</div>
	);
}
