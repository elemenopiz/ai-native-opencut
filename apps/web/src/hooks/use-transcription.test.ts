import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { aiClient } from "@/lib/ai-client";

/**
 * Regression guard for the transcription error-masking bug.
 *
 * On hosted deployments there is no server transcription backend, so Whisper
 * runs entirely on-device. When the on-device path throws, the old code fell
 * back to `aiClient.transcribe()` and let its "Cannot connect to AI backend"
 * error propagate — masking the REAL on-device cause with a message that told
 * the user to start a docker backend that isn't even part of the hosted stack.
 *
 * `transcribeFileWithEngine` (the shared single-file primitive behind both the
 * single-track and whole-video "transcribe all" paths) must instead surface the
 * on-device error whenever both paths fail, while still using the server result
 * for genuinely self-hosted setups where the fallback succeeds.
 *
 * Isolation note: bun runs every test file in one process and `mock.module` is
 * process-global, so the local-whisper mock is captured-and-restored here
 * (afterAll) and the ai-client seam is a restorable `spyOn`, not a module mock —
 * otherwise the stubs leak into unrelated test files.
 */

// Capture the real module so afterAll can restore it (isLocalWhisperSupported
// returns false in a non-DOM env, so we must fake it to reach the on-device
// branch at all).
const realLocalWhisper = await import("@/lib/transcription/local-whisper");

let localSupported = true;
let localTranscribe: (
	file: File,
	opts: Record<string, unknown>,
) => Promise<unknown>;

mock.module("@/lib/transcription/local-whisper", () => ({
	...realLocalWhisper,
	isLocalWhisperSupported: () => localSupported,
	transcribeLocally: (file: File, opts: Record<string, unknown>) =>
		localTranscribe(file, opts),
}));

const { transcribeFileWithEngine } = await import("@/hooks/use-transcription");

afterAll(() => {
	// Restore the genuine module so later test files don't inherit the stub.
	mock.module("@/lib/transcription/local-whisper", () => realLocalWhisper);
});

function file() {
	return new File([new Uint8Array([0, 1, 2])], "clip.mp4", {
		type: "video/mp4",
	});
}

describe("transcribeFileWithEngine (whisper error handling)", () => {
	beforeEach(() => {
		localSupported = true;
		localTranscribe = () =>
			Promise.resolve({ segments: [], language: "en", duration: 1 });
	});

	afterEach(() => {
		// Undo the aiClient.transcribe spy (a shared singleton across files).
		mock.restore();
	});

	it("surfaces the on-device error when the server fallback also fails", async () => {
		localTranscribe = () =>
			Promise.reject(new Error("WebGPU shader compilation failed"));
		spyOn(aiClient, "transcribe").mockImplementation(() =>
			Promise.reject(
				new Error("Cannot connect to AI backend. Make sure it is running."),
			),
		);

		await expect(
			transcribeFileWithEngine({ file: file(), engine: "whisper" }),
		).rejects.toThrow("WebGPU shader compilation failed");
	});

	it("falls back to the server result when on-device fails but a backend is reachable", async () => {
		localTranscribe = () => Promise.reject(new Error("on-device unavailable"));
		const served = { segments: [{ id: 0 }], language: "es", duration: 2 };
		const spy = spyOn(aiClient, "transcribe").mockImplementation(() =>
			Promise.resolve(served as never),
		);

		const out = await transcribeFileWithEngine({
			file: file(),
			engine: "whisper",
		});
		expect(out).toBe(served as never);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("skips on-device entirely (uses the server) when local Whisper is unsupported", async () => {
		localSupported = false;
		let localCalled = false;
		localTranscribe = () => {
			localCalled = true;
			return Promise.reject(new Error("should not run"));
		};
		const served = { segments: [], language: "en", duration: 3 };
		spyOn(aiClient, "transcribe").mockImplementation(() =>
			Promise.resolve(served as never),
		);

		const out = await transcribeFileWithEngine({
			file: file(),
			engine: "whisper",
		});
		expect(localCalled).toBe(false);
		expect(out).toBe(served as never);
	});

	it("retries on-device ONCE on a transient network error, then succeeds", async () => {
		let calls = 0;
		const served = { segments: [{ id: 7 }], language: "en", duration: 4 };
		localTranscribe = () => {
			calls++;
			return calls === 1
				? Promise.reject(new Error("network error"))
				: Promise.resolve(served as never);
		};
		const serverSpy = spyOn(aiClient, "transcribe");

		const out = await transcribeFileWithEngine({
			file: file(),
			engine: "whisper",
		});
		expect(calls).toBe(2); // failed once, retried, succeeded
		expect(out).toBe(served as never);
		expect(serverSpy).not.toHaveBeenCalled(); // never touched the server
	});

	it("does NOT retry on-device for a non-network error", async () => {
		let calls = 0;
		localTranscribe = () => {
			calls++;
			return Promise.reject(new Error("Unable to decode audio data"));
		};
		const served = { segments: [], language: "en", duration: 1 };
		spyOn(aiClient, "transcribe").mockImplementation(() =>
			Promise.resolve(served as never),
		);

		await transcribeFileWithEngine({ file: file(), engine: "whisper" });
		expect(calls).toBe(1); // decode errors are not retryable
	});

	it("after two on-device network errors, surfaces the on-device error", async () => {
		let calls = 0;
		localTranscribe = () => {
			calls++;
			return Promise.reject(new Error("network error"));
		};
		spyOn(aiClient, "transcribe").mockImplementation(() =>
			Promise.reject(new Error("Cannot connect to AI backend.")),
		);

		await expect(
			transcribeFileWithEngine({ file: file(), engine: "whisper" }),
		).rejects.toThrow("network error");
		expect(calls).toBe(2); // one retry, then gives up on-device
	});
});
