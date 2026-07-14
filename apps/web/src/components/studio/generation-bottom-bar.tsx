"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowUpIcon,
	ArrowDown01Icon,
	Coins01Icon,
} from "@hugeicons/core-free-icons";
import {
	Popover,
	PopoverArrow,
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
 * trigger (chevron + a plain-language settings summary) opens one popover
 * holding every secondary control as chip grids and a live credits chip, plus
 * one circular submit arrow — the panel's single high-contrast element.
 * Renders bare (no border/background of its own) — callers nest it as the
 * last section inside a {@link GenerationCard}, which supplies the hairline
 * divider above it.
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
		<div className={cn("flex items-center gap-2 px-3 py-2", className)}>
			<Popover>
				<PopoverTrigger asChild>
					<button
						type="button"
						data-testid={
							testIdPrefix ? `${testIdPrefix}-settings-trigger` : undefined
						}
						className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left text-xs font-medium text-foreground/80 transition-colors hover:text-foreground"
					>
						<HugeiconsIcon
							icon={ArrowDown01Icon}
							className="size-3.5 shrink-0 text-muted-foreground"
						/>
						<span className="truncate">{summary}</span>
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					side="top"
					sideOffset={10}
					collisionPadding={12}
					className="w-[19rem] space-y-3 rounded-2xl p-4"
				>
					{settingsContent}
					<PopoverArrow />
				</PopoverContent>
			</Popover>

			<span
				className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-border/50 px-2 py-1 text-xs font-medium tabular-nums text-muted-foreground"
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
						: "bg-foreground text-background hover:bg-foreground/90",
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
 *  Aspect Ratio / Resolution / Size / Quality / Batch inside the popover.
 *  `variant="solid"` selects with a high-contrast fill (foreground/background,
 *  i.e. near-white-on-black in dark mode) — reserved for Resolution per the
 *  design spec; every other chip grid uses the quieter neutral fill. */
export function ChipGrid<T extends string | number>({
	label,
	options,
	value,
	onChange,
	hint,
	testIdPrefix,
	variant = "default",
}: {
	label: string;
	options: { value: T; label: string; title?: string }[];
	value: T;
	onChange: (v: T) => void;
	hint?: string;
	testIdPrefix?: string;
	variant?: "default" | "solid";
}) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<span className="text-xs font-medium text-muted-foreground">
					{label}
				</span>
				{hint && (
					<span className="text-[10px] text-muted-foreground">{hint}</span>
				)}
			</div>
			<div className="flex flex-wrap gap-1.5">
				{options.map((opt) => {
					const active = value === opt.value;
					return (
						<button
							key={String(opt.value)}
							type="button"
							title={opt.title}
							data-testid={
								testIdPrefix
									? `${testIdPrefix}-${String(opt.value)}`
									: undefined
							}
							onClick={() => onChange(opt.value)}
							className={cn(
								"rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
								active
									? variant === "solid"
										? "border-transparent bg-foreground text-background"
										: "border-transparent bg-foreground/15 text-foreground"
									: "border-border/50 text-muted-foreground hover:border-foreground/40 hover:text-foreground",
							)}
						>
							{opt.label}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** Palmier-style text tabs — the mode idiom shared by the video Reference-mode
 *  selector, the persona Consistency selector, and Audio's Score/Music/
 *  Voiceover switch. Medium-weight muted text; the active tab turns
 *  full-contrast with a 2px underline, laid over a hairline baseline shared by
 *  every tab so only the active one reads as "selected" — no boxed pills. */
export function TextTabs<T extends string>({
	options,
	value,
	onChange,
	testIdPrefix,
	className,
}: {
	options: { value: T; label: string; title?: string }[];
	value: T;
	onChange: (v: T) => void;
	testIdPrefix?: string;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-4 border-b border-border/60",
				className,
			)}
		>
			{options.map((opt) => {
				const active = value === opt.value;
				return (
					<button
						key={String(opt.value)}
						type="button"
						title={opt.title}
						data-testid={
							testIdPrefix ? `${testIdPrefix}-${String(opt.value)}` : undefined
						}
						onClick={() => onChange(opt.value)}
						className={cn(
							"relative -mb-px pb-2 text-sm font-medium transition-colors",
							active
								? "text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}

/**
 * The one-calm-surface card: a single rounded-2xl, hairline-bordered
 * container whose direct children are separated by a hairline divider
 * (`divide-y`) instead of nested boxes. Used to group Name + Prompt +
 * Variations + the bottom bar into one visual unit, per the Palmier
 * reference — each section supplies its own padding.
 */
export function GenerationCard({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60",
				className,
			)}
		>
			{children}
		</div>
	);
}
