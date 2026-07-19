"use client";

import { useState, useMemo, useCallback } from "react";
import { cn } from "@/utils/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEditor } from "@/hooks/use-editor";
import { useTranscriptStore } from "@/stores/transcript-store";
import { buildSpeakerCaptionSegments } from "@/lib/transcription/speaker-captions";
import {
	CAPTION_PRESETS,
	getCaptionPreset,
	buildCaptionElementStyle,
	type CaptionPresetId,
} from "@/lib/captions/caption-presets";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";
import { toast } from "sonner";

type SpeakerPosition = "left" | "right" | "center";

/** Horizontal offset (as a ratio of canvas width) for a speaker's caption line,
 *  so diarized speakers can be visually separated left/right/center. */
const POSITION_X_RATIO: Record<SpeakerPosition, number> = {
	left: -0.22,
	right: 0.22,
	center: 0,
};

export function SpeakerCaptionsPanel({ className }: { className?: string }) {
	const editor = useEditor();
	const segments = useTranscriptStore((s) => s.segments);
	// Speaker names/positions are populated by diarization (`applySpeakerDiarization`)
	// and shared across every speaker-aware feature — read them from the store
	// rather than keeping a private copy, so renames persist and stay consistent.
	const storeSpeakerNames = useTranscriptStore((s) => s.speakerNames);
	const speakerPositions = useTranscriptStore((s) => s.speakerPositions);
	const setSpeakerName = useTranscriptStore((s) => s.setSpeakerName);
	const setSpeakerPosition = useTranscriptStore((s) => s.setSpeakerPosition);

	const [captionPreset, setCaptionPreset] =
		useState<CaptionPresetId>("clean-bold");
	const [mergeConsecutive, setMergeConsecutive] = useState(false);
	const [appliedTrackId, setAppliedTrackId] = useState<string | null>(null);

	const captionSegments = useMemo(
		() =>
			buildSpeakerCaptionSegments(segments, {
				speakerNames: storeSpeakerNames,
				groupConsecutive: mergeConsecutive,
			}),
		[segments, storeSpeakerNames, mergeConsecutive],
	);

	const uniqueSpeakers = useMemo(() => {
		const seen = new Map<string, { index: number; color: string }>();
		for (const seg of captionSegments) {
			if (!seen.has(seg.speaker)) {
				seen.set(seg.speaker, {
					index: seg.speakerIndex,
					color: seg.speakerColor,
				});
			}
		}
		return Array.from(seen.entries()).map(([speaker, info]) => ({
			speaker,
			...info,
		}));
	}, [captionSegments]);

	// Diarization is considered "present" when we have a real speaker id — a
	// single "unknown" speaker means the diarization pass returned nothing (or
	// the backend was unavailable), so captions still work but aren't split.
	const hasDiarization = useMemo(
		() => uniqueSpeakers.some((s) => s.speaker !== "unknown"),
		[uniqueSpeakers],
	);

	const handleRenameSpeaker = useCallback(
		(speaker: string, name: string) => {
			setSpeakerName(speaker, name);
		},
		[setSpeakerName],
	);

	const cyclePosition = useCallback(
		(speaker: string) => {
			const order: SpeakerPosition[] = ["center", "left", "right"];
			const current = speakerPositions[speaker] ?? "center";
			const next = order[(order.indexOf(current) + 1) % order.length];
			setSpeakerPosition(speaker, next);
		},
		[speakerPositions, setSpeakerPosition],
	);

	const removeAppliedTrack = useCallback(() => {
		if (!appliedTrackId) return;
		try {
			editor.timeline.removeTrack({ trackId: appliedTrackId });
		} catch {
			// Track may have been removed manually already.
		}
		setAppliedTrackId(null);
	}, [appliedTrackId, editor]);

	const handleApplyToTimeline = useCallback(() => {
		if (captionSegments.length === 0) {
			toast.error("No caption segments to apply");
			return;
		}

		// Removing the old track, adding the new one, and inserting every
		// segment is one user action ("apply") — must undo as a single step.
		const supportsTransaction =
			typeof editor.command.beginTransaction === "function";
		if (supportsTransaction) {
			editor.command.beginTransaction({ name: "Apply speaker captions" });
		}

		let trackId: string;
		try {
			// Replace a previously-applied speaker-caption track so re-applying with a
			// different style/grouping doesn't stack duplicates.
			removeAppliedTrack();

			const preset = getCaptionPreset(captionPreset);
			const canvasSize = editor.project.getActive().settings.canvasSize;
			const baseY = canvasSize.height * preset.yPositionRatio;

			trackId = editor.timeline.addTrack({ type: "text", index: 0 });
			editor.timeline.renameTrack({ trackId, name: "Speaker Captions" });

			for (let i = 0; i < captionSegments.length; i++) {
				const seg = captionSegments[i];

				// Word timings are element-local (0-based) for the renderer's karaoke path.
				const wordTimings = seg.words.map((w) => ({
					word: w.word,
					start: w.start - seg.start,
					end: w.end - seg.start,
				}));

				const position = (speakerPositions[seg.speaker] ??
					"center") as SpeakerPosition;
				const x = canvasSize.width * POSITION_X_RATIO[position];

				editor.timeline.insertElement({
					placement: { mode: "explicit", trackId },
					element: {
						...DEFAULT_TEXT_ELEMENT,
						...buildCaptionElementStyle({
							preset,
							elementKey: `${trackId}-${i}`,
						}),
						// Tint the base (unspoken) color per speaker so each diarized
						// speaker is visually distinct; the preset's highlight/active
						// colors still drive the karaoke fill.
						color: seg.speakerColor,
						name: `${seg.speakerLabel} ${i + 1}`,
						content: seg.text,
						startTime: seg.start,
						duration: seg.end - seg.start,
						...(wordTimings.length > 0 ? { wordTimings } : {}),
						opacity: 1,
						transform: {
							scale: 1,
							position: { x, y: baseY },
							rotate: 0,
						},
					},
				});
			}
			if (supportsTransaction) editor.command.commitTransaction();
		} catch (err) {
			if (supportsTransaction) editor.command.rollbackTransaction();
			throw err;
		}

		setAppliedTrackId(trackId);
		toast.success(
			`Applied ${captionSegments.length} speaker-labeled captions`,
			{
				description: hasDiarization
					? `${uniqueSpeakers.length} speakers, ${getCaptionPreset(captionPreset).name} style`
					: "No distinct speakers detected — captions added as one voice.",
			},
		);
	}, [
		captionSegments,
		captionPreset,
		speakerPositions,
		editor,
		hasDiarization,
		uniqueSpeakers.length,
		removeAppliedTrack,
	]);

	if (segments.length === 0) {
		return (
			<div className={cn("p-4 text-center", className)}>
				<p className="text-sm text-muted-foreground">
					Transcribe your video first to enable speaker captions.
				</p>
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col h-full", className)}>
			<div className="px-4 py-3 border-b space-y-2">
				<div className="flex items-center justify-between">
					<span className="text-xs font-medium">Speaker Captions</span>
					<Badge variant="secondary" className="text-[8px] px-1 py-0">
						{uniqueSpeakers.length}{" "}
						{uniqueSpeakers.length === 1 ? "speaker" : "speakers"}
					</Badge>
				</div>
				{!hasDiarization && (
					<p className="text-[10px] text-muted-foreground leading-relaxed">
						No speaker diarization on this transcript yet — captions will be
						added as a single voice. Re-transcribe with speaker detection to
						split by speaker.
					</p>
				)}
			</div>

			<div className="px-4 py-3 space-y-3 border-b">
				{uniqueSpeakers.map(({ speaker, index, color }) => (
					<div key={speaker} className="flex items-center gap-2">
						<div
							className="size-4 rounded-full shrink-0 border"
							style={{ backgroundColor: color }}
						/>
						<Input
							className="h-7 text-[10px]"
							value={storeSpeakerNames[speaker] ?? `Speaker ${index + 1}`}
							onChange={(e) => handleRenameSpeaker(speaker, e.target.value)}
							placeholder={`Speaker ${index + 1}`}
						/>
						<Button
							variant="outline"
							size="sm"
							className="h-7 px-2 text-[9px] capitalize shrink-0 w-16"
							onClick={() => cyclePosition(speaker)}
							title="Cycle caption position for this speaker"
						>
							{speakerPositions[speaker] ?? "center"}
						</Button>
					</div>
				))}
			</div>

			<div className="px-4 py-3 space-y-2 border-b">
				<div className="flex flex-col gap-1.5">
					<Label className="text-[11px] text-muted-foreground">
						Caption style
					</Label>
					<Select
						value={captionPreset}
						onValueChange={(value) =>
							setCaptionPreset(value as CaptionPresetId)
						}
					>
						<SelectTrigger className="h-8">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{CAPTION_PRESETS.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none">
					<input
						type="checkbox"
						className="accent-primary"
						checked={mergeConsecutive}
						onChange={(e) => setMergeConsecutive(e.target.checked)}
					/>
					Merge consecutive lines from the same speaker
				</label>
			</div>

			<ScrollArea className="flex-1 min-h-0">
				<div className="px-4 py-3 space-y-1">
					{captionSegments.map((seg) => (
						<div
							key={`${seg.speaker}-${seg.start}-${seg.end}`}
							className="rounded border p-2 space-y-1"
							style={{ borderLeftColor: seg.speakerColor, borderLeftWidth: 3 }}
						>
							<div className="flex items-center gap-1.5">
								<span
									className="text-[9px] font-medium"
									style={{ color: seg.speakerColor }}
								>
									{seg.speakerLabel}
								</span>
								<span className="text-[8px] text-muted-foreground font-mono">
									{seg.start.toFixed(1)}s — {seg.end.toFixed(1)}s
								</span>
							</div>
							<p className="text-[10px] text-muted-foreground">{seg.text}</p>
						</div>
					))}
				</div>
			</ScrollArea>

			<div className="px-4 py-3 border-t space-y-1.5">
				<Button size="sm" className="w-full" onClick={handleApplyToTimeline}>
					{appliedTrackId ? "Re-apply" : "Apply"} {captionSegments.length}{" "}
					Speaker Captions
				</Button>
				{appliedTrackId && (
					<Button
						size="sm"
						variant="outline"
						className="w-full text-destructive hover:text-destructive"
						onClick={removeAppliedTrack}
					>
						Remove caption track
					</Button>
				)}
			</div>
		</div>
	);
}
