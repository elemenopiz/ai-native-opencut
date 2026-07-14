"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowUpIcon,
	ArrowDown01Icon,
	Coins01Icon,
} from "@hugeicons/core-free-icons";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import type { CostRange } from "@/lib/studio/cost";
import { formatCostRange } from "@/lib/studio/cost";

interface GenerationBottomBarProps {
	/** Compact summary shown on the model/settings trigger, e.g.
	 *  "Seedance 2 · 1080p · 5s · 16:9". */
	summary: string;
	/** Chip grids / model list / toggles rendered inside the settings popover. */
	settingsContent: React.ReactNode;
	/** Live, resolution/backend-aware credits estimate — updates as settings change. */
	cost: CostRange;
	onSubmit: () => void;
	submitDisabled?: boolean;
	busy?: boolean;
	/** Accessible label for the submit button (e.g. "Generate 2 takes"). */
	submitLabel?: string;
	className?: string;
	/** Prefix for data-testid attributes on the trigger/submit controls, so E2E
	 *  can target a specific tab's bar (e.g. "video-gen", "image-gen"). */
	testIdPrefix?: string;
}

/**
 * The Palmier-pattern bottom bar shared by every generation surface: a single
 * trigger (model + a plain-language settings summary) opens one popover
 * holding every secondary control as chip grids, a live credits chip, and one
 * circular submit arrow. Everything that isn't the prompt lives here.
 */
export function GenerationBottomBar({
	summary,
	settingsContent,
	cost,
	onSubmit,
	submitDisabled,
	busy,
	submitLabel = "Generate",
	className,
	testIdPrefix,
}: GenerationBottomBarProps) {
	return (
		<div
			className={cn(
				"flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-1.5 pl-1",
				className,
			)}
		>
			<Popover>
				<PopoverTrigger asChild>
					<button
						type="button"
						data-testid={
							testIdPrefix ? `${testIdPrefix}-settings-trigger` : undefined
						}
						className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent"
					>
						<span className="truncate">{summary}</span>
						<HugeiconsIcon
							icon={ArrowDown01Icon}
							className="size-3.5 shrink-0 text-muted-foreground"
						/>
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					side="top"
					className="w-80 max-h-[70vh] overflow-y-auto space-y-4 p-3"
				>
					{settingsContent}
				</PopoverContent>
			</Popover>

			<span
				className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-background px-2 py-1 text-xs font-semibold tabular-nums text-foreground"
				title="Estimated credits for this generation"
			>
				<HugeiconsIcon icon={Coins01Icon} className="size-3.5" />
				{formatCostRange(cost)}
			</span>

			<button
				type="button"
				data-testid={testIdPrefix ? `${testIdPrefix}-submit` : undefined}
				aria-label={submitLabel}
				title={submitLabel}
				onClick={onSubmit}
				disabled={submitDisabled}
				className={cn(
					"flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
					submitDisabled
						? "bg-muted text-muted-foreground cursor-not-allowed"
						: "bg-primary text-primary-foreground hover:bg-primary/90",
				)}
			>
				{busy ? (
					<Spinner className="size-4" />
				) : (
					<HugeiconsIcon icon={ArrowUpIcon} className="size-4" />
				)}
			</button>
		</div>
	);
}

/** A row of equal-width chip buttons — the shared visual for Duration /
 *  Aspect Ratio / Resolution / Size / Quality / Batch inside the popover. */
export function ChipGrid<T extends string | number>({
	label,
	options,
	value,
	onChange,
	hint,
	testIdPrefix,
}: {
	label: string;
	options: { value: T; label: string; title?: string }[];
	value: T;
	onChange: (v: T) => void;
	hint?: string;
	testIdPrefix?: string;
}) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<span className="text-[11px] font-medium text-muted-foreground">
					{label}
				</span>
				{hint && (
					<span className="text-[10px] text-muted-foreground">{hint}</span>
				)}
			</div>
			<div className="flex flex-wrap gap-1.5">
				{options.map((opt) => (
					<button
						key={String(opt.value)}
						type="button"
						title={opt.title}
						data-testid={
							testIdPrefix ? `${testIdPrefix}-${String(opt.value)}` : undefined
						}
						onClick={() => onChange(opt.value)}
						className={cn(
							"rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
							value === opt.value
								? "border-primary bg-primary text-primary-foreground"
								: "border-border text-muted-foreground hover:border-foreground hover:text-foreground",
						)}
					>
						{opt.label}
					</button>
				))}
			</div>
		</div>
	);
}
