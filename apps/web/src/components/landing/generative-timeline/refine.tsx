import { ActSection } from "./act-section";
import { Reveal } from "./reveal";
import { cn } from "@/utils/ui";

/**
 * Act 02 — Refine. Vision self-review: the critic judges actual frames
 * (motion/temporal defects, cross-shot continuity) and auto-corrects
 * with reroll/remix under a cost gate. Takes-as-versions.
 */

const VERDICTS = [
	{
		verdict: "PASS",
		tone: "emerald",
		shot: "SHOT 01 · TAKE 1",
		note: "Motion coherent. Matches StyleBible.",
	},
	{
		verdict: "REROLL",
		tone: "amber",
		shot: "SHOT 03 · TAKE 1",
		note: "Temporal defect — subject flickers between frames.",
	},
	{
		verdict: "REMIX",
		tone: "sky",
		shot: "SHOT 04 · TAKE 1",
		note: "Continuity drift from shot 03 — re-anchoring on its final frame.",
	},
] as const;

const POINTS = [
	{
		title: "Motion, not stills",
		body: "The critic pulls a take's actual frames and judges movement across them — temporal defects that a single thumbnail would never show.",
	},
	{
		title: "Cross-shot continuity",
		body: "Each shot is checked against the one before it and against the StyleBible, so the sequence holds together as a whole — not just shot by shot.",
	},
	{
		title: "Takes as versions",
		body: "Every generated clip on the timeline keeps its takes. Swap one in place — the cut, the trims, and everything downstream stay exactly where they were.",
	},
];

export function Refine() {
	return (
		<ActSection
			id="refine"
			index="02"
			act="Refine"
			title="It watches its own takes."
			lead="A vision critic reviews the actual frames of every take — the pixels, not the prompt. Verdicts are pass, reroll, or remix, and corrections run automatically, bounded by a cost gate you control."
		>
			<div className="grid gap-4 md:grid-cols-3">
				{VERDICTS.map((v, i) => (
					<Reveal key={v.shot} delay={i * 0.08}>
						<div className="rounded-xl border border-border/70 bg-card/50 p-5">
							{/* Frame strip */}
							<div aria-hidden className="flex gap-1">
								{[0, 1, 2, 3].map((f) => (
									<div
										key={f}
										className={cn(
											"h-10 flex-1 rounded-sm border bg-gradient-to-br",
											v.tone === "amber" && f === 2
												? "border-amber-400/70 from-slate-500/40 to-slate-800/60"
												: "border-white/10 from-sky-600/30 to-indigo-900/40",
										)}
									/>
								))}
							</div>
							<div className="mt-4 flex items-center justify-between">
								<span className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground">
									{v.shot}
								</span>
								<span
									className={cn(
										"rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-widest",
										v.tone === "emerald" &&
											"bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
										v.tone === "amber" &&
											"bg-amber-500/15 text-amber-600 dark:text-amber-400",
										v.tone === "sky" && "bg-primary/15 text-primary",
									)}
								>
									{v.verdict}
								</span>
							</div>
							<p className="mt-2.5 text-pretty text-sm leading-relaxed text-muted-foreground">
								{v.note}
							</p>
						</div>
					</Reveal>
				))}
			</div>

			<div className="mt-12 grid gap-x-10 gap-y-8 md:grid-cols-3">
				{POINTS.map((point, i) => (
					<Reveal key={point.title} delay={i * 0.08}>
						<div className="border-l-2 border-primary/40 pl-5">
							<h3 className="font-semibold tracking-tight">{point.title}</h3>
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
