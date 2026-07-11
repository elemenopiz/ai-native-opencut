"use client";

import { motion } from "motion/react";
import type { PropsWithChildren } from "react";
import { cn } from "@/utils/ui";

/**
 * Shared visual vocabulary for the "Director's Cut" landing page.
 *
 * Everything here is CSS/SVG only — no canvas, no video, no external assets.
 * "Footage" frames are deliberately near-black in BOTH themes (they represent
 * a cinema screen); the surrounding page chrome uses theme tokens.
 */

export const GRAIN_URI = `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

const EASE = [0.22, 1, 0.36, 1] as const;

/** Scroll-triggered reveal. Fires once, slightly before fully in view. */
export function Reveal({
	children,
	delay = 0,
	className,
}: PropsWithChildren<{ delay?: number; className?: string }>) {
	return (
		<motion.div
			className={className}
			initial={{ opacity: 0, y: 28 }}
			whileInView={{ opacity: 1, y: 0 }}
			viewport={{ once: true, margin: "-12% 0px" }}
			transition={{ duration: 0.7, delay, ease: EASE }}
		>
			{children}
		</motion.div>
	);
}

/** Small mono production tag, e.g. "SC 03 · TK 02". */
export function SceneTag({
	children,
	className,
}: PropsWithChildren<{ className?: string }>) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em]",
				className,
			)}
		>
			{children}
		</span>
	);
}

/** Film-credit eyebrow above section headings. */
export function Eyebrow({
	children,
	className,
}: PropsWithChildren<{ className?: string }>) {
	return (
		<p
			className={cn(
				"font-mono text-[11px] uppercase tracking-[0.32em] text-muted-foreground",
				className,
			)}
		>
			{children}
		</p>
	);
}

/** Registration/crop marks in the four corners of a frame. */
export function FrameCorners({ className }: { className?: string }) {
	const corner = "absolute size-3.5 border-white/25";
	return (
		<div
			className={cn("pointer-events-none absolute inset-2 z-10", className)}
			aria-hidden
		>
			<span className={cn(corner, "top-0 left-0 border-t border-l")} />
			<span className={cn(corner, "top-0 right-0 border-t border-r")} />
			<span className={cn(corner, "bottom-0 left-0 border-b border-l")} />
			<span className={cn(corner, "bottom-0 right-0 border-b border-r")} />
		</div>
	);
}

/**
 * A "footage" frame: dark screen, grain, vignette, corner marks, and an
 * optional slate line (top-left) + timecode (bottom-right).
 */
export function Screen({
	children,
	slate,
	timecode,
	className,
	innerClassName,
}: PropsWithChildren<{
	slate?: string;
	timecode?: string;
	className?: string;
	innerClassName?: string;
}>) {
	return (
		<div
			className={cn(
				"relative overflow-hidden rounded-lg bg-[hsl(240,4%,5%)] ring-1 ring-border",
				className,
			)}
		>
			{/* Grain */}
			<div
				className="pointer-events-none absolute inset-0 z-10 opacity-[0.05]"
				style={{ backgroundImage: GRAIN_URI }}
				aria-hidden
			/>
			{/* Vignette */}
			<div
				className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(ellipse_90%_80%_at_50%_45%,transparent_55%,rgba(0,0,0,0.55))]"
				aria-hidden
			/>
			<FrameCorners />
			{slate ? (
				<SceneTag className="absolute top-4 left-5 z-20 text-white/45">
					{slate}
				</SceneTag>
			) : null}
			{timecode ? (
				<SceneTag className="absolute bottom-3.5 right-5 z-20 text-white/35">
					{timecode}
				</SceneTag>
			) : null}
			<div className={cn("relative", innerClassName)}>{children}</div>
		</div>
	);
}
