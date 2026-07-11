"use client";

import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ColorPicker } from "@/components/ui/color-picker";
import { Label } from "@/components/ui/label";
import {
	BLUR_INTENSITY_PRESETS,
	DEFAULT_BLUR_INTENSITY,
	DEFAULT_COLOR,
} from "@/constants/project-constants";
import { patternCraftGradients } from "@/data/colors/pattern-craft";
import { colors as solidColors } from "@/data/colors/solid";
import { syntaxUIGradients } from "@/data/colors/syntax-ui";
import { useEditor } from "@/hooks/use-editor";
import type { TBackground } from "@/types/project";
import { cn } from "@/utils/ui";

/**
 * Project-level canvas Background section.
 *
 * Sets what renders BEHIND clips that don't cover the full canvas (e.g. 16:9
 * footage on a 9:16 canvas). Three modes:
 *
 * - Blur (hero): a scaled-to-cover, blurred copy of the frame's own content
 *   fills the canvas — the default look for vertical repurposing.
 * - Color: a solid fill.
 * - Gradient: a CSS-gradient fill.
 *
 * The persisted shape is the existing `TBackground` union on
 * `project.settings.background` — no schema change. Gradients ride the
 * `type: "color"` variant as a CSS gradient string, which the render path
 * (`ColorNode` → `drawCssBackground`) already understands in both preview and
 * export, since both call `buildScene` with `settings.background`.
 */

type BackgroundMode = "blur" | "color" | "gradient";

// Deduped — the two preset packs share a few gradients, and the swatch
// buttons key on the gradient string itself.
const GRADIENT_PRESETS: string[] = [
	...new Set([...syntaxUIGradients, ...patternCraftGradients]),
];

function isGradientValue({ value }: { value: string }): boolean {
	return /gradient\(/i.test(value);
}

function getBackgroundMode({
	background,
}: {
	background: TBackground;
}): BackgroundMode {
	if (background.type === "blur") {
		return "blur";
	}
	return isGradientValue({ value: background.color }) ? "gradient" : "color";
}

const MODE_DESCRIPTIONS: Record<BackgroundMode, string> = {
	blur: "A blurred, zoomed copy of your own footage fills the canvas — the classic look for turning 16:9 clips into 9:16 reels.",
	color: "A solid color fills the canvas behind clips that don't cover it.",
	gradient: "A gradient fills the canvas behind clips that don't cover it.",
};

export function BackgroundSettings() {
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const background = activeProject.settings.background;
	const mode = getBackgroundMode({ background });

	// Remember the last pick per mode so toggling between modes restores it
	// instead of resetting to defaults.
	const [lastSolidColor, setLastSolidColor] = useState<string>(() =>
		background.type === "color" && !isGradientValue({ value: background.color })
			? background.color
			: DEFAULT_COLOR,
	);
	const [lastGradient, setLastGradient] = useState<string>(() =>
		background.type === "color" && isGradientValue({ value: background.color })
			? background.color
			: GRADIENT_PRESETS[0],
	);
	const [lastBlurIntensity, setLastBlurIntensity] = useState<number>(() =>
		background.type === "blur"
			? background.blurIntensity
			: DEFAULT_BLUR_INTENSITY,
	);

	const applyBackground = useCallback(
		({
			next,
			pushHistory = true,
		}: {
			next: TBackground;
			pushHistory?: boolean;
		}) => {
			editor.project.updateSettings({
				settings: { background: next },
				pushHistory,
			});
		},
		[editor.project],
	);

	const handleModeSelect = useCallback(
		({ nextMode }: { nextMode: BackgroundMode }) => {
			if (nextMode === mode) return;
			if (nextMode === "blur") {
				applyBackground({
					next: { type: "blur", blurIntensity: lastBlurIntensity },
				});
				return;
			}
			if (nextMode === "gradient") {
				applyBackground({ next: { type: "color", color: lastGradient } });
				return;
			}
			applyBackground({ next: { type: "color", color: lastSolidColor } });
		},
		[mode, applyBackground, lastBlurIntensity, lastGradient, lastSolidColor],
	);

	const handleBlurIntensitySelect = useCallback(
		({ blurIntensity }: { blurIntensity: number }) => {
			setLastBlurIntensity(blurIntensity);
			applyBackground({ next: { type: "blur", blurIntensity } });
		},
		[applyBackground],
	);

	const handleSolidColorSelect = useCallback(
		({ color, pushHistory }: { color: string; pushHistory?: boolean }) => {
			setLastSolidColor(color);
			applyBackground({ next: { type: "color", color }, pushHistory });
		},
		[applyBackground],
	);

	const handleGradientSelect = useCallback(
		({ gradient }: { gradient: string }) => {
			setLastGradient(gradient);
			applyBackground({ next: { type: "color", color: gradient } });
		},
		[applyBackground],
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center gap-1" role="tablist">
					{(["blur", "color", "gradient"] as const).map((option) => {
						const isActive = mode === option;
						return (
							<button
								key={option}
								type="button"
								role="tab"
								aria-selected={isActive}
								onClick={() => handleModeSelect({ nextMode: option })}
								className={cn(
									"flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] capitalize transition-colors",
									isActive
										? "border-primary/40 bg-primary/5 font-medium"
										: "border-border hover:bg-accent cursor-pointer",
								)}
							>
								{option}
								{option === "blur" && (
									<Badge
										variant="outline"
										className={cn(
											"text-[7px] px-1 py-0",
											isActive
												? "text-primary border-primary/40"
												: "text-amber-500 border-amber-500/40",
										)}
									>
										Best for 9:16
									</Badge>
								)}
							</button>
						);
					})}
				</div>
				<p className="text-[10px] text-muted-foreground leading-relaxed">
					{MODE_DESCRIPTIONS[mode]}
				</p>
			</div>

			{mode === "blur" && (
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">Blur intensity</Label>
					<div className="flex items-center gap-1">
						{BLUR_INTENSITY_PRESETS.map((preset) => {
							const isActive =
								background.type === "blur" &&
								background.blurIntensity === preset.value;
							return (
								<button
									key={preset.value}
									type="button"
									onClick={() =>
										handleBlurIntensitySelect({ blurIntensity: preset.value })
									}
									className={cn(
										"rounded-md border px-2.5 py-1 text-[11px] transition-colors",
										isActive
											? "border-primary/40 bg-primary/5 font-medium"
											: "border-border hover:bg-accent cursor-pointer",
									)}
								>
									{preset.label}
								</button>
							);
						})}
					</div>
				</div>
			)}

			{mode === "color" && (
				<div className="flex flex-col gap-2">
					<div className="flex flex-col gap-1.5">
						<Label className="text-xs">Custom color</Label>
						<ColorPicker
							value={
								background.type === "color"
									? background.color.replace("#", "")
									: DEFAULT_COLOR.replace("#", "")
							}
							onChange={(color) =>
								handleSolidColorSelect({
									color: `#${color}`,
									pushHistory: false,
								})
							}
							onChangeEnd={(color) =>
								handleSolidColorSelect({ color: `#${color}` })
							}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label className="text-xs">Swatches</Label>
						<div className="flex flex-wrap gap-1">
							{solidColors.map((color) => {
								const isActive =
									background.type === "color" &&
									background.color.toLowerCase() === color.toLowerCase();
								return (
									<button
										key={color}
										type="button"
										title={color}
										aria-label={`Background color ${color}`}
										onClick={() => handleSolidColorSelect({ color })}
										className={cn(
											"size-5 rounded-sm border cursor-pointer transition-shadow",
											isActive
												? "ring-2 ring-primary ring-offset-1 ring-offset-background"
												: "hover:ring-1 hover:ring-foreground/30",
										)}
										style={{ backgroundColor: color }}
									/>
								);
							})}
						</div>
					</div>
				</div>
			)}

			{mode === "gradient" && (
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">Presets</Label>
					<div className="flex flex-wrap gap-1.5">
						{GRADIENT_PRESETS.map((gradient) => {
							const isActive =
								background.type === "color" && background.color === gradient;
							return (
								<button
									key={gradient}
									type="button"
									aria-label="Background gradient preset"
									onClick={() => handleGradientSelect({ gradient })}
									className={cn(
										"h-9 w-14 rounded-md border cursor-pointer transition-shadow",
										isActive
											? "ring-2 ring-primary ring-offset-1 ring-offset-background"
											: "hover:ring-1 hover:ring-foreground/30",
									)}
									style={{ background: gradient }}
								/>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
