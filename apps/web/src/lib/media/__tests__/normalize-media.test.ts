import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Configurable mediabunny stubs. Tests set these before exercising the SUT.
// A SINGLE mediabunny mock serves both the unit tests (probe/decide/normalize)
// AND the processMediaAssets wiring tests below, so the real normalize-media
// module is exercised end-to-end and never itself mocked — that avoids the bun
// `mock.module` cross-file leak that a separate "mock normalize-media" wiring
// file would trigger against this file's real import.
type TrackStub = {
	getCodec: () => Promise<string | null>;
	canDecode?: () => Promise<boolean>;
	isVideoTrack?: () => boolean;
};

let videoTrack: TrackStub | null = null;
let inputThrows = false;
let disposed = 0;

// Conversion behaviour.
let conversion: {
	isValid: boolean;
	utilizedTracks: TrackStub[];
	discardedTracks: { reason: string }[];
	onProgress?: (p: number, t: number) => unknown;
	execute: () => Promise<void>;
} | null = null;
let outputBuffer: ArrayBuffer | null = new Uint8Array([9, 9, 9]).buffer;

mock.module("mediabunny", () => ({
	ALL_FORMATS: {},
	QUALITY_HIGH: 4_000_000,
	BlobSource: class {
		constructor(_file: unknown) {}
	},
	Input: class {
		async getPrimaryVideoTrack() {
			if (inputThrows) throw new Error("cannot parse");
			return videoTrack;
		}
		dispose() {
			disposed += 1;
		}
	},
	// generateThumbnail (in processing.ts) constructs a VideoSampleSink; the
	// wiring tests don't care about the thumbnail, so a no-op sink whose iterator
	// yields nothing is enough — the decode simply produces no frames.
	VideoSampleSink: class {
		constructor(_track: unknown) {}
		async *samplesAtTimestamps() {}
	},
	Output: class {
		target: { buffer: ArrayBuffer | null };
		constructor(opts: { target: { buffer: ArrayBuffer | null } }) {
			this.target = opts.target;
		}
	},
	Mp4OutputFormat: class {},
	BufferTarget: class {
		buffer: ArrayBuffer | null = outputBuffer;
	},
	Conversion: {
		init: async () => {
			if (!conversion) throw new Error("no conversion configured");
			return conversion;
		},
	},
}));

// getVideoInfo is stubbed so wiring tests don't need a real decoder; capture
// WHICH file it ran against to prove the transcode substitution happened.
let getVideoInfoFile: File | null = null;
mock.module("@/lib/media/mediabunny", () => ({
	getVideoInfo: async ({ videoFile }: { videoFile: File }) => {
		getVideoInfoFile = videoFile;
		return { duration: 5, width: 1920, height: 1080, fps: 30 };
	},
}));

const toastCalls = {
	error: [] as string[],
	loading: [] as string[],
	success: [] as string[],
	dismiss: 0,
};
mock.module("sonner", () => ({
	toast: {
		error: (msg: string) => {
			toastCalls.error.push(msg);
		},
		loading: (msg: string) => {
			toastCalls.loading.push(msg);
			return "toast-id";
		},
		success: (msg: string) => {
			toastCalls.success.push(msg);
		},
		dismiss: () => {
			toastCalls.dismiss += 1;
		},
	},
}));

const { probeVideoFile, decideNormalization, normalizeVideoFile } =
	await import("@/lib/media/normalize-media");
const { processMediaAssets } = await import("@/lib/media/processing");

function makeVideoTrack(overrides: Partial<TrackStub> = {}): TrackStub {
	return {
		getCodec: async () => "avc",
		canDecode: async () => true,
		isVideoTrack: () => true,
		...overrides,
	};
}

function passthroughConversion() {
	return {
		isValid: true,
		utilizedTracks: [{ getCodec: async () => "avc", isVideoTrack: () => true }],
		discardedTracks: [],
		execute: async () => {},
	};
}

const file = () =>
	new File([new Uint8Array([1, 2, 3])], "GX010042.mp4", { type: "video/mp4" });

// mock.module registrations persist for the whole bun test process — restore
// them when this file is done so the mediabunny/sonner stubs can't leak into
// later test files (this repo has a documented history of that failure class).
afterAll(() => {
	mock.restore();
});

beforeEach(() => {
	videoTrack = null;
	inputThrows = false;
	disposed = 0;
	conversion = null;
	outputBuffer = new Uint8Array([9, 9, 9]).buffer;
	getVideoInfoFile = null;
	toastCalls.error = [];
	toastCalls.loading = [];
	toastCalls.success = [];
	toastCalls.dismiss = 0;
});

describe("decideNormalization — decision table", () => {
	function probe(overrides: Record<string, unknown>) {
		return {
			parseable: true,
			videoCodec: "avc",
			decodable: true,
			...overrides,
		} as Parameters<typeof decideNormalization>[0];
	}

	test("avc + decodable → passthrough", () => {
		expect(decideNormalization(probe({ videoCodec: "avc" }))).toBe(
			"passthrough",
		);
	});

	test("hevc + decodable → passthrough (the GoPro/iPhone case, hardware-decodable)", () => {
		expect(decideNormalization(probe({ videoCodec: "hevc" }))).toBe(
			"passthrough",
		);
	});

	test("hevc + undecodable → unsupported", () => {
		expect(
			decideNormalization(probe({ videoCodec: "hevc", decodable: false })),
		).toBe("unsupported");
	});

	test("unparseable → unsupported", () => {
		expect(
			decideNormalization(
				probe({ parseable: false, videoCodec: null, decodable: false }),
			),
		).toBe("unsupported");
	});

	test("other decodable non-avc codecs → passthrough (decodability is the gate, not codec identity)", () => {
		for (const codec of ["vp9", "av1", "vp8", "prores"]) {
			expect(decideNormalization(probe({ videoCodec: codec }))).toBe(
				"passthrough",
			);
		}
	});
});

describe("probeVideoFile", () => {
	test("reports codec + decodable (nothing else — hot-path probe stays slim)", async () => {
		videoTrack = makeVideoTrack({
			getCodec: async () => "hevc",
			canDecode: async () => true,
		});

		const result = await probeVideoFile(file());
		expect(result).toEqual({
			parseable: true,
			videoCodec: "hevc",
			decodable: true,
		});
		expect(disposed).toBe(1); // input always disposed
	});

	test("undecodable track surfaces decodable:false", async () => {
		videoTrack = makeVideoTrack({
			getCodec: async () => "hevc",
			canDecode: async () => false,
		});
		const result = await probeVideoFile(file());
		expect(result.decodable).toBe(false);
	});

	test("no video track → unparseable result (does not throw)", async () => {
		videoTrack = null;
		const result = await probeVideoFile(file());
		expect(result.parseable).toBe(false);
		expect(result.videoCodec).toBeNull();
		expect(result.decodable).toBe(false);
	});

	test("mediabunny parse failure → unparseable result (does not throw)", async () => {
		inputThrows = true;
		const result = await probeVideoFile(file());
		expect(result.parseable).toBe(false);
		expect(disposed).toBe(1);
	});
});

describe("normalizeVideoFile", () => {
	test("transcodes to an H.264 mp4 named basename-normalized.mp4", async () => {
		let executed = false;
		conversion = {
			...passthroughConversion(),
			execute: async () => {
				executed = true;
			},
		};

		const out = await normalizeVideoFile(file());
		expect(executed).toBe(true);
		expect(out).toBeInstanceOf(File);
		expect(out.name).toBe("GX010042-normalized.mp4");
		expect(out.type).toBe("video/mp4");
		expect(disposed).toBe(1);
	});

	test("forwards progress (0..1) to the callback", async () => {
		const seen: number[] = [];
		conversion = {
			...passthroughConversion(),
			execute: async function (this: { onProgress?: (p: number) => void }) {
				this.onProgress?.(0.5);
				this.onProgress?.(1);
			},
		} as never;

		await normalizeVideoFile(file(), (p) => seen.push(p));
		expect(seen).toEqual([0.5, 1]);
	});

	test("throws when the video track was dropped (no audio-only fallback)", async () => {
		conversion = {
			isValid: true,
			// only an audio track survived — emitting this would be a silent black clip
			utilizedTracks: [
				{ getCodec: async () => "aac", isVideoTrack: () => false },
			],
			discardedTracks: [{ reason: "no_encodable_target_codec" }],
			execute: async () => {},
		};
		await expect(normalizeVideoFile(file())).rejects.toThrow(
			/Cannot normalize video/,
		);
		expect(disposed).toBe(1);
	});

	test("throws when the conversion is invalid", async () => {
		conversion = {
			isValid: false,
			utilizedTracks: [],
			discardedTracks: [{ reason: "undecodable_source_codec" }],
			execute: async () => {},
		};
		await expect(normalizeVideoFile(file())).rejects.toThrow(
			/Cannot normalize video/,
		);
	});

	test("throws when output produced no buffer", async () => {
		outputBuffer = null;
		conversion = passthroughConversion();
		await expect(normalizeVideoFile(file())).rejects.toThrow(/no output/);
	});
});

describe("processMediaAssets — normalize-on-ingest wiring", () => {
	test("passthrough (hevc/decodable, the GoPro/iPhone case): ingests the raw file as-is, no transcode", async () => {
		videoTrack = makeVideoTrack({
			getCodec: async () => "hevc",
			canDecode: async () => true,
		});
		// No `conversion` stub configured — if the code took the transcode path
		// it would throw (`Conversion.init` requires one), so this also proves
		// `normalizeVideoFile` is never invoked for decodable HEVC anymore.
		conversion = null;

		const [asset] = await processMediaAssets({ files: [file()] });

		// The asset's backing file is the ORIGINAL bytes — no `-normalized.mp4`
		// substitution, no provenance metadata, no conversion toast. Playback,
		// export, and thumbnailing all decode this via the same codec-agnostic
		// WebCodecs sinks (video-cache/processing), so passthrough is correct.
		expect(asset.file.name).toBe("GX010042.mp4");
		expect(getVideoInfoFile?.name).toBe("GX010042.mp4");
		expect(asset.normalized).toBeUndefined();
		expect(toastCalls.success).toHaveLength(0);
		expect(toastCalls.error).toHaveLength(0);
	});

	test("unsupported (undecodable): still ingests the asset but warns with the codec", async () => {
		videoTrack = makeVideoTrack({
			getCodec: async () => "hevc",
			canDecode: async () => false,
		});

		const [asset] = await processMediaAssets({ files: [file()] });

		expect(asset).toBeDefined();
		expect(asset.file.name).toBe("GX010042.mp4"); // original, un-substituted
		expect(asset.normalized).toBeUndefined();
		expect(toastCalls.error).toHaveLength(1);
		expect(toastCalls.error[0]).toContain("HEVC");
	});

	test("unsupported (no video track): warns 'couldn't read a video track', not a codec blame", async () => {
		videoTrack = null; // audio-only-in-video-container / unparseable

		const [asset] = await processMediaAssets({ files: [file()] });

		expect(asset).toBeDefined();
		expect(asset.file.name).toBe("GX010042.mp4");
		expect(asset.normalized).toBeUndefined();
		expect(toastCalls.error).toHaveLength(1);
		expect(toastCalls.error[0]).toContain("Couldn't read a video track");
		expect(toastCalls.error[0]).not.toContain("decode");
	});

	// NOTE: a prior "normalize throws → falls back to the original file" wiring
	// test lived here, exercising decision==="transcode" via a decodable HEVC
	// probe. Under the new decodable-gated policy that decision is no longer
	// reachable through the real (unmocked) `decideNormalization` — decodable
	// video always takes the "passthrough" branch above, so there is no wiring
	// path left that calls `normalizeVideoFile` to make throw. The underlying
	// safety property (a failed transcode falls back to the original file) is
	// still real code in `processing.ts` and is unit-tested at the
	// `normalizeVideoFile` level above ("throws when the conversion is
	// invalid", etc.); it is intentionally not reachable via processMediaAssets
	// today (see `decideNormalization`'s doc comment on the kept-but-unreached
	// "transcode" decision).

	test("passthrough (avc): no transcode, no provenance, no toast", async () => {
		videoTrack = makeVideoTrack({
			getCodec: async () => "avc",
			canDecode: async () => true,
		});

		const [asset] = await processMediaAssets({ files: [file()] });

		expect(asset.file.name).toBe("GX010042.mp4");
		expect(asset.normalized).toBeUndefined();
		expect(toastCalls.error).toHaveLength(0);
		expect(toastCalls.success).toHaveLength(0);
		expect(getVideoInfoFile?.name).toBe("GX010042.mp4");
	});
});
