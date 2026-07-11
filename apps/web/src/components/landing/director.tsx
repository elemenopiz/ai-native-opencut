import { cn } from "@/utils/ui";

/**
 * The Director — Byorn's flagship. Copy on the left, a faithful mock of the
 * shot plan on the right: brief → shots → takes, with real critic verdicts
 * and routing decisions. Server component, no client JS.
 */

const SHOTS = [
	{
		n: "01",
		desc: "Wide — night exterior, rain on glass",
		route: "route: quality",
		verdict: "pass",
		takes: "take 1",
		state: "pass" as const,
	},
	{
		n: "02",
		desc: "Close — hands at the desk, screen glow",
		route: "route: cost",
		verdict: "reroll-with-delta",
		takes: "take 2 ✓",
		state: "fixed" as const,
	},
	{
		n: "03",
		desc: "Match cut — same character, new scene",
		route: "route: quality",
		verdict: "remix-for-continuity",
		takes: "take 2 ✓",
		state: "fixed" as const,
	},
	{
		n: "04",
		desc: "Insert — library footage, cast by the Director",
		route: "from your library",
		verdict: "cast",
		takes: "—",
		state: "library" as const,
	},
];

const DIRECTOR_POINTS = [
	{
		title: "Shot plan from a brief",
		body: "Describe the film. The Director storyboards it into shots, reserves slots on the timeline, and generates takes for each.",
	},
	{
		title: "Vision self-review",
		body: "A critic looks at each take's actual frames — including motion defects and cross-shot continuity — and rerolls or remixes under an explicit cost gate.",
	},
	{
		title: "One interface, many models",
		body: "Cost/quality-aware routing across multiple AI video backends. You direct; the routing picks the right model per shot.",
	},
	{
		title: "References become a StyleBible",
		body: "Drop style frames or a character photo. The StyleBible seeds every shot's look; a persona keeps the character consistent.",
	},
	{
		title: "It knows your footage",
		body: "An Understanding Pass indexes your uploaded library so the Director casts real footage, not only generated clips.",
	},
];

export function DirectorSection() {
	return (
		<section className="border-t">
			<div className="mx-auto max-w-6xl px-6 py-20 md:py-28 lg:border-x lg:border-border/50 lg:px-12">
				<div className="mb-12 flex items-baseline gap-4">
					<span className="font-mono text-xs text-primary">01</span>
					<h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
						A Director that watches its own footage.
					</h2>
				</div>

				<div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16">
					{/* Copy */}
					<div className="order-2 space-y-7 lg:order-1">
						{DIRECTOR_POINTS.map((p) => (
							<div key={p.title}>
								<h3 className="text-sm font-medium">{p.title}</h3>
								<p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
									{p.body}
								</p>
							</div>
						))}
					</div>

					{/* Shot-plan mock */}
					<div className="order-1 lg:order-2">
						<div className="overflow-hidden rounded-xl border bg-card shadow-sm">
							<div className="flex h-9 items-center justify-between border-b px-3">
								<span className="font-mono text-[11px] font-medium">
									Director — shot plan
								</span>
								<span className="font-mono text-[10px] text-muted-foreground/70">
									4 shots · 7 takes
								</span>
							</div>

							<div className="border-b px-3 py-2.5">
								<p className="text-[11px] leading-snug text-muted-foreground">
									<span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground/60 uppercase">
										Brief&ensp;
									</span>
									Thirty seconds. Night exterior, one continuous mood, the same
									character throughout.
								</p>
								<div className="mt-2 flex flex-wrap items-center gap-1.5">
									<span className="rounded-[4px] border border-primary/50 px-1.5 py-0.5 font-mono text-[9px] text-foreground">
										StyleBible · tungsten, 35mm, slow push-ins
									</span>
									<span className="rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
										persona · seed-locked
									</span>
								</div>
							</div>

							<ul>
								{SHOTS.map((s) => (
									<li
										key={s.n}
										className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-x-3 border-b px-3 py-2.5 last:border-b-0"
									>
										<span className="font-mono text-[10px] text-muted-foreground/60">
											{s.n}
										</span>
										<div className="min-w-0">
											<p className="truncate text-[11px] text-foreground">
												{s.desc}
											</p>
											<p className="mt-0.5 font-mono text-[9px] text-muted-foreground/70">
												{s.route}
											</p>
										</div>
										<div className="flex items-center gap-1.5">
											<span
												className={cn(
													"rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px]",
													s.state === "pass" &&
														"border-primary/60 text-foreground",
													s.state === "fixed" &&
														"border-border text-muted-foreground",
													s.state === "library" &&
														"border-dashed border-border text-muted-foreground/70",
												)}
											>
												{s.verdict}
											</span>
											<span className="hidden font-mono text-[9px] text-muted-foreground/60 sm:inline">
												{s.takes}
											</span>
										</div>
									</li>
								))}
							</ul>

							<div className="bg-accent/40 px-3 py-2">
								<p className="font-mono text-[9px] tracking-wide text-muted-foreground/70">
									VISION REVIEW · FRAMES + MOTION + CONTINUITY · RUNS UNDER THE
									COST GATE — IT ASKS BEFORE IT SPENDS
								</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
