/**
 * Audio backend registration barrel.
 *
 * No audio backend is registered for the beta — neither ElevenLabs Music nor
 * fal MMAudio has a funded key, and there is no Google/Seedance audio-gen
 * equivalent to fall back to. Both adapters are real, complete code (see
 * their file headers); re-add their `registerBackend` calls once a provider
 * is actually funded.
 */

export function registerAudioBackends(): void {
	// Intentionally empty — see file header.
}
