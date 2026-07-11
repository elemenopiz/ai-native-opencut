"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GRAIN_URI, FrameCorners, SceneTag } from "./film";

const EASE = [0.22, 1, 0.36, 1] as const;

function rise(delay: number) {
	return {
		initial: { opacity: 0, y: 22 },
		animate: { opacity: 1, y: 0 },
		transition: { duration: 0.8, delay, ease: EASE },
	};
}

/**
 * Act 0 — the title card. One giant letterboxed screen with the headline
 * projected onto it. The screen is intentionally near-black in both themes;
 * the page chrome around it uses theme tokens.
 */
export function Hero() {
	return (
		<section className="relative px-4 pt-6 pb-20 sm:px-6 md:pt-10">
			<div className="mx-auto w-full max-w-6xl">
				<motion.div
					initial={{ opacity: 0, scale: 0.985 }}
					animate={{ opacity: 1, scale: 1 }}
					transition={{ duration: 1, ease: EASE }}
					className="relative overflow-hidden rounded-xl bg-[hsl(240,4%,4%)] ring-1 ring-border"
				>
					{/* Letterbox bars */}
					<div className="h-8 bg-black/60 sm:h-10" aria-hidden />

					<div className="relative">
						{/* Grain + vignette + faint key light */}
						<div
							className="pointer-events-none absolute inset-0 z-10 opacity-[0.06]"
							style={{ backgroundImage: GRAIN_URI }}
							aria-hidden
						/>
						<div
							className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_55%_at_50%_0%,rgba(0,157,255,0.13),transparent_70%)]"
							aria-hidden
						/>
						<div
							className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(ellipse_95%_85%_at_50%_40%,transparent_50%,rgba(0,0,0,0.6))]"
							aria-hidden
						/>
						<FrameCorners className="inset-3" />

						{/* Slate data */}
						<div className="absolute top-5 left-6 z-20 flex items-center gap-4 sm:left-8">
							<SceneTag className="text-white/45">Prod. Byorn</SceneTag>
							<SceneTag className="hidden text-white/45 sm:inline-flex">
								Sc 01 · Tk 01
							</SceneTag>
						</div>
						<div className="absolute top-5 right-6 z-20 flex items-center gap-2 sm:right-8">
							<span className="relative flex size-1.5">
								<span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500/70" />
								<span className="relative inline-flex size-1.5 rounded-full bg-red-500" />
							</span>
							<SceneTag className="text-white/45">Rec</SceneTag>
						</div>

						{/* Projected title */}
						<div className="relative z-20 flex flex-col items-center px-6 py-20 text-center sm:py-28 md:py-32">
							<motion.p
								{...rise(0.15)}
								className="font-mono text-[11px] uppercase tracking-[0.42em] text-white/50"
							>
								Byorn presents
							</motion.p>

							<motion.h1
								{...rise(0.3)}
								className="mt-7 max-w-3xl text-balance text-4xl font-semibold leading-[1.06] tracking-tight text-white sm:text-6xl md:text-7xl"
							>
								Where AI footage gets made.
								<span className="block text-white/45">And finished.</span>
							</motion.h1>

							<motion.p
								{...rise(0.48)}
								className="mt-7 max-w-xl text-pretty text-base leading-relaxed text-white/65 md:text-lg"
							>
								Byorn is an AI-native video editor. Its Director turns a brief
								into shots and takes across multiple AI models, reviews every
								frame, and lands the cut on a real, professional timeline —
								where you finish it.
							</motion.p>

							<motion.div
								{...rise(0.62)}
								className="mt-10 flex flex-col items-center gap-3 sm:flex-row"
							>
								<Link href="/projects">
									<Button
										size="lg"
										className="group h-12 bg-white px-8 text-base text-black hover:bg-white/90"
									>
										Start editing
										<ArrowRight className="ml-1 size-4 transition-transform group-hover:translate-x-0.5" />
									</Button>
								</Link>
								<a href="#act-1">
									<Button
										size="lg"
										variant="outline"
										className="h-12 border-white/20 bg-transparent px-8 text-base text-white/80 hover:bg-white/10 hover:text-white"
									>
										Follow the production
									</Button>
								</a>
							</motion.div>

							{/* Honest one-line ticker */}
							<motion.div
								{...rise(0.8)}
								className="mt-14 flex flex-wrap items-center justify-center gap-x-5 gap-y-2"
							>
								{[
									"Seed-locked characters",
									"A vision critic on every take",
									"Multi-model routing",
									"Agent-operable over MCP",
								].map((line) => (
									<SceneTag key={line} className="text-white/40">
										<span className="size-1 rounded-full bg-white/25" />
										{line}
									</SceneTag>
								))}
							</motion.div>
						</div>

						{/* Bottom timecode strip */}
						<div className="relative z-20 flex items-center justify-between border-t border-white/10 px-6 py-3 sm:px-8">
							<SceneTag className="text-white/35">2.39 : 1</SceneTag>
							<SceneTag className="text-white/35">
								Private beta · opening soon
							</SceneTag>
							<SceneTag className="text-white/35">00:00:00:01</SceneTag>
						</div>
					</div>

					<div className="h-8 bg-black/60 sm:h-10" aria-hidden />
				</motion.div>
			</div>
		</section>
	);
}
