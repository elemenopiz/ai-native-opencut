import { beforeEach, describe, expect, mock, test } from "bun:test";

// Drive the mediabunny surface the normalizer touches without a real
// WebCodecs transcode: the module-level knobs below let each test pick the
// probed frame rate and force the failure branches.
let avgFps = 30;
let hasVideoTrack = true;
let conversionValid = true;
let probeThrows = false;
let convertThrows = false;
let executeCount = 0;
let lastVideoOptions: { frameRate?: number } | undefined;

mock.module("mediabunny", () => ({
	ALL_FORMATS: [],
	BlobSource: class {},
	Mp4OutputFormat: class {},
	BufferTarget: class {},
	Input: class {
		async getPrimaryVideoTrack() {
			if (!hasVideoTrack) return null;
			return {
				async computePacketStats() {
					if (probeThrows) throw new Error("probe failed");
					return { averagePacketRate: avgFps };
				},
			};
		}
		dispose() {}
	},
	Output: class {
		target = { buffer: new ArrayBuffer(8) };
	},
	Conversion: {
		async init(opts: { video?: { frameRate?: number } }) {
			lastVideoOptions = opts.video;
			return {
				isValid: conversionValid,
				async execute() {
					if (convertThrows) throw new Error("convert failed");
					executeCount += 1;
				},
			};
		},
	},
}));

const { normalizeReferenceVideoFps } = await import(
	"./normalize-reference-video"
);

const videoFile = () =>
	new File([new Uint8Array([1])], "clip.mov", { type: "video/quicktime" });
const imageFile = () =>
	new File([new Uint8Array([1])], "photo.png", { type: "image/png" });

beforeEach(() => {
	avgFps = 30;
	hasVideoTrack = true;
	conversionValid = true;
	probeThrows = false;
	convertThrows = false;
	executeCount = 0;
	lastVideoOptions = undefined;
});

describe("normalizeReferenceVideoFps", () => {
	test("returns non-video files untouched, without probing", async () => {
		const file = imageFile();
		const out = await normalizeReferenceVideoFps(file);
		expect(out).toBe(file);
		expect(executeCount).toBe(0);
	});

	test("passes a ≤60fps video through unchanged (no re-encode)", async () => {
		avgFps = 59.94;
		const file = videoFile();
		const out = await normalizeReferenceVideoFps(file);
		expect(out).toBe(file);
		expect(executeCount).toBe(0);
	});

	test("treats exactly 60fps as compliant (boundary is ≤60)", async () => {
		avgFps = 60;
		const file = videoFile();
		const out = await normalizeReferenceVideoFps(file);
		expect(out).toBe(file);
		expect(executeCount).toBe(0);
	});

	test("re-encodes a >60fps video to constant 60fps mp4", async () => {
		// The real failure: an iPhone "60fps" clip measures ~60.04fps.
		avgFps = 60.0394;
		const file = videoFile();
		const out = await normalizeReferenceVideoFps(file);
		expect(out).not.toBe(file);
		expect(out.type).toBe("video/mp4");
		expect(out.name).toBe("clip.mp4");
		expect(executeCount).toBe(1);
		expect(lastVideoOptions?.frameRate).toBe(60);
	});

	test("falls back to the raw file when there is no video track", async () => {
		hasVideoTrack = false;
		const file = videoFile();
		expect(await normalizeReferenceVideoFps(file)).toBe(file);
	});

	test("never throws — a probe failure yields the raw file", async () => {
		probeThrows = true;
		const file = videoFile();
		expect(await normalizeReferenceVideoFps(file)).toBe(file);
	});

	test("never throws — a transcode failure yields the raw file", async () => {
		avgFps = 120;
		convertThrows = true;
		const file = videoFile();
		expect(await normalizeReferenceVideoFps(file)).toBe(file);
	});

	test("falls back to the raw file when the conversion is invalid", async () => {
		avgFps = 120;
		conversionValid = false;
		const file = videoFile();
		const out = await normalizeReferenceVideoFps(file);
		expect(out).toBe(file);
		expect(executeCount).toBe(0);
	});
});
