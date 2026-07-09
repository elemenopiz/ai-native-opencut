"use client";

import { cn } from "@/utils/ui";
import type { Arrangement } from "@/types/arrangement";

/**
 * A gallery card for one arrangement. Renders a media-free preview: a mini
 * slot-strip that conveys the shot count / pacing, plus name, duration and slot
 * count. Purely presentational — the parent wires the click.
 */
export function ArrangementCard({
	arrangement,
	onSelect,
	className,
	footer,
}: {
	arrangement: Arrangement;
	onSelect?: () => void;
	className?: string;
	footer?: React.ReactNode;
}) {
	const slotCount = arrangement.slots.length;
	const duration = Math.round(arrangement.totalDuration);
	const aspect = arrangement.canvas
		? arrangement.canvas.width / arrangement.canvas.height
		: 16 / 9;
	const isPortrait = aspect < 1;

	return (
		<div
			className={cn(
				"group flex flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors",
				onSelect && "hover:border-primary/60 cursor-pointer",
				className,
			)}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (onSelect && (e.key === "Enter" || e.key === " ")) {
					e.preventDefault();
					onSelect();
				}
			}}
			role={onSelect ? "button" : undefined}
			tabIndex={onSelect ? 0 : undefined}
		>
			<div className="bg-muted relative flex aspect-video items-center justify-center overflow-hidden p-4">
				<div
					className={cn(
						"flex h-full w-full items-center justify-center gap-1",
						isPortrait ? "flex-col" : "flex-row",
					)}
				>
					{arrangement.slots.length === 0 ? (
						<span className="text-muted-foreground text-xs">Blank</span>
					) : (
						arrangement.slots.slice(0, 8).map((slot) => (
							<div
								key={slot.id}
								className="bg-primary/25 group-hover:bg-primary/40 rounded-sm transition-colors"
								style={
									isPortrait
										? { width: "60%", flexGrow: Math.max(slot.duration, 0.5) }
										: { height: "60%", flexGrow: Math.max(slot.duration, 0.5) }
								}
								title={slot.label}
							/>
						))
					)}
				</div>
				<span className="bg-black/60 absolute bottom-2 right-2 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold text-white">
					{isPortrait ? "9:16" : aspect === 1 ? "1:1" : "16:9"}
				</span>
			</div>

			<div className="flex flex-col gap-1 p-3">
				<h3 className="truncate text-sm font-medium">{arrangement.name}</h3>
				{arrangement.description && (
					<p className="text-muted-foreground line-clamp-2 text-xs">
						{arrangement.description}
					</p>
				)}
				<div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
					<span>
						{slotCount} slot{slotCount === 1 ? "" : "s"}
					</span>
					<span>·</span>
					<span>{duration}s</span>
				</div>
				{footer}
			</div>
		</div>
	);
}
