import type { EditorCore } from "@/core";
import { aiClient } from "@/lib/ai-client";
import {
	getVoiceProfileForPersona,
	voiceLockFragment,
	type VoiceProfile,
} from "@/lib/director/consistency-prompt";
import { assertReferenceUsable } from "@/stores/voice-consent-store";
import { processMediaAssets } from "@/lib/media/processing";
import { generateUUID } from "@/utils/id";
import type { GenerationSpec, TimelineElement } from "@/types/timeline";

/**
 * TTS voiceovers as FIRST-CLASS TAKES — the audio twin of
 * `lib/studio/generate-take.ts`. A voiceover generation is recorded on its
 * slot exactly like a visual one: a `Take` whose `spec` carries full
 * provenance — `model`, `prompt` (the spoken text), `voice`/`voiceRef` (the
 * vocal identity), `seed`/`seedLocked`, and `voiceLock` (the serialized
 * `voiceLockFragment` actually prepended to the dialogue) — so a beat can be
 * re-generated deterministically and its vocal identity never drifts
 * take-to-take (seed-lock's audio analog).
 *
 * Pipeline: resolve voice-lock → `aiClient.generateSpeechBlob`
 * (POST /api/tts/generate) → import the audio through the normal media
 * pipeline → patch the take `ready` with its `mediaId`, using the same
 * `addTakeToElement`/`updateTake`/`selectTake` bookkeeping visual takes use.
 */

/** Terminal result of generating one voiceover take's media. */
export type GenerateVoiceoverTakeResult =
	| { status: "ready"; mediaId: string; seed?: number }
	| { status: "failed"; error: string };

/** The local TTS service's default model (`services/tts-service`). */
export const DEFAULT_TTS_MODEL = "xtts_v2";

/**
 * Build a voiceover `GenerationSpec`. Reuses the shared spec type (so the
 * existing `Take` model and timeline bookkeeping apply unchanged) with
 * `kind: "voiceover"` as the discriminator; the visual-only required fields
 * are filled with inert defaults and ignored by the TTS path.
 */
export function makeVoiceoverSpec({
	text,
	model,
	voice,
	voiceRef,
	language,
	personaId,
	seed,
	seedLocked,
	voiceLock,
}: {
	/** The spoken dialogue — stored as the spec's `prompt` (provenance). */
	text: string;
	model?: string;
	voice?: string;
	voiceRef?: string;
	language?: string;
	personaId?: string;
	seed?: number;
	seedLocked?: boolean;
	voiceLock?: string;
}): GenerationSpec {
	return {
		kind: "voiceover",
		prompt: text,
		model: model ?? DEFAULT_TTS_MODEL,
		voice,
		voiceRef,
		language: language ?? "en",
		personaId,
		seed,
		seedLocked,
		voiceLock,
		// Inert visual fields — required by the shared spec shape, unused by TTS.
		mode: "text-to-video",
		resolution: "720p",
		orientation: "landscape",
		duration: 0,
	};
}

/**
 * Resolve the voice-lock fragment for a spec: an explicit `spec.voiceLock`
 * wins; otherwise the consistency context's character backing
 * `spec.personaId` supplies its `VoiceProfile` (see
 * `getVoiceProfileForPersona`), serialized via `voiceLockFragment`. Mirrors
 * how `studio-executor.ts` folds `withConsistencyContext` into each shot.
 */
export function resolveVoiceLock(
	editor: EditorCore,
	spec: GenerationSpec,
	voiceProfile?: VoiceProfile,
): string | undefined {
	if (spec.voiceLock) return spec.voiceLock;
	const profile =
		voiceProfile ??
		(spec.personaId
			? getVoiceProfileForPersona(editor, spec.personaId)
			: undefined);
	if (!profile) return undefined;
	const fragment = voiceLockFragment(profile);
	return fragment || undefined;
}

/** Import a finished voiceover's audio through the normal media pipeline and
 *  register it as a durable project MediaAsset. Exported so the Voiceover UI's
 *  non-Take paths (full-voiceover "Add to timeline" and the cloud per-segment
 *  branch) can land audio the same durable way as the first-class Take pipeline,
 *  instead of an ephemeral `blob:` object URL that dies on reload/export. */
export async function importAudioAsset(
	editor: EditorCore,
	projectId: string,
	blob: Blob,
	name: string,
): Promise<{ mediaId: string }> {
	const fileName = name.toLowerCase().endsWith(".wav") ? name : `${name}.wav`;
	const type = blob.type.startsWith("audio/") ? blob.type : "audio/wav";
	const file = new File([blob], fileName, { type });
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) throw new Error("processing produced no asset");
	const mediaId = await editor.media.addMediaAsset({
		projectId,
		asset: processed,
	});
	return { mediaId };
}

/**
 * The provider pipeline for one voiceover take: submit the beat's dialogue —
 * with its voice-lock fragment prepended (`spec.voiceLock`, pre-resolved by
 * `runVoiceoverTake`) — via `aiClient.generateSpeechBlob`, then import the
 * audio as a project MediaAsset. Pure (no timeline/take bookkeeping), same
 * split as `generateTakeMedia`.
 */
export async function generateVoiceoverTakeMedia({
	editor,
	projectId,
	spec,
}: {
	editor: EditorCore;
	projectId: string;
	spec: GenerationSpec;
}): Promise<GenerateVoiceoverTakeResult> {
	try {
		const dialogue = spec.prompt.trim();
		if (!dialogue) return { status: "failed", error: "No dialogue text" };
		// CONSENT GATE (Flow D #1): a cloned-voice reference may only be spoken once
		// its profile is `consented`. Throws for a pending/revoked clone — caught
		// below and surfaced as a failed take, so an unconsented clone never reaches
		// the TTS backend. A built-in speaker / unknown ref passes.
		assertReferenceUsable(spec.voiceRef);
		// Voice-lock: restate the character's vocal identity ahead of every
		// beat's dialogue — the per-beat analog of `withConsistencyContext`.
		const text = spec.voiceLock ? `${spec.voiceLock}\n\n${dialogue}` : dialogue;

		const blob = await aiClient.generateSpeechBlob({
			text,
			language: spec.language ?? "en",
			// A cloned-voice reference wins over a built-in speaker name.
			speakerWav: spec.voiceRef,
			speaker: spec.voiceRef ? undefined : spec.voice,
		});

		const { mediaId } = await importAudioAsset(
			editor,
			projectId,
			blob,
			dialogue.slice(0, 40) || "voiceover",
		);
		return { status: "ready", mediaId, seed: spec.seed };
	} catch (err) {
		return {
			status: "failed",
			error: err instanceof Error ? err.message : "Voiceover generation failed",
		};
	}
}

/** True if the slot has no active take chosen yet (mirrors `useSlotGeneration`). */
function slotHasNoActiveTake(editor: EditorCore, elementId: string): boolean {
	const element = editor.timeline
		.getTracks()
		.flatMap((track) => track.elements as TimelineElement[])
		.find((el) => el.id === elementId);
	const generative = element as { activeTakeId?: string } | undefined;
	return !generative?.activeTakeId;
}

/**
 * Generate one voiceover take for a slot and fold the result into its `takes`
 * — the audio twin of `useSlotGeneration`'s `runOneTake`, kept React-free so
 * both UI and Director paths can call it. Resolves the beat's voice-lock
 * UP FRONT and records it on the stored spec, so the take's provenance is the
 * exact request that produced it.
 */
export async function runVoiceoverTake({
	editor,
	projectId,
	elementId,
	spec,
	voiceProfile,
}: {
	editor: EditorCore;
	projectId: string;
	elementId: string;
	spec: GenerationSpec;
	/** Explicit vocal identity for this beat; defaults to the consistency
	 *  context's character matching `spec.personaId`. */
	voiceProfile?: VoiceProfile;
}): Promise<{ takeId: string; success: boolean }> {
	const voiceLock = resolveVoiceLock(editor, spec, voiceProfile);
	const effectiveSpec: GenerationSpec = {
		...spec,
		kind: "voiceover",
		model: spec.model ?? DEFAULT_TTS_MODEL,
		voiceLock,
	};

	const takeId = generateUUID();
	editor.timeline.addTakeToElement({
		elementId,
		take: {
			id: takeId,
			status: "queued",
			spec: effectiveSpec,
			createdAt: Date.now(),
		},
	});
	editor.timeline.updateTake({
		elementId,
		takeId,
		patch: { status: "generating" },
	});

	const result = await generateVoiceoverTakeMedia({
		editor,
		projectId,
		spec: effectiveSpec,
	});
	if (result.status === "failed") {
		editor.timeline.updateTake({
			elementId,
			takeId,
			patch: { status: "failed", error: result.error },
		});
		return { takeId, success: false };
	}

	editor.timeline.updateTake({
		elementId,
		takeId,
		patch: { status: "ready", mediaId: result.mediaId, seed: result.seed },
	});
	// Auto-select the first take to land when nothing is active yet, mirroring
	// visual-slot behavior.
	if (slotHasNoActiveTake(editor, elementId)) {
		editor.timeline.selectTake({ elementId, takeId });
	}
	return { takeId, success: true };
}
