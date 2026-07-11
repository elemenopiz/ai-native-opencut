"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SparklesIcon,
	ArrowTurnBackwardIcon,
} from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";

/** The three enhance modes, matching the endpoint's contract. */
export type EnhanceMode = "image" | "video" | "director";

/**
 * The compact context slice a surface can cheaply supply. Everything is optional
 * — the endpoint treats missing context as "none", so a surface only passes what
 * it already has in hand (no new fetches).
 */
export interface EnhanceContext {
	styleBible?: string;
	brief?: string;
	assetNotes?: string[];
	persona?: string;
}

interface EnhancePromptButtonProps {
	/** Read the current field text at click time (not captured on render). */
	getPrompt: () => string;
	/** Replace the field text with the enhanced (or, on undo, original) value. */
	setPrompt: (next: string) => void;
	/** Which prompt dialect to target. */
	mode: EnhanceMode;
	/** Optional: the reference context to weave in, gathered lazily at click time. */
	getContext?: () => EnhanceContext | undefined;
	/** Extra classes for positioning inside/adjacent to a textarea. */
	className?: string;
}

// ── "provider not configured" session cache ──────────────────────────────────
// The endpoint returns 503 `enhance_not_configured` when no provider key is set.
// There is no local fallback for enhancement, so once we learn that, every button
// hides for the rest of the session. A tiny external store so all mounted buttons
// react to the first 503 without prop-drilling.

let notConfigured = false;
const listeners = new Set<() => void>();

function markNotConfigured() {
	if (notConfigured) return;
	notConfigured = true;
	for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

function useNotConfigured(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => notConfigured,
		() => notConfigured,
	);
}

type EnhanceState = "idle" | "loading";

/**
 * A compact sparkle button that rewrites the adjacent prompt field into a
 * detailed, generation-ready prompt via `/api/llm/enhance-prompt`, then shows an
 * inline "Enhanced · Undo" affordance. It NEVER submits the form — it only
 * replaces the field text, so the user reads, edits, and decides.
 *
 * State machine: idle → loading → enhanced (Undo shown). Undo restores the exact
 * pre-enhance text. Re-pressing Enhance runs again from the CURRENT field content;
 * the stored "original" is only refreshed when there is no pending undo (so the
 * original always points at what the user last typed themselves, never at an
 * enhanced-then-edited value).
 */
export function EnhancePromptButton({
	getPrompt,
	setPrompt,
	mode,
	getContext,
	className,
}: EnhancePromptButtonProps) {
	const hidden = useNotConfigured();
	const [state, setState] = useState<EnhanceState>("idle");
	// True once we've enhanced and not yet undone — Undo stays available even if
	// the user hand-edits the enhanced text afterward.
	const [canUndo, setCanUndo] = useState(false);
	// The exact user-authored text to restore on Undo.
	const originalRef = useRef("");

	const enhance = useCallback(async () => {
		if (state === "loading") return;
		const current = getPrompt().trim();
		if (!current) return;

		// Refresh the undo anchor only when there's no pending undo — so a second
		// Enhance re-enhances the current text but Undo still points at the user's
		// own last draft, not an enhanced one.
		if (!canUndo) originalRef.current = getPrompt();

		setState("loading");
		try {
			const res = await fetch("/api/llm/enhance-prompt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: current,
					mode,
					context: getContext?.() ?? undefined,
				}),
			});
			if (res.status === 503) {
				const data = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
				if (data?.error === "enhance_not_configured") markNotConfigured();
				return;
			}
			if (!res.ok) return;
			const data = (await res.json()) as { enhanced?: string };
			const enhanced = data.enhanced?.trim();
			if (!enhanced) return;
			setPrompt(enhanced);
			setCanUndo(true);
		} catch {
			// Network/parse failure — silently leave the field untouched. The button
			// returns to idle so the user can retry.
		} finally {
			setState("idle");
		}
	}, [state, canUndo, getPrompt, setPrompt, mode, getContext]);

	const undo = useCallback(() => {
		setPrompt(originalRef.current);
		setCanUndo(false);
	}, [setPrompt]);

	if (hidden) return null;

	const loading = state === "loading";

	return (
		<span className={cn("inline-flex items-center gap-1", className)}>
			<button
				type="button"
				onClick={enhance}
				disabled={loading}
				title="Enhance prompt"
				aria-label="Enhance prompt"
				className={cn(
					"inline-flex size-6 items-center justify-center rounded text-muted-foreground",
					"transition-colors hover:text-foreground hover:bg-accent",
					"disabled:opacity-60 disabled:cursor-default",
				)}
			>
				{loading ? (
					<Spinner className="size-3.5" />
				) : (
					<HugeiconsIcon icon={SparklesIcon} className="size-3.5" />
				)}
			</button>
			{canUndo && !loading && (
				<button
					type="button"
					onClick={undo}
					title="Undo enhancement — restore your original prompt"
					className="inline-flex items-center gap-0.5 rounded px-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
				>
					<HugeiconsIcon icon={ArrowTurnBackwardIcon} className="size-3" />
					Enhanced · Undo
				</button>
			)}
		</span>
	);
}
