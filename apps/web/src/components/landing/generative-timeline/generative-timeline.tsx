"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/utils/ui";

/**
 * The hero centerpiece: a stylized Byorn timeline that edits itself.
 *
 * Every beat maps to a real, shipped feature:
 *  plan      → Director storyboard (shot plan appears as empty slots)
 *  gen 1–4   → takes generate into clips across routed backends
 *  review    → vision critic flags a temporal defect on shot 03
 *  reroll    → the flagged take is rerolled automatically
 *  swap      → takes-as-versions: shot 02 swaps take 1/3 → 2/3 in place
 *  captions  → on-device Whisper captions + music bed land
 *  play      → playhead sweeps the finished cut
 *
 * Respects prefers-reduced-motion: renders the finished state, statically.
 */

const SHOTS = [
	{
		id: "01",
		name: "COAST — WIDE",
		width: 21,
		fill: "bg-gradient-to-br from-sky-400/80 via-blue-600/70 to-slate-800/80",
	},
	{
		id: "02",
		name: "HARBOR — DRONE",
		width: 27,
		fill: "bg-gradient-to-br from-cyan-400/80 via-sky-600/70 to-indigo-900/80",
	},
	{
		id: "03",
		name: "FIGURE — CLOSE",
		width: 24,
		fill: "bg-gradient-to-br from-blue-300/80 via-slate-500/70 to-slate-900/80",
	},
	{
		id: "04",
		name: "SKYLINE — DUSK",
		width: 28,
		fill: "bg-gradient-to-br from-indigo-400/80 via-blue-700/70 to-black/80",
	},
] as const;

const CAPTION_WORDS = ["We", "open", "on", "the", "coast—", "then", "hold."];

const WAVE_BARS = Array.from({ length: 64 }, (_, i) => ({
	id: `bar-${i}`,
	height: Math.round(22 + 58 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6))),
}));

type StepKey =
	| "plan"
	| "gen-0"
	| "gen-1"
	| "gen-2"
	| "gen-3"
	| "review"
	| "reroll"
	| "swap"
	| "captions"
	| "play";

const STEPS: { key: StepKey; duration: number; status: string }[] = [
	{
		key: "plan",
		duration: 2000,
		status: "storyboard · planning 4 shots from brief",
	},
	{
		key: "gen-0",
		duration: 1100,
		status: "generate · shot 01 · take 1 — route: quality",
	},
	{
		key: "gen-1",
		duration: 1100,
		status: "generate · shot 02 · take 1 — route: cost",
	},
	{
		key: "gen-2",
		duration: 1100,
		status: "generate · shot 03 · take 1 — seed-locked persona",
	},
	{
		key: "gen-3",
		duration: 1100,
		status: "generate · shot 04 · take 1 — route: quality",
	},
	{
		key: "review",
		duration: 1900,
		status: "reviewTake · shot 03 — temporal defect → reroll",
	},
	{
		key: "reroll",
		duration: 1700,
		status: "reroll · shot 03 · take 2 — pass",
	},
	{
		key: "swap",
		duration: 1600,
		status: "chooseTake · shot 02 — take 2/3 swapped in place",
	},
	{
		key: "captions",
		duration: 1800,
		status: "captions · on-device whisper — word-level",
	},
	{
		key: "play",
		duration: 3000,
		status: "cut assembled · 00:00:12:00 — every clip keeps its takes",
	},
];

const STEP_INDEX: Record<StepKey, number> = STEPS.reduce(
	(acc, step, i) => {
		acc[step.key] = i;
		return acc;
	},
	{} as Record<StepKey, number>,
);

export function GenerativeTimeline() {
	const reduceMotion = useReducedMotion();
	const finalStep = STEPS.length - 1;
	const [step, setStep] = useState(reduceMotion ? finalStep : 0);

	useEffect(() => {
		if (reduceMotion) {
			setStep(finalStep);
			return;
		}
		const current = STEPS[step];
		const timer = setTimeout(() => {
			setStep((prev) => (prev + 1) % STEPS.length);
		}, current.duration);
		return () => clearTimeout(timer);
	}, [step, reduceMotion, finalStep]);

	const key = STEPS[step].key;
	const shotGenerated = (i: number) =>
		step >= STEP_INDEX[`gen-${i}` as StepKey];
	const flagged = key === "review";
	const rerolling = key === "reroll";
	const rerolled = step > STEP_INDEX.reroll || reduceMotion;
	const swapped = step >= STEP_INDEX.swap;
	const captionsIn = step >= STEP_INDEX.captions;
	const playing = key === "play";

	return (
		<div className="relative w-full">
			{/* Glow behind the panel */}
			<div
				aria-hidden
				className="absolute -inset-x-8 -top-10 bottom-0 -z-10 bg-[radial-gradient(ellipse_60%_70%_at_50%_30%,rgba(0,157,255,0.14),transparent)]"
			/>

			<div className="overflow-hidden rounded-xl border border-border/70 bg-card/80 shadow-2xl shadow-black/20 backdrop-blur-sm">
				{/* Window chrome */}
				<div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
					<div className="flex items-center gap-3">
						<div className="flex gap-1.5" aria-hidden>
							<span className="size-2.5 rounded-full bg-muted-foreground/25" />
							<span className="size-2.5 rounded-full bg-muted-foreground/25" />
							<span className="size-2.5 rounded-full bg-muted-foreground/25" />
						</div>
						<span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
							byorn · scene_04
						</span>
					</div>
					<span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
						00:00:12:00 · 24fps
					</span>
				</div>

				{/* Ruler */}
				<div
					className="flex border-b border-border/40 px-3 pt-2 pb-1 pl-[4.5rem] sm:pl-[5.5rem]"
					aria-hidden
				>
					{["00:00", "00:03", "00:06", "00:09", "00:12"].map((t, i) => (
						<span
							key={t}
							className={cn(
								"flex-1 border-l border-border/50 pl-1 font-mono text-[9px] tabular-nums text-muted-foreground/50",
								i === 4 && "flex-none",
							)}
						>
							{t}
						</span>
					))}
				</div>

				{/* Lanes */}
				<div className="relative space-y-1.5 px-3 py-3">
					{/* Playhead */}
					{!reduceMotion && (
						<motion.div
							aria-hidden
							className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-primary"
							style={{ left: "4.5rem" }}
							initial={false}
							animate={
								playing
									? { left: ["4.5rem", "calc(100% - 0.875rem)"], opacity: 1 }
									: { left: "4.5rem", opacity: 0.35 }
							}
							transition={
								playing ? { duration: 2.6, ease: "linear" } : { duration: 0.2 }
							}
						>
							<div className="-ml-[3px] size-0 border-x-4 border-t-4 border-x-transparent border-t-primary" />
						</motion.div>
					)}

					{/* V1 — generated shots */}
					<Lane label="V1">
						<div className="flex h-full w-full gap-1">
							{SHOTS.map((shot, i) => {
								const generated = shotGenerated(i);
								const isFlagged = i === 2 && flagged;
								const isRerolling = i === 2 && rerolling;
								return (
									<div
										key={shot.id}
										className="relative h-full"
										style={{ width: `${shot.width}%` }}
									>
										{/* Planned slot (dashed) */}
										<div
											className={cn(
												"absolute inset-0 flex items-center justify-center rounded-md border border-dashed border-border transition-opacity duration-500",
												generated ? "opacity-0" : "opacity-100",
											)}
										>
											<span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60">
												{shot.id}
											</span>
										</div>

										{/* Generated clip */}
										<AnimatePresence>
											{generated && (
												<motion.div
													key={
														i === 2 && (isRerolling || rerolled)
															? "take-2"
															: "take-1"
													}
													initial={
														reduceMotion ? false : { opacity: 0, scaleX: 0.6 }
													}
													animate={{ opacity: 1, scaleX: 1 }}
													exit={{ opacity: 0 }}
													transition={{
														duration: 0.5,
														ease: [0.22, 1, 0.36, 1],
													}}
													className={cn(
														"absolute inset-0 origin-left overflow-hidden rounded-md border",
														isFlagged
															? "border-amber-400/90"
															: "border-white/15",
														shot.fill,
													)}
												>
													{/* Frame stripes to suggest footage */}
													<div
														aria-hidden
														className="absolute inset-0 opacity-25"
														style={{
															backgroundImage:
																"repeating-linear-gradient(90deg, transparent 0px, transparent 10px, rgba(255,255,255,0.25) 10px, rgba(255,255,255,0.25) 11px)",
														}}
													/>
													{/* Reroll shimmer */}
													{isRerolling && !reduceMotion && (
														<motion.div
															aria-hidden
															className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent"
															initial={{ x: "-100%" }}
															animate={{ x: "100%" }}
															transition={{
																duration: 0.9,
																repeat: Infinity,
																ease: "linear",
															}}
														/>
													)}
													<div className="absolute inset-x-0 bottom-0 flex items-center justify-between px-1.5 pb-1">
														<span className="hidden font-mono text-[8px] uppercase tracking-wider text-white/80 sm:block">
															{shot.name}
														</span>
														<span
															className={cn(
																"rounded-sm px-1 py-px font-mono text-[8px] font-semibold tracking-wide",
																isFlagged
																	? "bg-amber-400/90 text-black"
																	: "bg-black/50 text-white/90",
															)}
														>
															{i === 2 && (rerolled || isRerolling)
																? "TK 2"
																: i === 1 && swapped
																	? "TK 2/3"
																	: i === 1
																		? "TK 1/3"
																		: "TK 1"}
														</span>
													</div>
													{/* Swap flash on shot 02 */}
													{i === 1 && key === "swap" && !reduceMotion && (
														<motion.div
															aria-hidden
															className="absolute inset-0 bg-primary/30"
															initial={{ opacity: 1 }}
															animate={{ opacity: 0 }}
															transition={{ duration: 0.8 }}
														/>
													)}
												</motion.div>
											)}
										</AnimatePresence>

										{/* Vision critic callout on shot 03 */}
										<AnimatePresence>
											{i === 2 && (isFlagged || isRerolling) && (
												<motion.div
													initial={{ opacity: 0, y: 6 }}
													animate={{ opacity: 1, y: 0 }}
													exit={{ opacity: 0, y: 6 }}
													transition={{ duration: 0.3 }}
													className="absolute -top-9 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md border border-amber-400/50 bg-background px-2 py-1 font-mono text-[9px] tracking-wide text-amber-500 shadow-lg dark:text-amber-300"
												>
													{isFlagged
														? "critic · temporal defect"
														: "critic · rerolling take 2"}
												</motion.div>
											)}
										</AnimatePresence>
									</div>
								);
							})}
						</div>
					</Lane>

					{/* CC — captions */}
					<Lane label="CC">
						<div className="flex h-full w-full items-center gap-1 pl-[2%]">
							{CAPTION_WORDS.map((word, i) => (
								<motion.span
									key={word}
									initial={reduceMotion ? false : { opacity: 0, y: 6 }}
									animate={
										captionsIn ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }
									}
									transition={{
										duration: 0.25,
										delay: captionsIn ? i * 0.08 : 0,
									}}
									className="rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[8px] text-primary sm:text-[9px]"
								>
									{word}
								</motion.span>
							))}
						</div>
					</Lane>

					{/* A1 — music bed */}
					<Lane label="A1">
						<motion.div
							initial={reduceMotion ? false : { opacity: 0, scaleX: 0.85 }}
							animate={
								captionsIn
									? { opacity: 1, scaleX: 1 }
									: { opacity: 0, scaleX: 0.85 }
							}
							transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
							className="flex h-full w-[94%] origin-left items-center gap-px overflow-hidden rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5"
						>
							{WAVE_BARS.map((bar) => (
								<span
									key={bar.id}
									aria-hidden
									className="w-full rounded-full bg-emerald-500/50"
									style={{ height: `${bar.height}%` }}
								/>
							))}
						</motion.div>
					</Lane>
				</div>

				{/* Status line */}
				<div className="flex items-center gap-2.5 border-t border-border/60 px-4 py-2.5">
					<span className="relative flex size-1.5 shrink-0" aria-hidden>
						{!reduceMotion && (
							<span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
						)}
						<span className="relative inline-flex size-1.5 rounded-full bg-primary" />
					</span>
					<AnimatePresence mode="wait">
						<motion.span
							key={key}
							initial={reduceMotion ? false : { opacity: 0, y: 4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
							transition={{ duration: 0.2 }}
							className="truncate font-mono text-[10px] tracking-wide text-muted-foreground sm:text-[11px]"
						>
							{STEPS[step].status}
						</motion.span>
					</AnimatePresence>
				</div>
			</div>
		</div>
	);
}

function Lane({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-stretch gap-2">
			<div className="flex w-[3.375rem] shrink-0 items-center sm:w-[4.375rem]">
				<span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/60">
					{label}
				</span>
			</div>
			<div
				className={cn(
					"relative min-w-0 flex-1 rounded-md bg-muted/20 px-1 py-1 dark:bg-white/[0.03]",
					label === "V1" ? "h-14 sm:h-16" : "h-7 sm:h-8",
				)}
			>
				{children}
			</div>
		</div>
	);
}
