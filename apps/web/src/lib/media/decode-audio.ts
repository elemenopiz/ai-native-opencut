/**
 * Shared browser audio decode: media `File` → mono 16 kHz Float32 PCM.
 *
 * Extracted from the on-device Whisper path so both transcription and auto-cut
 * (silence analysis) share ONE decode implementation. Uses Web Audio
 * `decodeAudioData` for the container/codec demux, then an `OfflineAudioContext`
 * to downmix to mono and resample to 16 kHz. 16 kHz mono is plenty for both
 * speech recognition and loudness (max-abs) analysis, and avoids holding a
 * full-rate multi-channel buffer in memory.
 */

/** Sample rate every decode here resamples to. */
export const DECODE_SAMPLE_RATE = 16000;

/** Decode any supported media File to a mono 16 kHz Float32Array. */
export async function decodeToMono16k(file: File): Promise<Float32Array> {
	const arrayBuffer = await file.arrayBuffer();
	const AudioCtor =
		window.AudioContext ||
		// biome-ignore lint/suspicious/noExplicitAny: Safari prefix.
		(window as any).webkitAudioContext;
	const decodeCtx = new AudioCtor();
	let audioBuffer: AudioBuffer;
	try {
		audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
	} finally {
		decodeCtx.close?.();
	}

	if (
		audioBuffer.sampleRate === DECODE_SAMPLE_RATE &&
		audioBuffer.numberOfChannels === 1
	) {
		return audioBuffer.getChannelData(0).slice();
	}

	// Downmix to mono + resample to 16 kHz by rendering through an offline graph.
	const frames = Math.max(
		1,
		Math.ceil(audioBuffer.duration * DECODE_SAMPLE_RATE),
	);
	const offline = new OfflineAudioContext(1, frames, DECODE_SAMPLE_RATE);
	const source = offline.createBufferSource();
	source.buffer = audioBuffer;
	source.connect(offline.destination);
	source.start();
	const rendered = await offline.startRendering();
	return rendered.getChannelData(0).slice();
}
