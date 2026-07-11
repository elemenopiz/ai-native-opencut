"use client";

import Image from "next/image";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	LayoutThreeColumnIcon,
	LayoutThreeRowIcon,
} from "@hugeicons/core-free-icons";
import { Label } from "@/components/ui/label";
import { NumberField } from "@/components/ui/number-field";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
	DEFAULT_GRID_CONFIG,
	GRID_MAX,
	GRID_MIN,
	clampGridValue,
	computeGridLines,
	usePreviewStore,
	type GuideId,
} from "@/stores/preview-store";
import { cn } from "@/utils/ui";

const GUIDE_OPTIONS: { id: GuideId; label: string }[] = [
	{ id: "grid", label: "Grid" },
	{ id: "tiktok", label: "TikTok" },
];

function GridSwatchLines({ rows, cols }: { rows: number; cols: number }) {
	const { verticals, horizontals } = computeGridLines({ rows, cols });

	return (
		<>
			{verticals.map((pct) => (
				<div
					key={`v-${pct}`}
					className="absolute top-0 bottom-0 w-px bg-foreground/25"
					style={{ left: `${pct}%` }}
				/>
			))}
			{horizontals.map((pct) => (
				<div
					key={`h-${pct}`}
					className="absolute left-0 right-0 h-px bg-foreground/25"
					style={{ top: `${pct}%` }}
				/>
			))}
		</>
	);
}

function GuidePreviewThumbnail({ guideId }: { guideId: GuideId }) {
	if (guideId === "grid") {
		return (
			<div className="relative aspect-video w-full overflow-hidden rounded-xs bg-foreground/5">
				<GridSwatchLines
					rows={DEFAULT_GRID_CONFIG.rows}
					cols={DEFAULT_GRID_CONFIG.cols}
				/>
			</div>
		);
	}

	return (
		<div className="relative aspect-video w-full overflow-hidden rounded-xs bg-foreground/5">
			<Image
				src="/platform-guides/tiktok-blueprint.png"
				alt=""
				fill
				className="object-contain opacity-70"
				draggable={false}
			/>
		</div>
	);
}

function GuideSwatchButton({
	guideId,
	label,
	isSelected,
	onClick,
}: {
	guideId: GuideId;
	label: string;
	isSelected: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={isSelected}
			className={cn(
				"flex cursor-pointer flex-col gap-1.5 rounded-sm px-1.5 py-1.5 hover:bg-foreground/5",
				isSelected && "bg-primary/5! text-primary",
			)}
		>
			<GuidePreviewThumbnail guideId={guideId} />
			<span
				className={cn(
					"text-xs",
					isSelected ? "text-primary" : "text-muted-foreground",
				)}
			>
				{label}
			</span>
		</button>
	);
}

function GridOptions() {
	const rows = usePreviewStore((state) => state.gridConfig.rows);
	const cols = usePreviewStore((state) => state.gridConfig.cols);
	const setGridConfig = usePreviewStore((state) => state.setGridConfig);

	return (
		<div className="flex gap-2 px-4">
			<NumberField
				icon={<HugeiconsIcon icon={LayoutThreeRowIcon} />}
				value={rows}
				min={GRID_MIN}
				max={GRID_MAX}
				step={1}
				allowExpressions={false}
				isDefault={rows === DEFAULT_GRID_CONFIG.rows}
				onReset={() => setGridConfig({ rows: DEFAULT_GRID_CONFIG.rows })}
				onScrub={(value) => setGridConfig({ rows: clampGridValue(value) })}
				onChange={(event) => {
					const parsed = Number.parseInt(event.target.value, 10);
					if (!Number.isNaN(parsed)) setGridConfig({ rows: parsed });
				}}
				className="flex-1"
				aria-label="Grid rows"
			/>
			<NumberField
				icon={<HugeiconsIcon icon={LayoutThreeColumnIcon} />}
				value={cols}
				min={GRID_MIN}
				max={GRID_MAX}
				step={1}
				allowExpressions={false}
				isDefault={cols === DEFAULT_GRID_CONFIG.cols}
				onReset={() => setGridConfig({ cols: DEFAULT_GRID_CONFIG.cols })}
				onScrub={(value) => setGridConfig({ cols: clampGridValue(value) })}
				onChange={(event) => {
					const parsed = Number.parseInt(event.target.value, 10);
					if (!Number.isNaN(parsed)) setGridConfig({ cols: parsed });
				}}
				className="flex-1"
				aria-label="Grid columns"
			/>
		</div>
	);
}

/**
 * Popover picker for the preview's guide overlays (grid / TikTok). Only one
 * guide is ever active at a time; picking the active guide again turns it
 * off. Purely a preview/UI preference — not part of the document model, so
 * changes here don't go through the undo/command stack.
 */
export function GuidePicker({ children }: { children: React.ReactNode }) {
	const activeGuideId = usePreviewStore((state) => state.activeGuideId);
	const toggleGuide = usePreviewStore((state) => state.toggleGuide);

	return (
		<Popover>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent align="end" sideOffset={8} className="w-60 px-0 py-3">
				<div className="flex flex-col gap-2 px-4">
					<Label>Guides</Label>
					<div className="grid grid-cols-2 gap-1">
						{GUIDE_OPTIONS.map((guide) => (
							<GuideSwatchButton
								key={guide.id}
								guideId={guide.id}
								label={guide.label}
								isSelected={activeGuideId === guide.id}
								onClick={() => toggleGuide(guide.id)}
							/>
						))}
					</div>
				</div>
				{activeGuideId === "grid" && (
					<>
						<Separator className="my-3" />
						<GridOptions />
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}
