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
import type { EditorCore } from "@/core";
import { analyzeMediaSilence } from "@/lib/auto-cut";
import type { EditSegment } from "@/lib/auto-cut";
import { applyAutoCut, planAutoCut } from "@/lib/auto-cut/apply";
import type { TimelineElement } from "@/types/timeline";

/**
 * Auto-cut (silence removal) dialog for a single timeline clip. Threshold +
 * before/after margins are pre-filled from the engine's contract defaults; the
 * remaining smoothing knobs (minKeep/minCut) fall through to the engine.
 *
 * Analyze → decode the clip's audio and report "N silent sections, M s" for the
 * clip's VISIBLE span, then Apply hard-cuts them as one undoable step. Kept lean
 * on purpose: no settings persistence, one dialog.
 */

// Mirrors the AutoCutOptions defaults documented in lib/auto-cut/types.ts.
const DEFAULTS = { threshold: 0.04, marginBefore: 0.2, marginAfter: 0.3 };

type Phase = "idle" | "analyzing" | "analyzed";

interface Preview {
	removedCount: number;
	removedSeconds: number;
}

export function RemoveSilenceDialog({
	isOpen,
	onOpenChange,
	editor,
	element,
	mediaFile,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	editor: EditorCore;
	element: TimelineElement;
	mediaFile: File;
}) {
	const [threshold, setThreshold] = useState(DEFAULTS.threshold);
	const [marginBefore, setMarginBefore] = useState(DEFAULTS.marginBefore);
	const [marginAfter, setMarginAfter] = useState(DEFAULTS.marginAfter);
	const [phase, setPhase] = useState<Phase>("idle");
	const [preview, setPreview] = useState<Preview | null>(null);
	const [segments, setSegments] = useState<EditSegment[] | null>(null);

	const handleOpenChange = (open: boolean) => {
		if (open) {
			setThreshold(DEFAULTS.threshold);
			setMarginBefore(DEFAULTS.marginBefore);
			setMarginAfter(DEFAULTS.marginAfter);
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
			// Preview against the live timeline so the count reflects the clip's
			// current trims (planAutoCut is pure — no mutation here).
			const plan = planAutoCut({
				tracks: editor.timeline.getTracks(),
				elementId: element.id,
				segments: analysis.segments,
			});
			setSegments(analysis.segments);
			setPreview(
				plan
					? {
							removedCount: plan.summary.removedCount,
							removedSeconds: plan.summary.removedSeconds,
						}
					: { removedCount: 0, removedSeconds: 0 },
			);
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
				toast.info("No silence to remove in this clip.");
			} else {
				toast.success(
					`Removed ${summary.removedCount} silent section${
						summary.removedCount === 1 ? "" : "s"
					} (${summary.removedSeconds.toFixed(1)}s).`,
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

					{phase === "analyzed" && preview && (
						<div className="text-sm">
							{preview.removedCount > 0 ? (
								<span>
									<span className="font-medium text-foreground">
										{preview.removedCount}
									</span>{" "}
									silent section{preview.removedCount === 1 ? "" : "s"} —{" "}
									<span className="font-medium text-foreground">
										{preview.removedSeconds.toFixed(1)}s
									</span>{" "}
									to remove.
								</span>
							) : (
								<span className="text-muted-foreground">
									No silence found with these settings.
								</span>
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
