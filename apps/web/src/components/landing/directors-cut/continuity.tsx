"use client";

import { cn } from "@/utils/ui";
import { Eyebrow, Reveal, SceneTag, Screen } from "./film";

/**
 * Character consistency spotlight — seed-locked personas.
 * Same silhouette, three different scenes, one locked identity.
 */

function PersonaSilhouette({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 80 100"
			className={cn("h-auto w-14 sm:w-16", className)}
			role="presentation"
			aria-hidden="true"
		>
			{/* head */}
			<circle cx="40" cy="30" r="15" fill="currentColor" />
			{/* shoulders */}
			<path d="M12 100c0-20 12-33 28-33s28 13 28 33Z" fill="currentColor" />
		</svg>
	);
}

const SCENES = [
	{
		slate: "Sc 03 · Alley, night",
		bg: "from-sky-950 via-slate-950 to-black",
		light:
			"bg-[radial-gradient(ellipse_60%_50%_at_30%_10%,rgba(56,140,255,0.25),transparent_70%)]",
	},
	{
		slate: "Sc 09 · Diner, dusk",
		bg: "from-amber-950 via-stone-950 to-black",
		light:
			"bg-[radial-gradient(ellipse_60%_50%_at_70%_15%,rgba(255,170,60,0.22),transparent_70%)]",
	},
	{
		slate: "Sc 17 · Rooftop, dawn",
		bg: "from-rose-950 via-neutral-950 to-black",
		light:
			"bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,rgba(255,110,130,0.2),transparent_70%)]",
	},
];

export function Continuity() {
	return (
		<section className="border-y bg-accent/40 px-4 py-20 sm:px-6 md:py-28">
			<div className="mx-auto w-full max-w-6xl">
				<div className="grid grid-cols-1 items-end gap-10 md:grid-cols-[1.1fr_1fr]">
					<Reveal>
						<Eyebrow>Continuity department</Eyebrow>
						<h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
							The same character, from scene three to scene seventeen.
						</h2>
					</Reveal>
					<Reveal delay={0.1}>
						<p className="text-pretty leading-relaxed text-muted-foreground md:text-lg">
							Character drift is the hardest unsolved problem in generated
							video. Byorn seed-locks personas: cast a character once — from a
							photo or a generated look — and the Director holds that identity
							across shots, scenes, and rerolls. The critic checks continuity
							against the previous shot, so the person who walks out of scene
							three is the person who shows up on the rooftop.
						</p>
					</Reveal>
				</div>

				<Reveal delay={0.15} className="mt-14">
					<div className="relative grid grid-cols-1 gap-5 sm:grid-cols-3">
						{/* lock line connecting the scenes (desktop) */}
						<div
							className="pointer-events-none absolute top-1/2 right-[8%] left-[8%] z-0 hidden border-t border-dashed border-primary/40 sm:block"
							aria-hidden
						/>
						{SCENES.map((scene) => (
							<Screen
								key={scene.slate}
								slate={scene.slate}
								className="z-10"
								innerClassName="flex aspect-[4/3] items-end justify-center"
							>
								<div
									className={cn("absolute inset-0 bg-gradient-to-b", scene.bg)}
									aria-hidden
								/>
								<div
									className={cn("absolute inset-0", scene.light)}
									aria-hidden
								/>
								<PersonaSilhouette className="relative text-white/85 drop-shadow-[0_0_24px_rgba(0,0,0,0.8)]" />
								<span className="absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full border border-primary/50 bg-black/50 px-2 py-0.5">
									{/* padlock */}
									<svg
										viewBox="0 0 12 12"
										className="size-2.5 text-primary"
										role="presentation"
										aria-hidden="true"
									>
										<rect
											x="2"
											y="5"
											width="8"
											height="6"
											rx="1"
											fill="currentColor"
										/>
										<path
											d="M4 5V3.5a2 2 0 0 1 4 0V5"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.4"
										/>
									</svg>
									<SceneTag className="text-primary">Persona locked</SceneTag>
								</span>
							</Screen>
						))}
					</div>
				</Reveal>
			</div>
		</section>
	);
}
