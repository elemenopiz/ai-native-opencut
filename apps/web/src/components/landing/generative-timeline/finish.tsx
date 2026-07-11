import { ActSection } from "./act-section";
import { Reveal } from "./reveal";

/**
 * Act 03 — Finish. The real editor underneath: masks, keyframes,
 * transitions, speed, audio, subtitle import — plus on-device Whisper
 * captions. Every item verified shipped.
 */

const TOOLS = [
	{
		name: "Masks",
		detail:
			"Shape, freeform pen-tool, and text-reveal masks with WebGL-feathered edges.",
	},
	{
		name: "Keyframes",
		detail: "A bezier easing editor, plus copy and paste between keyframes.",
	},
	{
		name: "Transitions",
		detail:
			"Real transitions on the timeline — visible, adjustable, removable.",
	},
	{
		name: "Speed control",
		detail: "Retime any clip without breaking the edit around it.",
	},
	{
		name: "Group editing",
		detail: "Multi-select clips, then move and resize them as one.",
	},
	{
		name: "Audio surgery",
		detail: "Detach or extract audio from any clip and cut it separately.",
	},
	{
		name: "Subtitle import",
		detail: "Bring existing subtitle files straight onto the timeline.",
	},
	{
		name: "Preview guides",
		detail: "Composition guides in the preview for framing that holds up.",
	},
];

export function Finish() {
	return (
		<ActSection
			id="finish"
			index="03"
			act="Finish"
			title="A real editor underneath."
			lead="Byorn isn't a prompt box with an export button. Under the Director sits a professional multi-track editor — the finishing tools that decide whether footage becomes a film."
		>
			<div className="grid gap-px overflow-hidden rounded-xl border border-border/70 bg-border/50 sm:grid-cols-2 lg:grid-cols-4">
				{TOOLS.map((tool, i) => (
					<Reveal key={tool.name} delay={(i % 4) * 0.06} className="h-full">
						<div className="flex h-full flex-col bg-card/80 p-5 transition-colors hover:bg-card">
							<span
								aria-hidden
								className="font-mono text-[10px] tracking-[0.25em] text-primary/70"
							>
								{String(i + 1).padStart(2, "0")}
							</span>
							<h3 className="mt-3 font-semibold tracking-tight">{tool.name}</h3>
							<p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
								{tool.detail}
							</p>
						</div>
					</Reveal>
				))}
			</div>

			{/* Captions strip */}
			<Reveal delay={0.1}>
				<div className="mt-6 grid items-center gap-8 rounded-xl border border-border/70 bg-card/50 p-8 md:grid-cols-[1fr_1.1fr] md:p-10">
					<div>
						<p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary">
							Captions &amp; transcript
						</p>
						<h3 className="mt-4 text-balance text-2xl font-bold tracking-tight">
							Transcribed in your browser.
						</h3>
						<p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
							On-device Whisper runs on WebGPU, right in the tab — fast, and
							your audio stays with you — with a server fallback when your
							hardware says no. Word-level captions land on the timeline, and a
							transcript panel keeps the whole edit navigable by text.
						</p>
					</div>
					<CaptionFigure />
				</div>
			</Reveal>
		</ActSection>
	);
}

function CaptionFigure() {
	const words = [
		{ w: "So", t: "00:04.2" },
		{ w: "here's", t: "00:04.5" },
		{ w: "the", t: "00:04.8" },
		{ w: "part", t: "00:05.0" },
		{ w: "nobody", t: "00:05.4" },
		{ w: "cuts.", t: "00:05.9" },
	];
	return (
		<div
			aria-hidden
			className="rounded-lg border border-border/70 bg-background/60 p-4"
		>
			<div className="flex items-center justify-between border-b border-border/50 pb-2">
				<span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
					transcript · whisper (local)
				</span>
				<span className="rounded-sm bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[8px] tracking-widest text-emerald-600 dark:text-emerald-400">
					WEBGPU
				</span>
			</div>
			<div className="mt-3 flex flex-wrap gap-1.5">
				{words.map((word, i) => (
					<span
						key={word.t}
						className={
							i === 3
								? "rounded-sm border border-primary/50 bg-primary/15 px-2 py-1 font-mono text-[11px] text-primary"
								: "rounded-sm border border-border/60 px-2 py-1 font-mono text-[11px] text-muted-foreground"
						}
					>
						{word.w}
					</span>
				))}
			</div>
			<div className="mt-3 flex justify-between font-mono text-[8px] tabular-nums text-muted-foreground/50">
				{words.map((word) => (
					<span key={word.t}>{word.t}</span>
				))}
			</div>
		</div>
	);
}
