"use client";

import { useState } from "react";
import {
	Popover,
	PopoverArrow,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/utils/ui";
import {
	CAMERA_CATEGORIES,
	CAMERA_PRESETS,
	getCameraPreset,
} from "@/lib/studio/camera-presets";

interface CameraPresetPickerProps {
	value: string | null;
	onChange: (presetId: string | null) => void;
}

/**
 * Higgsfield-style camera & motion picker. Choosing a preset weaves a
 * directorial fragment into the prompt at generation time.
 *
 * The trigger IS the composer's tool-row chip (filled-chip tokens, same as
 * every other chip in the panel) — callers drop this inline in a flex row
 * next to EnhancePromptButton etc., no wrapping label needed. Popover
 * content keeps the category list + 2-col grid; selected cell uses the
 * filled token, not a colored border.
 */
export function CameraPresetPicker({
	value,
	onChange,
}: CameraPresetPickerProps) {
	const [open, setOpen] = useState(false);
	const selected = getCameraPreset(value);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex h-[30px] shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
						selected
							? "bg-foreground/[0.14] text-foreground font-semibold"
							: "bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
					)}
				>
					<svg
						className="size-[12.5px] shrink-0"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth={1.8}
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
						/>
					</svg>
					<span className="max-w-[110px] truncate">
						{selected ? selected.label : "Camera"}
					</span>
					{selected && (
						<span
							role="button"
							tabIndex={0}
							onClick={(e) => {
								e.stopPropagation();
								onChange(null);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.stopPropagation();
									onChange(null);
								}
							}}
							className="shrink-0 text-muted-foreground hover:text-foreground"
							aria-label="Clear camera motion"
						>
							✕
						</span>
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="top"
				sideOffset={10}
				collisionPadding={12}
				className="max-h-80 w-72 overflow-y-auto rounded-[18px] border-foreground/[0.12] bg-popover/95 p-[14px] shadow-xl backdrop-blur-xl"
			>
				<div className="space-y-3">
					{CAMERA_CATEGORIES.map((category) => (
						<div key={category}>
							<p className="mb-1 px-0.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
								{category}
							</p>
							<div className="grid grid-cols-2 gap-1.5">
								{CAMERA_PRESETS.filter((p) => p.category === category).map(
									(preset) => {
										const isActive = preset.id === value;
										return (
											<button
												key={preset.id}
												type="button"
												title={preset.hint}
												onClick={() => {
													onChange(isActive ? null : preset.id);
													setOpen(false);
												}}
												className={cn(
													"rounded-[10px] px-2.5 py-1.5 text-left text-[12.5px] font-medium transition-colors duration-150",
													isActive
														? "bg-foreground/[0.16] font-semibold text-foreground"
														: "bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
												)}
											>
												<span className="block truncate">{preset.label}</span>
												<span className="block truncate text-[11.5px] text-muted-foreground">
													{preset.hint}
												</span>
											</button>
										);
									},
								)}
							</div>
						</div>
					))}
				</div>
				<PopoverArrow />
			</PopoverContent>
		</Popover>
	);
}
