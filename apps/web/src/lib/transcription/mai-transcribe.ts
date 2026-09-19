/**
 * MAI-Transcribe-2 transcription (main-thread orchestrator).
 *
 * Extracts 16 kHz mono Opus audio from a media File in the browser, uploads it
 * to `/api/transcribe` (which relays to MAI-Transcribe-2 on Microsoft Foundry),
 * and returns the same `TranscriptionResult` shape the rest of the app already
 * consumes — so this drops in where on-device Whisper used to sit.
 *
 * WHY EXTRACT CLIENT-SIDE: the source is usually a video file. Uploading the
 * video would burn bandwidth on pixels the speech model discards, and would
 * blow the host body limit within seconds of footage. Extracting audio first
 * turns a 2 GB screen recording into a few megabytes of speech, and reuses the
 * mediabunny decode stack already vendored for ingest/proxy work.
 *
 * WHY CHUNK: the provider accepts 500 MB / 5 hours in one request, but Vercel
 * caps serverless request bodies near 4.5 MB. Anything above
 * `TRANSCRIBE_CHUNK_TARGET_BYTES` is therefore cut into several windows,
 * transcribed in sequence, and stitched with corrected timestamps. See that
 * constant for how this collapses to a single request on Cloudflare.
 */

import {
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	Conversion,
	Input,
	OggOutputFormat,
	Output,
} from "mediabunny";
import {
	TRANSCRIBE_AUDIO_BITRATE,
	TRANSCRIBE_CHUNK_TARGET_BYTES,
	TRANSCRIBE_DIARIZATION_MAX_SECONDS,
	TRANSCRIBE_SAMPLE_RATE,
	toTranscriptionLocale,
} from "@/constants/transcription-constants";
import type { TranscriptionResult, TranscriptionSegment } from "@/types/ai";

export interface MaiTranscribeProgress {
	stage: "extracting" | "transcribing";
	/** 0..1 across the whole job, not within the current stage. */
	progress: number;
	message?: string;
}

export interface MaiTranscribeOptions {
	/** App language code (e.g. "en"), or undefined/"auto" to auto-detect. */
	language?: string;
	/** "clean" drops fillers; "verbatim" keeps every um and uh. */
	style?: "clean" | "verbatim";
	/**
	 * Request speaker labels. Ignored for audio past
	 * TRANSCRIBE_DIARIZATION_MAX_SECONDS, where the provider's diarizer is
	 * documented to fail — see `wantsDiarization`.
	 */
	diarize?: boolean;
	onProgress?: (progress: MaiTranscribeProgress) => void;
	signal?: AbortSignal;
}

/**
 * Injectable seams for tests.
 *
 * Mirrors the `input.convert ?? runMediabunnyConversion` idiom in
 * `lib/media/clip-reference.ts`: the default wiring is the real thing, and a
 * test swaps in stubs so the chunk-window and offset arithmetic can be
 * verified without a browser, a media decoder, or a network.
 */
export interface MaiTranscribeDeps {
	readDuration?: (file: File) => Promise<number>;
	extractAudio?: (
		file: File,
		window?: { start: number; end: number },
	) => Promise<Blob>;
	postChunk?: (
		audio: Blob,
		options: {
			locale?: string;
			style: "clean" | "verbatim";
			diarize: boolean;
			signal?: AbortSignal;
		},
	) => Promise<TranscriptionResult>;
}

/**
 * Failure with a stable `code` the UI can branch on.
 *
 * `message` is written to be shown to a person as-is: no provider names, no
 * env var names, no status codes. The technical detail stays in the code field
 * and the server logs.
 */
export class MaiTranscribeError extends Error {
	constructor(
		message: string,
		readonly code:
			| "not_configured"
			| "unauthorized"
			| "rate_limited"
			| "provider_error"
			| "no_audio"
			| "extract_failed"
			| "aborted",
	) {
		super(message);
		this.name = "MaiTranscribeError";
	}
}

/**
 * Bytes per second of extracted audio, used to pick chunk boundaries BEFORE
 * encoding (so we never have to split an encoded Ogg stream, which isn't
 * byte-sliceable). Opus at this bitrate is ~2 KB/s; the margin covers
 * container overhead and the fact that Opus is variable-rate, so dense speech
 * runs above the nominal bitrate.
 */
const ESTIMATED_BYTES_PER_SECOND = (TRANSCRIBE_AUDIO_BITRATE / 8) * 1.35;

/** Seconds of overlap between adjacent chunks. See `assignsToChunk`. */
const CHUNK_OVERLAP_SECONDS = 2;

/** True when the audio is short enough for the provider's diarizer to work. */
function wantsDiarization(diarize: boolean, durationSeconds: number): boolean {
	return diarize && durationSeconds < TRANSCRIBE_DIARIZATION_MAX_SECONDS;
}

/**
 * Extract one time window of a media File as 16 kHz mono Ogg/Opus.
 *
 * `trim` is omitted entirely for a whole-file extract: passing an explicit
 * 0..duration window would force mediabunny down the trimming path for the
 * common single-chunk case, for no benefit.
 */
async function extractAudioWindow(
	file: File,
	window?: { start: number; end: number },
): Promise<Blob> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});
	try {
		const output = new Output({
			format: new OggOutputFormat(),
			target: new BufferTarget(),
		});

		const conversion = await Conversion.init({
			input,
			output,
			// Pixels are dead weight for speech recognition, and dropping the
			// video track here is what keeps a multi-GB source under the body cap.
			video: { discard: true },
			audio: {
				codec: "opus",
				bitrate: TRANSCRIBE_AUDIO_BITRATE,
				numberOfChannels: 1,
				sampleRate: TRANSCRIBE_SAMPLE_RATE,
			},
			...(window ? { trim: window } : {}),
		});

		const audioSurvived = conversion.utilizedTracks.some((track) =>
			track.isAudioTrack(),
		);
		if (!conversion.isValid || !audioSurvived) {
			throw new MaiTranscribeError(
				"This file doesn't have an audio track to transcribe.",
				"no_audio",
			);
		}

		await conversion.execute();

		const buffer = output.target.buffer;
		if (!buffer) {
			throw new MaiTranscribeError(
				"Couldn't read the audio from this file.",
				"extract_failed",
			);
		}
		return new Blob([buffer], { type: "audio/ogg" });
	} finally {
		input.dispose();
	}
}

/** Read the source duration, preferring cheap metadata over a full scan. */
async function readDuration(file: File): Promise<number> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});
	try {
		const fromMetadata = await input
			.getDurationFromMetadata()
			.catch(() => null);
		if (fromMetadata && Number.isFinite(fromMetadata) && fromMetadata > 0) {
			return fromMetadata;
		}
		// Metadata duration is missing on some streamed/remuxed captures — pay
		// for the precise scan rather than mis-sizing the chunk windows.
		return await input.computeDuration();
	} finally {
		input.dispose();
	}
}

/** POST one already-extracted chunk and return its chunk-relative result. */
async function postChunk(
	audio: Blob,
	options: {
		locale?: string;
		style: "clean" | "verbatim";
		diarize: boolean;
		signal?: AbortSignal;
	},
): Promise<TranscriptionResult> {
	const form = new FormData();
	form.append("audio", audio, "audio.ogg");
	if (options.locale) form.append("language", options.locale);
	form.append("style", options.style);
	form.append("diarize", String(options.diarize));

	let response: Response;
	try {
		response = await fetch("/api/transcribe", {
			method: "POST",
			body: form,
			signal: options.signal,
		});
	} catch {
		if (options.signal?.aborted) {
			throw new MaiTranscribeError("Transcription cancelled.", "aborted");
		}
		throw new MaiTranscribeError(
			"Couldn't reach transcription just now. Check your connection and try again.",
			"provider_error",
		);
	}

	if (!response.ok) {
		// Deliberately does NOT surface the server's message field: those name
		// env vars and providers. The code decides the copy; the body is only
		// read so the request isn't left unconsumed.
		await response.text().catch(() => "");
		switch (response.status) {
			case 503:
				throw new MaiTranscribeError(
					"Transcription isn't available right now.",
					"not_configured",
				);
			case 401:
			case 403:
				throw new MaiTranscribeError(
					"Sign in to transcribe audio.",
					"unauthorized",
				);
			case 429:
				throw new MaiTranscribeError(
					"You've hit today's transcription limit. Try again later.",
					"rate_limited",
				);
			default:
				throw new MaiTranscribeError(
					"Transcription didn't finish. Try again in a moment.",
					"provider_error",
				);
		}
	}

	return (await response.json()) as TranscriptionResult;
}

/**
 * Decide whether a chunk-relative segment is speech we already captured.
 *
 * Adjacent chunks overlap by CHUNK_OVERLAP_SECONDS so a word straddling a cut
 * is heard in full by at least one of them — which means the overlap region is
 * transcribed twice and one copy has to go.
 *
 * WHY THIS RULE AND NOT A BOUNDARY TEST: the obvious approach is to give each
 * chunk the segments whose midpoint falls in its nominal (non-overlapping)
 * window. That silently LOSES speech. The two chunks heard different audio, so
 * they can disagree about where a phrase sits: if the earlier chunk places it
 * just past the boundary and the later chunk places its copy just before,
 * neither claims it and the words vanish from the transcript with nothing to
 * show anything went wrong.
 *
 * So the rule is coverage-based instead: keep anything that extends past the
 * last thing we already kept. A near-duplicate at a seam is possible, but it is
 * VISIBLE and editable, whereas dropped speech is neither. Non-lossy by
 * construction — a segment is discarded only when its audio is entirely inside
 * a span already transcribed.
 */
export function isAlreadyCovered(
	segment: TranscriptionSegment,
	chunkStart: number,
	lastKeptEnd: number,
): boolean {
	return chunkStart + segment.end <= lastKeptEnd;
}

/** Shift a chunk-relative segment onto the source file's timeline. */
export function offsetSegment(
	segment: TranscriptionSegment,
	offset: number,
	id: number,
): TranscriptionSegment {
	return {
		...segment,
		id,
		start: segment.start + offset,
		end: segment.end + offset,
		words: segment.words.map((word) => ({
			...word,
			start: word.start + offset,
			end: word.end + offset,
		})),
	};
}

/**
 * Transcribe a media File with MAI-Transcribe-2.
 *
 * Throws {@link MaiTranscribeError} with person-readable copy on every failure
 * path — there is no on-device fallback any more, so callers surface these
 * directly rather than degrading to a second engine.
 */
export async function transcribeWithMai(
	file: File,
	options: MaiTranscribeOptions = {},
	deps: MaiTranscribeDeps = {},
): Promise<TranscriptionResult> {
	const { onProgress, signal } = options;
	const readDurationOf = deps.readDuration ?? readDuration;
	const extract = deps.extractAudio ?? extractAudioWindow;
	const post = deps.postChunk ?? postChunk;
	const style = options.style ?? "verbatim";
	const locale = toTranscriptionLocale(options.language);

	const throwIfAborted = () => {
		if (signal?.aborted) {
			throw new MaiTranscribeError("Transcription cancelled.", "aborted");
		}
	};

	throwIfAborted();
	onProgress?.({ stage: "extracting", progress: 0, message: "Reading audio" });

	const duration = await readDurationOf(file);
	const diarize = wantsDiarization(options.diarize ?? true, duration);

	// Chunk boundaries come from a size ESTIMATE rather than from encoding
	// first and measuring: an encoded Ogg stream can't be split by byte offset,
	// so the windows have to be chosen before any encoding happens.
	const chunkSeconds =
		TRANSCRIBE_CHUNK_TARGET_BYTES / ESTIMATED_BYTES_PER_SECOND;
	const chunkCount = Math.max(1, Math.ceil(duration / chunkSeconds));
	const step = duration / chunkCount;

	const segments: TranscriptionSegment[] = [];
	let detectedLanguage = "";
	// End of the last segment kept, on the source timeline — the high-water
	// mark `isAlreadyCovered` de-duplicates against.
	let lastKeptEnd = 0;

	for (let index = 0; index < chunkCount; index++) {
		throwIfAborted();

		const isLast = index === chunkCount - 1;
		const nominalStart = index * step;
		const nominalEnd = isLast ? duration : (index + 1) * step;
		// Reach backwards as well as forwards so a word cut by the PREVIOUS
		// boundary is also fully present here; midpoint assignment then picks
		// exactly one copy.
		const windowStart = Math.max(0, nominalStart - CHUNK_OVERLAP_SECONDS);
		const windowEnd = Math.min(duration, nominalEnd + CHUNK_OVERLAP_SECONDS);

		const base = index / chunkCount;
		const span = 1 / chunkCount;
		onProgress?.({
			stage: "extracting",
			progress: base,
			message:
				chunkCount > 1
					? `Reading audio (part ${index + 1} of ${chunkCount})`
					: "Reading audio",
		});

		const audio = await extract(
			file,
			chunkCount === 1 ? undefined : { start: windowStart, end: windowEnd },
		);

		throwIfAborted();
		onProgress?.({
			stage: "transcribing",
			progress: base + span * 0.4,
			message:
				chunkCount > 1
					? `Transcribing (part ${index + 1} of ${chunkCount})`
					: "Transcribing",
		});

		const result = await post(audio, { locale, style, diarize, signal });
		if (!detectedLanguage && result.language) {
			detectedLanguage = result.language;
		}

		for (const segment of result.segments) {
			if (isAlreadyCovered(segment, windowStart, lastKeptEnd)) continue;
			const placed = offsetSegment(segment, windowStart, segments.length);
			segments.push(placed);
			lastKeptEnd = Math.max(lastKeptEnd, placed.end);
		}
	}

	onProgress?.({ stage: "transcribing", progress: 1 });

	return {
		segments,
		language: detectedLanguage || "en-US",
		duration,
	};
}
