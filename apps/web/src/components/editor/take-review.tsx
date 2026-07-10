"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { useBackends } from "@/hooks/use-backends";
import { useSlotGeneration } from "@/hooks/use-slot-generation";
import { TakeProvenanceBadge } from "@/components/editor/take-provenance-badge";
import type {
	SafetyTier,
	Take,
	VideoElement,
	ImageElement,
} from "@/types/timeline";

type SlotEl = (VideoElement | ImageElement) & { id: string };

type TierFilter = SafetyTier | "all";

/** Short labels for the safety-tier filter chips. */
const TIER_LABEL: Record<SafetyTier, string> = {
	"indemnified-equivalent": "Indemnified",
	partner: "Partner",
	experimental: "Experimental",
};

/**
 * Phase 4 — step-through take review. Walk the reel slot-by-slot and pick the
 * winning take for each. Keyboard: ←/→ move between slots, 1–9 pick a take.
 * Selection routes through `selectTake` (non-destructive — alternates stay).
 */
export function TakeReview({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const [version, setVersion] = useState(0);
	const [index, setIndex] = useState(0);

	// Re-read slots whenever the timeline changes (or the dialog opens).
	useEffect(() => {
		if (!open) return;
		const bump = () => setVersion((v) => v + 1);
		return editor.timeline.subscribe(bump);
	}, [open, editor]);

	const slots = useMemo(() => {
		const out: SlotEl[] = [];
		for (const track of editor.timeline.getTracks()) {
			for (const el of track.elements) {
				if (
					(el.type === "video" || el.type === "image") &&
					el.generation &&
					(el.takes?.length ?? 0) > 0
				) {
					out.push(el as SlotEl);
				}
			}
		}
		return out.sort((a, b) => a.startTime - b.startTime);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, version, open]);

	const clampedIndex = Math.min(index, Math.max(0, slots.length - 1));
	const slot = slots[clampedIndex];

	// N-way compare + safety-tier filter (Phase 2).
	const modality: "video" | "image" | null = slot
		? slot.type === "image"
			? "image"
			: "video"
		: null;
	const { backends } = useBackends(modality);
	const { generateAcrossBackends } = useSlotGeneration();
	const [tierFilter, setTierFilter] = useState<TierFilter>("all");
	const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
	const [comparing, setComparing] = useState(false);

	// Default every available backend to selected when the catalog (re)loads.
	useEffect(() => {
		setCompareIds(new Set(backends.map((b) => b.id)));
	}, [backends]);

	// Reset the tier filter when moving to a different slot.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => setTierFilter("all"), [slot?.id]);

	const allTakes = useMemo(() => slot?.takes ?? [], [slot]);

	// Which tiers actually appear among this slot's takes (drives the chips).
	const tiersPresent = useMemo(() => {
		const set = new Set<SafetyTier>();
		for (const t of allTakes)
			if (t.provenance) set.add(t.provenance.safetyTier);
		return set;
	}, [allTakes]);

	// Preserve each take's ORIGINAL order (keyboard 1–9 still maps to it) while
	// filtering which are shown.
	const visibleTakes = useMemo(
		() =>
			allTakes
				.map((take, i) => ({ take, order: i + 1 }))
				.filter(
					({ take }) =>
						tierFilter === "all" || take.provenance?.safetyTier === tierFilter,
				),
		[allTakes, tierFilter],
	);

	const toggleCompareId = useCallback((id: string) => {
		setCompareIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const runCompare = useCallback(async () => {
		if (!slot?.generation || compareIds.size === 0) return;
		setComparing(true);
		try {
			await generateAcrossBackends({
				elementId: slot.id,
				spec: slot.generation,
				backendIds: [...compareIds],
			});
		} finally {
			setComparing(false);
		}
	}, [slot, compareIds, generateAcrossBackends]);

	const selectByOrder = useCallback(
		(takeOrder: number) => {
			if (!slot) return;
			const take = slot.takes?.[takeOrder];
			if (take)
				editor.timeline.selectTake({ elementId: slot.id, takeId: take.id });
		},
		[slot, editor],
	);

	// Keyboard navigation while open.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowLeft") {
				setIndex((i) => Math.max(0, i - 1));
			} else if (e.key === "ArrowRight") {
				setIndex((i) => Math.min(slots.length - 1, i + 1));
			} else if (/^[1-9]$/.test(e.key)) {
				selectByOrder(Number(e.key) - 1);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, slots.length, selectByOrder]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-sm">
						Review takes
						{slots.length > 0 && (
							<span className="text-xs font-normal text-muted-foreground">
								Slot {clampedIndex + 1} of {slots.length} · ←/→ to move · 1–9 to
								pick
							</span>
						)}
					</DialogTitle>
				</DialogHeader>

				{!slot ? (
					<div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
						No slots with takes yet. Generate some takes first.
					</div>
				) : (
					<div className="space-y-3">
						<p className="truncate text-xs text-muted-foreground">
							{slot.generation?.prompt || slot.name}
						</p>

						{/* Safety-tier filter — visible only when takes span >1 tier.
						    Adobe buries the tier in a legal PDF; we let you filter by it. */}
						{tiersPresent.size > 1 && (
							<div className="flex items-center gap-1">
								<span className="mr-1 text-[11px] text-muted-foreground">
									Tier
								</span>
								<TierChip
									label="All"
									count={allTakes.length}
									active={tierFilter === "all"}
									onClick={() => setTierFilter("all")}
								/>
								{(
									[
										"indemnified-equivalent",
										"partner",
										"experimental",
									] as SafetyTier[]
								)
									.filter((t) => tiersPresent.has(t))
									.map((t) => (
										<TierChip
											key={t}
											label={TIER_LABEL[t]}
											count={
												allTakes.filter((x) => x.provenance?.safetyTier === t)
													.length
											}
											active={tierFilter === t}
											onClick={() => setTierFilter(t)}
										/>
									))}
							</div>
						)}

						<div className="grid grid-cols-3 gap-3">
							{visibleTakes.map(({ take, order }) => (
								<TakeTile
									key={take.id}
									take={take}
									order={order}
									active={slot.activeTakeId === take.id}
									onClick={() =>
										editor.timeline.selectTake({
											elementId: slot.id,
											takeId: take.id,
										})
									}
									resolveUrl={(mediaId) =>
										editor.media.getAssetById(mediaId)?.url
									}
								/>
							))}
							{visibleTakes.length === 0 && (
								<div className="col-span-3 flex h-24 items-center justify-center text-xs text-muted-foreground">
									No takes in this tier.
								</div>
							)}
						</div>

						{/* N-way compare — fan this slot's prompt across models. Each
						    result stays a versioned take (Firefly collapses to one clip). */}
						{slot.generation && backends.length > 0 && (
							<div className="space-y-2 rounded-lg border border-border bg-muted/30 p-2">
								<div className="flex items-center justify-between">
									<span className="text-[11px] font-medium text-foreground">
										Compare across models
									</span>
									<button
										type="button"
										disabled={comparing || compareIds.size === 0}
										onClick={runCompare}
										className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
									>
										{comparing
											? "Generating…"
											: `Generate across ${compareIds.size} model${
													compareIds.size === 1 ? "" : "s"
												}`}
									</button>
								</div>
								<div className="flex flex-wrap gap-1">
									{backends.map((b) => (
										<button
											key={b.id}
											type="button"
											onClick={() => toggleCompareId(b.id)}
											title={`${b.vendor} · ${b.safetyTier}`}
											className={cn(
												"rounded border px-1.5 py-0.5 text-[10px] transition-colors",
												compareIds.has(b.id)
													? "border-primary bg-primary/10 text-foreground"
													: "border-border text-muted-foreground hover:text-foreground",
											)}
										>
											{b.label}
										</button>
									))}
								</div>
							</div>
						)}

						<div className="flex items-center justify-between pt-1">
							<button
								type="button"
								className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
								disabled={clampedIndex === 0}
								onClick={() => setIndex((i) => Math.max(0, i - 1))}
							>
								← Previous slot
							</button>
							<button
								type="button"
								className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
								disabled={clampedIndex >= slots.length - 1}
								onClick={() =>
									setIndex((i) => Math.min(slots.length - 1, i + 1))
								}
							>
								Next slot →
							</button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function TierChip({
	label,
	count,
	active,
	onClick,
}: {
	label: string;
	count: number;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded-full border px-2 py-0.5 text-[10px] transition-colors",
				active
					? "border-primary bg-primary/10 text-foreground"
					: "border-border text-muted-foreground hover:text-foreground",
			)}
		>
			{label}
			<span className="ml-1 opacity-60">{count}</span>
		</button>
	);
}

function TakeTile({
	take,
	order,
	active,
	onClick,
	resolveUrl,
}: {
	take: Take;
	order: number;
	active: boolean;
	onClick: () => void;
	resolveUrl: (mediaId: string) => string | undefined;
}) {
	const url =
		take.thumbnailUrl ?? (take.mediaId ? resolveUrl(take.mediaId) : undefined);
	const isReady = take.status === "ready";
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"relative aspect-video overflow-hidden rounded-lg border bg-muted text-left transition-all",
				active
					? "border-primary ring-2 ring-primary"
					: "border-border hover:border-foreground/40",
			)}
		>
			{isReady && url ? (
				take.mediaId ? (
					<video
						src={url}
						className="size-full object-cover"
						muted
						loop
						playsInline
					/>
				) : (
					<img src={url} alt="" className="size-full object-cover" />
				)
			) : (
				<div className="flex size-full items-center justify-center text-[11px] text-muted-foreground">
					{take.status === "failed" ? "Failed" : "Generating…"}
				</div>
			)}
			<span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-medium text-white">
				{order}
			</span>
			{active && (
				<Badge className="absolute right-1 top-1 px-1 py-0 text-[10px]">
					Active
				</Badge>
			)}
			<TakeProvenanceBadge
				take={take}
				className="absolute inset-x-1 bottom-1 justify-start rounded bg-black/70 px-1 py-0.5"
			/>
		</button>
	);
}
