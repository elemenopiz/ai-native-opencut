import { ActSection } from "./act-section";
import { Reveal } from "./reveal";

/**
 * Honest value section: credit-based metering, cost shown before
 * generation, budget-gated auto-correction. No invented tiers.
 */

const POINTS = [
	{
		title: "Credits meter generation",
		body: "Editing is just editing. Credits are spent when models render — takes, voiceover, music — and on nothing else.",
	},
	{
		title: "Costs shown before you commit",
		body: "Every generation shows its estimated cost up front. Above your approval threshold, Byorn asks before it spends.",
	},
	{
		title: "Autopilot on a budget",
		body: "The Director's automatic rerolls and remixes run inside a cost gate you set. It fixes takes — it doesn't run a tab.",
	},
];

export function Value() {
	return (
		<ActSection
			id="value"
			index="05"
			act="Value"
			title="Pay for what you generate."
			lead="Byorn is credit-based, and deliberately boring about it: you see what a generation costs before it runs, and anything automatic stays inside a budget you set."
		>
			<div className="grid gap-6 md:grid-cols-3">
				{POINTS.map((point, i) => (
					<Reveal key={point.title} delay={i * 0.08}>
						<div className="h-full rounded-xl border border-border/70 bg-card/50 p-6">
							<span
								aria-hidden
								className="font-mono text-[10px] tracking-[0.25em] text-primary/70"
							>
								{String(i + 1).padStart(2, "0")}
							</span>
							<h3 className="mt-3 font-semibold tracking-tight">
								{point.title}
							</h3>
							<p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
								{point.body}
							</p>
						</div>
					</Reveal>
				))}
			</div>
		</ActSection>
	);
}
