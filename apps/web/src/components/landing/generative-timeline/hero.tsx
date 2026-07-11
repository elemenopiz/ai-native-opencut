"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { GenerativeTimeline } from "./generative-timeline";

const PROOF_POINTS = [
	"Seed-locked characters",
	"Vision self-review",
	"Agent-drivable over MCP",
];

export function Hero() {
	const reduceMotion = useReducedMotion();

	const enter = (delay: number) =>
		reduceMotion
			? {}
			: {
					initial: { opacity: 0, y: 20 },
					animate: { opacity: 1, y: 0 },
					transition: {
						duration: 0.8,
						delay,
						ease: [0.22, 1, 0.36, 1] as const,
					},
				};

	return (
		<div className="relative overflow-hidden px-4 pb-20 pt-20 sm:pt-24 md:pb-28">
			{/* Atmosphere */}
			<div aria-hidden className="absolute inset-0 -z-10">
				<div className="absolute inset-0 bg-[radial-gradient(ellipse_75%_55%_at_50%_-10%,rgba(0,157,255,0.10),transparent)]" />
				{/* Ruler-grid: vertical ticks like a timeline */}
				<div
					className="absolute inset-0 opacity-[0.35] dark:opacity-[0.25]"
					style={{
						backgroundImage:
							"linear-gradient(90deg, var(--border) 1px, transparent 1px)",
						backgroundSize: "96px 100%",
						maskImage:
							"linear-gradient(to bottom, transparent, black 12%, black 55%, transparent 85%)",
					}}
				/>
				{/* Noise grain */}
				<div
					className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03]"
					style={{
						backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
					}}
				/>
			</div>

			<div className="mx-auto flex w-full max-w-5xl flex-col items-center text-center">
				{/* Eyebrow */}
				<motion.p
					{...enter(0)}
					className="font-mono text-[11px] uppercase tracking-[0.35em] text-muted-foreground"
				>
					Byorn — AI-native video editor
				</motion.p>

				{/* Headline */}
				<motion.h1
					{...enter(0.1)}
					className="mt-7 text-balance text-5xl font-bold tracking-tight sm:text-6xl md:text-7xl"
				>
					The generative
					<br />
					<span className="text-primary">timeline.</span>
				</motion.h1>

				{/* Subhead */}
				<motion.p
					{...enter(0.22)}
					className="mx-auto mt-7 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground md:text-xl"
				>
					The editor where AI footage gets made <em>and</em> finished. A
					Director plans the shots, generates takes across models, reviews its
					own frames, and hands you a real edit — in one timeline.
				</motion.p>

				{/* CTAs */}
				<motion.div
					{...enter(0.34)}
					className="mt-9 flex flex-col items-center gap-3 sm:flex-row"
				>
					<Link href="/projects">
						<Button
							size="lg"
							className="group h-12 px-8 text-base font-medium shadow-lg shadow-primary/20 transition-shadow hover:shadow-xl hover:shadow-primary/30"
						>
							Start editing
							<ArrowRight className="ml-1 size-4 transition-transform group-hover:translate-x-0.5" />
						</Button>
					</Link>
					<a href="#generate">
						<Button
							size="lg"
							variant="outline"
							className="h-12 px-8 text-base font-medium"
						>
							See how it works
						</Button>
					</a>
				</motion.div>

				{/* Proof points */}
				<motion.ul
					{...enter(0.46)}
					className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
				>
					{PROOF_POINTS.map((point) => (
						<li
							key={point}
							className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground"
						>
							<span aria-hidden className="size-1 rounded-full bg-primary" />
							{point}
						</li>
					))}
				</motion.ul>

				{/* The timeline, editing itself */}
				<motion.div
					{...(reduceMotion
						? {}
						: {
								initial: { opacity: 0, y: 32 },
								animate: { opacity: 1, y: 0 },
								transition: {
									duration: 0.9,
									delay: 0.6,
									ease: [0.22, 1, 0.36, 1] as const,
								},
							})}
					className="mt-16 w-full max-w-4xl"
				>
					<GenerativeTimeline />
					<p className="mt-4 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground/60">
						Live sequence — every beat is a shipped feature
					</p>
				</motion.div>
			</div>
		</div>
	);
}
