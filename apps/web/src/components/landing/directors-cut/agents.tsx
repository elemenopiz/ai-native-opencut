"use client";

import { Eyebrow, Reveal, SceneTag, Screen } from "./film";

/**
 * Agent-native section: external agents drive the timeline over MCP.
 * The verbs listed are real tool names from the catalog.
 */

const VERBS = [
	"storyboard",
	"intakeReferences",
	"generate",
	"reroll",
	"remix",
	"reviewTake",
	"compareTake",
	"chooseTake",
	"trim",
	"split",
	"move",
	"reorder",
	"setPrompt",
	"getBackends",
	"addVoiceover",
	"addMusicBed",
];

export function Agents() {
	return (
		<section className="border-y bg-accent/40 px-4 py-20 sm:px-6 md:py-28">
			<div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-12 md:grid-cols-2 md:gap-16">
				<Reveal>
					<Eyebrow>Also starring · your agents</Eyebrow>
					<h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
						An editor agents can actually operate.
					</h2>
					<p className="mt-5 text-pretty leading-relaxed text-muted-foreground md:text-lg">
						Byorn exposes its editing surface over MCP — real timeline
						operations, not a passthrough wrapper around a chat prompt. An
						external agent can plan a storyboard, generate and review takes, and
						cut clips on the same timeline you see, over HTTP/SSE with
						per-project token auth.
					</p>
					<ul className="mt-7 space-y-2.5 text-sm text-foreground/85">
						{[
							"20+ editing verbs, from storyboard to split",
							"HTTP/SSE transport — works with any MCP client",
							"Per-project tokens, scoped and revocable",
						].map((line) => (
							<li key={line} className="flex items-start gap-3">
								<span
									className="mt-[7px] size-1.5 shrink-0 rounded-full bg-primary"
									aria-hidden
								/>
								{line}
							</li>
						))}
					</ul>
				</Reveal>

				<Reveal delay={0.12}>
					<Screen slate="MCP · tool catalog" timecode="live">
						<div className="px-6 py-10 sm:px-8 sm:py-12">
							<div className="rounded-md border border-white/12 bg-white/[0.03] p-5">
								<div className="flex items-center justify-between border-b border-white/10 pb-3">
									<SceneTag className="text-white/45">byorn.tools()</SceneTag>
									<span className="flex items-center gap-1.5">
										<span className="size-1.5 rounded-full bg-emerald-400" />
										<SceneTag className="text-white/45">connected</SceneTag>
									</span>
								</div>
								<div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 font-mono text-xs">
									{VERBS.map((verb, i) => (
										<span
											key={verb}
											className={i % 5 === 2 ? "text-primary" : "text-white/55"}
										>
											{verb}
											<span className="text-white/25">()</span>
										</span>
									))}
									<span className="text-white/30">…</span>
								</div>
							</div>
							<p className="mt-3 text-right font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
								Same tools the in-app Director uses
							</p>
						</div>
					</Screen>
				</Reveal>
			</div>
		</section>
	);
}
