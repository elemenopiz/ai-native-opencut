import type { EditorCore } from "@/core";
import { generateTakeMedia } from "@/lib/studio/generate-take";
import {
	generateVoiceoverTakeMedia,
	resolveVoiceLock,
} from "@/lib/studio/generate-voiceover-take";
import {
	getStoredConsistencyContext,
	withConsistencyContext,
} from "./consistency-prompt";
import type { GenerateExecutor } from "./types";

/** Fallback frame rate when a project somehow has no fps set. */
const DEFAULT_FPS = 30;

/**
 * THE single seconds→frames conversion site for the Director generation path.
 *
 * Every Director/timeline time value is in SECONDS (see the unit convention in
 * `director-api.ts` / `agent.ts`), and the current provider pipeline
 * (`generate-take.ts` → `/api/studio/generate`) wants `duration` in SECONDS too,
 * so NO conversion is needed today and this helper is intentionally unused by the
 * live path. It exists so that if a future provider/spec field is expressed in
 * FRAMES, there is exactly ONE place that reads the active project's fps and does
 * the math — rather than scattering `* fps` throughout the codebase. fps lives at
 * `project.settings.fps` (not `metadata`).
 */
export function secondsToFrames(seconds: number, editor: EditorCore): number {
	const fps = editor.project.getActiveOrNull()?.settings.fps ?? DEFAULT_FPS;
	return Math.round(seconds * fps);
}

/**
 * A `GenerateExecutor` backed by the real studio provider pipeline
 * (`generateTakeMedia`). This is the concrete generation boundary the Director
 * delegates to — the same engine `useSlotGeneration` uses, so the agent path and
 * the UI path produce takes identically.
 */
export function createStudioExecutor(editor: EditorCore): GenerateExecutor {
	return {
		async run({ spec }) {
			let projectId: string;
			try {
				projectId = editor.project.getActive().metadata.id;
			} catch {
				return { status: "failed", error: "No active project" };
			}
			// Voiceover specs route through the TTS engine, not the visual
			// `/api/studio/generate` path. Resolve the beat's voice-lock (the
			// audio analog of the consistency block) and hand off to the same
			// pure media pipeline `runVoiceoverTake` uses — the Director's take
			// bookkeeping (queued→generating→ready, select) is done by the caller.
			if (spec.kind === "voiceover") {
				const voiceLock = resolveVoiceLock(editor, spec);
				const result = await generateVoiceoverTakeMedia({
					editor,
					projectId,
					spec: { ...spec, voiceLock },
				});
				if (result.status === "failed") {
					return { status: "failed", error: result.error };
				}
				return { status: "ready", mediaId: result.mediaId, seed: result.seed };
			}

			// Fold the reel-level STYLE/CHARACTERS/SETTING block into this shot's
			// prompt, if one is set — each take is an independent provider call,
			// so identity/style has to be restated per-shot (see consistency-prompt.ts).
			const context = getStoredConsistencyContext(editor);
			const effectiveSpec = context
				? { ...spec, prompt: withConsistencyContext(spec.prompt, context) }
				: spec;
			const result = await generateTakeMedia({
				editor,
				projectId,
				spec: effectiveSpec,
			});
			if (result.status === "failed") {
				return { status: "failed", error: result.error };
			}
			return {
				status: "ready",
				mediaId: result.mediaId,
				thumbnailUrl: result.thumbnailUrl,
			};
		},
	};
}
