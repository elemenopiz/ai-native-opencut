import {
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	Conversion,
	Input,
	Mp4OutputFormat,
	Output,
} from "mediabunny";

/**
 * BytePlus Seedance 2.0 rejects any omni-reference **video** whose measured
 * average frame rate is above 60fps:
 *
 *   400 InvalidParameter — the parameter `content[N]` ... the parameter video
 *   frame rate specified in the request must be less than or equal to 60 for
 *   model dreamina-seedance-2-0 in r2v.
 *
 * The trap: a clip a phone labels "60fps" is recorded variable-frame-rate, and
 * its *average* rate measures just over 60. A real iPhone .mov example:
 *
 *   r_frame_rate   = 60000/1001 = 59.94fps   (the nominal "60fps" label)
 *   avg_frame_rate = 274200/4567 = 60.04fps  (457 frames / 7.6117s)
 *
 * BytePlus enforces on the *average*, so the file trips the `<= 60` check even
 * though it "is" a 60fps clip. A naive guard that reads the nominal rate would
 * wave it through and still fail server-side. We normalize on the way out:
 * probe the true average rate and, only when it exceeds 60, re-encode to a
 * constant 60fps so the average lands at exactly 60.0.
 */
const MAX_REFERENCE_FPS = 60;

/**
 * If `file` is a video whose measured average frame rate exceeds 60fps, return
 * a new File re-encoded to a constant 60fps (H.264 MP4, audio preserved).
 *
 * Otherwise — a non-video, a ≤60fps video, or any probe/transcode failure —
 * the original file is returned unchanged. Normalization must never block an
 * upload: on any failure we fall back to the raw file (which either uploads
 * fine or surfaces BytePlus's own error downstream); this function never
 * throws.
 */
export async function normalizeReferenceVideoFps(file: File): Promise<File> {
	if (!file.type.startsWith("video/")) return file;

	let input: Input | undefined;
	try {
		input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

		const track = await input.getPrimaryVideoTrack();
		if (!track) return file;

		// `averagePacketRate` is frames ÷ duration — the same quantity BytePlus
		// reads as `avg_frame_rate`, so it's the value that actually gates the
		// request (not the nominal `r_frame_rate`).
		const stats = await track.computePacketStats();
		const avgFps = stats.averagePacketRate ?? 0;
		if (avgFps <= MAX_REFERENCE_FPS) return file;

		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		// Setting `frameRate` forces a transcode that resamples to constant
		// 60fps; audio tracks are carried over by default.
		const conversion = await Conversion.init({
			input,
			output,
			video: { frameRate: MAX_REFERENCE_FPS },
		});
		if (!conversion.isValid) return file;

		await conversion.execute();

		const buffer = output.target.buffer;
		if (!buffer) return file;

		const name = `${file.name.replace(/\.[^./\\]+$/, "")}.mp4`;
		return new File([buffer], name, { type: "video/mp4" });
	} catch {
		return file;
	} finally {
		input?.dispose();
	}
}
