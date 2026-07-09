// Adapted from palmier-io/sixsevenstudio (MIT). See THIRD_PARTY_NOTICES.
/**
 * Consistency prompt builder — ports sixsevenstudio's "global context" trick
 * (`src/lib/ai-sdk.ts`'s `SYSTEM_PROMPT` `<global_context>` block) to our
 * Director.
 *
 * sixsevenstudio's insight: each scene is an INDEPENDENT Sora API call with no
 * shared state, so it prepends one reusable STYLE + CHARACTERS + SETTING
 * paragraph to every per-scene prompt to keep identity/style from drifting
 * shot to shot. Our Director has the exact same shape of problem — each slot
 * in `director-api.ts`'s `runTakesForSlot` is its own `generateVideo`/
 * `renderPersonaStill` call (see `provider-adapter.ts`, `persona-still.ts`) —
 * so the same fix applies: build ONE context block per reel/storyboard and
 * fold it into every shot's prompt before it reaches the provider.
 *
 * This deliberately COMPLEMENTS, not replaces, what we already have:
 *  - Persona identity + seed-lock (`@/stores/persona-store`'s `Persona`,
 *    `GenerationSpec.personaId`/`seed`/`seedLocked`) anchor ONE character's
 *    face via reference images + a locked seed — the strongest signal we
 *    have, and this module never overrides it.
 *  - `composePersonaScenePrompt`/`composePersonaVideoPrompt`
 *    (`@/lib/studio/personas`) already weave the ACTIVE persona's descriptor
 *    into the still + video prompts for that one character.
 *  - `composePromptWithCamera` (`@/lib/studio/camera-presets`) weaves in the
 *    camera-motion fragment.
 *
 * What's missing today: `GenerationSpec` carries at most ONE `personaId`, and
 * nothing textually pins STYLE (color grade, film stock, mood) or SETTING
 * (location, time of day, lighting) across an entire multi-shot reel, nor
 * describes secondary/background characters that have no persona/reference
 * image of their own. That's the gap this module fills — a reel-level
 * `ConsistencyContext` that a wiring pass prepends ahead of the
 * camera/persona fragments so every independent generation call in a
 * storyboard sees the same style/cast/location paragraph, mirroring
 * sixsevenstudio's technique but sourced from OUR persona model instead of
 * free-text.
 *
 * WIRED (mirrors sixsevenstudio's `read_global_context`/`update_global_context`
 * tool pair):
 *  - `director-api.ts` exposes `getConsistencyContext`/`setConsistencyContext`
 *    verbs and surfaces the current block on `ReelSnapshot.consistency`;
 *    `agent.ts` lists both in `TOOLS`/`TOOL_DOCS`.
 *  - `studio-executor.ts`'s `createStudioExecutor().run()` applies
 *    `withConsistencyContext` to `spec.prompt` right before
 *    `generateTakeMedia`, using the editor-keyed registry below.
 */

import type { EditorCore } from "@/core";
import type { Persona } from "@/stores/persona-store";

/** One character's textual identity anchor, reel-scoped (not just the active persona). */
export interface ConsistencyCharacter {
	/** Display name or role (e.g. "The Stranger"), matching sixsevenstudio's convention. */
	name: string;
	/** Detailed physical descriptor — reuse `Persona.descriptor` when one exists. */
	descriptor: string;
	/** Set when this character is backed by a locked persona (identity + seed). */
	personaId?: string;
	/** This character's locked vocal identity, restated on every TTS beat via
	 *  `voiceLockFragment` — the audio analog of `descriptor`. Settable through
	 *  the Director's existing `setConsistencyContext` verb (`extraCharacters`). */
	voice?: VoiceProfile;
}

/** The reusable STYLE + CHARACTERS + SETTING block, held once per reel/storyboard. */
export interface ConsistencyContext {
	/** Visual tone, color grade, film stock, realism level — held constant across shots. */
	style: string;
	/** All characters appearing anywhere in the reel, personas or not. */
	characters: ConsistencyCharacter[];
	/** Primary location(s): environment, architecture, lighting, time of day, atmosphere. */
	setting: string;
}

const DEFAULT_STYLE =
	"Cinematic photorealism, natural lighting, consistent color grade across shots.";

export interface BuildConsistencyContextInput {
	/** Free-text style paragraph; falls back to `DEFAULT_STYLE` (matches our "realistic by default" convention). */
	style?: string;
	/** Free-text setting paragraph for the reel's primary location(s). */
	setting?: string;
	/** Personas already carrying a locked descriptor — pulled straight from `usePersonaStore`, not re-authored. */
	personas?: Pick<Persona, "id" | "name" | "descriptor">[];
	/** Characters with no persona/reference image (extras, background cast) — described in text only. */
	extraCharacters?: ConsistencyCharacter[];
}

/**
 * Assemble a reel-level `ConsistencyContext` from our OWN data — persona
 * descriptors (already authored for reference-conditioned stills) plus any
 * extra characters and a style/setting the director agent or user supplies.
 * Never invents persona text: `descriptor` is passed through verbatim so it
 * stays the single source of truth for that character's identity.
 */
export function buildConsistencyContext(
	input: BuildConsistencyContextInput,
): ConsistencyContext {
	const fromPersonas: ConsistencyCharacter[] = (input.personas ?? []).map(
		(p) => ({ name: p.name, descriptor: p.descriptor, personaId: p.id }),
	);
	return {
		style: (input.style ?? DEFAULT_STYLE).trim() || DEFAULT_STYLE,
		characters: [...fromPersonas, ...(input.extraCharacters ?? [])],
		setting: (input.setting ?? "").trim(),
	};
}

/**
 * Render the context as the STYLE/CHARACTERS/SETTING block text, mirroring
 * sixsevenstudio's `<global_context>` structure (three labeled sections, one
 * character per line with its full descriptor).
 */
export function serializeConsistencyContext(context: ConsistencyContext): string {
	const lines: string[] = [`STYLE: ${context.style || DEFAULT_STYLE}`];

	if (context.characters.length > 0) {
		lines.push("CHARACTERS:");
		for (const character of context.characters) {
			lines.push(`- ${character.name}: ${character.descriptor}`);
		}
	}

	if (context.setting) {
		lines.push(`SETTING: ${context.setting}`);
	}

	return lines.join("\n");
}

/**
 * Prepend the serialized global context ahead of a single shot's prompt, so
 * identity/style/setting survive even though each shot is an independent
 * provider call. Apply this BEFORE `composePromptWithCamera` and
 * `composePersonaVideoPrompt` (in that order: reel context → camera
 * fragment → persona anchor), since persona/camera fragments are the
 * strongest, most shot-specific signal and should read last, closest to the
 * scene description they modify.
 */
export function withConsistencyContext(
	shotPrompt: string,
	context: ConsistencyContext,
): string {
	const block = serializeConsistencyContext(context);
	const trimmedShot = shotPrompt.trim();
	if (!block.trim()) return trimmedShot;
	return `${block}\n\nSHOT: ${trimmedShot}`;
}

// ── Editor-keyed registry ────────────────────────────────────────────────────
//
// One reel has one consistency context, held for the lifetime of the editor
// instance (session state, not persisted). Keyed by `EditorCore` reference so
// `director-api.ts`'s `setConsistencyContext`/`getConsistencyContext` verbs
// and `studio-executor.ts`'s per-take `withConsistencyContext` application
// share the same value without threading it through both factories' call
// signatures. A `WeakMap` means it's naturally GC'd with the editor.

const contextByEditor = new WeakMap<EditorCore, ConsistencyContext>();

/** Read the reel-level consistency context set for this editor, if any. */
export function getStoredConsistencyContext(
	editor: EditorCore,
): ConsistencyContext | undefined {
	return contextByEditor.get(editor);
}

/** Set (or clear, passing `undefined`) the consistency context for this editor. */
export function storeConsistencyContext(
	editor: EditorCore,
	context: ConsistencyContext | undefined,
): void {
	if (context) contextByEditor.set(editor, context);
	else contextByEditor.delete(editor);
}

// ── Voice-lock across beats ──────────────────────────────────────────────────
//
// sixsevenstudio has no audio/dialogue path, but the identical technique
// applies to ours: restate the character's voice profile in every beat's
// TTS/dialogue prompt so pitch, tone, accent, and pace don't drift
// take-to-take, exactly like restating CHARACTERS keeps faces from drifting
// shot-to-shot.
//
// WIRED: the TTS pipeline is `aiClient.generateSpeech`/`generateSpeechBlob`
// (`@/lib/ai-client` → POST /api/tts/generate) plus `aiClient.cloneVoice` for
// cloned-voice refs. Voice-lock is applied per beat in
// `lib/studio/generate-voiceover-take.ts` — `runVoiceoverTake` resolves the
// beat's `VoiceProfile` (spec override, else the consistency context's
// character matching `spec.personaId` via `getVoiceProfileForPersona` below),
// serializes it with `voiceLockFragment`, records it on the take's
// `GenerationSpec.voiceLock` (provenance, next to seed-lock), and
// `generateVoiceoverTakeMedia` prepends it to the dialogue before submitting —
// the same shape as `withConsistencyContext` per shot above.

/** A character's locked vocal identity, restated every beat. */
export interface VoiceProfile {
	pitch: string;
	tone: string;
	accent: string;
	pace: string;
}

/** Render a voice-lock fragment to prepend/append to a per-beat dialogue prompt. */
export function voiceLockFragment(profile: VoiceProfile): string {
	const parts = [
		profile.pitch && `pitch: ${profile.pitch}`,
		profile.tone && `tone: ${profile.tone}`,
		profile.accent && `accent: ${profile.accent}`,
		profile.pace && `pace: ${profile.pace}`,
	].filter((p): p is string => Boolean(p));
	if (parts.length === 0) return "";
	return `Voice consistency — ${parts.join(", ")}.`;
}

/**
 * Prepend the voice-lock fragment ahead of a single beat's dialogue, mirroring
 * `withConsistencyContext` for shots: each TTS beat is an independent provider
 * call, so the vocal identity has to be restated per beat.
 */
export function withVoiceLock(
	dialoguePrompt: string,
	profile: VoiceProfile,
): string {
	const fragment = voiceLockFragment(profile);
	const trimmed = dialoguePrompt.trim();
	if (!fragment) return trimmed;
	return `${fragment}\n\n${trimmed}`;
}

/**
 * Resolve the locked voice for a persona-backed character from this editor's
 * stored consistency context — the voiceover twin of how `withConsistencyContext`
 * restates that same character's visual `descriptor` per shot.
 */
export function getVoiceProfileForPersona(
	editor: EditorCore,
	personaId: string,
): VoiceProfile | undefined {
	const context = contextByEditor.get(editor);
	return context?.characters.find((c) => c.personaId === personaId)?.voice;
}
