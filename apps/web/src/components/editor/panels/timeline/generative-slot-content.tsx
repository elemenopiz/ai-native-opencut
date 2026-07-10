"use client";

import { motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SparklesIcon, Alert02Icon } from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import type { ImageElement, VideoElement } from "@/types/timeline";

type GenerativeElement = VideoElement | ImageElement;

/**
 * Timeline rendering for a generative slot whose media isn't resolved yet —
 * the empty / generating / failed states. A filled slot falls back to the
 * normal tiled-thumbnail path (see ELEMENT_CONTENT_RENDERERS). Reuses the
 * existing animation primitives: `Spinner` (animate-spin) + a `motion` sheen.
 */
export function GenerativeSlotContent({
	element,
}: {
	element: GenerativeElement;
}) {
	const takes = element.takes ?? [];
	const isGenerating = takes.some(
		(t) => t.status === "generating" || t.status === "queued",
	);
	const isFailed =
		!isGenerating &&
		takes.length > 0 &&
		takes.every((t) => t.status === "failed");
	const prompt = element.generation?.prompt?.trim() || element.name;

	return (
		<div
			data-testid="generative-slot-content"
			data-slot-state={
				isGenerating ? "generating" : isFailed ? "failed" : "empty"
			}
			className={cn(
				"absolute inset-0 flex items-center gap-1.5 overflow-hidden px-2",
				// Diagonal hatching reads as a placeholder on any track color.
				"bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(0,0,0,0.14)_6px,rgba(0,0,0,0.14)_12px)]",
			)}
		>
			{/* Animated sheen while generating — a light band sweeping across. */}
			{isGenerating && (
				<motion.div
					aria-hidden
					className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3"
					style={{
						background:
							"linear-gradient(90deg, transparent, rgba(255,255,255,0.22), transparent)",
					}}
					initial={{ x: 0 }}
					animate={{ x: "400%" }}
					transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
				/>
			)}

			{isGenerating ? (
				<Spinner className="size-3.5 shrink-0 text-white" />
			) : isFailed ? (
				<HugeiconsIcon
					icon={Alert02Icon}
					className="size-3.5 shrink-0 text-red-400"
				/>
			) : (
				<HugeiconsIcon
					icon={SparklesIcon}
					className="size-3.5 shrink-0 text-white/80"
				/>
			)}

			<span
				className={cn(
					"truncate text-[11px] leading-none",
					isFailed ? "text-red-300" : "text-white/90",
				)}
			>
				{isGenerating ? "Generating…" : isFailed ? "Generation failed" : prompt}
			</span>
		</div>
	);
}

/**
 * Small "N takes" pill for a filled generative slot with alternates, so the
 * timeline shows at a glance which clips have more takes to choose from.
 */
export function SlotTakesBadge({ element }: { element: GenerativeElement }) {
	const takes = element.takes ?? [];
	if (!element.generation || takes.length < 2) return null;
	return (
		<div className="pointer-events-none absolute right-1 top-1 z-10 rounded-sm bg-black/70 px-1 py-0.5 text-[10px] font-medium leading-none text-white">
			{takes.length} takes
		</div>
	);
}
