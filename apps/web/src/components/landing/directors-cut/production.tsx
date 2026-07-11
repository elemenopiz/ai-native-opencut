"use client";

import type { ReactNode } from "react";
import { cn } from "@/utils/ui";
import { Eyebrow, Reveal, SceneTag, Screen } from "./film";

/**
 * The production, in five acts: brief → StyleBible → shot plan → takes
 * (with the vision critic) → a real timeline → the finished cut.
 * Every claim maps to shipped code (reference-intake, storyboard-plan,
 * vision-critic, takes-as-versions, on-device Whisper captions).
 */

interface Act {
	id: string;
	numeral: string;
	slate: string;
	title: string;
	copy: string;
	beats: string[];
	visual: ReactNode;
}

// ---------- Act visuals (pure CSS/SVG) ----------

function StyleBibleVisual() {
	const refs = [
		"from-amber-700/70 via-orange-900/60 to-stone-900",
		"from-sky-800/70 via-slate-900 to-black",
		"from-rose-900/60 via-neutral-900 to-black",
	];
	return (
		<Screen slate="Sc 01 · Reference intake" timecode="00:00:04:12">
			<div className="flex flex-col gap-6 px-6 py-12 sm:flex-row sm:items-center sm:px-10 sm:py-14">
				{/* Dropped references */}
				<div className="flex shrink-0 items-center gap-3 sm:flex-col">
					{refs.map((g, i) => (
						<div
							key={g}
							className={cn(
								"h-14 w-20 rounded-sm bg-gradient-to-br ring-1 ring-white/15",
								g,
							)}
							style={{ transform: `rotate(${(i - 1) * 3}deg)` }}
						/>
					))}
				</div>

				{/* Flow arrow */}
				<svg
					viewBox="0 0 48 24"
					className="h-6 w-12 shrink-0 self-center text-white/30 max-sm:rotate-90"
					role="presentation"
					aria-hidden="true"
				>
					<path
						d="M2 12h38m0 0-6-6m6 6-6 6"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					/>
				</svg>

				{/* The StyleBible */}
				<div className="min-w-0 flex-1 rounded-md border border-white/12 bg-white/[0.04] p-5">
					<SceneTag className="text-primary">StyleBible</SceneTag>
					<dl className="mt-4 space-y-2.5 font-mono text-[11px] text-white/60">
						<div className="flex items-center justify-between gap-4">
							<dt className="uppercase tracking-[0.18em] text-white/35">
								Palette
							</dt>
							<dd className="flex gap-1.5">
								{[
									"bg-amber-600",
									"bg-orange-900",
									"bg-sky-800",
									"bg-stone-700",
								].map((c) => (
									<span
										key={c}
										className={cn(
											"size-3 rounded-full ring-1 ring-white/20",
											c,
										)}
									/>
								))}
							</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="uppercase tracking-[0.18em] text-white/35">
								Look
							</dt>
							<dd className="truncate">warm tungsten, shallow focus</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="uppercase tracking-[0.18em] text-white/35">
								Persona
							</dt>
							<dd className="text-primary">locked · rides every shot</dd>
						</div>
					</dl>
				</div>
			</div>
		</Screen>
	);
}

function ShotPlanVisual() {
	const rows = [
		{
			shot: "Sc 01 · Sh A",
			desc: "Establishing, slow push-in",
			model: "Model A",
		},
		{ shot: "Sc 01 · Sh B", desc: "Character close-up", model: "Model C" },
		{ shot: "Sc 02 · Sh A", desc: "Product insert, macro", model: "Model B" },
		{ shot: "Sc 02 · Sh B", desc: "Walk-and-talk, tracking", model: "Model A" },
	];
	return (
		<Screen slate="Shot plan · routed" timecode="00:00:09:03">
			<div className="px-6 py-12 sm:px-10 sm:py-14">
				<ul className="divide-y divide-white/10 rounded-md border border-white/12 bg-white/[0.03]">
					{rows.map((r, i) => (
						<li
							key={r.shot}
							className="flex items-center gap-3 px-4 py-3 sm:gap-4"
						>
							<SceneTag className="w-20 shrink-0 text-white/40 sm:w-24">
								{r.shot}
							</SceneTag>
							<span className="min-w-0 flex-1 truncate text-xs text-white/65">
								{r.desc}
							</span>
							<span
								className={cn(
									"shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
									i === 1
										? "border-primary/50 text-primary"
										: "border-white/15 text-white/45",
								)}
							>
								{r.model}
							</span>
						</li>
					))}
				</ul>
				<p className="mt-3 text-right font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
					Routed by cost + quality · estimate shown before render
				</p>
			</div>
		</Screen>
	);
}

function CriticVisual() {
	const takes = [
		{
			tk: "Tk 01",
			verdict: "Reroll",
			note: "motion defect",
			tone: "border-red-400/40 text-red-300/90",
			bg: "from-neutral-800 to-neutral-950",
		},
		{
			tk: "Tk 02",
			verdict: "Remix",
			note: "continuity vs Sc 01",
			tone: "border-amber-400/40 text-amber-300/90",
			bg: "from-neutral-800 to-neutral-950",
		},
		{
			tk: "Tk 03",
			verdict: "Pass",
			note: "cut it in",
			tone: "border-primary/60 text-primary",
			bg: "from-sky-950 to-neutral-950",
		},
	];
	return (
		<Screen slate="Vision critic · Sc 01 Sh B" timecode="00:00:17:22">
			<div className="grid grid-cols-1 gap-4 px-6 py-12 sm:grid-cols-3 sm:px-10 sm:py-14">
				{takes.map((t) => (
					<figure key={t.tk} className="min-w-0">
						<div
							className={cn(
								"relative aspect-video rounded-sm bg-gradient-to-b ring-1",
								t.bg,
								t.verdict === "Pass" ? "ring-primary/60" : "ring-white/12",
							)}
						>
							<SceneTag className="absolute top-2 left-2.5 text-white/45">
								{t.tk}
							</SceneTag>
							<span
								className={cn(
									"absolute bottom-2 left-2.5 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em]",
									t.tone,
								)}
							>
								{t.verdict}
							</span>
						</div>
						<figcaption className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
							{t.note}
						</figcaption>
					</figure>
				))}
			</div>
		</Screen>
	);
}

function TimelineVisual() {
	return (
		<Screen slate="Timeline · V2 V1 A1" timecode="00:00:31:08">
			<div className="px-6 py-12 sm:px-10 sm:py-14">
				{/* Take versions popover */}
				<div className="mb-3 inline-flex items-center gap-2 rounded-md border border-white/12 bg-white/[0.05] px-3 py-1.5">
					<SceneTag className="text-white/45">Takes</SceneTag>
					{["1", "2", "3"].map((n) => (
						<span
							key={n}
							className={cn(
								"flex size-5 items-center justify-center rounded-sm font-mono text-[10px]",
								n === "3"
									? "bg-primary text-white"
									: "bg-white/10 text-white/50",
							)}
						>
							{n}
						</span>
					))}
					<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
						swap in place
					</span>
				</div>

				{/* Tracks */}
				<div className="space-y-1.5">
					<div className="flex h-9 gap-1.5">
						<div className="w-[18%] rounded-sm bg-white/[0.07]" />
						<div className="w-[30%] rounded-sm border border-primary/70 bg-primary/25" />
						<div className="w-[22%] rounded-sm bg-white/[0.07]" />
					</div>
					<div className="flex h-9 gap-1.5">
						<div className="w-[26%] rounded-sm bg-white/[0.09]" />
						<div className="w-[20%] rounded-sm bg-white/[0.09]" />
						<div className="w-[34%] rounded-sm bg-white/[0.09]" />
					</div>
					<div className="flex h-6 gap-1.5">
						<div className="relative w-[62%] overflow-hidden rounded-sm bg-emerald-900/40">
							<svg
								viewBox="0 0 200 20"
								preserveAspectRatio="none"
								className="absolute inset-0 h-full w-full text-emerald-400/50"
								role="presentation"
								aria-hidden="true"
							>
								<path
									d="M0 10 Q10 2 20 10 T40 10 T60 10 Q65 18 70 10 T90 10 T110 10 Q118 1 126 10 T146 10 T166 10 T186 10 L200 10"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
								/>
							</svg>
						</div>
						<div className="w-[18%] rounded-sm bg-emerald-900/30" />
					</div>
				</div>

				{/* Playhead */}
				<div className="relative mt-1.5 h-0">
					<div className="absolute -top-[7.25rem] left-[44%] h-[7rem] w-px bg-white/60" />
				</div>
			</div>
		</Screen>
	);
}

function ShipVisual() {
	const words = ["every", "frame", "earned", "its", "place"];
	return (
		<Screen slate="Final cut · captions on" timecode="00:01:02:15">
			<div className="flex flex-col items-center px-6 py-14 sm:px-10 sm:py-16">
				<p className="flex flex-wrap justify-center gap-x-2 gap-y-1 text-lg font-semibold sm:text-xl">
					{words.map((w, i) => (
						<span
							key={w}
							className={cn(
								i === 2
									? "rounded-sm bg-primary px-1.5 text-white"
									: "text-white/75",
							)}
						>
							{w}
						</span>
					))}
				</p>
				<p className="mt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
					Word-level captions · Whisper runs in your browser
				</p>
				<div className="mt-8 w-full max-w-xs">
					<div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
						<span>Export</span>
						<span>87%</span>
					</div>
					<div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
						<div className="h-full w-[87%] rounded-full bg-primary" />
					</div>
				</div>
			</div>
		</Screen>
	);
}

// ---------- Acts ----------

const ACTS: Act[] = [
	{
		id: "act-1",
		numeral: "I",
		slate: "Reference intake",
		title: "A look walks in the door.",
		copy: "Drop style frames — or a single character photo — and the Director distills them into a StyleBible: the palette, grade, and mood that seeds every shot that follows. An Understanding Pass reads your uploaded library too, so real footage gets cast alongside generated shots.",
		beats: [
			"StyleBible built from your references",
			"Optional persona from one character photo",
			"Your own library indexed and castable",
		],
		visual: <StyleBibleVisual />,
	},
	{
		id: "act-2",
		numeral: "II",
		slate: "The shot plan",
		title: "The brief becomes a shot list.",
		copy: "Scenes, shots, and intent — planned before a single frame renders. Each shot is routed to the right AI video model for the job, weighing cost against quality across multiple backends through one interface. You see the estimate before you commit.",
		beats: [
			"Brief → scene-by-scene shot plan",
			"Cost- and quality-aware model routing",
			"Budget gates you set, honored throughout",
		],
		visual: <ShotPlanVisual />,
	},
	{
		id: "act-3",
		numeral: "III",
		slate: "Takes & the critic",
		title: "A critic watches every take.",
		copy: "Each shot generates takes — and a vision critic looks at the actual frames. Motion defects, temporal glitches, continuity breaks against the previous shot: weak takes get rerolled or remixed automatically, always under the cost gate.",
		beats: [
			"Frame-level review of every take",
			"Catches motion and temporal defects",
			"Cross-shot continuity, corrected automatically",
		],
		visual: <CriticVisual />,
	},
	{
		id: "act-4",
		numeral: "IV",
		slate: "The assembly",
		title: "Takes land on a real timeline.",
		copy: "Not a preview strip — a professional multi-track timeline. Every generated clip keeps its takes as versions, so you can swap a take in place without breaking the edit. Then cut like an editor: masks, keyframes, transitions, speed.",
		beats: [
			"Multi-track editing, generated clips first-class",
			"Takes-as-versions — swap without re-cutting",
			"Full editing toolkit underneath",
		],
		visual: <TimelineVisual />,
	},
	{
		id: "act-5",
		numeral: "V",
		slate: "The cut ships",
		title: "Finish it. Ship it.",
		copy: "Auto-captions from Whisper running on-device in your browser (with a server fallback), word-level styling, subtitle import, and export. The finished piece leaves the building with your name on it.",
		beats: [
			"On-device Whisper auto-captions",
			"Word-level caption styling + subtitle import",
			"Export the cut, credits and all",
		],
		visual: <ShipVisual />,
	},
];

export function Production() {
	return (
		<section className="px-4 py-20 sm:px-6 md:py-28">
			<div className="mx-auto w-full max-w-6xl">
				<Reveal className="mx-auto max-w-2xl text-center">
					<Eyebrow>The production · in five acts</Eyebrow>
					<h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
						This is how a brief becomes a finished cut.
					</h2>
					<p className="mt-5 text-pretty text-muted-foreground md:text-lg">
						Byorn&apos;s Director runs the whole set — and hands you the cut on
						a timeline you actually control.
					</p>
				</Reveal>

				<div className="mt-20 space-y-24 md:space-y-32">
					{ACTS.map((act, i) => (
						<article
							key={act.id}
							id={act.id}
							className="grid scroll-mt-24 grid-cols-1 items-center gap-10 md:grid-cols-2 md:gap-14"
						>
							<Reveal className={cn("min-w-0", i % 2 === 1 && "md:order-2")}>
								<div className="flex items-baseline gap-4">
									<span
										className="font-mono text-5xl font-light text-muted-foreground/40 md:text-6xl"
										aria-hidden
									>
										{act.numeral}
									</span>
									<Eyebrow>
										Act {act.numeral} · {act.slate}
									</Eyebrow>
								</div>
								<h3 className="mt-5 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
									{act.title}
								</h3>
								<p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
									{act.copy}
								</p>
								<ul className="mt-6 space-y-2.5">
									{act.beats.map((beat) => (
										<li
											key={beat}
											className="flex items-start gap-3 text-sm text-foreground/85"
										>
											<span
												className="mt-[7px] size-1.5 shrink-0 rounded-full bg-primary"
												aria-hidden
											/>
											{beat}
										</li>
									))}
								</ul>
							</Reveal>

							<Reveal
								delay={0.12}
								className={cn("min-w-0", i % 2 === 1 && "md:order-1")}
							>
								{act.visual}
							</Reveal>
						</article>
					))}
				</div>
			</div>
		</section>
	);
}
