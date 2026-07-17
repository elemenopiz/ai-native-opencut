import { useCallback, useRef } from "react";
import {
	Tooltip,
	TooltipTrigger,
	TooltipContent,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { Mic01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";
import { useAudioRecording } from "@/hooks/use-audio-recording";

function formatElapsed(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

export function RecordButton() {
	const { state, startRecording, stopRecording, addToTimeline } =
		useAudioRecording();
	const recordingCountRef = useRef(1);

	const handleClick = useCallback(async () => {
		if (state.isRecording) {
			const result = await stopRecording();
			if (result) {
				const name = `Recording ${recordingCountRef.current}`;
				recordingCountRef.current += 1;
				await addToTimeline(result.blob, result.duration, name);
			}
			return;
		}
		await startRecording();
	}, [state.isRecording, startRecording, stopRecording, addToTimeline]);

	return (
		<div className="flex items-center gap-1.5">
			{state.isRecording && (
				<div className="flex items-center gap-1 px-1 text-red-500">
					<span className="size-1.5 animate-pulse rounded-full bg-red-500" />
					<span className="font-mono text-[10px] tabular-nums">
						{formatElapsed(state.duration)}
					</span>
				</div>
			)}
			<Tooltip delayDuration={200}>
				<TooltipTrigger asChild>
					<Button
						variant={state.isRecording ? "secondary" : "text"}
						size="icon"
						aria-label={
							state.isRecording ? "Stop recording" : "Record voiceover"
						}
						onClick={handleClick}
						className={cn(
							"rounded-sm",
							state.isRecording && "text-red-500 hover:text-red-500",
						)}
					>
						<HugeiconsIcon icon={Mic01Icon} />
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					{state.isRecording ? "Stop recording" : "Record voiceover"}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
