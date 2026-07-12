"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocalStorage } from "@/hooks/storage/use-local-storage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { useAIStatus } from "@/hooks/use-ai-status";
import { useAIStore } from "@/stores/ai-store";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { SIGNUP_GRANT_CREDITS } from "@/lib/credits/signup-grant";
import { isFeatureAvailable } from "@/lib/local-ai/retired-features";
import { cn } from "@/utils/ui";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	FolderAddIcon,
	AiMagicIcon,
	FilmRoll01Icon,
	SlidersHorizontalIcon,
	Download01Icon,
	ArrowRight01Icon,
	ArrowLeft01Icon,
	Coins01Icon,
	CpuIcon,
} from "@hugeicons/core-free-icons";

/* ------------------------------------------------------------------ *
 * Byorn onboarding — a compact, keyboard-driven "director's console"
 * that teaches the AI-native loop the moment a user lands in a project.
 *
 * Wiring is inherited from the previous onboarding: a localStorage flag
 * gates a single dialog rendered in the editor page. The key is bumped
 * (v4) so existing beta testers see the rebuilt tour exactly once. The
 * final CTA drops the user straight into the Director tab.
 * ------------------------------------------------------------------ */

type StepId = "project" | "direct" | "takes" | "edit" | "export";

interface Step {
	id: StepId;
	rail: string;
	icon: typeof FolderAddIcon;
	kicker: string;
	title: string;
	body: React.ReactNode;
	illustration: React.ReactNode;
}

export function Onboarding() {
	const [step, setStep] = useState(0);
	const [hasSeenOnboarding, setHasSeenOnboarding] = useLocalStorage({
		key: "hasSeenOnboarding-v4",
		defaultValue: false,
	});
	const { isConnected } = useAIStatus();
	const toggleSetupGuide = useAIStore((s) => s.toggleSetupGuide);
	const setActiveTab = useAssetsPanelStore((s) => s.setActiveTab);

	const isOpen = !hasSeenOnboarding;
	const close = useCallback(
		() => setHasSeenOnboarding({ value: true }),
		[setHasSeenOnboarding],
	);

	const steps = STEPS;
	const last = steps.length - 1;
	const current = steps[step];

	const goNext = useCallback(
		() => setStep((s) => Math.min(s + 1, last)),
		[last],
	);
	const goPrev = useCallback(() => setStep((s) => Math.max(s - 1, 0)), []);

	const openDirector = useCallback(() => {
		setActiveTab("director");
		close();
	}, [setActiveTab, close]);

	const openLocalAI = useCallback(() => {
		close();
		toggleSetupGuide();
	}, [close, toggleSetupGuide]);

	// Left / right arrows walk the tour; Esc is handled by the dialog.
	const onKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "ArrowRight") {
				e.preventDefault();
				step === last ? openDirector() : goNext();
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				goPrev();
			}
		},
		[step, last, goNext, goPrev, openDirector],
	);

	return (
		<Dialog open={isOpen} onOpenChange={close}>
			<DialogContent
				onKeyDown={onKeyDown}
				className="max-w-[46rem] overflow-hidden border-border/70 bg-popover p-0"
			>
				<DialogTitle className="sr-only">Welcome to Byorn</DialogTitle>

				<div className="grid sm:grid-cols-[13.5rem_1fr]">
					{/* ── Rail: the shot list ── */}
					<aside className="relative hidden flex-col gap-5 border-r border-border/60 bg-background/40 p-5 sm:flex">
						<Wordmark />
						<ol className="flex flex-col gap-0.5">
							{steps.map((s, i) => {
								const state =
									i === step ? "active" : i < step ? "done" : "todo";
								return (
									<li key={s.id}>
										<button
											type="button"
											onClick={() => setStep(i)}
											className={cn(
												"group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors",
												state === "active"
													? "bg-primary/10"
													: "hover:bg-accent/60",
											)}
										>
											<span
												className={cn(
													"flex size-5 shrink-0 items-center justify-center rounded-[5px] font-mono text-[10px] tabular-nums transition-colors",
													state === "active" &&
														"bg-primary text-primary-foreground",
													state === "done" && "bg-primary/15 text-primary",
													state === "todo" &&
														"bg-muted/70 text-muted-foreground",
												)}
											>
												{String(i + 1).padStart(2, "0")}
											</span>
											<span
												className={cn(
													"truncate text-xs transition-colors",
													state === "active"
														? "font-medium text-foreground"
														: "text-muted-foreground group-hover:text-foreground",
												)}
											>
												{s.rail}
											</span>
										</button>
									</li>
								);
							})}
						</ol>
						<p className="mt-auto text-[10px] leading-relaxed text-muted-foreground/70">
							Private beta ·{" "}
							<button
								type="button"
								onClick={close}
								className="underline decoration-dotted underline-offset-2 hover:text-foreground"
							>
								skip the tour
							</button>
						</p>
					</aside>

					{/* ── Content ── */}
					<section className="flex min-h-[27rem] flex-col">
						{/* Illustration stage */}
						<div className="relative flex h-48 items-center justify-center overflow-hidden border-b border-border/60 bg-background/60">
							<div
								aria-hidden
								className="pointer-events-none absolute inset-0 opacity-[0.35]"
								style={{
									backgroundImage:
										"linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)",
									backgroundSize: "22px 22px",
									maskImage:
										"radial-gradient(120% 80% at 50% 40%, #000 30%, transparent 75%)",
								}}
							/>
							<div
								aria-hidden
								className="pointer-events-none absolute left-1/2 top-1/2 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
								style={{ background: "var(--primary)", opacity: 0.1 }}
							/>
							<div key={current.id} className="byorn-ob-stage relative z-10">
								{current.illustration}
							</div>
						</div>

						{/* Copy */}
						<div
							key={`${current.id}-copy`}
							className="byorn-ob-copy flex flex-1 flex-col gap-3 p-6"
						>
							<div className="flex items-center gap-2">
								<span className="flex size-6 items-center justify-center rounded-md bg-primary/12 text-primary">
									<HugeiconsIcon icon={current.icon} className="size-3.5" />
								</span>
								<span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
									{current.kicker}
								</span>
							</div>
							<h2 className="text-[1.35rem] font-semibold leading-tight tracking-tight text-foreground">
								{current.title}
							</h2>
							<div className="text-[0.9rem] leading-relaxed text-muted-foreground">
								{current.body}
							</div>

							{step === last && (
								<div className="mt-1 flex flex-col gap-2 rounded-lg border border-border/60 bg-background/50 p-3">
									<BetaNote
										icon={Coins01Icon}
										title="Generations cost credits"
										desc={`Every account starts with ${SIGNUP_GRANT_CREDITS} credits on us. The Director previews the cost before it spends any of it.`}
									/>
									{/* Points at the retired local desktop engine's setup
									    guide (its copy is also stale: transcription is
									    in-browser, voiceover is cloud now) — hidden with the
									    stack. */}
									{isFeatureAvailable("localBackendSetup") && (
										<BetaNote
											icon={CpuIcon}
											title={
												<>
													Some features are{" "}
													<span className="text-foreground/90">Local AI</span>
												</>
											}
											desc={
												<>
													Transcription, voiceover, and denoise run on the Byorn
													desktop engine{" "}
													<button
														type="button"
														onClick={openLocalAI}
														className="text-primary underline-offset-2 hover:underline"
													>
														{isConnected ? "(connected)" : "(set it up)"}
													</button>
													.
												</>
											}
										/>
									)}
								</div>
							)}

							{/* Footer */}
							<div className="mt-auto flex items-center justify-between pt-4">
								<div className="flex items-center gap-1.5">
									{steps.map((s, i) => (
										<button
											key={s.id}
											type="button"
											aria-label={`Go to step ${i + 1}`}
											onClick={() => setStep(i)}
											className={cn(
												"h-1.5 rounded-full transition-all",
												i === step
													? "w-5 bg-primary"
													: "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60",
											)}
										/>
									))}
								</div>

								<div className="flex items-center gap-2">
									{step > 0 && (
										<Button
											variant="ghost"
											size="sm"
											onClick={goPrev}
											className="text-muted-foreground"
										>
											<HugeiconsIcon
												icon={ArrowLeft01Icon}
												className="size-3.5"
											/>
											Back
										</Button>
									)}
									{step < last ? (
										<Button size="sm" onClick={goNext} className="pr-2.5">
											Next
											<HugeiconsIcon
												icon={ArrowRight01Icon}
												className="size-3.5"
											/>
										</Button>
									) : (
										<Button
											size="sm"
											onClick={openDirector}
											className="bg-primary pr-2.5 text-primary-foreground hover:bg-primary/90"
										>
											Open the Director
											<HugeiconsIcon icon={AiMagicIcon} className="size-3.5" />
										</Button>
									)}
								</div>
							</div>
						</div>
					</section>
				</div>
			</DialogContent>

			<style>{keyframes}</style>
		</Dialog>
	);
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

const STEPS: Step[] = [
	{
		id: "project",
		rail: "Start a project",
		icon: FolderAddIcon,
		kicker: "Byorn · The AI-native editor",
		title: "You don't cut clips. You direct them.",
		body: (
			<>
				Byorn is an AI-native editor: every shot is generated onto a real
				timeline you can still trim, layer, and export. It all lives inside a{" "}
				<Term>project</Term> — spin up a blank timeline and you're in.
			</>
		),
		illustration: <ProjectArt />,
	},
	{
		id: "direct",
		rail: "Direct a reel",
		icon: AiMagicIcon,
		kicker: "The Director · ⌘K",
		title: "Ask for a reel. Approve the plan.",
		body: (
			<>
				Tell the <Term>Director</Term> what you want — “storyboard a 3-shot reel
				about…”. It proposes a shot list grounded in your assets and shows the
				credit cost <em>before</em> it spends anything. Nothing generates until
				you say go.
			</>
		),
		illustration: <DirectArt />,
	},
	{
		id: "takes",
		rail: "Generate takes",
		icon: FilmRoll01Icon,
		kicker: "Takes",
		title: "Every clip is re-rollable.",
		body: (
			<>
				Each shot becomes a <Term>slot</Term> on the timeline that fills with{" "}
				<Term>takes</Term> as they finish. Don't love one? Re-roll it — a take
				is just a version of the clip, so you can keep the timeline and swap the
				shot underneath.
			</>
		),
		illustration: <TakesArt />,
	},
	{
		id: "edit",
		rail: "Edit like an editor",
		icon: SlidersHorizontalIcon,
		kicker: "Timeline",
		title: "Then edit it like you'd expect.",
		body: (
			<>
				It's still a full editor underneath. Trim and arrange on the timeline,
				add transitions, grade with <Term>LUT color</Term>, and drop in music —
				all the normal moves, on top of shots you directed.
			</>
		),
		illustration: <EditArt />,
	},
	{
		id: "export",
		rail: "Export",
		icon: Download01Icon,
		kicker: "Ship it",
		title: "Export and you're done.",
		body: (
			<>
				Pick a platform preset and export in one click. That's the whole loop —
				reference, direct, generate, edit, ship. Two quick notes before you
				start:
			</>
		),
		illustration: <ExportArt />,
	},
];

/* ------------------------------------------------------------------ *
 * Small pieces
 * ------------------------------------------------------------------ */

function Term({ children }: { children: React.ReactNode }) {
	return <span className="font-medium text-foreground">{children}</span>;
}

function BetaNote({
	icon,
	title,
	desc,
}: {
	icon: typeof Coins01Icon;
	title: React.ReactNode;
	desc: React.ReactNode;
}) {
	return (
		<div className="flex items-start gap-2.5">
			<span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground">
				<HugeiconsIcon icon={icon} className="size-3.5" />
			</span>
			<p className="text-xs leading-relaxed text-muted-foreground">
				<span className="font-medium text-foreground">{title}</span> — {desc}
			</p>
		</div>
	);
}

function Wordmark() {
	return (
		<div className="flex items-center gap-2">
			<span className="relative flex size-6 items-center justify-center">
				<span
					className="absolute inset-0 rounded-[7px]"
					style={{
						background:
							"linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary) 55%, #000))",
					}}
				/>
				<span className="relative font-mono text-[13px] font-bold text-primary-foreground">
					B
				</span>
			</span>
			<span className="text-sm font-semibold tracking-tight">Byorn</span>
		</div>
	);
}

/* ------------------------------------------------------------------ *
 * Illustrations — built from the app's own tokens, no imagery.
 * Each is a stylised, screenshot-like fragment of the real UI.
 * ------------------------------------------------------------------ */

const cardCls =
	"rounded-lg border border-border/70 bg-card/90 shadow-sm backdrop-blur-sm";

function ProjectArt() {
	return (
		<div className="flex items-center gap-3">
			<div className={cn(cardCls, "flex w-36 flex-col gap-2 p-3")}>
				<div className="flex h-14 items-center justify-center rounded-md border border-dashed border-border">
					<HugeiconsIcon
						icon={FolderAddIcon}
						className="size-5 text-muted-foreground"
					/>
				</div>
				<div className="h-1.5 w-16 rounded-full bg-muted" />
				<div className="h-1.5 w-24 rounded-full bg-muted/60" />
			</div>
			<div
				className={cn(
					cardCls,
					"flex w-36 flex-col gap-2 p-3 ring-1 ring-primary/40",
				)}
			>
				<div
					className="flex h-14 items-center justify-center rounded-md"
					style={{
						background:
							"linear-gradient(135deg, color-mix(in srgb, var(--primary) 22%, transparent), transparent)",
					}}
				>
					<div className="grid grid-cols-3 gap-1">
						{Array.from({ length: 6 }).map((_, i) => (
							<span
								key={i}
								className="size-3 rounded-[3px] bg-primary/50"
								style={{ opacity: 0.4 + (i % 3) * 0.2 }}
							/>
						))}
					</div>
				</div>
				<div className="h-1.5 w-20 rounded-full bg-primary/50" />
				<div className="h-1.5 w-24 rounded-full bg-muted/60" />
			</div>
		</div>
	);
}

function DirectArt() {
	return (
		<div className={cn(cardCls, "flex w-64 flex-col gap-2.5 p-3")}>
			<div className="flex items-center gap-2">
				<span className="flex size-5 items-center justify-center rounded-md bg-primary/15 text-primary">
					<HugeiconsIcon icon={AiMagicIcon} className="size-3" />
				</span>
				<span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
					Director
				</span>
			</div>
			<div className="ml-auto max-w-[80%] rounded-lg rounded-br-sm bg-primary px-2.5 py-1.5">
				<div className="h-1.5 w-28 rounded-full bg-primary-foreground/80" />
			</div>
			{/* cost-preview approval gate */}
			<div className="rounded-lg border border-primary/30 bg-primary/[0.06] p-2.5">
				<div className="mb-1.5 flex items-center justify-between">
					<span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
						3 shots · plan
					</span>
					<span className="flex items-center gap-1 font-mono text-[9px] text-primary">
						<HugeiconsIcon icon={Coins01Icon} className="size-2.5" />
						~9 cr
					</span>
				</div>
				<div className="flex gap-1.5">
					{Array.from({ length: 3 }).map((_, i) => (
						<div
							key={i}
							className="h-8 flex-1 rounded-[5px] border border-border/70 bg-card"
						/>
					))}
				</div>
				<div className="mt-2 flex gap-1.5">
					<div className="h-4 flex-1 rounded-[4px] bg-muted" />
					<div className="h-4 flex-1 rounded-[4px] bg-primary" />
				</div>
			</div>
		</div>
	);
}

function TakesArt() {
	return (
		<div className={cn(cardCls, "w-64 p-3")}>
			<div className="mb-2 flex items-center justify-between">
				<span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
					Shot 02 · slot
				</span>
				<span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[8px] text-muted-foreground">
					3 takes
				</span>
			</div>
			<div className="flex gap-1.5">
				{[0, 1, 2].map((i) => (
					<div
						key={i}
						className={cn(
							"relative h-16 flex-1 overflow-hidden rounded-md border",
							i === 1
								? "border-primary ring-1 ring-primary/40"
								: "border-border/70",
						)}
						style={{
							background:
								i === 1
									? "linear-gradient(135deg, color-mix(in srgb, var(--primary) 30%, transparent), var(--card))"
									: "linear-gradient(135deg, var(--muted), var(--card))",
						}}
					>
						<span className="absolute left-1 top-1 font-mono text-[8px] text-muted-foreground">
							v{i + 1}
						</span>
						{i === 2 && (
							<span className="absolute inset-0 flex items-center justify-center">
								<HugeiconsIcon
									icon={FilmRoll01Icon}
									className="size-4 text-primary/70"
								/>
							</span>
						)}
					</div>
				))}
			</div>
			<div className="mt-2 flex items-center gap-1.5">
				<span className="rounded-[4px] bg-primary px-2 py-1 font-mono text-[8px] text-primary-foreground">
					re-roll
				</span>
				<div className="h-1.5 flex-1 rounded-full bg-muted/60" />
			</div>
		</div>
	);
}

function EditArt() {
	const tracks = [
		{ w: ["55%", "40%"], tint: "var(--primary)" },
		{ w: ["30%", "25%", "35%"], tint: "var(--muted-foreground)" },
		{ w: ["70%"], tint: "var(--primary)" },
	];
	return (
		<div className={cn(cardCls, "w-72 p-3")}>
			<div className="mb-2 flex items-center gap-2">
				<span className="size-1.5 rounded-full bg-primary" />
				<div className="h-1 w-10 rounded-full bg-muted" />
				<span className="ml-auto font-mono text-[9px] text-muted-foreground">
					00:06
				</span>
			</div>
			<div className="flex flex-col gap-1.5">
				{tracks.map((t, ti) => (
					<div key={ti} className="flex gap-1.5">
						{t.w.map((w, ci) => (
							<div
								key={ci}
								className="h-5 rounded-[5px]"
								style={{
									width: w,
									background:
										ti === 1
											? "var(--muted)"
											: `color-mix(in srgb, ${t.tint} ${
													28 + ci * 8
												}%, var(--card))`,
									border: "1px solid var(--border)",
								}}
							/>
						))}
					</div>
				))}
			</div>
			<div className="mt-2.5 flex items-center gap-1.5">
				{["cut", "fade", "LUT", "music"].map((chip, i) => (
					<span
						key={chip}
						className={cn(
							"rounded-[4px] px-1.5 py-0.5 font-mono text-[8px]",
							i === 2
								? "bg-primary/15 text-primary"
								: "bg-muted text-muted-foreground",
						)}
					>
						{chip}
					</span>
				))}
			</div>
		</div>
	);
}

function ExportArt() {
	return (
		<div className={cn(cardCls, "flex w-56 flex-col gap-2.5 p-3")}>
			<div className="flex items-center gap-2">
				<HugeiconsIcon
					icon={Download01Icon}
					className="size-3.5 text-primary"
				/>
				<span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
					Export
				</span>
			</div>
			<div className="grid grid-cols-3 gap-1.5">
				{["9:16", "1:1", "16:9"].map((r, i) => (
					<div
						key={r}
						className={cn(
							"flex flex-col items-center gap-1 rounded-md border p-1.5",
							i === 0
								? "border-primary ring-1 ring-primary/40"
								: "border-border/70",
						)}
					>
						<span
							className="rounded-[3px] bg-muted"
							style={{
								width: i === 0 ? 12 : i === 1 ? 18 : 24,
								height: i === 0 ? 22 : i === 1 ? 18 : 14,
								background:
									i === 0
										? "color-mix(in srgb, var(--primary) 40%, var(--muted))"
										: "var(--muted)",
							}}
						/>
						<span className="font-mono text-[8px] text-muted-foreground">
							{r}
						</span>
					</div>
				))}
			</div>
			<div className="flex h-6 items-center justify-center rounded-md bg-primary font-mono text-[9px] text-primary-foreground">
				Export reel
			</div>
		</div>
	);
}

const keyframes = `
@keyframes byornObStage {
	from { opacity: 0; transform: translateY(8px) scale(0.98); }
	to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes byornObCopy {
	from { opacity: 0; transform: translateY(6px); }
	to { opacity: 1; transform: translateY(0); }
}
.byorn-ob-stage { animation: byornObStage 0.42s cubic-bezier(0.16, 1, 0.3, 1); }
.byorn-ob-copy { animation: byornObCopy 0.38s cubic-bezier(0.16, 1, 0.3, 1); }
@media (prefers-reduced-motion: reduce) {
	.byorn-ob-stage, .byorn-ob-copy { animation: none; }
}
`;
