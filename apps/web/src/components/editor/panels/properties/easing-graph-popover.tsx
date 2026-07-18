"use client";

// Loosely adapted from OpenCut-app/OpenCut's `timeline/components/graph-editor/popover.tsx`
// (pre-rewrite tag, MIT). See THIRD_PARTY_NOTICES.md. Trimmed: no per-component
// (axis) toolbar — our easing is a single bezier per keyframe, not a per-axis
// handle set — and no expand/collapse grid (our preset list is small enough
// to always show in full).

import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/utils/ui";
import type { CubicBezierControlPoints } from "@/types/animation";
import { BezierCurveThumb, BezierGraph } from "./bezier-graph";
import {
	EASING_GRAPH_PRESET_MATCH_TOLERANCE,
	EASING_GRAPH_PRESETS,
	findMatchingGraphPreset,
} from "./easing-graph-presets";
import {
	removeEasingPreset,
	saveEasingPreset,
	useCustomEasingPresets,
} from "./easing-custom-presets-store";

function findMatchingCustomPresetId({
	bezier,
	presets,
}: {
	bezier: CubicBezierControlPoints;
	presets: ReturnType<typeof useCustomEasingPresets>;
}): string | null {
	return (
		presets.find((preset) =>
			preset.value.every(
				(component, index) =>
					Math.abs(component - bezier[index]) <=
					EASING_GRAPH_PRESET_MATCH_TOLERANCE,
			),
		)?.id ?? null
	);
}

export function EasingGraphPopover({
	trigger,
	open,
	onOpenChange,
	value,
	isMixed,
	onPreviewValue,
	onCommitValue,
	onCancelPreview,
}: {
	trigger: React.ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	value: CubicBezierControlPoints;
	isMixed: boolean;
	onPreviewValue: (value: CubicBezierControlPoints) => void;
	onCommitValue: (value: CubicBezierControlPoints) => void;
	onCancelPreview: () => void;
}) {
	const customPresets = useCustomEasingPresets();

	const activePresetId = isMixed
		? null
		: (findMatchingGraphPreset({ bezier: value, presets: EASING_GRAPH_PRESETS })
				?.id ??
			findMatchingCustomPresetId({ bezier: value, presets: customPresets }));

	return (
		<Popover
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					onCancelPreview();
				}
				onOpenChange(nextOpen);
			}}
		>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				side="left"
				sideOffset={8}
				className="w-60 overflow-hidden px-0 py-3"
			>
				<div className="px-3 pb-3">
					<BezierGraph
						value={value}
						onChange={onPreviewValue}
						onChangeEnd={onCommitValue}
						onCancel={onCancelPreview}
					/>
				</div>

				<Tabs defaultValue="presets" className="flex flex-col gap-2">
					<TabsList className="px-3">
						<TabsTrigger value="presets" className="text-xs">
							Presets
						</TabsTrigger>
						<TabsTrigger value="saved" className="text-xs">
							Saved
						</TabsTrigger>
					</TabsList>
					<TabsContent value="presets" className="px-3">
						<div className="grid grid-cols-3 gap-1">
							{EASING_GRAPH_PRESETS.map((preset) => (
								<PresetItem
									key={preset.id}
									label={preset.label}
									value={preset.value}
									isActive={activePresetId === preset.id}
									onSelect={() => onCommitValue(preset.value)}
								/>
							))}
						</div>
					</TabsContent>
					<TabsContent value="saved" className="px-3">
						<div className="grid grid-cols-3 gap-1">
							{customPresets.map((preset) => (
								<PresetItem
									key={preset.id}
									label={preset.label}
									value={preset.value}
									isActive={activePresetId === preset.id}
									onSelect={() => onCommitValue(preset.value)}
									onDelete={() => removeEasingPreset({ id: preset.id })}
								/>
							))}
							<button
								type="button"
								onClick={() => saveEasingPreset({ value })}
								className="text-muted-foreground hover:bg-foreground/5 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-sm px-1 py-1"
							>
								<div className="border-foreground/10 flex aspect-video w-full items-center justify-center rounded-sm border border-dashed">
									<HugeiconsIcon
										icon={PlusSignIcon}
										className="size-3.5 opacity-40"
									/>
								</div>
								<span className="text-2xs leading-tight">Save</span>
							</button>
						</div>
					</TabsContent>
				</Tabs>
			</PopoverContent>
		</Popover>
	);
}

function PresetItem({
	label,
	value,
	isActive,
	onSelect,
	onDelete,
}: {
	label: string;
	value: CubicBezierControlPoints;
	isActive: boolean;
	onSelect: () => void;
	onDelete?: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"hover:bg-foreground/5 group relative flex cursor-pointer flex-col items-center gap-1 rounded-sm px-1 py-1",
				isActive && "bg-primary/5! text-primary",
			)}
		>
			<div
				className={cn(
					"bg-foreground/5 flex aspect-video w-full items-center justify-center rounded-sm",
					isActive && "bg-primary/5!",
				)}
			>
				<BezierCurveThumb value={value} />
			</div>
			<span
				className={cn(
					"text-2xs leading-tight",
					isActive ? "text-primary" : "text-muted-foreground",
				)}
			>
				{label}
			</span>
			{onDelete && (
				<Button
					variant="destructive"
					size="icon"
					className="absolute -right-0.5 -top-0.5 hidden size-4.5 rounded-full [&_svg]:size-3 group-hover:flex"
					onClick={(event) => {
						event.stopPropagation();
						onDelete();
					}}
				>
					<HugeiconsIcon icon={Delete02Icon} />
				</Button>
			)}
		</button>
	);
}
