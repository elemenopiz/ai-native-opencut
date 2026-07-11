"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Eyebrow, FrameCorners, GRAIN_URI, Reveal, SceneTag } from "./film";

/**
 * The end credits: honest, credit-based economics + closing CTA.
 * No invented price tiers — generation is metered in credits, estimates
 * and budget gates are shown before anything renders.
 */

const TERMS = [
	{
		term: "Credits, not tiers",
		detail:
			"Generation is metered in credits. Buy what you need; spend it on renders.",
	},
	{
		term: "Estimates up front",
		detail:
			"Every generation shows its estimated cost before you commit a single frame.",
	},
	{
		term: "Budget gates",
		detail:
			"Set a ceiling and the Director — rerolls, remixes and all — stays under it.",
	},
];

export function Credits() {
	return (
		<section className="px-4 py-20 sm:px-6 md:py-28">
			<div className="mx-auto w-full max-w-6xl">
				{/* Honest economics */}
				<Reveal className="mx-auto max-w-2xl text-center">
					<Eyebrow>The budget</Eyebrow>
					<h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
						You pay for what you generate.
					</h2>
				</Reveal>

				<Reveal delay={0.1} className="mt-12">
					<dl className="mx-auto grid max-w-4xl grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
						{TERMS.map((t) => (
							<div key={t.term} className="bg-background p-6 sm:p-7">
								<dt className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
									{t.term}
								</dt>
								<dd className="mt-3 text-sm leading-relaxed text-foreground/90">
									{t.detail}
								</dd>
							</div>
						))}
					</dl>
				</Reveal>

				{/* Closing title card */}
				<Reveal delay={0.15} className="mt-24 md:mt-32">
					<div className="relative overflow-hidden rounded-xl bg-[hsl(240,4%,4%)] ring-1 ring-border">
						<div className="h-6 bg-black/60 sm:h-8" aria-hidden />
						<div className="relative">
							<div
								className="pointer-events-none absolute inset-0 z-10 opacity-[0.05]"
								style={{ backgroundImage: GRAIN_URI }}
								aria-hidden
							/>
							<div
								className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_60%_at_50%_100%,rgba(0,157,255,0.12),transparent_70%)]"
								aria-hidden
							/>
							<FrameCorners className="inset-3" />

							<div className="relative z-20 flex flex-col items-center px-6 py-20 text-center sm:py-24">
								<SceneTag className="text-white/40">
									Final scene · your move
								</SceneTag>
								<h2 className="mt-6 max-w-2xl text-balance text-3xl font-semibold tracking-tight text-white sm:text-5xl">
									Directed by you.
								</h2>
								<p className="mt-5 max-w-md text-pretty text-white/60 md:text-lg">
									The set is built, the crew is ready, and the timeline is
									empty. Roll when you are.
								</p>
								<div className="mt-10">
									<Link href="/projects">
										<Button
											size="lg"
											className="group h-12 bg-white px-8 text-base text-black hover:bg-white/90"
										>
											Start editing
											<ArrowRight className="ml-1 size-4 transition-transform group-hover:translate-x-0.5" />
										</Button>
									</Link>
								</div>
								<SceneTag className="mt-8 text-white/35">
									Private beta · opening soon
								</SceneTag>
							</div>
						</div>
						<div className="h-6 bg-black/60 sm:h-8" aria-hidden />
					</div>
				</Reveal>
			</div>
		</section>
	);
}
