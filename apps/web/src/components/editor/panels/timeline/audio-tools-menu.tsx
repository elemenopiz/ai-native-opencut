"use client";

/**
 * Toolbar entry point for the timeline audio tools: dead-air removal,
 * beat-grid analysis, and multicam clip sync (audio / timecode / auto).
 */

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AudioWave01Icon,
	MusicNote01Icon,
	ScissorIcon,
	Exchange01Icon,
} from "@hugeicons/core-free-icons";
import {
	useBeatAnalysis,
	useMulticamSync,
	useSilenceRemoval,
	type MulticamSyncMode,
} from "@/hooks/timeline/use-audio-tools";
import { useBeatGridStore } from "@/stores/beat-grid-store";

export function AudioToolsMenu() {
	const { removeSilences, isRemovingSilences } = useSilenceRemoval();
	const { analyzeSelectedClipBeats, isAnalyzingBeats } = useBeatAnalysis();
	const { syncSelectedClips, isSyncing } = useMulticamSync();
	const grid = useBeatGridStore((s) => s.grid);

	const isBusy = isRemovingSilences || isAnalyzingBeats || isSyncing;

	const handleSync = (mode: MulticamSyncMode) => {
		void syncSelectedClips({ mode });
	};

	return (
		<DropdownMenu>
			<Tooltip delayDuration={200}>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button
							variant="text"
							size="icon"
							className="rounded-sm"
							disabled={isBusy}
							aria-label="Audio tools"
						>
							<HugeiconsIcon icon={AudioWave01Icon} />
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent>
					{isBusy ? "Audio tools (working…)" : "Audio tools"}
				</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="end" className="w-64">
				<DropdownMenuLabel>Audio tools</DropdownMenuLabel>
				<DropdownMenuSeparator />

				<DropdownMenuItem
					disabled={isBusy}
					onSelect={() => void removeSilences()}
				>
					<HugeiconsIcon icon={ScissorIcon} className="mr-2 size-4" />
					<div className="flex flex-col">
						<span>Remove dead air</span>
						<span className="text-muted-foreground text-xs">
							Cut silences from the selected clip
						</span>
					</div>
				</DropdownMenuItem>

				<DropdownMenuItem
					disabled={isBusy}
					onSelect={() => void analyzeSelectedClipBeats()}
				>
					<HugeiconsIcon icon={MusicNote01Icon} className="mr-2 size-4" />
					<div className="flex flex-col">
						<span>{grid ? "Re-analyze beat grid" : "Analyze beat grid"}</span>
						<span className="text-muted-foreground text-xs">
							Beat ticks + snap-to-beat from the selected clip
						</span>
					</div>
				</DropdownMenuItem>

				<DropdownMenuSeparator />

				<DropdownMenuSub>
					<DropdownMenuSubTrigger disabled={isBusy}>
						<HugeiconsIcon icon={Exchange01Icon} className="mr-2 size-4" />
						<div className="flex flex-col">
							<span>Sync clips (multicam)</span>
							<span className="text-muted-foreground text-xs">
								Align 2+ selected clips across tracks
							</span>
						</div>
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="w-56">
						<DropdownMenuItem
							disabled={isBusy}
							onSelect={() => handleSync("auto")}
						>
							<div className="flex flex-col">
								<span>Auto</span>
								<span className="text-muted-foreground text-xs">
									Audio first, timecode fallback
								</span>
							</div>
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={isBusy}
							onSelect={() => handleSync("audio")}
						>
							<div className="flex flex-col">
								<span>By audio waveform</span>
								<span className="text-muted-foreground text-xs">
									Cross-correlate energy envelopes
								</span>
							</div>
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={isBusy}
							onSelect={() => handleSync("timecode")}
						>
							<div className="flex flex-col">
								<span>By timecode</span>
								<span className="text-muted-foreground text-xs">
									File recording-time metadata
								</span>
							</div>
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
