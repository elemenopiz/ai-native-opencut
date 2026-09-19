import { describe, expect, it } from "bun:test";
import {
	TRANSCRIBE_CHUNK_TARGET_BYTES,
	TRANSCRIBE_MAX_UPLOAD_BYTES,
	TRANSCRIPTION_LANGUAGES,
	toTranscriptionLocale,
} from "@/constants/transcription-constants";

describe("toTranscriptionLocale", () => {
	it("region-qualifies a bare language code", () => {
		// The provider rejects an unqualified tag, so "en" must never be sent
		// through as-is — this is the single most likely cause of a 400 that
		// would otherwise look like a generic provider failure.
		expect(toTranscriptionLocale("en")).toBe("en-US");
		expect(toTranscriptionLocale("hi")).toBe("hi-IN");
		expect(toTranscriptionLocale("pt")).toBe("pt-BR");
	});

	it("maps Odia to its ISO-639-1 locale, not the app's internal code", () => {
		// The app stores Odia as "od"; the provider knows it as "or-IN". A
		// pass-through here would silently disable the language.
		expect(toTranscriptionLocale("od")).toBe("or-IN");
	});

	it("falls back to auto-detect rather than guessing a region", () => {
		expect(toTranscriptionLocale("auto")).toBeUndefined();
		expect(toTranscriptionLocale(undefined)).toBeUndefined();
		// Unmapped but real app language — better to let the multilingual model
		// decide than to invent a region tag the provider may not accept.
		expect(toTranscriptionLocale("sa")).toBeUndefined();
	});
});

describe("transcription language list", () => {
	it("covers the Indian languages the old local engine could not", () => {
		// The Whisper-era list was 9 global languages, and Indian languages were
		// silently redirected to a second engine. That redirect is gone, so the
		// list itself has to carry them.
		const codes = TRANSCRIPTION_LANGUAGES.map((l) => l.code);
		expect(codes).toContain("en");
		expect(codes).toContain("hi");
		expect(codes).toContain("ta");
		expect(codes.length).toBeGreaterThan(20);
	});
});

describe("upload size bounds", () => {
	it("gives the server headroom over the client's chunk target", () => {
		// A chunk that compresses worse than predicted must not 413 — the server
		// bound has to sit above the size the client aims for.
		expect(TRANSCRIBE_MAX_UPLOAD_BYTES).toBeGreaterThan(
			TRANSCRIBE_CHUNK_TARGET_BYTES,
		);
	});
});
