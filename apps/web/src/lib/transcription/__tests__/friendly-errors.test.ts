import { describe, expect, it } from "bun:test";
import {
	friendlyTranscriptionError,
	transcriptionDevHint,
	transcriptionErrorDetail,
} from "../friendly-errors";

/**
 * Standing rule: customer surfaces never show technical errors and never name
 * providers, env vars, container commands, or paths in primary copy. These
 * pin that property for the transcription/translation/speaker surfaces, the
 * same way `views/director.test.ts` pins it for the Director chat bubble.
 */

// Every token that must never appear in a visible line.
const FORBIDDEN = [
	"BYORN_SARVAM_API_KEY",
	"BYORN_SMALLEST_API_KEY",
	"Sarvam",
	"Smallest",
	"Whisper",
	"docker",
	"docker compose",
	"ai-backend",
	"speaker-service",
	"AI backend",
	"localhost",
	".env",
	"apps/web",
	"connection_refused",
	"ECONNREFUSED",
	"503",
	"404",
];

const RAW_DETAILS = [
	"Cannot connect to AI backend. Start the backend server first.",
	"connection_refused",
	"Sarvam API key is not configured. Add BYORN_SARVAM_API_KEY to your environment.",
	"Smallest AI API key is not configured. Set BYORN_SMALLEST_API_KEY in apps/web/.env.local.",
	"Speaker endpoint not found (404). Run: docker compose restart ai-backend",
	"Speaker service is not running (503). docker compose up -d speaker-service",
	"fetch failed: ECONNREFUSED 127.0.0.1:8420",
	"Backend error: 500 Internal Server Error",
	"TypeError: something.exploded is not a function",
	"",
];

describe("friendlyTranscriptionError — visible copy", () => {
	it("never leaks an infrastructure name from ANY raw detail", () => {
		for (const detail of RAW_DETAILS) {
			for (const task of ["transcribe", "translate", "speakers"] as const) {
				const line = friendlyTranscriptionError(detail, task);
				for (const token of FORBIDDEN) {
					expect(
						line.toLowerCase().includes(token.toLowerCase()),
						`"${token}" leaked into: ${line} (from: ${detail})`,
					).toBe(false);
				}
			}
		}
	});

	it("never echoes the raw detail back", () => {
		const detail = "Backend error: 500 Internal Server Error";
		expect(friendlyTranscriptionError(detail)).not.toContain(detail);
		expect(friendlyTranscriptionError(detail)).not.toContain("500");
	});

	it("names the task the user was actually doing", () => {
		expect(
			friendlyTranscriptionError("connection_refused", "transcribe"),
		).toContain("Transcription");
		expect(
			friendlyTranscriptionError("connection_refused", "translate"),
		).toContain("Translation");
		expect(
			friendlyTranscriptionError("connection_refused", "speakers"),
		).toContain("Speaker detection");
	});

	it("tells the user to retry when the cause looks transient", () => {
		for (const detail of [
			"Cannot connect to AI backend",
			"fetch failed",
			"request timed out",
			"Backend error: 503",
		]) {
			expect(friendlyTranscriptionError(detail)).toMatch(/try again/i);
		}
	});

	it("gives actionable guidance for an unsupported file, without a codec dump", () => {
		const line = friendlyTranscriptionError(
			"Invalid file format. Supported: mp4, mkv, avi, mov, webm, wav, mp3, m4a, ogg, flac, aac.",
		);
		expect(line).toMatch(/isn't supported/i);
		expect(line).toContain("MP4");
	});

	it("falls back to a generic line for anything unrecognized", () => {
		expect(
			friendlyTranscriptionError(
				"TypeError: something.exploded is not a function",
			),
		).toBe("Transcription didn't work this time. Please try again.");
		expect(friendlyTranscriptionError("")).toBe(
			"Transcription didn't work this time. Please try again.",
		);
	});
});

describe("transcriptionDevHint / transcriptionErrorDetail — collapsed channel", () => {
	it("keeps the raw detail available behind the collapsed channel", () => {
		const detail = "Backend error: 500 Internal Server Error";
		expect(transcriptionErrorDetail(detail)).toContain(detail);
	});

	it("points a developer at the right key outside production", () => {
		// The test runner is not NODE_ENV=production, so hints are live here.
		expect(transcriptionDevHint("Sarvam API key missing")).toContain(
			"BYORN_SARVAM_API_KEY",
		);
		expect(transcriptionDevHint("Smallest AI API key missing")).toContain(
			"BYORN_SMALLEST_API_KEY",
		);
		expect(transcriptionDevHint("connection_refused")).toMatch(/backend/i);
	});

	it("adds nothing for an unrecognized detail", () => {
		expect(transcriptionDevHint("TypeError: boom")).toBe("");
	});

	it("is silent in production, so no customer can ever see a key name", () => {
		const previous = process.env.NODE_ENV;
		try {
			// @ts-expect-error — NODE_ENV is typed readonly, overridden for the test.
			process.env.NODE_ENV = "production";
			expect(transcriptionDevHint("Sarvam API key missing")).toBe("");
			expect(transcriptionDevHint("connection_refused")).toBe("");
		} finally {
			// @ts-expect-error — restore.
			process.env.NODE_ENV = previous;
		}
	});
});
