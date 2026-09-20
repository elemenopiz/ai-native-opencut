"use client";

import { useEffect, useRef, useState } from "react";
import { animate, motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	EqualSignIcon,
} from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import type { EngagementScoreResult } from "@/lib/ai-client";

const GRADE_COLORS: Record<string, string> = {
	A: "text-green-400",
	B: "text-blue-400",
	C: "text-yellow-400",
	D: "text-orange-400",
	F: "text-red-400",
};

/**
 * Counts `display` toward `value` whenever `value` changes, so the headline
 * number visibly ticks from the old score to the new one instead of just
 * popping. Jumps straight to the target for viewers who prefer reduced
 * motion, and on first mount (nothing to count from yet).
 */
function useCountUp(value: number) {
	const [display, setDisplay] = useState(value);
	const prevRef = useRef(value);
	const isFirstRender = useRef(true);

	useEffect(() => {
		const from = prevRef.current;
		prevRef.current = value;

		if (isFirstRender.current || from === value) {
			isFirstRender.current = false;
			setDisplay(value);
			return;
		}

		if (
			typeof window !== "undefined" &&
			window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
		) {
			setDisplay(value);
			return;
		}

		const controls = animate(from, value, {
			duration: 0.6,
			ease: "easeOut",
			onUpdate: (v) => setDisplay(Math.round(v)),
		});
		return () => controls.stop();
	}, [value]);

	return display;
}

/**
 * The headline number: the thing a viewer's eye should land on first, and
 * the thing that should read as "went up" or "went down" in a fraction of a
 * second on a screen recording. Deliberately restrained — a number, a
 * direction, no confetti — because this is a professional editing tool.
 *
 * Pass `previous` (the score before the latest re-score) to show the delta;
 * omit it for a first-ever check, where there's nothing to compare against
 * yet. Pass `analyzing` while a re-score is in flight to hold the old
 * number on screen, dimmed, instead of hiding it.
 */
export function EngagementScoreHeadline({
	current,
	previous,
	analyzing = false,
}: {
	current: EngagementScoreResult;
	previous?: EngagementScoreResult | null;
	analyzing?: boolean;
}) {
	const displayComposite = useCountUp(Math.round(current.composite));
	const delta =
		previous != null
			? Math.round(current.composite - previous.composite)
			: null;
	const direction: "up" | "down" | "flat" =
		delta === null || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
	const gradeColor = GRADE_COLORS[current.grade] ?? "text-foreground";

	return (
		<div
			className={cn(
				"rounded-lg border p-4 space-y-1.5 transition-opacity duration-300",
				analyzing && "opacity-50",
			)}
		>
			<div className="flex items-center justify-between">
				<div className="flex items-baseline gap-2">
					<span
						className={cn(
							"text-4xl font-bold tabular-nums leading-none",
							gradeColor,
						)}
					>
						{displayComposite}
					</span>
					<span className="text-xs text-muted-foreground">/100</span>
					<span className={cn("text-base font-semibold", gradeColor)}>
						{current.grade}
					</span>
				</div>
				{analyzing && <Spinner className="h-4 w-4 text-muted-foreground" />}
			</div>

			{analyzing ? (
				<p className="text-xs text-muted-foreground">
					Re-scoring after your edit…
				</p>
			) : previous != null && delta !== null ? (
				<motion.div
					key={`${Math.round(previous.composite)}-${Math.round(current.composite)}`}
					initial={{ opacity: 0, y: 4 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.25, ease: "easeOut" }}
					className={cn(
						"flex items-center gap-1.5 text-sm font-medium",
						direction === "up"
							? "text-green-400"
							: direction === "down"
								? "text-red-400"
								: "text-muted-foreground",
					)}
				>
					<HugeiconsIcon
						icon={
							direction === "up"
								? ArrowUp01Icon
								: direction === "down"
									? ArrowDown01Icon
									: EqualSignIcon
						}
						className="size-3.5 flex-shrink-0"
					/>
					<span>
						{direction === "flat"
							? "No change"
							: delta > 0
								? `+${delta}`
								: delta}
					</span>
					<span className="text-xs font-normal text-muted-foreground">
						from {Math.round(previous.composite)}
					</span>
				</motion.div>
			) : (
				<p className="text-xs text-muted-foreground">
					First check — recheck after an edit to see the change.
				</p>
			)}
		</div>
	);
}
