import { cn } from "@/utils/ui";

/**
 * A faithful CSS/SVG recreation of the Byorn editor timeline — not a
 * screenshot. Multi-track: text overlay, B-roll, primary video, audio.
 * The selected clip on V1 is a generated clip; the drawer below shows its
 * takes with real critic verdicts (pass / reroll-with-delta /
 * remix-for-continuity). Pure server component, theme-token driven.
 */

const LABEL_COL = "w-[76px] shrink-0 sm:w-[88px]";

const RULER_SECONDS = [
	"0:00",
	"0:02",
	"0:04",
	"0:06",
	"0:08",
	"0:10",
	"0:12",
	"0:14",
];

/** Deterministic pseudo-waveform bar heights (0–1). */
const WAVE = [
	0.32, 0.55, 0.4, 0.72, 0.6, 0.35, 0.5, 0.82, 0.66, 0.44, 0.58, 0.3, 0.48,
	0.75, 0.52, 0.38, 0.64, 0.86, 0.57, 0.42, 0.68, 0.5, 0.34, 0.6, 0.78, 0.46,
	0.62, 0.36, 0.54, 0.7, 0.44, 0.58, 0.8, 0.5, 0.4, 0.66, 0.56, 0.33, 0.61,
	0.74, 0.47, 0.59, 0.37, 0.69, 0.53, 0.43, 0.76, 0.51, 0.39, 0.63, 0.57, 0.45,
	0.71, 0.49, 0.35, 0.65,
];

function TrackLabel({ name, kind }: { name: string; kind: string }) {
	return (
		<div
			className={cn(
				LABEL_COL,
				"flex items-center justify-between border-r px-2 sm:px-2.5",
			)}
		>
			<span className="font-mono text-[10px] font-medium text-muted-foreground">
				{name}
			</span>
			<span className="hidden font-mono text-[9px] text-muted-foreground/50 sm:inline">
				{kind}
			</span>
		</div>
	);
}

function Clip({
	left,
	width,
	className,
	children,
}: {
	left: string;
	width: string;
	className?: string;
	children?: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"absolute inset-y-1 flex items-center gap-1.5 overflow-hidden rounded-[5px] border border-border bg-accent px-2 text-[10px] whitespace-nowrap text-muted-foreground",
				className,
			)}
			style={{ left, width }}
		>
			{children}
		</div>
	);
}

/** Four-pointed spark — marks generated clips, as in the editor. */
function Spark({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 12 12"
			className={cn("size-2.5 shrink-0", className)}
			aria-hidden="true"
		>
			<path
				d="M6 0.5 L7.3 4.7 L11.5 6 L7.3 7.3 L6 11.5 L4.7 7.3 L0.5 6 L4.7 4.7 Z"
				fill="currentColor"
			/>
		</svg>
	);
}

function Waveform() {
	const w = WAVE.length * 8;
	return (
		<svg
			viewBox={`0 0 ${w} 32`}
			preserveAspectRatio="none"
			className="h-full w-full text-muted-foreground/60"
			aria-hidden="true"
		>
			{WAVE.map((h, i) => (
				<rect
					// biome-ignore lint/suspicious/noArrayIndexKey: static decorative bars
					key={i}
					x={i * 8 + 2}
					y={16 - h * 14}
					width={4}
					height={h * 28}
					rx={1.5}
					fill="currentColor"
				/>
			))}
		</svg>
	);
}

const TAKES = [
	{ n: 1, verdict: "reroll-with-delta", state: "retired" },
	{ n: 2, verdict: "remix-for-continuity", state: "retired" },
	{ n: 3, verdict: "pass", state: "active" },
	{ n: 4, verdict: "queued", state: "queued" },
] as const;

export function TimelineMock() {
	return (
		<div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
			<div className="min-w-[680px]">
				{/* ── Toolbar ─────────────────────────────────────────────── */}
				<div className="flex h-9 items-center justify-between border-b px-3">
					<div className="flex items-baseline gap-2">
						<span className="font-mono text-[11px] font-medium">
							launch-film
						</span>
						<span className="font-mono text-[10px] text-muted-foreground/70">
							· saved
						</span>
					</div>
					<div className="flex items-center gap-3 text-muted-foreground">
						{/* transport */}
						<svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
							<path d="M2 1v10M10.5 1.5v9L4 6z" fill="currentColor" />
						</svg>
						<svg
							viewBox="0 0 12 12"
							className="size-3 text-foreground"
							aria-hidden="true"
						>
							<path d="M2.5 1.5v9L10.5 6z" fill="currentColor" />
						</svg>
						<svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
							<path d="M10 1v10M1.5 1.5v9L8 6z" fill="currentColor" />
						</svg>
					</div>
					<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
						00:00:08:14
					</span>
				</div>

				{/* ── Ruler ───────────────────────────────────────────────── */}
				<div className="flex h-6 items-stretch border-b">
					<div className={cn(LABEL_COL, "border-r")} />
					<div className="relative flex flex-1">
						{RULER_SECONDS.map((t) => (
							<div
								key={t}
								className="flex-1 border-l border-border/60 pt-1 pl-1 font-mono text-[9px] leading-none text-muted-foreground/70 first:border-l-0"
							>
								{t}
							</div>
						))}
					</div>
				</div>

				{/* ── Lanes + playhead ────────────────────────────────────── */}
				<div className="relative">
					{/* T1 — text overlay */}
					<div className="flex h-9 items-stretch border-b">
						<TrackLabel name="T1" kind="text" />
						<div className="relative flex-1">
							<Clip left="36%" width="24%">
								<span className="truncate">Title — text-reveal mask</span>
							</Clip>
						</div>
					</div>

					{/* V2 — B-roll overlay */}
					<div className="flex h-10 items-stretch border-b">
						<TrackLabel name="V2" kind="video" />
						<div className="relative flex-1">
							<Clip left="50%" width="30%">
								<span className="truncate">
									B-roll — pen mask · feather 12&thinsp;px
								</span>
							</Clip>
						</div>
					</div>

					{/* V1 — primary video */}
					<div className="flex h-14 items-stretch border-b">
						<TrackLabel name="V1" kind="video" />
						<div className="relative flex-1">
							<Clip left="1.5%" width="28%">
								<span className="truncate">Shot 02 · library</span>
							</Clip>

							{/* Selected generated clip with take-version stack */}
							<div
								className="absolute inset-y-1"
								style={{ left: "30.5%", width: "31%" }}
							>
								{/* version stack behind */}
								<div
									aria-hidden="true"
									className="absolute inset-x-1.5 -bottom-1 h-full rounded-[5px] border border-border/70 bg-accent/40"
								/>
								<div
									aria-hidden="true"
									className="absolute inset-x-[3px] -bottom-0.5 h-full rounded-[5px] border border-border bg-accent/70"
								/>
								<div className="relative flex h-full items-center justify-between gap-2 overflow-hidden rounded-[5px] border border-primary bg-accent px-2 text-[10px] whitespace-nowrap ring-1 ring-primary/60">
									<span className="flex min-w-0 items-center gap-1.5">
										<Spark className="text-primary" />
										<span className="truncate font-medium text-foreground">
											Shot 03 · generated
										</span>
									</span>
									<span className="rounded-[3px] border border-border bg-background px-1 py-px font-mono text-[9px] text-muted-foreground">
										take 3/4
									</span>
								</div>
							</div>

							<Clip left="62.5%" width="30%">
								<Spark className="text-muted-foreground/70" />
								<span className="truncate">Shot 04 · generated</span>
							</Clip>
						</div>
					</div>

					{/* A1 — audio */}
					<div className="flex h-10 items-stretch border-b">
						<TrackLabel name="A1" kind="audio" />
						<div className="relative flex-1">
							<Clip left="1.5%" width="91%" className="gap-2 pr-3">
								<span className="shrink-0 truncate">VO — Whisper captions</span>
								<span className="h-[70%] min-w-0 flex-1">
									<Waveform />
								</span>
							</Clip>
						</div>
					</div>

					{/* Playhead — spans ruler-adjacent lanes only */}
					<div
						className="tl-playhead pointer-events-none absolute inset-y-0 z-10"
						style={{ left: "calc(76px + (100% - 76px) * 0.545)" }}
					>
						<div className="absolute top-0 h-2 w-2 -translate-x-1/2 rounded-[2px] bg-primary" />
						<div className="absolute inset-y-0 w-px -translate-x-1/2 bg-primary/80" />
					</div>
				</div>

				{/* ── Takes drawer for the selected clip ──────────────────── */}
				<div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
					<span className="mr-1 font-mono text-[10px] tracking-[0.14em] text-muted-foreground/70 uppercase">
						Shot 03 — takes
					</span>
					{TAKES.map((t) => (
						<span
							key={t.n}
							className={cn(
								"inline-flex items-center gap-1.5 rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px]",
								t.state === "active" && "border-primary/60 text-foreground",
								t.state === "retired" &&
									"border-border text-muted-foreground/80",
								t.state === "queued" &&
									"border-dashed border-border text-muted-foreground/60",
							)}
						>
							{t.state === "active" && (
								<span className="size-1.5 rounded-full bg-primary" />
							)}
							T{t.n} · {t.verdict}
						</span>
					))}
				</div>
			</div>

			{/* Subtle playhead drift; disabled for reduced motion. */}
			<style>{`
				@keyframes tl-drift {
					from { transform: translateX(0); }
					to { transform: translateX(44px); }
				}
				.tl-playhead { animation: tl-drift 16s linear infinite alternate; }
				@media (prefers-reduced-motion: reduce) {
					.tl-playhead { animation: none; }
				}
			`}</style>
		</div>
	);
}
