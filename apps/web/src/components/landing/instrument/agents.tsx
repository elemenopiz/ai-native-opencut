/**
 * Agent-native / MCP section. The verb list is the real tool catalog
 * (lib/director/tool-catalog.ts) — storyboard, generate, reroll,
 * compareTake, chooseTake are actual MCP verbs.
 */

const SESSION_LINES = [
	{ kind: "meta", text: "agent ⇄ byorn · MCP over HTTP/SSE · project token" },
	{ kind: "call", text: 'storyboard({ brief: "30s product film" })' },
	{ kind: "call", text: 'generate({ slot: "shot-03", takes: 2 })' },
	{ kind: "call", text: 'compareTake({ slot: "shot-03", a: 1, b: 2 })' },
	{ kind: "call", text: 'chooseTake({ slot: "shot-03", take: 2 })' },
	{ kind: "ok", text: "reel updated · 4 slots · budget intact" },
] as const;

const VERBS = [
	"getReel",
	"getSlot",
	"searchMedia",
	"getLibraryManifest",
	"getBackends",
	"storyboard",
	"proposeReel",
	"intakeReferences",
	"reserveSlot",
	"setPrompt",
	"generate",
	"reroll",
	"remix",
	"compareTake",
	"chooseTake",
	"getBudgetStatus",
];

export function AgentsSection() {
	return (
		<section id="agents" className="scroll-mt-16 border-t">
			<div className="mx-auto max-w-6xl px-6 py-20 md:py-28 lg:border-x lg:border-border/50 lg:px-12">
				<div className="mb-12 flex items-baseline gap-4">
					<span className="font-mono text-xs text-primary">03</span>
					<h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
						Agent-native, down to the verbs.
					</h2>
				</div>

				<div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16">
					<div>
						<p className="text-base leading-relaxed text-muted-foreground">
							External agents drive the same timeline you do — over MCP
							(HTTP/SSE), authenticated with per-project tokens. Around twenty
							real editing verbs: plan a storyboard, reserve slots, generate and
							reroll takes, compare them, choose one.
						</p>
						<p className="mt-4 text-base leading-relaxed text-muted-foreground">
							<span className="text-foreground">
								Real tools, not passthrough.
							</span>{" "}
							Each verb operates on the actual edit — slots, takes, budgets —
							not on a rendered picture of it.
						</p>

						<div className="mt-8 flex flex-wrap gap-1.5">
							{VERBS.map((v) => (
								<span
									key={v}
									className="rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
								>
									{v}
								</span>
							))}
						</div>
					</div>

					{/* Session transcript mock */}
					<div>
						<div className="overflow-hidden rounded-xl border bg-card shadow-sm">
							<div className="flex h-9 items-center gap-2 border-b px-3">
								<span className="size-1.5 rounded-full bg-primary" />
								<span className="font-mono text-[11px] font-medium">
									mcp session
								</span>
							</div>
							<div className="space-y-2.5 overflow-x-auto p-4 font-mono text-[11px] leading-relaxed">
								{SESSION_LINES.map((l) => (
									<p key={l.text} className="whitespace-nowrap">
										{l.kind === "meta" && (
											<span className="text-muted-foreground/60">
												# {l.text}
											</span>
										)}
										{l.kind === "call" && (
											<>
												<span className="text-primary">›</span>{" "}
												<span className="text-foreground">{l.text}</span>
											</>
										)}
										{l.kind === "ok" && (
											<span className="text-muted-foreground">✓ {l.text}</span>
										)}
									</p>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
