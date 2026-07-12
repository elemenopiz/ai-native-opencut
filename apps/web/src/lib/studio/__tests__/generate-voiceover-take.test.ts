/**
 * Unit coverage for the cloud-TTS voiceover take pipeline
 * (`generate-voiceover-take.ts`) after the browser-first flip (plan Task 8):
 *
 *  - CONSENT GATE ordering: an unconsented clone still fails with the consent
 *    message (Flow D #1), BEFORE the beta gate can mask it.
 *  - BETA GATE: any clone-backed spec (`voiceRef`) fails early with
 *    "Voice cloning is unavailable in beta" — even a consented clone — and
 *    never reaches the TTS request.
 *  - VOICE ALLOWLIST: only a `/api/tts`-allowlisted voice is forwarded; legacy
 *    values (the old "male"/"female" toggle, XTTS speaker names) are omitted
 *    from the wire request so the route's zod enum can't 400 the whole call.
 *
 * `aiClient.generateSpeechBlob` is spied via `spyOn` (restored per test) — no
 * `mock.module`, so nothing leaks into bun's process-global mock registry.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { aiClient } from "@/lib/ai-client";
import { useVoiceConsentStore } from "@/stores/voice-consent-store";
import type { EditorCore } from "@/core";
import type { TTSRequest } from "@/types/ai";
import {
	generateVoiceoverTakeMedia,
	makeVoiceoverSpec,
} from "../generate-voiceover-take";

// The editor is only touched AFTER a successful TTS call (media import) — every
// test here stops at or before the request, so a bare stub is enough.
const editor = {} as unknown as EditorCore;

/** Sentinel the spy throws AFTER capturing the request, so tests can assert the
 *  wire shape without dragging the browser media pipeline into bun. */
const STOP = new Error("stop-after-capture");

let captured: TTSRequest | null;
let speechSpy: ReturnType<typeof spyOn<typeof aiClient, "generateSpeechBlob">>;

beforeEach(() => {
	useVoiceConsentStore.setState({ profiles: {} });
	captured = null;
	speechSpy = spyOn(aiClient, "generateSpeechBlob").mockImplementation(
		async (request: TTSRequest) => {
			captured = request;
			throw STOP;
		},
	);
});

afterEach(() => {
	speechSpy.mockRestore();
});

describe("voice-clone gating (order matters)", () => {
	it("fails an UNCONSENTED clone with the consent message, not the beta one", async () => {
		useVoiceConsentStore
			.getState()
			.registerClone({ name: "Mara", referencePath: "/ref/mara.wav" });

		const result = await generateVoiceoverTakeMedia({
			editor,
			projectId: "p1",
			spec: makeVoiceoverSpec({ text: "hello", voiceRef: "/ref/mara.wav" }),
		});

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error).toMatch(/consent/i);
			expect(result.error).not.toContain("unavailable in beta");
		}
		expect(speechSpy).not.toHaveBeenCalled();
	});

	it("fails EARLY with the beta message for a CONSENTED clone — cloning is retired", async () => {
		const clone = useVoiceConsentStore
			.getState()
			.registerClone({ name: "Mara", referencePath: "/ref/mara.wav" });
		useVoiceConsentStore
			.getState()
			.grantProfileConsent(clone.id, { phrase: "x" });

		const result = await generateVoiceoverTakeMedia({
			editor,
			projectId: "p1",
			spec: makeVoiceoverSpec({ text: "hello", voiceRef: "/ref/mara.wav" }),
		});

		expect(result).toEqual({
			status: "failed",
			error: "Voice cloning is unavailable in beta",
		});
		expect(speechSpy).not.toHaveBeenCalled();
	});

	it("fails an unknown (never-registered) voiceRef with the beta message too", async () => {
		const result = await generateVoiceoverTakeMedia({
			editor,
			projectId: "p1",
			spec: makeVoiceoverSpec({ text: "hello", voiceRef: "/ref/ghost.wav" }),
		});

		expect(result).toEqual({
			status: "failed",
			error: "Voice cloning is unavailable in beta",
		});
		expect(speechSpy).not.toHaveBeenCalled();
	});
});

describe("voice allowlist pass-through", () => {
	it("OMITS a non-allowlisted voice from the wire request (route would 400)", async () => {
		// An XTTS-era speaker name — exactly the legacy value old specs carry.
		await generateVoiceoverTakeMedia({
			editor,
			projectId: "p1",
			spec: makeVoiceoverSpec({ text: "hello", voice: "Claribel Dervla" }),
		});

		expect(captured).not.toBeNull();
		// The wire body (what the route's strict zod schema sees) has NO voice key.
		const wire = JSON.parse(JSON.stringify(captured)) as Record<
			string,
			unknown
		>;
		expect("voice" in wire).toBe(false);
	});

	it("omits the old male/female toggle values the same way", async () => {
		await generateVoiceoverTakeMedia({
			editor,
			projectId: "p1",
			spec: makeVoiceoverSpec({ text: "hello", voice: "male" }),
		});

		const wire = JSON.parse(JSON.stringify(captured)) as Record<
			string,
			unknown
		>;
		expect("voice" in wire).toBe(false);
	});

	it("forwards an allowlisted voice untouched", async () => {
		await generateVoiceoverTakeMedia({
			editor,
			projectId: "p1",
			spec: makeVoiceoverSpec({ text: "hello", voice: "nova" }),
		});

		expect(captured?.voice).toBe("nova");
		expect(captured?.text).toBe("hello");
	});
});

describe("makeVoiceoverSpec provenance", () => {
	it("stamps the cloud TTS model, not the retired xtts default", () => {
		const spec = makeVoiceoverSpec({ text: "hello" });
		expect(spec.model).toBe("gpt-4o-mini-tts");
	});
});
