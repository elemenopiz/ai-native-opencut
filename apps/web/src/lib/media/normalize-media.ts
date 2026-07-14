import {
	Input,
	ALL_FORMATS,
	BlobSource,
	Output,
	Mp4OutputFormat,
	BufferTarget,
	Conversion,
	QUALITY_HIGH,
	type VideoCodec,
} from "mediabunny";

/**
 * "Normalize on ingest" for undecodable / non-portable video (GoPro/iPhone HEVC,
 * VP9-in-MP4, AV1, …). We probe the primary video track BEFORE the rest of the
 * ingest pipeline touches it, decide whether it's already portable, needs a
 * transcode to H.264/AAC, or is simply undecodable here — and, when it's a
 * transcode, re-mux it to a broadly-playable MP4 at source resolution.
 *
 * Pure logic (no DOM, no storage) so `processMediaAssets` stays the only wiring
 * point and this module is unit-testable by mocking `mediabunny`.
 */

/**
 * Deliberately minimal — only what `decideNormalization` reads, plus the codec
 * parameter string that ingest persists for passthrough non-H.264 assets (see
 * `PassthroughCodec` in `services/storage/types.ts`). Dimensions, rotation,
 * duration, audio codec etc. are all re-derived by the existing
 * `getVideoInfo`/thumbnail pass that runs right after, and reading them here
 * (especially `computeDuration()`, worst case a full packet scan on a
 * fragmented MP4) would double that work on every ordinary H.264 ingest.
 */
export interface ProbeResult {
	/** False when mediabunny couldn't parse the file or it has no video track. */
	parseable: boolean;
	videoCodec: VideoCodec | null;
	/** `track.canDecode()` — whether WebCodecs in THIS browser can decode it. */
	decodable: boolean;
	/**
	 * `track.getCodecParameterString()` — the FULL WebCodecs codec string (e.g.
	 * "hvc1.1.6.L120.90", not just "hevc"), valid as the `codec` member of a
	 * `VideoDecoder.isConfigSupported()` / `VideoDecoderConfig` call. Null when
	 * the codec is unknown to mediabunny (which also forces `videoCodec: null`).
	 */
	codecParameterString: string | null;
}

export type NormalizationDecision = "passthrough" | "transcode" | "unsupported";

function unparseableResult(): ProbeResult {
	return {
		parseable: false,
		videoCodec: null,
		decodable: false,
		codecParameterString: null,
	};
}

/**
 * Probe the primary video track's codec and — crucially — whether it can be
 * decoded here (`track.canDecode()`). Never throws: a file mediabunny can't
 * parse (or that has no video track) resolves to a `parseable: false` result
 * so the caller can surface a user-facing warning instead of crashing ingest.
 */
export async function probeVideoFile(file: File): Promise<ProbeResult> {
	let input: Input | undefined;

	try {
		input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) return unparseableResult();

		const [videoCodec, decodable, codecParameterString] = await Promise.all([
			videoTrack.getCodec(),
			videoTrack.canDecode(),
			videoTrack.getCodecParameterString(),
		]);

		return {
			parseable: true,
			videoCodec,
			decodable,
			codecParameterString,
		};
	} catch {
		return unparseableResult();
	} finally {
		input?.dispose();
	}
}

/**
 * Decide what ingest should do with a probed video:
 * - `passthrough`: `track.canDecode()` said yes in THIS browser — no work.
 *   Every downstream consumer (VideoCache's CanvasSink playback/seek,
 *   VideoSampleSink thumbnails, export's decode-then-re-encode) already
 *   drives mediabunny/WebCodecs generically by container+codec, not by
 *   assuming AVC, so a decodable HEVC/VP9/AV1/… source needs no ingest-time
 *   re-encode: keeping the original bytes is correct AND ~50-100x cheaper
 *   than the previous unconditional full-res transcode (measured: an 11-20s
 *   HEVC transcode collapses to a probe read, <0.2s).
 * - `unsupported`: undecodable here, or unparseable — we can neither play nor
 *   re-encode it in this browser (re-encoding requires decoding it first, so
 *   there is no "transcode our way out of this" option); ingest it as-is and
 *   let the caller warn.
 * - `transcode`: not reachable by this decodable-gated policy today (nothing
 *   both fails `canDecode()` and can still be fed through `normalizeVideoFile`,
 *   since that path itself decodes via WebCodecs). Kept as a decision + a
 *   working `normalizeVideoFile` seam for a future forced-conversion case
 *   (e.g. an explicit "convert for sharing with browsers that can't decode
 *   HEVC" action) rather than deleted.
 */
export function decideNormalization(probe: ProbeResult): NormalizationDecision {
	if (!probe.parseable || !probe.decodable || !probe.videoCodec) {
		return "unsupported";
	}
	return "passthrough";
}

function basename(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Transcode a decodable, non-portable video to an H.264/AAC MP4 at SOURCE
 * resolution (no scaling/cap), high quality. Returns a fresh
 * `${basename}-normalized.mp4` File.
 *
 * GoPro telemetry tracks (gpmd/tmcd) are neither video, audio, nor subtitle, so
 * mediabunny drops them from the MP4 automatically — no special handling needed.
 * We do guard the inverse failure: if the video track itself couldn't be
 * encoded (e.g. no H.264 encoder available) it'd be discarded, and emitting an
 * audio-only file would just reproduce the silent-black-clip bug — so we throw
 * instead, letting the caller fall back to the original file.
 */
export async function normalizeVideoFile(
	file: File,
	onProgress?: (progress: number) => void,
): Promise<File> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const conversion = await Conversion.init({
			input,
			output,
			video: { codec: "avc", bitrate: QUALITY_HIGH },
			audio: { codec: "aac" },
		});

		if (onProgress) {
			conversion.onProgress = (progress) => onProgress(progress);
		}

		const videoSurvived = conversion.utilizedTracks.some((track) =>
			track.isVideoTrack(),
		);
		if (!conversion.isValid || !videoSurvived) {
			const reasons = conversion.discardedTracks
				.map((t) => t.reason)
				.join(", ");
			throw new Error(
				`Cannot normalize video${reasons ? ` (${reasons})` : ""}`,
			);
		}

		await conversion.execute();

		const buffer = output.target.buffer;
		if (!buffer) throw new Error("Normalization produced no output");

		return new File([buffer], `${basename(file.name)}-normalized.mp4`, {
			type: "video/mp4",
		});
	} finally {
		input.dispose();
	}
}
