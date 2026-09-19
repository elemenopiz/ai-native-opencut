/**
 * Audio backend registration barrel.
 *
 * Three intentionally non-interchangeable audio backends: MMAudio
 * (video-to-audio "score"), ElevenLabs Music (text-to-music), and Higgsfield
 * Seed Audio (text-to-SPEECH). All are real, complete code that stays inert
 * until their provider key is set (`isAvailable() === false`). To add one:
 * create `./<provider>.ts` implementing `GenerationBackend`, import it, and
 * call `registerBackend` — no other file changes.
 */

import { registerBackend } from "@/lib/studio/backends/registry";
import { elevenlabsMusicBackend } from "@/lib/studio/backends/audio/elevenlabs-music";
import { falMmaudioBackend } from "@/lib/studio/backends/audio/fal-mmaudio";
import { higgsfieldSeedAudioBackend } from "@/lib/studio/backends/audio/higgsfield-seed-audio";

export function registerAudioBackends(): void {
	registerBackend(elevenlabsMusicBackend);
	registerBackend(falMmaudioBackend);

	// Narration. Registered but NOT yet reachable: `SlotIntent` has no
	// text-to-speech member, so this backend declares `intents: []`, which means
	// the router never auto-routes to it and `POST /api/studio/audio` (whose
	// actions are only "score" | "music") rejects an explicit pin. That is
	// deliberate — mislabelling it as a music model would return speech for a
	// music slot. See the adapter's header for the three-line follow-up that
	// turns it on.
	registerBackend(higgsfieldSeedAudioBackend);
}
