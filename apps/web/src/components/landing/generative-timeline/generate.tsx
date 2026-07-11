import { ActSection } from "./act-section";
import { Reveal } from "./reveal";

/**
 * Act 01 — Generate. The Director: brief → shot plan → takes,
 * seed-lock personas, StyleBible reference intake, model routing,
 * Understanding Pass. All verified shipped features.
 */

const CARDS = [
	{
		title: "StyleBible from references",
		body: "Drop in style frames or a character photo. The Director distills them into a StyleBible that seeds the look of every shot it generates — so the whole sequence reads as one film, not a grab bag of prompts.",
		figure: <StyleBibleFigure />,
	},
	{
		title: "Model routing",
		body: "One brief, many models. Cost- and quality-aware routing picks a backend per shot across multiple AI video providers, and you can compare takes side by side from a single interface.",
		figure: <RoutingFigure />,
	},
	{
		title: "Understanding Pass",
		body: "The Director casts your real footage, too. An Understanding Pass analyzes your uploaded library, so generated shots get cut against material you already have — not instead of it.",
		figure: <LibraryFigure />,
	},
];

export function Generate() {
	return (
		<ActSection
			id="generate"
			index="01"
			act="Generate"
			title="Direct footage into existence."
			lead="Give the Director a brief. It plans the shots, then generates takes for each one — routed across multiple AI video backends, seeded with your look, and cast alongside your real footage."
		>
			{/* Featured: seed-lock personas — the #1 unmet ask */}
			<Reveal>
				<div className="relative overflow-hidden rounded-xl border border-primary/25 bg-gradient-to-br from-primary/[0.07] via-transparent to-transparent p-8 md:p-10">
					<div className="grid items-center gap-8 md:grid-cols-[1.2fr_1fr]">
						<div>
							<p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary">
								Seed-lock personas
							</p>
							<h3 className="mt-4 text-balance text-2xl font-bold tracking-tight md:text-3xl">
								The same character, every shot.
							</h3>
							<p className="mt-4 max-w-lg text-pretty leading-relaxed text-muted-foreground">
								Lock a persona once and it holds across shots and scenes — the
								character consistency that generative tools keep promising and
								not delivering. On Byorn it&apos;s a first-class setting, not a
								prompt trick.
							</p>
						</div>
						<PersonaFigure />
					</div>
				</div>
			</Reveal>

			<div className="mt-6 grid gap-6 md:grid-cols-3">
				{CARDS.map((card, i) => (
					<Reveal key={card.title} delay={i * 0.08}>
						<div className="flex h-full flex-col rounded-xl border border-border/70 bg-card/50 p-6">
							{card.figure}
							<h3 className="mt-5 text-lg font-semibold tracking-tight">
								{card.title}
							</h3>
							<p className="mt-2.5 text-pretty text-sm leading-relaxed text-muted-foreground">
								{card.body}
							</p>
						</div>
					</Reveal>
				))}
			</div>
		</ActSection>
	);
}

/* ---------- Figures (inline SVG / CSS, no assets) ---------- */

function PersonaFigure() {
	return (
		<div aria-hidden className="flex items-center justify-center gap-3">
			{["SHOT 01", "SHOT 07", "SHOT 23"].map((label, i) => (
				<div key={label} className="flex flex-col items-center gap-2">
					<div
						className="flex h-20 w-16 items-end justify-center overflow-hidden rounded-lg border border-primary/30 bg-gradient-to-b from-sky-500/20 to-indigo-900/30 sm:h-24 sm:w-20"
						style={{ transform: `rotate(${(i - 1) * 3}deg)` }}
					>
						{/* Same silhouette in every frame = seed-locked */}
						<svg
							viewBox="0 0 40 44"
							className="w-9 text-primary/70 sm:w-11"
							fill="currentColor"
							aria-hidden="true"
						>
							<circle cx="20" cy="12" r="8" />
							<path d="M6 44c0-9 6-15 14-15s14 6 14 15H6z" />
						</svg>
					</div>
					<span className="font-mono text-[9px] tracking-[0.2em] text-muted-foreground/70">
						{label}
					</span>
				</div>
			))}
		</div>
	);
}

function StyleBibleFigure() {
	return (
		<div aria-hidden className="flex h-16 items-center gap-2">
			<div className="flex gap-1.5">
				{[0, 1, 2].map((i) => (
					<div
						key={i}
						className="h-10 w-7 rounded-sm border border-border bg-gradient-to-br from-amber-400/30 via-rose-400/20 to-indigo-500/30"
						style={{ transform: `rotate(${(i - 1) * 6}deg)` }}
					/>
				))}
			</div>
			<svg
				viewBox="0 0 24 24"
				className="size-4 text-muted-foreground/60"
				aria-hidden="true"
			>
				<path
					d="M4 12h14m0 0-5-5m5 5-5 5"
					stroke="currentColor"
					strokeWidth="1.5"
					fill="none"
					strokeLinecap="round"
				/>
			</svg>
			<div className="flex h-12 items-center rounded-md border border-primary/30 bg-primary/10 px-3">
				<span className="font-mono text-[10px] uppercase tracking-widest text-primary">
					StyleBible
				</span>
			</div>
		</div>
	);
}

function RoutingFigure() {
	return (
		<div aria-hidden className="flex h-16 items-center gap-3">
			<span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
				Brief
			</span>
			<svg viewBox="0 0 72 48" className="h-12 w-20" aria-hidden="true">
				<path
					d="M2 24 C 20 24, 20 8, 38 8 M2 24 C 20 24, 20 24, 38 24 M2 24 C 20 24, 20 40, 38 40"
					stroke="var(--primary)"
					strokeWidth="1.5"
					fill="none"
					opacity="0.6"
				/>
				<circle cx="2" cy="24" r="2.5" fill="var(--primary)" />
			</svg>
			<div className="flex flex-col gap-1.5">
				{["MODEL A", "MODEL B", "MODEL C"].map((m) => (
					<span
						key={m}
						className="rounded-sm border border-border bg-muted/30 px-2 py-0.5 font-mono text-[8px] tracking-widest text-muted-foreground"
					>
						{m}
					</span>
				))}
			</div>
		</div>
	);
}

function LibraryFigure() {
	return (
		<div aria-hidden className="flex h-16 items-end gap-1.5">
			{[38, 62, 46, 70, 54, 42, 66].map((h, i) => (
				<div
					key={h}
					className={
						i % 3 === 1
							? "w-5 rounded-sm bg-primary/50"
							: "w-5 rounded-sm bg-muted-foreground/20"
					}
					style={{ height: `${h}%` }}
				/>
			))}
			<span className="mb-1 ml-2 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
				library · analyzed
			</span>
		</div>
	);
}
