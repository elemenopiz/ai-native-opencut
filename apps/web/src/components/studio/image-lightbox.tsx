"use client";

import { useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";

export interface LightboxStill {
	id: string;
	imageUrl: string;
	revisedPrompt?: string;
}

interface ImageLightboxProps {
	stills: LightboxStill[];
	index: number;
	onIndexChange: (index: number) => void;
	onClose: () => void;
	onUseAsReference?: (url: string) => void;
}

/**
 * Full-screen scroll-through viewer for flipping between batch variations.
 * Arrow keys / on-screen arrows navigate; the image stays draggable so it can
 * be dropped straight onto the visionboard.
 */
export function ImageLightbox({
	stills,
	index,
	onIndexChange,
	onClose,
	onUseAsReference,
}: ImageLightboxProps) {
	const count = stills.length;
	const still = stills[index];

	const go = useCallback(
		(delta: number) => {
			if (count === 0) return;
			onIndexChange((index + delta + count) % count);
		},
		[count, index, onIndexChange],
	);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowRight") go(1);
			else if (e.key === "ArrowLeft") go(-1);
			else if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [go, onClose]);

	if (!still) return null;

	return (
		<div
			className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-6"
			onClick={onClose}
		>
			{/* Close */}
			<button
				onClick={onClose}
				className="absolute top-4 right-4 text-white/70 hover:text-white text-sm"
				aria-label="Close"
			>
				✕ Close
			</button>

			{/* Counter */}
			<div className="absolute top-4 left-4 text-white/70 text-xs font-mono">
				{index + 1} / {count}
			</div>

			<div
				className="relative flex items-center gap-4 max-w-full max-h-full"
				onClick={(e) => e.stopPropagation()}
			>
				{count > 1 && (
					<button
						onClick={() => go(-1)}
						className="text-white/70 hover:text-white text-3xl shrink-0 px-2"
						aria-label="Previous"
					>
						‹
					</button>
				)}

				<div className="flex flex-col items-center gap-3 min-w-0">
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img
						src={still.imageUrl}
						alt={still.revisedPrompt ?? ""}
						className="max-h-[72vh] max-w-full object-contain rounded-lg"
					/>
					<div className="flex items-center gap-3">
						<span className="text-white/50 text-xs">
							Close, then drag a tile to the visionboard
						</span>
						{onUseAsReference && (
							<Button
								size="sm"
								className="text-xs h-7"
								onClick={() => onUseAsReference(still.imageUrl)}
							>
								Use as reference
							</Button>
						)}
					</div>
				</div>

				{count > 1 && (
					<button
						onClick={() => go(1)}
						className="text-white/70 hover:text-white text-3xl shrink-0 px-2"
						aria-label="Next"
					>
						›
					</button>
				)}
			</div>
		</div>
	);
}
