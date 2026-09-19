import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { aiClient } from "@/lib/ai-client";
import { transcribeFileWithEngine } from "@/hooks/use-transcription";
import type { TranscriptionResult } from "@/types/ai";

/**
 * Engine-routing guard for the shared single-file primitive behind both the
 * single-track and whole-video "transcribe all" paths.
 *
 * On-device Whisper was removed: MAI-Transcribe-2 is the default and the only
 * engine that works in cloud deploys, while "sarvam" and "smallest" still talk
 * to the external Python backend. The risk this file guards is a silent
 * mis-route — e.g. the default falling through to a backend that does not exist
 * in prod, which is precisely the failure the old Whisper fallback used to mask.
 *
 * Isolation note: bun runs every test file in one process and `mock.module` is
 * process-global, so the ai-client seams are restorable `spyOn`s — module mocks
 * would leak into unrelated test files.
 */

const RESULT: TranscriptionResult = {
	segments: [],
	language: "en-US",
	duration: 0,
};

function file() {
	return new File([new Uint8Array([0, 1, 2])], "clip.mp4", {
		type: "video/mp4",
	});
}

const spies: { mockRestore: () => void }[] = [];

afterEach(() => {
	while (spies.length) spies.pop()?.mockRestore();
});

describe("transcribeFileWithEngine", () => {
	it("routes sarvam to the Sarvam backend", async () => {
		const sarvam = spyOn(aiClient, "sarvamTranscribe").mockResolvedValue(
			RESULT,
		);
		const smallest = spyOn(aiClient, "smallestTranscribe").mockResolvedValue(
			RESULT,
		);
		spies.push(sarvam, smallest);

		await transcribeFileWithEngine({
			file: file(),
			engine: "sarvam",
			language: "hi",
		});

		expect(sarvam).toHaveBeenCalledTimes(1);
		expect(sarvam.mock.calls[0][1]).toBe("hi");
		expect(smallest).not.toHaveBeenCalled();
	});

	it("routes smallest to the Smallest backend, defaulting the language", async () => {
		const sarvam = spyOn(aiClient, "sarvamTranscribe").mockResolvedValue(
			RESULT,
		);
		const smallest = spyOn(aiClient, "smallestTranscribe").mockResolvedValue(
			RESULT,
		);
		spies.push(sarvam, smallest);

		await transcribeFileWithEngine({ file: file(), engine: "smallest" });

		expect(smallest).toHaveBeenCalledTimes(1);
		// The Smallest route has no auto-detect, so an absent language must
		// become an explicit "en" rather than being forwarded as undefined.
		expect(smallest.mock.calls[0][1]).toBe("en");
		expect(sarvam).not.toHaveBeenCalled();
	});

	it("does not route the default engine to the external backend", async () => {
		const sarvam = spyOn(aiClient, "sarvamTranscribe").mockResolvedValue(
			RESULT,
		);
		const smallest = spyOn(aiClient, "smallestTranscribe").mockResolvedValue(
			RESULT,
		);
		spies.push(sarvam, smallest);

		// The MAI path needs a browser (media decode + fetch), so it throws here
		// rather than resolving — what matters is WHERE it did not go. If a
		// future edit made "mai" fall through to aiClient, these would fire and
		// the failure would only show up in prod, where that backend is absent.
		await transcribeFileWithEngine({ file: file(), engine: "mai" }).catch(
			() => undefined,
		);

		expect(sarvam).not.toHaveBeenCalled();
		expect(smallest).not.toHaveBeenCalled();
	});
});
