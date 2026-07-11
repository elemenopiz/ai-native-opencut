import { Reveal } from "./reveal";

/**
 * Shared shell for the four "acts" of the landing narrative.
 * Edit-suite editorial: hairline top rule, mono act marker, big display head.
 */
export function ActSection({
	id,
	index,
	act,
	title,
	lead,
	children,
}: {
	id: string;
	index: string;
	act: string;
	title: React.ReactNode;
	lead: string;
	children: React.ReactNode;
}) {
	return (
		<section id={id} className="relative border-t border-border/60">
			<div className="mx-auto max-w-6xl px-6 py-20 md:px-8 md:py-28">
				<Reveal>
					<div className="flex items-baseline gap-4 font-mono text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
						<span className="font-semibold text-primary">{index}</span>
						<span>{act}</span>
						<span
							aria-hidden
							className="hidden h-px flex-1 bg-border/70 sm:block"
						/>
					</div>
					<h2 className="mt-7 max-w-2xl text-balance text-4xl font-bold tracking-tight md:text-5xl">
						{title}
					</h2>
					<p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
						{lead}
					</p>
				</Reveal>
				<div className="mt-12 md:mt-16">{children}</div>
			</div>
		</section>
	);
}
