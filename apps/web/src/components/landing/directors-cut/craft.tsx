"use client";

import { Eyebrow, Reveal } from "./film";

/**
 * "A real editor underneath" — the toolkit, typeset like film credits.
 * Every line is a shipped capability; nothing aspirational.
 */

const CREDITS: { role: string; name: string }[] = [
	{
		role: "Timeline",
		name: "Multi-track editing · multi-select group move & resize · speed control",
	},
	{
		role: "Masks",
		name: "Shape · pen-tool freeform · text-reveal · WebGL feathering",
	},
	{
		role: "Keyframes",
		name: "Bezier easing editor · copy & paste between clips",
	},
	{
		role: "Transitions",
		name: "On the timeline, visible and removable — no blank frames",
	},
	{
		role: "Audio",
		name: "Detach & extract from video · sounds and music search",
	},
	{
		role: "Captions",
		name: "On-device Whisper (WebGPU) with server fallback · word-level styling · subtitle import",
	},
	{
		role: "Framing",
		name: "Preview guides · brand-able text and captions",
	},
	{
		role: "Library",
		name: "Insights X-ray of your assets · Understanding Pass for casting real footage",
	},
	{
		role: "Long-form",
		name: "Podcast Clips — surfaces the strongest moments in a recording",
	},
	{
		role: "Versions",
		name: "Takes-as-versions on every generated clip · version control on studio assets",
	},
];

export function Craft() {
	return (
		<section className="px-4 py-20 sm:px-6 md:py-28">
			<div className="mx-auto w-full max-w-3xl">
				<Reveal className="text-center">
					<Eyebrow>Not a prompt-to-video toy</Eyebrow>
					<h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
						A real editor underneath.
					</h2>
					<p className="mx-auto mt-5 max-w-xl text-pretty text-muted-foreground md:text-lg">
						Generation gets you footage. Craft gets you a film. The full credits
						of the cutting room:
					</p>
				</Reveal>

				<Reveal delay={0.1} className="mt-14">
					<dl className="divide-y divide-border border-y">
						{CREDITS.map((credit) => (
							<div
								key={credit.role}
								className="grid grid-cols-1 gap-1 py-4 sm:grid-cols-[10rem_1fr] sm:gap-8"
							>
								<dt className="font-mono text-[11px] uppercase tracking-[0.28em] text-muted-foreground sm:pt-1 sm:text-right">
									{credit.role}
								</dt>
								<dd className="text-sm leading-relaxed text-foreground/90">
									{credit.name}
								</dd>
							</div>
						))}
					</dl>
				</Reveal>
			</div>
		</section>
	);
}
