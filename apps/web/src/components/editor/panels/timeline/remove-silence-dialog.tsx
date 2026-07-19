"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { EditorCore } from "@/core";
import { analyzeMediaSilence } from "@/lib/auto-cut";
import type { EditSegment } from "@/lib/auto-cut";
import { applyAutoCut, planAutoCut } from "@/lib/auto-cut/apply";
import {
	DEFAULT_FILLER_WORDS,
	detectFalseStarts,
	detectFillers,
	OPTIONAL_FILLER_WORDS,
} from "@/lib/auto-cut/filler-detect";
import {
	buildSmartCleanupPlan,
	summarizeSmartCleanup,
} from "@/lib/auto-cut/smart-cleanup";
// Read-only reuse of the Director's synchronous transcript cache — the same
// seam `getTranscript` and the asset manifest's speech facet read through
// (see lib/director/transcript-lookup.ts's file doc). Not a Director-internals
// edit: this dialog only ever reads it.
import { assetTranscriptLookup } from "@/lib/director/transcript-lookup";
import type { TimelineElement } from "@/types/timeline";

/**
 * Auto-cut (silence removal + transcript-aware smart cleanup) dialog for a
 * single timeline clip. Threshold + before/after margins are pre-filled from
 * the engine's contract defaults; the remaining smoothing knobs (minKeep/
 * minCut) fall through to the engine.
 *
 * Analyze → decode the clip's audio for silence, and — when the clip's media
 * has a transcript AND at least one smart-cleanup toggle is on — layer in
 * filler-word / false-start cut ranges from `lib/auto-cut/filler-detect.ts`,
 * merged via `lib/auto-cut/smart-cleanup.ts#buildSmartCleanupPlan`. Report
 * "N silent sections, M filler words, ... — X s" for the clip's VISIBLE span,
 * then Apply hard-cuts them as one undoable step.
 *
 * With both smart-cleanup toggles OFF (their default), the merge step is
 * skipped entirely — behavior is byte-identical to the silence-only dialog
 * that shipped before this (see `smart-cleanup.test.ts` for the pure-logic
 * proof of that identity).
 */

// Mirrors the AutoCutOptions defaults documented in lib/auto-cut/types.ts.
const DEFAULTS = { threshold: 0.04, marginBefore: 0.2, marginAfter: 0.3 };

type Phase = "idle" | "analyzing" | "analyzed";

interface Preview {
	removedCount: number;
	removedSeconds: number;
	fillerCount: number;
	falseStartCount: number;
	undetectableFillerCount: number;
}

export function RemoveSilenceDialog({
	isOpen,
	onOpenChange,
	editor,
	element,
	mediaFile,
	mediaId,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	editor: EditorCore;
	element: TimelineElement;
	mediaFile: File;
	/** The clip's media asset id — used to look up a transcript (if any) for
	 *  filler/false-start detection. Smart-cleanup toggles are disabled when
	 *  omitted or when the asset hasn't been transcribed. */
	mediaId?: string;
}) {
	const [threshold, setThreshold] = useState(DEFAULTS.threshold);
	const [marginBefore, setMarginBefore] = useState(DEFAULTS.marginBefore);
	const [marginAfter, setMarginAfter] = useState(DEFAULTS.marginAfter);
	const [removeFillers, setRemoveFillers] = useState(false);
	const [removeFalseStarts, setRemoveFalseStarts] = useState(false);
	const [includeLike, setIncludeLike] = useState(false);
	const [phase, setPhase] = useState<Phase>("idle");
	const [preview, setPreview] = useState<Preview | null>(null);
	const [segments, setSegments] = useState<EditSegment[] | null>(null);

	const transcript = mediaId ? assetTranscriptLookup(mediaId) : undefined;
	const hasTranscriptSegments = !!transcript && transcript.segments.length > 0;

	const handleOpenChange = (open: boolean) => {
		if (open) {
			setThreshold(DEFAULTS.threshold);
			setMarginBefore(DEFAULTS.marginBefore);
			setMarginAfter(DEFAULTS.marginAfter);
			setRemoveFillers(false);
			setRemoveFalseStarts(false);
			setIncludeLike(false);
			setPhase("idle");
			setPreview(null);
			setSegments(null);
		}
		onOpenChange(open);
	};

	async function handleAnalyze() {
		setPhase("analyzing");
		setPreview(null);
		setSegments(null);
		try {
			const analysis = await analyzeMediaSilence(mediaFile, {
				threshold,
				marginBefore,
				marginAfter,
			});

			let finalSegments: EditSegment[] = analysis.segments;
			let fillerCount = 0;
			let falseStartCount = 0;
			let undetectableFillerCount = 0;

			if ((removeFillers || removeFalseStarts) && hasTranscriptSegments) {
				// biome-ignore lint/style/noNonNullAssertion: guarded by hasTranscriptSegments above.
				const transcriptSegments = transcript!.segments;
				const wordList = includeLike
					? [...DEFAULT_FILLER_WORDS, ...OPTIONAL_FILLER_WORDS]
					: [...DEFAULT_FILLER_WORDS];

				const fillerResult = removeFillers
					? detectFillers(transcriptSegments, { wordList })
					: { ranges: [], undetectableFillerCount: 0 };
				const falseStartRanges = removeFalseStarts
					? detectFalseStarts(transcriptSegments)
					: [];

				const extraCuts = [...fillerResult.ranges, ...falseStartRanges];
				finalSegments = buildSmartCleanupPlan(analysis.segments, extraCuts);

				const counts = summarizeSmartCleanup(
					extraCuts,
					fillerResult.undetectableFillerCount,
				);
				fillerCount = counts.fillerCount;
				falseStartCount = counts.falseStartCount;
				undetectableFillerCount = counts.undetectableFillerCount;
			}

			// Preview against the live timeline so the count reflects the clip's
			// current trims (planAutoCut is pure — no mutation here).
			const plan = planAutoCut({
				tracks: editor.timeline.getTracks(),
				elementId: element.id,
				segments: finalSegments,
			});
			setSegments(finalSegments);
			setPreview({
				removedCount: plan?.summary.removedCount ?? 0,
				removedSeconds: plan?.summary.removedSeconds ?? 0,
				fillerCount,
				falseStartCount,
				undetectableFillerCount,
			});
			setPhase("analyzed");
		} catch (err) {
			setPhase("idle");
			toast.error(
				err instanceof Error
					? err.message
					: "Couldn't analyze this clip for silence.",
			);
		}
	}

	function handleApply() {
		if (!segments) return;
		try {
			const summary = applyAutoCut({
				editor,
				elementId: element.id,
				segments,
			});
			if (!summary || summary.removedCount === 0) {
				toast.info("Nothing to remove in this clip.");
			} else {
				const extras: string[] = [];
				if (preview?.fillerCount) {
					extras.push(
						`${preview.fillerCount} filler word${preview.fillerCount === 1 ? "" : "s"}`,
					);
				}
				if (preview?.falseStartCount) {
					extras.push(
						`${preview.falseStartCount} false start${preview.falseStartCount === 1 ? "" : "s"}`,
					);
				}
				const extraText = extras.length ? ` (incl. ${extras.join(", ")})` : "";
				toast.success(
					`Removed ${summary.removedCount} section${
						summary.removedCount === 1 ? "" : "s"
					}${extraText} (${summary.removedSeconds.toFixed(1)}s).`,
				);
			}
			onOpenChange(false);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't remove silence.",
			);
		}
	}

	const analyzing = phase === "analyzing";
	const canApply =
		phase === "analyzed" && !!preview && preview.removedCount > 0;

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Remove silence</DialogTitle>
				</DialogHeader>

				<DialogBody className="gap-3">
					<div className="text-xs text-muted-foreground">
						Detect and hard-cut dead air from{" "}
						<span className="font-medium text-foreground">{element.name}</span>.
						Downstream clips slide left to close the gaps.
					</div>

					<div className="grid grid-cols-3 gap-2">
						<div>
							<Label htmlFor="rs-threshold" className="text-xs">
								Threshold
							</Label>
							<Input
								id="rs-threshold"
								type="number"
								min={0}
								max={1}
								step={0.01}
								value={threshold}
								onChange={(e) => setThreshold(Number(e.target.value))}
								className="mt-1"
							/>
						</div>
						<div>
							<Label htmlFor="rs-before" className="text-xs">
								Pad before (s)
							</Label>
							<Input
								id="rs-before"
								type="number"
								min={0}
								step={0.05}
								value={marginBefore}
								onChange={(e) => setMarginBefore(Number(e.target.value))}
								className="mt-1"
							/>
						</div>
						<div>
							<Label htmlFor="rs-after" className="text-xs">
								Pad after (s)
							</Label>
							<Input
								id="rs-after"
								type="number"
								min={0}
								step={0.05}
								value={marginAfter}
								onChange={(e) => setMarginAfter(Number(e.target.value))}
								className="mt-1"
							/>
						</div>
					</div>

					<div className="flex flex-col gap-2 rounded-md border border-border p-2">
						<div className="flex items-center justify-between gap-2">
							<Label htmlFor="rs-fillers" className="text-xs font-normal">
								Remove filler words (um, uh, you know…)
							</Label>
							<Switch
								id="rs-fillers"
								checked={removeFillers}
								onCheckedChange={setRemoveFillers}
								disabled={!hasTranscriptSegments}
							/>
						</div>
						{removeFillers && hasTranscriptSegments && (
							<div className="flex items-center justify-between gap-2 pl-1">
								<Label
									htmlFor="rs-like"
									className="text-xs font-normal text-muted-foreground"
								>
									Also cut "like" (riskier — many non-filler uses)
								</Label>
								<Switch
									id="rs-like"
									checked={includeLike}
									onCheckedChange={setIncludeLike}
								/>
							</div>
						)}
						<div className="flex items-center justify-between gap-2">
							<Label htmlFor="rs-false-starts" className="text-xs font-normal">
								Remove false starts (low-confidence)
							</Label>
							<Switch
								id="rs-false-starts"
								checked={removeFalseStarts}
								onCheckedChange={setRemoveFalseStarts}
								disabled={!hasTranscriptSegments}
							/>
						</div>
						{!hasTranscriptSegments && (
							<div className="text-xs text-muted-foreground">
								Transcribe this clip to enable filler-word / false-start
								cleanup.
							</div>
						)}
					</div>

					{phase === "analyzed" && preview && (
						<div className="text-sm">
							{preview.removedCount > 0 ? (
								<span>
									<span className="font-medium text-foreground">
										{preview.removedCount}
									</span>{" "}
									section{preview.removedCount === 1 ? "" : "s"}
									{preview.fillerCount > 0 &&
										` (${preview.fillerCount} filler)`}
									{preview.falseStartCount > 0 &&
										` (${preview.falseStartCount} false start${preview.falseStartCount === 1 ? "" : "s"})`}
									{" — "}
									<span className="font-medium text-foreground">
										{preview.removedSeconds.toFixed(1)}s
									</span>{" "}
									to remove.
								</span>
							) : (
								<span className="text-muted-foreground">
									Nothing found with these settings.
								</span>
							)}
							{preview.undetectableFillerCount > 0 && (
								<div className="mt-1 text-xs text-muted-foreground">
									{preview.undetectableFillerCount} more filler word
									{preview.undetectableFillerCount === 1 ? "" : "s"} found
									mid-sentence — this clip's transcript only has sentence-level
									timing, so those can't be safely cut without risking real
									speech.
								</div>
							)}
						</div>
					)}
				</DialogBody>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="outline"
						onClick={handleAnalyze}
						disabled={analyzing}
					>
						{analyzing ? "Analyzing…" : "Analyze"}
					</Button>
					<Button onClick={handleApply} disabled={!canApply}>
						Apply
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
