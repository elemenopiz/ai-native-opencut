"use client";

import { useEditor } from "@/hooks/use-editor";
import { usePlaybackTime } from "@/hooks/use-playback-time";
import { formatTimeCode } from "@/lib/time";
import { invokeAction } from "@/lib/actions";
import { EditableTimecode } from "@/components/editable-timecode";
import { Button } from "@/components/ui/button";
import {
	FullScreenIcon,
	HandGripIcon,
	PauseIcon,
	PlayIcon,
	SearchAddIcon,
	SearchMinusIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { OcSocialIcon } from "@byorn/ui/icons";
import { Separator } from "@/components/ui/separator";
import { usePreviewStore } from "@/stores/preview-store";
import { AIToolbar } from "@/components/editor/ai/ai-toolbar";

const ZOOM_STEP = 1.25;

export function PreviewToolbar({
	isFullscreen,
	onToggleFullscreen,
}: {
	isFullscreen: boolean;
	onToggleFullscreen: () => void;
}) {
	const editor = useEditor();
	const isPlaying = editor.playback.getIsPlaying();
	const totalDuration = editor.timeline.getTotalDuration();
	const fps = editor.project.getActive().settings.fps;

	return (
		<div className="grid grid-cols-[1fr_auto_1fr] items-center pb-3 pt-5 px-5">
			<div className="flex items-center">
				<PlaybackTimecode
					duration={totalDuration}
					fps={fps}
					onTimeChange={({ time }) => editor.playback.seek({ time })}
				/>
				<span className="text-muted-foreground px-2 font-mono text-xs">/</span>
				<span className="text-muted-foreground font-mono text-xs">
					{formatTimeCode({
						timeInSeconds: totalDuration,
						format: "HH:MM:SS:FF",
						fps,
					})}
				</span>
			</div>

			<Button
				variant="text"
				size="icon"
				onClick={() => invokeAction("toggle-play")}
			>
				<HugeiconsIcon icon={isPlaying ? PauseIcon : PlayIcon} />
			</Button>

			<div className="justify-self-end flex items-center gap-2.5">
				<AIToolbar />
				<Separator orientation="vertical" className="h-4" />
				<PreviewZoomControls />
				<Separator orientation="vertical" className="h-4" />
				<Button
					variant="secondary"
					size="sm"
					className="[&_svg]:size-auto px-1 h-7"
					onClick={onToggleFullscreen}
					title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
				>
					<OcSocialIcon size={20} />
				</Button>
				<Separator orientation="vertical" className="h-4" />
				<Button
					variant="text"
					onClick={onToggleFullscreen}
					title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
				>
					<HugeiconsIcon icon={FullScreenIcon} />
				</Button>
			</div>
		</div>
	);
}

// Isolated leaf: subscribes only to the playhead time (usePlaybackTime), so the
// per-frame tick during playback re-renders this timecode alone instead of the
// whole toolbar/editor tree.
function PlaybackTimecode({
	duration,
	fps,
	onTimeChange,
}: {
	duration: number;
	fps: number;
	onTimeChange: ({ time }: { time: number }) => void;
}) {
	const currentTime = usePlaybackTime();

	return (
		<EditableTimecode
			time={currentTime}
			duration={duration}
			format="HH:MM:SS:FF"
			fps={fps}
			onTimeChange={onTimeChange}
			className="text-center"
		/>
	);
}

function PreviewZoomControls() {
	const {
		zoom,
		panMode,
		fitScale,
		setZoom,
		setZoomAndPan,
		togglePanMode,
		resetView,
	} = usePreviewStore();
	const zoomPercent = Math.round(zoom * (fitScale || 1) * 100);

	return (
		<div className="flex items-center gap-0.5">
			<Button
				variant={panMode ? "secondary" : "text"}
				size="icon"
				className="size-7"
				onClick={togglePanMode}
				title="Pan tool (drag to pan, middle-drag anytime)"
			>
				<HugeiconsIcon icon={HandGripIcon} className="size-4" />
			</Button>
			<Button
				variant="text"
				size="icon"
				className="size-7"
				onClick={() => setZoom({ zoom: zoom / ZOOM_STEP })}
				title="Zoom out"
			>
				<HugeiconsIcon icon={SearchMinusIcon} className="size-4" />
			</Button>
			<Button
				variant="text"
				size="sm"
				className="h-7 w-12 px-1 font-mono text-xs"
				onClick={resetView}
				title="Zoom to fit"
			>
				{zoomPercent}%
			</Button>
			<Button
				variant="text"
				size="icon"
				className="size-7"
				onClick={() => setZoom({ zoom: zoom * ZOOM_STEP })}
				title="Zoom in"
			>
				<HugeiconsIcon icon={SearchAddIcon} className="size-4" />
			</Button>
			<Button
				variant="text"
				size="sm"
				className="h-7 px-1 font-mono text-xs"
				onClick={() =>
					setZoomAndPan({
						zoom: fitScale > 0 ? 1 / fitScale : 1,
						pan: { x: 0, y: 0 },
					})
				}
				title="Zoom to 100%"
			>
				1:1
			</Button>
		</div>
	);
}
