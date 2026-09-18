"use client";

import { cn } from "@/utils/ui";

// ----- Director "working" indicators -----
//
// Two small, purely presentational pieces used by the Director chat surface
// while an agent turn is in flight. Both are driven entirely by props — no
// store access, no timers of their own — so the caller's existing busy flag
// (Director's `isThinking` state) stays the single source of truth for
// "is the agent working" rather than either of these keeping a second one.
//
// `TypingDots` is the three-dot "someone is typing" affordance: three
// same-size dots cycling opacity/position, never a spinner (a spinner reads
// as "loading a resource"; dots read as "composing a reply", which is the
// truer picture of an LLM turn). Built on Tailwind's built-in `animate-bounce`
// with staggered `[animation-delay:…]` offsets — the same bracket-delay
// convention already used for the landing page's entrance animations
// (`components/landing/hero.tsx`) — rather than a bespoke keyframe, since
// nothing in `globals.css` already defines a dot-cycle keyframe and
// `animate-bounce` gets the same cycling-dot feel without adding one.
//
// `EditingStatusChip` is the persistent "Byorn is editing" pill: unlike the
// per-turn status row in the transcript (which scrolls with the message
// list and swaps its label as the agent's status changes), this chip's copy
// never changes — it just marks, for as long as `isThinking` is true, that a
// turn is in flight. `glow-generation` (globals.css) is the repo's existing
// "this is actively generating" treatment (see `background-tasks.tsx`,
// `generative-slot-content.tsx`) — reused here rather than inventing a
// second glow effect for the same idea.

/** Three-dot "composing" indicator. Sizing/color are entirely up to the
 *  caller via `className` (it renders in `currentColor`), so it can sit
 *  inside a muted status row or a tinted chip without its own opinion. */
export function TypingDots({ className }: { className?: string }) {
	return (
		<span
			className={cn("inline-flex items-center gap-0.5", className)}
			role="presentation"
			aria-hidden="true"
		>
			<span className="size-1 rounded-full bg-current animate-bounce [animation-delay:0ms]" />
			<span className="size-1 rounded-full bg-current animate-bounce [animation-delay:150ms]" />
			<span className="size-1 rounded-full bg-current animate-bounce [animation-delay:300ms]" />
		</span>
	);
}

/** Persistent "Byorn is editing" pill. Renders unconditionally — the caller
 *  decides whether a turn is in flight and mounts/unmounts it accordingly
 *  (see `DirectorView`'s header, gated on `isThinking`) rather than this
 *  component reading any busy state itself. */
export function EditingStatusChip({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"glow-generation inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary",
				className,
			)}
		>
			<TypingDots className="text-primary" />
			Byorn is editing
		</span>
	);
}
