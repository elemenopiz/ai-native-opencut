"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SparklesIcon,
	ArrowTurnBackwardIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
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

// ── @mention handle preservation ──────────────────────────────────────────
// Omni/persona surfaces let users insert literal handles (@Image1, @Video2,
// ...) that resolve to attached reference media server-side. The rewrite is a
// free-form LLM call with no structural awareness of these tokens, so nothing
// guarantees it keeps one verbatim. Belt-and-suspenders: the server prompt asks
// it to preserve them (see enhance-prompt/route.ts), and this is the backstop
// — if a handle present in the original text is missing from the rewrite, it
// gets appended back so a reference never silently drops out from under the
// user. ONLY the exact shapes generation-form.tsx mints (@Image<n>/@Video<n>):
// this button is shared with surfaces that have no mention system (Director,
// image gen, B-roll), where a looser pattern would false-positive on ordinary
// @-words the user typed and force them into the rewrite.
const HANDLE_RE = /@(?:Image|Video)\d+/g;

// A plain `.includes(handle)` would let a longer handle satisfy a shorter
// one's presence check (e.g. "@Image10" in the text would count as "@Image1"
// surviving, since the latter is a literal substring of the former) — so the
// presence check must reject a match immediately followed by another digit.
function handleSurvives(handle: string, text: string): boolean {
	const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${escaped}(?!\\d)`).test(text);
}

export function restoreDroppedHandles(
	original: string,
	enhanced: string,
): string {
	const originalHandles = [...new Set(original.match(HANDLE_RE) ?? [])];
	if (originalHandles.length === 0) return enhanced;
	const missing = originalHandles.filter((h) => !handleSurvives(h, enhanced));
	return missing.length ? `${enhanced} ${missing.join(" ")}` : enhanced;
}

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
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as {
					message?: string;
				} | null;
				if (res.status === 401) {
					toast.error("Log in to enhance prompts.");
				} else if (res.status === 429) {
					toast.error("Rate limit reached — try again in a minute.");
				} else {
					toast.error(data?.message || "Prompt enhancement failed.");
				}
				return;
			}
			const data = (await res.json()) as { enhanced?: string };
			const enhanced = data.enhanced?.trim();
			if (!enhanced) return;
			setPrompt(restoreDroppedHandles(current, enhanced));
			setCanUndo(true);
		} catch {
			// Network/parse failure — the button returns to idle so the user can retry.
			toast.error("Prompt enhancement failed.");
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
