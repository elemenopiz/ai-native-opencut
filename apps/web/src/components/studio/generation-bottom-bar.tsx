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
	/** Bright model name on the trigger, e.g. "Seedance 2". */
	modelLabel: string;
	/** Muted settings recap next to the model label, e.g.
	 *  "1080p · 5s · 16:9". */
	settingsSummary?: string;
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
 * trigger (chevron + model name + a plain-language settings recap) opens one
 * popover holding every secondary control as chip grids and a live credits
 * chip, plus one circular submit arrow — the panel's single high-contrast
 * element. Renders bare (no border/background of its own) — callers nest it
 * as the last section inside a {@link GenerationCard}, which supplies the
 * hairline divider above it.
 */
export function GenerationBottomBar({
	modelLabel,
	settingsSummary,
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
				"flex min-h-[58px] items-center gap-2 pl-4 pr-3",
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
						className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left transition-colors"
					>
						<HugeiconsIcon
							icon={ArrowDown01Icon}
							className="size-2.5 shrink-0 text-muted-foreground"
						/>
						<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
							<span className="shrink-0 truncate text-[13px] font-semibold text-foreground">
								{modelLabel}
							</span>
							{settingsSummary && (
								<span className="truncate text-[12.5px] text-muted-foreground">
									{settingsSummary}
								</span>
							)}
						</span>
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					side="top"
					sideOffset={10}
					collisionPadding={12}
					className="w-80 space-y-[17px] rounded-[18px] border-foreground/[0.12] bg-popover/95 p-[18px] shadow-xl backdrop-blur-xl"
				>
					{settingsContent}
					<PopoverArrow />
				</PopoverContent>
			</Popover>

			<span
				className="flex shrink-0 items-center gap-1.5 whitespace-nowrap"
				title="Estimated credits for this generation"
			>
				<span className="flex size-[15px] items-center justify-center rounded-full bg-foreground/[0.14]">
					<HugeiconsIcon
						icon={Coins01Icon}
						className="size-[9px] text-foreground/70"
					/>
				</span>
				<span className="text-[12.5px] font-semibold tabular-nums text-foreground/80">
					{formatCostRange(cost)}
				</span>
			</span>

			<button
				type="button"
				data-testid={testIdPrefix ? `${testIdPrefix}-submit` : undefined}
				aria-label={submitLabel}
				title={submitLabel}
				onClick={onSubmit}
				disabled={submitDisabled}
				className={cn(
					"flex size-[38px] shrink-0 items-center justify-center rounded-full transition-colors",
					submitDisabled
						? "bg-foreground/[0.08] text-muted-foreground cursor-not-allowed"
						: "bg-zinc-900 text-zinc-50 hover:opacity-90 dark:bg-[#ede9e1] dark:text-[#1a1a18]",
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

/** A row of filled chip buttons — the shared visual for Duration / Aspect
 *  Ratio / Size / Quality / Batch inside the popover. Pass `columns` to lay
 *  options out as a fixed-column, centered grid instead of flex-wrap (e.g.
 *  Duration uses 5); omit it for the default wrapping row. */
export function ChipGrid<T extends string | number>({
	label,
	options,
	value,
	onChange,
	hint,
	testIdPrefix,
	columns,
}: {
	label: string;
	options: { value: T; label: string; title?: string }[];
	value: T;
	onChange: (v: T) => void;
	hint?: string;
	testIdPrefix?: string;
	/** Fixed column count — renders a centered grid instead of flex-wrap. */
	columns?: number;
}) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<span className="text-[13px] font-semibold text-foreground/70">
					{label}
				</span>
				{hint && (
					<span className="text-[11.5px] text-muted-foreground">{hint}</span>
				)}
			</div>
			<div
				className={columns ? "grid gap-[7px]" : "flex flex-wrap gap-[7px]"}
				style={
					columns
						? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
						: undefined
				}
			>
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
								"flex h-[30px] items-center justify-center rounded-[10px] px-3 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
								columns && "w-full",
								active
									? "bg-foreground/[0.16] font-semibold text-foreground"
									: "bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
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

/** A connected, single-select control for a small closed set of options
 *  (Resolution for video/image) — an alternative to {@link ChipGrid} when the
 *  options should read as one contiguous switch rather than independent
 *  chips. The selected segment gets the cream high-contrast fill; adjacent
 *  unselected segments get a 1px hairline separator (skipped next to the
 *  selected segment, which supplies its own visual edge). */
export function SegmentedControl<T extends string | number>({
	options,
	value,
	onChange,
	testIdPrefix,
	className,
}: {
	options: { value: T; label: React.ReactNode; title?: string }[];
	value: T;
	onChange: (v: T) => void;
	testIdPrefix?: string;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex rounded-[11px] bg-foreground/[0.05] p-[3px]",
				className,
			)}
		>
			{options.map((opt, i) => {
				const active = value === opt.value;
				const prevActive = i > 0 && options[i - 1].value === value;
				const showSeparator = i > 0 && !active && !prevActive;
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
							"relative flex h-[30px] flex-1 items-center justify-center rounded-lg text-[12.5px] font-semibold transition-colors duration-150",
							active
								? "bg-zinc-900 text-zinc-50 dark:bg-[#f2efe9] dark:text-[#171717]"
								: "text-muted-foreground hover:text-foreground",
							showSeparator &&
								"before:absolute before:left-0 before:h-4 before:w-px before:bg-foreground/[0.12]",
						)}
					>
						{opt.label}
					</button>
				);
			})}
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
				"flex items-center gap-[22px] border-b border-foreground/[0.08]",
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
							"relative -mb-px pb-2 text-sm font-semibold transition-colors",
							active
								? "text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground"
								: "text-foreground/45 hover:text-foreground/80",
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
				"divide-y divide-foreground/[0.08] overflow-hidden rounded-2xl border border-foreground/[0.09] bg-foreground/[0.035] transition-colors focus-within:border-foreground/[0.16]",
				className,
			)}
		>
			{children}
		</div>
	);
}
