/**
 * Consistency-context folding for the NON-Director generation paths.
 *
 * `studio-executor.ts` (the Director agent's `GenerateExecutor`) already folds
 * the reel-level STYLE/CHARACTERS/SETTING block (`lib/director/consistency-prompt.ts`)
 * into every take's prompt before it reaches the provider — because each take is
 * an INDEPENDENT provider call with no shared state, identity/style has to be
 * restated per-shot or it drifts shot to shot. Two other call sites submit takes
 * through the exact same provider pipeline but never fold the context:
 *
 *  - `useStudioGeneration().generate()` (`hooks/use-studio-generation.ts`) — the
 *    manual Generate panel, which POSTs `/api/studio/generate` directly.
 *  - `useSlotGeneration().runOneTake()` (`hooks/use-slot-generation.ts`) — the
 *    Rerun/Remix/"Generate all" path, which calls `generateTakeMedia` directly.
 *
 * This module is the shared, pure fold used by both, so the manual/rerun paths
 * produce the identical STYLE/CHARACTERS/SETTING-prefixed prompt the Director
 * path already does, without duplicating `withConsistencyContext`'s formatting.
 */

import type { EditorCore } from "@/core";
import {
	getStoredConsistencyContext,
	withConsistencyContext,
	type ConsistencyContext,
} from "@/lib/director/consistency-prompt";
import type { Persona } from "@/stores/persona-store";
import type { GenerationSpec } from "@/types/timeline";

/**
 * Resolve the active reel-level consistency context for an editor.
 *
 * Reads the session `WeakMap` first (`getStoredConsistencyContext`) — the fast
 * path, populated by `hydrateDirectorStateFromBible` on editor mount
 * (`components/providers/editor-provider.tsx`) and kept live by the Director's
 * `setConsistencyContext` verb. Falls back to the persisted Project Bible
 * (`editor.project.getProjectBible()?.consistencyContext`) so a caller that
 * runs before hydration completes, or an `EditorCore` used outside the normal
 * `EditorProvider` mount flow (headless tests, MCP tooling), still sees the
 * reel's set context instead of silently folding nothing.
 */
export function resolveConsistencyContext(
	editor: EditorCore,
): ConsistencyContext | undefined {
	const live = getStoredConsistencyContext(editor);
	if (live) return live;
	return editor.project.getProjectBible()?.consistencyContext;
}

/**
 * Shape of `withConsistencyContext`'s output: the serialized block always
 * starts with `STYLE:` and hands off to the shot text after a blank line and
 * a `SHOT:` marker (`consistency-prompt.ts`'s `serializeConsistencyContext` +
 * `withConsistencyContext`). Used to detect an already-folded prompt so a
 * remix of a take whose prompt was folded once doesn't get folded again.
 */
const FOLDED_PROMPT_PATTERN = /^STYLE:[\s\S]*\n\nSHOT:/;

/** True when `prompt` already carries a folded STYLE/CHARACTERS/SETTING block. */
export function isConsistencyFolded(prompt: string): boolean {
	return FOLDED_PROMPT_PATTERN.test(prompt.trim());
}

/**
 * Fold `context` into `prompt`, idempotently. No-ops (returns `prompt`
 * unchanged) when there's no context to fold, or when `prompt` already carries
 * a folded block — e.g. remixing a take generated on the Director path, or a
 * second rerun of an already-folded slot spec. Otherwise delegates the actual
 * formatting to `withConsistencyContext` so there is exactly one place that
 * knows the block's shape.
 */
export function foldConsistencyIntoPrompt(
	prompt: string,
	context: ConsistencyContext | undefined,
): string {
	if (!context) return prompt;
	if (isConsistencyFolded(prompt)) return prompt;
	return withConsistencyContext(prompt, context);
}

/**
 * `foldConsistencyIntoPrompt`'s `GenerationSpec` twin — resolves the editor's
 * consistency context and folds it into `spec.prompt`, returning a NEW spec
 * (or the same reference when nothing changed, so callers can cheaply check
 * `folded === spec` if useful). Voiceover specs (`spec.kind === "voiceover"`)
 * are passed through untouched: the visual STYLE/CHARACTERS/SETTING block
 * doesn't belong in spoken dialogue text — the audio analog is
 * `withVoiceLock`/`getVoiceProfileForPersona` in `consistency-prompt.ts`,
 * applied by `generate-voiceover-take.ts`, not this module.
 */
export function foldConsistencyIntoSpec(
	spec: GenerationSpec,
	editor: EditorCore,
): GenerationSpec {
	if (spec.kind === "voiceover") return spec;
	const context = resolveConsistencyContext(editor);
	const folded = foldConsistencyIntoPrompt(spec.prompt, context);
	if (folded === spec.prompt) return spec;
	return { ...spec, prompt: folded };
}

// ── Persona-seed threading (manual single-shot generate) ────────────────────
//
// `personas.seed` (`stores/persona-store.ts`) is captured at persona creation
// but never read downstream — `/api/studio/generate/route.ts` deliberately
// does NOT fall back to it, because a batch of unlocked drafts needs each
// take to get its own fresh random seed to actually vary. That rationale only
// applies to batches: a lone single-shot generation for a locked persona has
// no siblings to differentiate from, so reusing the persona's stored seed
// makes repeat single-shot generations of that persona reproduce the same
// shot instead of drifting on a fresh random seed every time.

/** Inputs for the persona-seed threading rule — mirrors the manual Generate
 *  panel's `generate()` params plus the resolved persona record, if any. */
export interface PersonaSeedOverrideParams {
	personaId?: string;
	/** How many takes this generate() call is one of. Threading only applies
	 *  to a lone take — `routeCompletedTake`'s own single/batch boundary. */
	batchSize: number;
	/** An explicit seed the caller already supplied — always wins. */
	seed?: number;
	persona: Pick<Persona, "seed"> | undefined;
}

/**
 * Decide whether a manual generate() call should send the persona's stored
 * seed. Returns the seed to use, or `undefined` when the rule doesn't apply
 * (no persona, a batch of 2+, an explicit seed already set, or the persona
 * has no locked seed) — callers should leave the request's `seed` field as
 * the caller supplied it (i.e. absent) in every `undefined` case.
 */
export function resolvePersonaSeedOverride(
	params: PersonaSeedOverrideParams,
): number | undefined {
	if (!params.personaId) return undefined;
	if (params.batchSize > 1) return undefined;
	if (params.seed != null) return undefined;
	if (!params.persona || params.persona.seed == null) return undefined;
	return params.persona.seed;
}
