"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import {
	aiClient,
	AIClientError,
	type EngagementScoreResult,
} from "@/lib/ai-client";
import { useEngagementStore } from "@/stores/engagement-store";
import { useTranscriptStore } from "@/stores/transcript-store";
import { ScoreBreakdown } from "./score-breakdown";
import { EngagementScoreHeadline } from "./engagement-score-headline";
import { toast } from "sonner";

/**
 * The subset of a clip window this panel can hand a scorer: whatever the
 * editor currently knows about the transcript on the timeline. No
 * `audio_path`/`video_path` — those are for callers that already have a
 * file on a server, which the editor doesn't.
 */
export interface EngagementScoreParams {
	transcript_text: string;
	start: number;
	end: number;
	title?: string;
}

/**
 * Turns a clip window into an engagement score. The panel doesn't care
 * where the number comes from — see `defaultScoreFn` below for the
 * current source, and the `scoreFn` prop for how to swap it out.
 */
export type EngagementScoreFn = (
	params: EngagementScoreParams,
) => Promise<EngagementScoreResult>;

/**
 * Default scorer: the Python ai-backend via `aiClient.engagementScore`
 * (localhost:8420 in dev). This backend is NOT deployed to production
 * (see docs/PROD-READINESS.md), so it only works when it's running
 * locally — see the `AIClientError` handling in `handleCheck` below for
 * how that's surfaced. A Higgsfield model-based video scorer will plug in
 * here later by passing a different `scoreFn` — this panel's UI and state
 * wiring don't need to change for that.
 */
const defaultScoreFn: EngagementScoreFn = (params) =>
	aiClient.engagementScore(params);

/**
 * Engagement Score panel for the editor.
 *
 * Allows users to check their video's engagement score at any time
 * during editing or before export. Works with any video on the timeline.
 */
export function EngagementPanel({
	className,
	scoreFn = defaultScoreFn,
}: {
	className?: string;
	/** Injectable scoring function; defaults to the local ai-backend. */
	scoreFn?: EngagementScoreFn;
}) {
	const score = useEngagementStore((s) => s.currentScore);
	const previousScore = useEngagementStore((s) => s.previousScore);
	const isAnalyzing = useEngagementStore((s) => s.isAnalyzing);
	const error = useEngagementStore((s) => s.error);
	const errorKind = useEngagementStore((s) => s.errorKind);
	const errorDetail = useEngagementStore((s) => s.errorDetail);
	const setScore = useEngagementStore((s) => s.setScore);
	const setAnalyzing = useEngagementStore((s) => s.setAnalyzing);
	const setError = useEngagementStore((s) => s.setError);
	const clear = useEngagementStore((s) => s.clear);
	const lastAnalyzedAt = useEngagementStore((s) => s.lastAnalyzedAt);

	const segments = useTranscriptStore((s) => s.segments);

	const handleCheck = useCallback(async () => {
		setAnalyzing(true);

		try {
			// Use real transcript from the editor if available
			const transcriptText =
				segments.length > 0 ? segments.map((s) => s.text).join(" ") : "";

			const lastEnd =
				segments.length > 0 ? Math.max(...segments.map((s) => s.end)) : 30;

			const result = await scoreFn({
				transcript_text: transcriptText || "No transcript available",
				start: 0,
				end: lastEnd,
				title: "Current Project",
			});
			setScore(result);
			toast.success(
				`Engagement Score: ${result.grade} (${Math.round(result.composite)}/100)`,
			);
		} catch (e) {
			// A connection/timeout AIClientError means the scorer (the local
			// ai-backend, by default) simply isn't reachable — expected outside
			// of local dev, not a bug. Show a calm heads-up instead of the raw
			// error text; anything else is a real failure.
			if (
				e instanceof AIClientError &&
				(e.errorType === "connection_refused" || e.errorType === "timeout")
			) {
				setError(
					"Local scoring needs the AI backend running. Start it and try again.",
					"backend_unavailable",
				);
			} else {
				// Never surface the raw exception text as primary copy — collapse
				// it behind "Technical details" and lead with a calm, generic line.
				const detail = e instanceof Error ? e.message : String(e);
				setError(
					"Couldn't score this cut right now. Try again in a moment.",
					"generic",
					detail,
				);
			}
			toast.error("Failed to check engagement score");
		} finally {
			setAnalyzing(false);
		}
	}, [segments, scoreFn, setScore, setAnalyzing, setError]);

	return (
		<div className={className}>
			<div className="space-y-4 p-1">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-semibold">Engagement Score</h3>
					{score && (
						<Button
							variant="ghost"
							size="sm"
							className="text-xs h-7"
							onClick={clear}
						>
							Clear
						</Button>
					)}
				</div>

				<p className="text-xs text-muted-foreground">
					Check how engaging your video is before publishing. Get a score with
					actionable suggestions.
				</p>

				{/* Nothing scored yet */}
				{!score && !isAnalyzing && !error && (
					<Button className="w-full" onClick={handleCheck}>
						Check Engagement Score
					</Button>
				)}

				{/* Scoring in progress, first-ever check — nothing to hold on
				    screen yet, so a plain spinner line is the honest state. */}
				{isAnalyzing && !score && (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner className="h-4 w-4" />
						<span>Analyzing engagement...</span>
					</div>
				)}

				{/* Scoring in progress, re-check — hold the previous headline
				    number on screen (dimmed) right up to the reveal, instead of
				    replacing it with a bare spinner. That hold-then-reveal beat
				    is the whole point: the number visibly changes, not just
				    appears. */}
				{isAnalyzing && score && (
					<EngagementScoreHeadline current={score} analyzing />
				)}

				{/* Error — backend_unavailable is an expected, calm state (the
				    local ai-backend just isn't running), so it gets the same
				    yellow "heads up" treatment used elsewhere in the editor
				    instead of alarming red. Any other failure gets a friendly,
				    non-technical line up front; the raw detail (never a
				    provider/env/path name) is collapsed behind "Technical
				    details" rather than shown by default. */}
				{error && (
					<div className="space-y-2">
						<div
							className={cn(
								"rounded-lg border p-3",
								errorKind === "backend_unavailable"
									? "border-yellow-500/30 bg-yellow-500/5"
									: "border-red-500/30 bg-red-500/5",
							)}
						>
							<p
								className={cn(
									"text-xs",
									errorKind === "backend_unavailable"
										? "text-yellow-500 font-medium"
										: "text-red-400",
								)}
							>
								{error}
							</p>
							{errorKind === "generic" && errorDetail && (
								<details className="mt-1.5">
									<summary className="cursor-pointer select-none text-[10px] text-muted-foreground/60">
										Technical details
									</summary>
									<p className="mt-1 break-words text-[10px] text-muted-foreground/60">
										{errorDetail}
									</p>
								</details>
							)}
						</div>
						<Button variant="outline" size="sm" onClick={handleCheck}>
							Retry
						</Button>
					</div>
				)}

				{/* Scored — the headline number leads (this is what the eye
				    should land on first), the breakdown stays one glance away. */}
				{score && !isAnalyzing && (
					<>
						<EngagementScoreHeadline current={score} previous={previousScore} />

						{/* Verdict banner */}
						<div className="rounded-lg border p-3 text-center space-y-1">
							{score.composite >= 70 ? (
								<>
									<p className="text-sm font-medium text-green-400">
										Ready to publish!
									</p>
									<p className="text-xs text-muted-foreground">
										Your video has strong engagement potential.
									</p>
								</>
							) : score.composite >= 50 ? (
								<>
									<p className="text-sm font-medium text-yellow-400">
										Good, but could improve
									</p>
									<p className="text-xs text-muted-foreground">
										Check the suggestions below.
									</p>
								</>
							) : (
								<>
									<p className="text-sm font-medium text-red-400">Needs work</p>
									<p className="text-xs text-muted-foreground">
										Apply the suggestions to boost engagement.
									</p>
								</>
							)}
						</div>

						<ScoreBreakdown
							score={score}
							segments={segments}
							duration={
								segments.length > 0
									? Math.max(...segments.map((s) => s.end))
									: undefined
							}
						/>

						{lastAnalyzedAt && (
							<p className="text-[10px] text-muted-foreground text-right">
								Checked {new Date(lastAnalyzedAt).toLocaleTimeString()}
							</p>
						)}

						<Button variant="outline" className="w-full" onClick={handleCheck}>
							Re-check Score
						</Button>
					</>
				)}
			</div>
		</div>
	);
}
