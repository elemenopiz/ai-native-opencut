import { describe, expect, test } from "bun:test";
import { isUnreadableVideoProbe } from "@/lib/media/processing";
import type { ProbeResult } from "@/lib/media/normalize-media";

// BUG55 (P2): a corrupt/unreadable video was still added as a phantom asset
// (undefined duration/dims/thumbnail) because the "unsupported" arm fired the
// right toast but never skipped the file. `isUnreadableVideoProbe` is the pure
// predicate `processMediaAssets` now uses to decide which "unsupported" probes
// mean "nothing to ingest" vs. "real media, just can't decode it here".
function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
	return {
		parseable: true,
		videoCodec: "avc",
		decodable: true,
		codecParameterString: "avc1.640028",
		...overrides,
	};
}

describe("isUnreadableVideoProbe", () => {
	test("unparseable file (corrupt/truncated) -> unreadable", () => {
		expect(
			isUnreadableVideoProbe(
				probe({ parseable: false, videoCodec: null, decodable: false }),
			),
		).toBe(true);
	});

	test("parseable but no video track (audio-only-in-video-container) -> unreadable", () => {
		expect(isUnreadableVideoProbe(probe({ videoCodec: null }))).toBe(true);
	});

	test("parseable, known codec, but this browser can't decode it (e.g. HEVC on Chrome) -> NOT unreadable", () => {
		// This is real media — must keep importing exactly as before, just
		// warned. Only the "no readable video track at all" case skips ingest.
		expect(
			isUnreadableVideoProbe(
				probe({ videoCodec: "hevc", decodable: false, parseable: true }),
			),
		).toBe(false);
	});

	test("parseable, decodable, known codec (normal case) -> NOT unreadable", () => {
		expect(isUnreadableVideoProbe(probe())).toBe(false);
	});
});
