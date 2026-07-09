"use client";

import { useMemo } from "react";
import { cn } from "@/utils/ui";
import type { EngagementScoreResult } from "@/lib/ai-client";
import type { TranscriptionSegment } from "@/types/ai";
import { deriveDiagnostics } from "@/lib/engagement-diagnostics";
import { EngagementDiagnosticsView } from "./engagement-diagnostics";

const GRADE_COLORS: Record<string, string> = {
	A: "text-green-400",
	B: "text-blue-400",
	C: "text-yellow-400",
	D: "text-orange-400",
	F: "text-red-400",
};

const SCORE_LABELS: Record<string, string> = {
	hook: "Hook Strength",
	curiosity: "Curiosity Gap",
	energy: "Audio Energy",
	audio_sync: "Beat Sync",
	face_presence: "Face Presence",
	emotional_arc: "Emotional Arc",
	virality: "Viral Potential",
};

export function ScoreBreakdown({
	score,
	segments,
	duration,
}: {
	score: EngagementScoreResult;
	/** Optional transcript segments — enables a timeline-aligned attention heatmap. */
	segments?: TranscriptionSegment[];
	duration?: number;
}) {
	const entries = Object.entries(SCORE_LABELS);

	// Diagnostic reframe: lead with Hook / Hold rate / Attention + heatmap.
	const diagnostics = useMemo(
		() => deriveDiagnostics({ result: score, segments, duration }),
		[score, segments, duration],
	);

	return (
		<div className="space-y-3">
			{/* Diagnostic dimensions + attention heatmap lead */}
			<EngagementDiagnosticsView diagnostics={diagnostics} />

			{/* Overall grade (summary) */}
			<div className="flex items-center justify-between border-t border-border/50 pt-2">
				<span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
					Overall
				</span>
				<div className="flex items-baseline gap-2">
					<span className={cn("text-lg font-bold", GRADE_COLORS[score.grade])}>
						{score.grade}
					</span>
					<span className="text-sm font-semibold">{Math.round(score.composite)}</span>
					<span className="text-[10px] text-muted-foreground">/100</span>
				</div>
			</div>

			{/* Raw signal bars */}
			<div className="space-y-1.5">
				{entries.map(([key, label]) => {
					const sub = score[key as keyof EngagementScoreResult];
					const val = typeof sub === "object" && sub !== null && "composite" in sub
						? (sub as { composite: number }).composite
						: 0;

					return (
						<div key={key} className="flex items-center gap-2">
							<span className="text-[10px] text-muted-foreground w-20 flex-shrink-0 truncate">
								{label}
							</span>
							<div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
								<div
									className={cn(
										"h-full rounded-full transition-all",
										val >= 70 ? "bg-green-500" : val >= 40 ? "bg-yellow-500" : "bg-red-500",
									)}
									style={{ width: `${val}%` }}
								/>
							</div>
							<span className="text-[10px] text-muted-foreground w-6 text-right">
								{Math.round(val)}
							</span>
						</div>
					);
				})}
			</div>

			{/* Suggestions */}
			{score.suggestions.length > 0 && (
				<div className="space-y-1.5 pt-2 border-t border-border/50">
					<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
						Suggestions
					</span>
					{score.suggestions.map((s, i) => (
						<div key={i} className="flex items-start gap-1.5">
							<span className={cn(
								"mt-0.5 h-1.5 w-1.5 rounded-full flex-shrink-0",
								s.expected_impact === "high" ? "bg-red-400" : "bg-yellow-400",
							)} />
							<p className="text-xs text-muted-foreground">{s.suggestion}</p>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
