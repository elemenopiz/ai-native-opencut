"use client";

import { cn } from "@/utils/ui";
import type {
	DimensionRating,
	EngagementDiagnostics,
} from "@/lib/engagement-diagnostics";
import { formatTimecode } from "@/lib/engagement-diagnostics";

const RATING_TEXT: Record<DimensionRating, string> = {
	strong: "text-green-400",
	ok: "text-yellow-400",
	weak: "text-red-400",
};

const RATING_BG: Record<DimensionRating, string> = {
	strong: "border-green-500/30 bg-green-500/5",
	ok: "border-yellow-500/30 bg-yellow-500/5",
	weak: "border-red-500/30 bg-red-500/5",
};

const RATING_LABEL: Record<DimensionRating, string> = {
	strong: "Strong",
	ok: "Okay",
	weak: "Weak",
};

/** Attention (0-100) → red→amber→green hue. */
function attentionColor(a: number): string {
	const hue = Math.round((a / 100) * 120); // 0 = red, 120 = green
	return `hsl(${hue} 70% 45%)`;
}

function DimensionCard({
	label,
	score,
	rating,
	verdict,
}: {
	label: string;
	score: number;
	rating: DimensionRating;
	verdict: string;
}) {
	return (
		<div className={cn("rounded-lg border p-3 space-y-1", RATING_BG[rating])}>
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
					{label}
				</span>
				<span className={cn("text-[10px] font-medium", RATING_TEXT[rating])}>
					{RATING_LABEL[rating]}
				</span>
			</div>
			<div className={cn("text-2xl font-bold leading-none", RATING_TEXT[rating])}>
				{score}
				<span className="text-xs font-normal text-muted-foreground">/100</span>
			</div>
			<p className="text-[11px] leading-snug text-muted-foreground">{verdict}</p>
		</div>
	);
}

/**
 * Attention heatmap + estimated retention curve, aligned to the timeline.
 * The colored band shows per-moment attention; the overlaid line is the
 * estimated retention curve; red ticks mark likely drop-off points.
 */
function HeatmapChart({ diagnostics }: { diagnostics: EngagementDiagnostics }) {
	const { heatmap, holdRate } = diagnostics;
	const { segments, duration } = heatmap;
	if (segments.length === 0 || duration <= 0) return null;

	const W = 320;
	const H = 60;
	const x = (t: number) => (t / duration) * W;

	// Retention curve path.
	const points = holdRate.curve.map((c) => `${x(c.time).toFixed(1)},${(H - (c.retention / 100) * H).toFixed(1)}`);
	const linePath = points.length > 0 ? `M ${points.join(" L ")}` : "";

	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
					Attention heatmap
				</span>
				<span className="text-[10px] text-muted-foreground">
					{heatmap.timed ? "aligned to timeline" : "estimated"}
				</span>
			</div>

			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="w-full h-16 rounded-md overflow-hidden"
				preserveAspectRatio="none"
				role="img"
				aria-label="Attention heatmap and retention curve"
			>
				{/* Heatmap bands */}
				{segments.map((s, i) => (
					<rect
						key={i}
						x={x(s.start)}
						y={0}
						width={Math.max(0.5, x(s.end) - x(s.start))}
						height={H}
						fill={attentionColor(s.attention)}
						opacity={0.85}
					>
						<title>{`${formatTimecode(s.start)} — attention ${s.attention}/100${s.label ? `\n"${s.label}"` : ""}`}</title>
					</rect>
				))}

				{/* Retention curve */}
				{linePath && (
					<path
						d={linePath}
						fill="none"
						stroke="white"
						strokeWidth={1.5}
						strokeLinejoin="round"
						opacity={0.9}
						vectorEffect="non-scaling-stroke"
					/>
				)}

				{/* Drop-off markers */}
				{holdRate.dropoffs.map((d, i) => (
					<line
						key={i}
						x1={x(d.time)}
						y1={0}
						x2={x(d.time)}
						y2={H}
						stroke="#f87171"
						strokeWidth={1.5}
						strokeDasharray="3 2"
						vectorEffect="non-scaling-stroke"
					/>
				))}
			</svg>

			{/* Axis */}
			<div className="flex justify-between text-[9px] text-muted-foreground">
				<span>0:00</span>
				<span>{formatTimecode(duration / 2)}</span>
				<span>{formatTimecode(duration)}</span>
			</div>
		</div>
	);
}

/**
 * Diagnostic view: leads with the three actionable dimensions (Hook, Hold Rate,
 * Attention) and the attention heatmap, so a creator sees *what* to fix rather
 * than a single grade.
 */
export function EngagementDiagnosticsView({
	diagnostics,
}: {
	diagnostics: EngagementDiagnostics;
}) {
	const { hook, holdRate, heatmap } = diagnostics;
	const peakAttention =
		heatmap.segments.reduce((m, s) => Math.max(m, s.attention), 0);

	return (
		<div className="space-y-3">
			{/* Three dimensions */}
			<div className="grid grid-cols-3 gap-2">
				<DimensionCard label="Hook" score={hook.score} rating={hook.rating} verdict={hook.verdict} />
				<DimensionCard
					label="Hold rate"
					score={holdRate.score}
					rating={holdRate.rating}
					verdict={holdRate.verdict}
				/>
				<DimensionCard
					label="Attention"
					score={peakAttention}
					rating={
						peakAttention >= 65 ? "strong" : peakAttention >= 45 ? "ok" : "weak"
					}
					verdict={`Peaks at ${formatTimecode(heatmap.peakTime)}, dips at ${formatTimecode(heatmap.valleyTime)}.`}
				/>
			</div>

			{/* Heatmap + retention curve */}
			<HeatmapChart diagnostics={diagnostics} />

			{/* Drop-off callouts */}
			{holdRate.dropoffs.length > 0 && (
				<div className="space-y-1">
					<span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
						Likely drop-off points
					</span>
					{holdRate.dropoffs.map((d, i) => (
						<div key={i} className="flex items-start gap-1.5 text-[11px]">
							<span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-400" />
							<p className="text-muted-foreground">
								<span className="font-medium text-foreground">{formatTimecode(d.time)}</span> — {d.reason}
								<span className="text-muted-foreground/70"> (~{d.retention}% still watching)</span>
							</p>
						</div>
					))}
				</div>
			)}

			{/* Hook issues */}
			{hook.issues.length > 0 && (
				<div className="space-y-1">
					<span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
						Fix your hook
					</span>
					{hook.issues.map((issue, i) => (
						<div key={i} className="flex items-start gap-1.5 text-[11px]">
							<span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-yellow-400" />
							<p className="text-muted-foreground">{issue}</p>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
