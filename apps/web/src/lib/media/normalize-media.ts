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
	type AudioCodec,
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

export interface ProbeResult {
	/** False when mediabunny couldn't parse the file or it has no video track. */
	parseable: boolean;
	videoCodec: VideoCodec | null;
	codecParameterString: string | null;
	width: number | null;
	height: number | null;
	/** Clockwise display rotation in degrees (0/90/180/270), 0 when unknown. */
	rotation: number;
	duration: number | null;
	/** `track.canDecode()` — whether WebCodecs in THIS browser can decode it. */
	decodable: boolean;
	audioCodec: AudioCodec | null;
}

export type NormalizationDecision = "passthrough" | "transcode" | "unsupported";

/**
 * Video codecs we treat as already-portable: playable everywhere and safe to
 * keep inside an MP4 without re-encoding. AVC (H.264) is the universal baseline
 * every target browser decodes; every other codec (hevc/vp9/av1/vp8/prores) is
 * considered non-portable and gets transcoded when it's decodable here.
 */
const PORTABLE_VIDEO_CODECS: ReadonlySet<VideoCodec> = new Set<VideoCodec>([
	"avc",
]);

function unparseableResult(): ProbeResult {
	return {
		parseable: false,
		videoCodec: null,
		codecParameterString: null,
		width: null,
		height: null,
		rotation: 0,
		duration: null,
		decodable: false,
		audioCodec: null,
	};
}

/**
 * Probe the primary video track's codec, dimensions, rotation, duration and —
 * crucially — whether it can be decoded here (`track.canDecode()`), plus the
 * primary audio codec if present. Never throws: a file mediabunny can't parse
 * (or that has no video track) resolves to a `parseable: false` result so the
 * caller can surface a user-facing warning instead of crashing ingest.
 */
export async function probeVideoFile(file: File): Promise<ProbeResult> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) return unparseableResult();

		const [
			videoCodec,
			codecParameterString,
			width,
			height,
			rotation,
			decodable,
			audioTrack,
		] = await Promise.all([
			videoTrack.getCodec(),
			videoTrack.getCodecParameterString(),
			videoTrack.getDisplayWidth(),
			videoTrack.getDisplayHeight(),
			videoTrack.getRotation(),
			videoTrack.canDecode(),
			input.getPrimaryAudioTrack(),
		]);

		let duration: number | null = null;
		try {
			const d = await videoTrack.computeDuration();
			duration = Number.isFinite(d) && d > 0 ? d : null;
		} catch {
			duration = null;
		}

		const audioCodec = audioTrack ? await audioTrack.getCodec() : null;

		return {
			parseable: true,
			videoCodec,
			codecParameterString,
			width,
			height,
			rotation,
			duration,
			decodable,
			audioCodec,
		};
	} catch {
		return unparseableResult();
	} finally {
		input.dispose();
	}
}

/**
 * Decide what ingest should do with a probed video:
 * - `passthrough`: already AVC/H.264 and decodable — no work.
 * - `transcode`: decodable but a non-portable codec (hevc/vp9/av1/…) — re-encode
 *   to H.264 so preview, export, and other browsers all handle it. HEVC →
 *   transcode is the primary case this feature exists for.
 * - `unsupported`: undecodable here, or unparseable — we can neither play nor
 *   re-encode it in this browser; ingest it as-is and let the caller warn.
 */
export function decideNormalization(probe: ProbeResult): NormalizationDecision {
	if (!probe.parseable || !probe.decodable || !probe.videoCodec) {
		return "unsupported";
	}
	if (PORTABLE_VIDEO_CODECS.has(probe.videoCodec)) return "passthrough";
	return "transcode";
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
