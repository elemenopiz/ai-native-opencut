import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ByornLogo } from "@/components/footer";
import { Reveal } from "./reveal";

export function CTA() {
	return (
		<section className="relative overflow-hidden border-t border-border/60">
			{/* Atmosphere */}
			<div aria-hidden className="absolute inset-0 -z-10">
				<div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_80%_at_50%_110%,rgba(0,157,255,0.12),transparent)]" />
			</div>

			<div className="mx-auto flex max-w-4xl flex-col items-center px-6 py-24 text-center md:py-32">
				<Reveal className="flex flex-col items-center">
					{/* White bear mark needs a dark seat to read in light mode too */}
					<div className="flex size-16 items-center justify-center rounded-2xl border border-white/10 bg-zinc-900 shadow-lg">
						<ByornLogo size={38} />
					</div>
					<p className="mt-8 font-mono text-[11px] uppercase tracking-[0.35em] text-muted-foreground">
						Generate · Refine · Finish · Automate
					</p>
					<h2 className="mt-6 text-balance text-4xl font-bold tracking-tight md:text-5xl">
						The cut starts here.
					</h2>
					<p className="mt-5 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
						Open a project and put the generative timeline to work — brief in,
						finished sequence out.
					</p>
					<Link href="/projects" className="mt-9">
						<Button
							size="lg"
							className="group h-12 px-8 text-base font-medium shadow-lg shadow-primary/20 transition-shadow hover:shadow-xl hover:shadow-primary/30"
						>
							Start editing
							<ArrowRight className="ml-1 size-4 transition-transform group-hover:translate-x-0.5" />
						</Button>
					</Link>
				</Reveal>
			</div>
		</section>
	);
}
