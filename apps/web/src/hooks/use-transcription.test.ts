import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { aiClient } from "@/lib/ai-client";
import * as maiTranscribeModule from "@/lib/transcription/mai-transcribe";
import { MaiTranscribeError } from "@/lib/transcription/mai-transcribe";
import {
	transcribeFileWithEngine,
	isTranscriptionNotConfigured,
	TRANSCRIPTION_UNAVAILABLE_MESSAGE,
	__resetTranscriptionAvailabilityForTests,
} from "@/hooks/use-transcription";
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

/**
 * Regression guard for the "Transcribe still fires when it's known to be
 * off" bug: once a "mai" attempt learns the server has no key configured
 * (`MaiTranscribeError` with `code: "not_configured"`), the session-sticky
 * flag the Captions panel disables its button on must flip — and must NOT
 * flip for an unrelated failure, which would incorrectly disable a feature
 * that might work again on retry.
 */
describe("transcription availability flag", () => {
	afterEach(() => {
		__resetTranscriptionAvailabilityForTests();
		while (spies.length) spies.pop()?.mockRestore();
	});

	it("starts available", () => {
		expect(isTranscriptionNotConfigured()).toBe(false);
	});

	it("marks not-configured after a mai 'not_configured' failure", async () => {
		const mai = spyOn(
			maiTranscribeModule,
			"transcribeWithMai",
		).mockRejectedValue(
			new MaiTranscribeError(
				"Transcription isn't available right now.",
				"not_configured",
			),
		);
		spies.push(mai);

		await transcribeFileWithEngine({ file: file(), engine: "mai" }).catch(
			() => undefined,
		);

		expect(mai).toHaveBeenCalledTimes(1);
		expect(isTranscriptionNotConfigured()).toBe(true);
	});

	it("does not mark not-configured for an unrelated mai failure", async () => {
		const mai = spyOn(
			maiTranscribeModule,
			"transcribeWithMai",
		).mockRejectedValue(
			new MaiTranscribeError(
				"Couldn't reach transcription just now. Check your connection and try again.",
				"provider_error",
			),
		);
		spies.push(mai);

		await transcribeFileWithEngine({ file: file(), engine: "mai" }).catch(
			() => undefined,
		);

		expect(mai).toHaveBeenCalledTimes(1);
		expect(isTranscriptionNotConfigured()).toBe(false);
	});

	it("never names a provider, key, or env var in the disabled-button copy", () => {
		expect(TRANSCRIPTION_UNAVAILABLE_MESSAGE).not.toMatch(
			/azure|env|AZURE_SPEECH|key/i,
		);
		expect(TRANSCRIPTION_UNAVAILABLE_MESSAGE).toBe(
			"Transcription isn't available on this account yet.",
		);
	});
});
