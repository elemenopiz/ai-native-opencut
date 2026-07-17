"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { HugeiconsIcon } from "@hugeicons/react";
import { VolumeHighIcon } from "@hugeicons/core-free-icons";
import { useAutoDuck, type DuckSpanMode } from "@/hooks/use-auto-duck";
import { useEditor } from "@/hooks/use-editor";
import { cn } from "@/utils/ui";

export function AutoDuckPanel({ className }: { className?: string }) {
	const editor = useEditor();
	const { applyAutoDuck } = useAutoDuck();
	const [duckAmount, setDuckAmount] = useState(-18);
	const [fadeDuration, setFadeDuration] = useState(0.3);
	const [spanMode, setSpanMode] = useState<DuckSpanMode>("voiceover-elements");

	const tracks = editor.timeline.getTracks();
	const audioTracks = tracks.filter(
		(t) => t.type === "audio" || t.type === "video",
	);

	const handleApply = useCallback(() => {
		applyAutoDuck({
			duckAmountDb: duckAmount,
			fadeDurationSec: fadeDuration,
			spanMode,
		});
	}, [applyAutoDuck, duckAmount, fadeDuration, spanMode]);

	return (
		<div className={className}>
			<div className="px-4 py-3 border-b space-y-3">
				<div className="flex items-center gap-2">
					<HugeiconsIcon
						icon={VolumeHighIcon}
						className="size-4 text-primary"
					/>
					<span className="text-xs font-medium">Auto-Duck</span>
				</div>
				<p className="text-[10px] text-muted-foreground">
					Automatically lower music volume under the voice.
				</p>
			</div>

			<div className="px-4 py-3 space-y-4">
				<div className="space-y-1.5">
					<div className="flex items-center gap-2">
						<span className="text-xs flex-1">Duck under</span>
						<button
							type="button"
							className={cn(
								"text-[10px] px-2 py-0.5 rounded-full border transition-colors",
								spanMode === "voiceover-elements"
									? "bg-primary text-primary-foreground border-primary"
									: "text-muted-foreground hover:bg-accent",
							)}
							onClick={() => setSpanMode("voiceover-elements")}
						>
							Voiceover
						</button>
						<button
							type="button"
							className={cn(
								"text-[10px] px-2 py-0.5 rounded-full border transition-colors",
								spanMode === "transcript"
									? "bg-primary text-primary-foreground border-primary"
									: "text-muted-foreground hover:bg-accent",
							)}
							onClick={() => setSpanMode("transcript")}
						>
							Transcript
						</button>
					</div>
					<p className="text-[10px] text-muted-foreground">
						{spanMode === "voiceover-elements"
							? "Ducks under voiceover clips on the timeline — no transcript needed."
							: "Ducks under transcribed speech segments."}
					</p>
				</div>

				<div className="space-y-1.5">
					<div className="flex justify-between text-[10px] text-muted-foreground">
						<span>Duck Amount</span>
						<span className="font-mono">{duckAmount} dB</span>
					</div>
					<Slider
						value={[duckAmount]}
						onValueChange={([v]) => setDuckAmount(v)}
						min={-30}
						max={-6}
						step={1}
					/>
				</div>

				<div className="space-y-1.5">
					<div className="flex justify-between text-[10px] text-muted-foreground">
						<span>Fade Duration</span>
						<span className="font-mono">{fadeDuration.toFixed(1)}s</span>
					</div>
					<Slider
						value={[fadeDuration]}
						onValueChange={([v]) => setFadeDuration(v)}
						min={0.1}
						max={1.0}
						step={0.1}
					/>
				</div>

				<div className="text-[9px] text-muted-foreground">
					{audioTracks.length} audio track{audioTracks.length !== 1 ? "s" : ""}{" "}
					detected. Music tracks (named "music", "bgm", "bg") are auto-detected.
				</div>

				<Button size="sm" className="w-full" onClick={handleApply}>
					Apply Auto-Duck
				</Button>
			</div>
		</div>
	);
}
