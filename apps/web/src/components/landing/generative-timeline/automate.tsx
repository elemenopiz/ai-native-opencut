import { ActSection } from "./act-section";
import { Reveal } from "./reveal";

/**
 * Act 04 — Automate. The MCP server: external agents drive the same
 * timeline with real editing verbs (HTTP/SSE, per-project token auth).
 * Verb names below are real entries from the tool catalog.
 */

const VERBS = [
	{ name: "storyboard", desc: "plan shots from a brief" },
	{ name: "generate", desc: "render a take for a slot" },
	{ name: "reviewTake", desc: "critique a take's frames" },
	{ name: "reroll", desc: "regenerate a failed take" },
	{ name: "remix", desc: "revise with a correction" },
	{ name: "compareTake", desc: "judge takes head-to-head" },
	{ name: "chooseTake", desc: "swap a take in place" },
	{ name: "intakeReferences", desc: "build a StyleBible" },
	{ name: "addVoiceover", desc: "narration on the timeline" },
	{ name: "addMusicBed", desc: "score under the cut" },
	{ name: "setBudget", desc: "cap what the run can spend" },
	{ name: "approveFinalCut", desc: "sign off the sequence" },
];

const GUARANTEES = [
	{
		title: "Real tools, not a passthrough",
		body: "Each verb executes against the same editor core the in-app Director uses — actual timeline operations, not a chat wrapper that forwards prompts.",
	},
	{
		title: "HTTP / SSE transport",
		body: "Standard MCP over HTTP with server-sent events, so any MCP-capable agent can connect with nothing exotic in between.",
	},
	{
		title: "Per-project tokens",
		body: "Access is scoped per project with token auth. An agent gets the timeline you gave it — and only that one.",
	},
];

export function Automate() {
	return (
		<ActSection
			id="automate"
			index="04"
			act="Automate"
			title="Your agents. The same timeline."
			lead="Byorn exposes the editor itself over MCP. External agents storyboard, generate, review, and cut with the same verbs the Director uses — a real tool surface, not a prompt relay."
		>
			<div className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
				{/* Verb sheet */}
				<Reveal>
					<div className="overflow-hidden rounded-xl border border-border/70 bg-card/60">
						<div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
							<span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
								mcp · tool catalog
							</span>
							<span className="font-mono text-[10px] tracking-widest text-primary">
								20+ VERBS
							</span>
						</div>
						<ul className="grid sm:grid-cols-2">
							{VERBS.map((verb, i) => (
								<li
									key={verb.name}
									className="flex items-baseline gap-3 border-b border-border/40 px-5 py-2.5 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0"
								>
									<span
										aria-hidden
										className="font-mono text-[9px] tabular-nums text-muted-foreground/40"
									>
										{String(i + 1).padStart(2, "0")}
									</span>
									<code className="font-mono text-[13px] text-primary">
										{verb.name}
									</code>
									<span className="ml-auto hidden truncate text-right text-xs text-muted-foreground sm:block">
										{verb.desc}
									</span>
								</li>
							))}
						</ul>
						<div className="border-t border-border/60 px-5 py-2.5 font-mono text-[10px] tracking-wide text-muted-foreground/60">
							…plus slots, briefs, budgets, project bible, and voice-consent
							controls.
						</div>
					</div>
				</Reveal>

				{/* Guarantees */}
				<div className="flex flex-col gap-4">
					{GUARANTEES.map((g, i) => (
						<Reveal key={g.title} delay={i * 0.08} className="flex-1">
							<div className="flex h-full flex-col justify-center rounded-xl border border-border/70 bg-card/50 p-6">
								<h3 className="font-semibold tracking-tight">{g.title}</h3>
								<p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
									{g.body}
								</p>
							</div>
						</Reveal>
					))}
				</div>
			</div>
		</ActSection>
	);
}
