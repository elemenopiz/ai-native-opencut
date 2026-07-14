/**
 * Audio backend registration barrel.
 *
 * Two intentionally non-interchangeable audio backends: MMAudio (video-to-audio
 * "score") and ElevenLabs Music (text-to-music). Both are real, complete code
 * that stays inert until their provider key is set (`isAvailable() === false`).
 * To add one: create `./<provider>.ts` implementing `GenerationBackend`,
 * import it, and call `registerBackend` — no other file changes.
 */

import { registerBackend } from "@/lib/studio/backends/registry";
import { elevenlabsMusicBackend } from "@/lib/studio/backends/audio/elevenlabs-music";
import { falMmaudioBackend } from "@/lib/studio/backends/audio/fal-mmaudio";

export function registerAudioBackends(): void {
	registerBackend(elevenlabsMusicBackend);
	registerBackend(falMmaudioBackend);
}
