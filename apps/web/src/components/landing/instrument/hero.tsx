import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TimelineMock } from "./timeline-mock";

/**
 * Typographic hero — one declarative claim, left-aligned, followed by a
 * faithful mock of the actual editor timeline. Server-rendered; the only
 * motion is CSS enter animations and the playhead drift inside the mock.
 */
export function Hero() {
	return (
		<section className="relative overflow-hidden">
			{/* Quiet vertical hairlines that frame the content column */}
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 mx-auto hidden max-w-6xl border-x border-border/50 lg:block"
			/>

			<div className="mx-auto max-w-6xl px-6 pt-20 pb-10 md:pt-28 lg:px-12">
				<p className="animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards font-mono text-[11px] tracking-[0.22em] text-muted-foreground uppercase duration-700">
					Byorn — AI-native video editor · Private beta
				</p>

				<h1 className="animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards mt-6 max-w-4xl text-5xl leading-[1.02] font-semibold tracking-tighter [animation-delay:80ms] duration-700 sm:text-6xl md:text-7xl">
					The timeline
					<br />
					is generative.
				</h1>

				<p className="animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground [animation-delay:160ms] duration-700 md:text-lg">
					Byorn is a professional editor where AI footage gets made{" "}
					<em className="text-foreground not-italic">and</em> finished.
					Generated clips sit on a real multi-track timeline as first-class
					citizens — each one holding its takes, reviewed by a critic that
					watches the actual frames, cut with the precision tools an editor
					expects.
				</p>

				<div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards mt-8 flex flex-wrap items-center gap-4 [animation-delay:240ms] duration-700">
					<Button asChild size="lg" className="h-11 px-6 text-sm font-medium">
						<Link href="/projects">Start editing</Link>
					</Button>
					<Link
						href="#agents"
						className="text-sm text-muted-foreground transition-colors hover:text-foreground"
					>
						Built for agents, too&nbsp;&rarr;
					</Link>
				</div>
			</div>

			<div className="mx-auto max-w-6xl px-6 pb-20 lg:px-12">
				<div className="animate-in fade-in slide-in-from-bottom-4 fill-mode-backwards [animation-delay:320ms] duration-1000">
					<TimelineMock />
				</div>
				<p className="mt-4 font-mono text-[11px] tracking-wide text-muted-foreground/80">
					THE TIMELINE, DRAWN TO SCALE — A GENERATED CLIP HOLDING FOUR TAKES.
					SWAP ONE IN PLACE; THE EDIT DOESN&rsquo;T MOVE.
				</p>
			</div>
		</section>
	);
}
