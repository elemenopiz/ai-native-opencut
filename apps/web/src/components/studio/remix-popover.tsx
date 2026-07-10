"use client";

// Adapted from palmier-io/sixsevenstudio (MIT). See THIRD_PARTY_NOTICES.
/**
 * Remix popover — ports sixsevenstudio's `RemixPopover`
 * (`src/components/videos/RemixPopover.tsx`): the manual UI affordance for the
 * remix pattern. A small Sparkles-button opens a popover with a single
 * delta-prompt textarea ("make the colors more vibrant, add a sunset...") and
 * a confirm button — the user describes the CHANGE, never re-types the whole
 * prompt.
 *
 * The remix VERB is already ported and wired: `lib/studio/remix.ts`'s
 * `buildRemixSpec` composes the delta onto the prior take's prompt, carries
 * the seed with `seedLocked: true`, and re-anchors on the prior reference
 * image; `director-api.ts` exposes it as a `remix` verb for the agent. What's
 * been missing (flagged in remix.ts's own header) is the HUMAN path — a
 * "Remix" button on a take for users who don't go through the agent. That's
 * this component.
 *
 * Mapping onto OUR data model (not theirs): upstream's popover only emits the
 * raw delta string and the caller talks to Sora's server-side
 * `videos.remix(videoId, prompt)` endpoint. We have no such endpoint
 * (BytePlus ModelArk only creates fresh generations), so this component goes
 * one step further than upstream and emits the ready-to-submit
 * `GenerationSpec` too: it takes the prior `Take` (our unit of "a previous
 * generation" — see `types/timeline.ts`), runs the delta through
 * `buildRemixSpec`, and hands the caller `{ spec, remixPrompt }`. The caller
 * only has to enqueue the spec through whatever generation path it already
 * uses — it never needs to know how remixing composes prompts or seeds.
 *
 * Self-contained: pure UI + the pure `buildRemixSpec` builder. No stores, no
 * provider calls, no timeline mutations.
 *
 * WIRED:
 *  1. `components/editor/panels/properties/generative-clip-properties.tsx`'s
 *     `SpecSection` renders this beside the "Re-roll · +1 take" button and
 *     enqueues via `useSlotGeneration().generateIntoSlot` — a remix lands as a
 *     new take on the same slot, exactly like a re-roll but with the
 *     delta-composed, seed-locked spec.
 *  3. That call site resolves the active take's REAL last frame via
 *     `extractTakeLastFrame` (`lib/media/last-frame.ts`) and passes it as
 *     `anchorImageUrl`, so a manual remix re-conditions on the finished video's
 *     final frame instead of the original reference still — matching the agent
 *     path in `director-api.ts`'s `remix` verb.
 *
 * WIRING TODO (separate reviewed pass — do not wire here):
 *  2. Optionally `components/studio/take-card.tsx` (studio panel takes):
 *     same pattern in the hover action overlay, enqueueing via
 *     `use-studio-generation`'s submit path with the built spec.
 */

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { buildRemixSpec } from "@/lib/studio/remix";
import type { GenerationSpec, Take } from "@/types/timeline";

export interface RemixPopoverProps {
	/** The take being remixed — supplies the prior prompt/seed/spec to anchor on. */
	take: Pick<Take, "spec" | "seed">;
	/**
	 * Called with the ready-to-submit spec (delta composed onto the original
	 * prompt, seed locked) plus the raw delta the user typed, for display or
	 * provenance. The caller enqueues the spec through its existing
	 * generation path (e.g. `useSlotGeneration().generateIntoSlot`).
	 */
	onRemix: (result: { spec: GenerationSpec; remixPrompt: string }) => void;
	/**
	 * Frame to re-condition on (e.g. the prior take's last frame, once that
	 * extractor exists). Falls back to the prior spec's own reference image.
	 */
	anchorImageUrl?: string;
	/** "icon" renders a square icon-only trigger for tight overlays (mirrors upstream). */
	buttonSize?: "sm" | "icon";
	buttonClassName?: string;
	/** Tighter copy + a 3-row textarea for cramped contexts like card overlays. */
	compact?: boolean;
}

export function RemixPopover({
	take,
	onRemix,
	anchorImageUrl,
	buttonSize = "sm",
	buttonClassName,
	compact = false,
}: RemixPopoverProps) {
	const [remixPrompt, setRemixPrompt] = useState("");
	const [isOpen, setIsOpen] = useState(false);

	const handleSubmit = () => {
		const delta = remixPrompt.trim();
		if (!delta) return;
		const spec = buildRemixSpec({
			priorTake: take,
			remixPrompt: delta,
			anchorImageUrl,
		});
		onRemix({ spec, remixPrompt: delta });
		setRemixPrompt("");
		setIsOpen(false);
	};

	const handleCancel = () => {
		setRemixPrompt("");
		setIsOpen(false);
	};

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size={buttonSize === "icon" ? "icon" : "sm"}
					className={buttonClassName}
					title="Remix take"
				>
					<Sparkles
						className={buttonSize === "icon" ? "size-3.5" : "size-3 mr-1.5"}
					/>
					{buttonSize !== "icon" && "Remix"}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80" onClick={(e) => e.stopPropagation()}>
				<div className="space-y-3">
					<div>
						<h4 className="font-medium text-sm mb-1">Remix take</h4>
						<p className="text-xs text-muted-foreground">
							{compact
								? "Describe modifications"
								: "Describe the change — the original prompt, seed, and reference carry over"}
						</p>
					</div>
					<Textarea
						placeholder="e.g., Make the colors more vibrant, add a sunset in the background..."
						value={remixPrompt}
						onChange={(e) => setRemixPrompt(e.target.value)}
						rows={compact ? 3 : 4}
						className="text-sm"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								handleSubmit();
							}
						}}
					/>
					<div className="flex justify-end gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={(e) => {
								e.stopPropagation();
								handleCancel();
							}}
						>
							Cancel
						</Button>
						<Button
							size="sm"
							onClick={(e) => {
								e.stopPropagation();
								handleSubmit();
							}}
							disabled={!remixPrompt.trim()}
						>
							{compact ? "Remix" : "Create remix"}
						</Button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
