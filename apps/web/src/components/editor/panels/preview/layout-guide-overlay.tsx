"use client";

import Image from "next/image";
import { computeGridLines, usePreviewStore } from "@/stores/preview-store";

function TikTokGuide() {
	return (
		<div className="pointer-events-none absolute inset-0">
			<Image
				src="/platform-guides/tiktok-blueprint.png"
				alt="TikTok layout guide"
				className="absolute inset-0 size-full object-contain"
				draggable={false}
				fill
			/>
		</div>
	);
}

function GridLines({ rows, cols }: { rows: number; cols: number }) {
	const { verticals, horizontals } = computeGridLines({ rows, cols });

	return (
		<>
			{verticals.map((pct) => (
				<div
					key={`v-${pct}`}
					className="absolute top-0 bottom-0 w-px bg-white/35"
					style={{ left: `${pct}%` }}
				/>
			))}
			{horizontals.map((pct) => (
				<div
					key={`h-${pct}`}
					className="absolute left-0 right-0 h-px bg-white/35"
					style={{ top: `${pct}%` }}
				/>
			))}
		</>
	);
}

function GridGuide() {
	const gridConfig = usePreviewStore((state) => state.gridConfig);

	return (
		<div className="pointer-events-none absolute inset-0">
			<GridLines rows={gridConfig.rows} cols={gridConfig.cols} />
		</div>
	);
}

/**
 * Preview-only chrome rendered over the canvas (never composited into
 * `buildScene`/export output). Must stay `pointerEvents: none` and mounted
 * behind `PreviewInteractionOverlay` so it never steals pointer events from
 * transform/mask handles.
 */
export function LayoutGuideOverlay() {
	const activeGuideId = usePreviewStore((state) => state.activeGuideId);

	if (activeGuideId === "grid") return <GridGuide />;
	if (activeGuideId === "tiktok") return <TikTokGuide />;

	return null;
}
