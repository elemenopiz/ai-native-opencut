"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
 */
export function CameraPresetPicker({ value, onChange }: CameraPresetPickerProps) {
	const [open, setOpen] = useState(false);
	const selected = getCameraPreset(value);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"w-full flex items-center justify-between gap-2 rounded-md border px-2.5 h-8 text-xs transition-colors",
						selected
							? "border-primary/60 bg-primary/5 text-foreground"
							: "border-border text-muted-foreground hover:border-foreground",
					)}
				>
					<span className="flex items-center gap-1.5 truncate">
						<svg className="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
							<path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
						</svg>
						{selected ? selected.label : "Add camera motion"}
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
							className="text-muted-foreground hover:text-foreground shrink-0"
							aria-label="Clear camera motion"
						>
							✕
						</span>
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72 p-0 max-h-80 overflow-y-auto">
				<div className="p-2 space-y-3">
					{CAMERA_CATEGORIES.map((category) => (
						<div key={category}>
							<p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-1 mb-1">
								{category}
							</p>
							<div className="grid grid-cols-2 gap-1">
								{CAMERA_PRESETS.filter((p) => p.category === category).map((preset) => {
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
												"text-left rounded-md border px-2 py-1.5 text-xs transition-colors",
												isActive
													? "border-primary bg-primary text-primary-foreground"
													: "border-border hover:border-foreground hover:bg-muted",
											)}
										>
											<span className="block font-medium truncate">{preset.label}</span>
											<span
												className={cn(
													"block text-[10px] truncate",
													isActive ? "text-primary-foreground/80" : "text-muted-foreground",
												)}
											>
												{preset.hint}
											</span>
										</button>
									);
								})}
							</div>
						</div>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
