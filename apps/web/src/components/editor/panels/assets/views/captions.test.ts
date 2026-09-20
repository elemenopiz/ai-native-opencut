import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for "the Transcribe action still fires anyway" bug: when
 * MAI-Transcribe-2 has no server-side key, `/api/transcribe` always 503s, so
 * clicking "Generate transcript" was a guaranteed failed round trip before
 * the user ever saw the (already-correct) friendly line. The fix disables
 * the button once the session has learned this — see
 * `use-transcription.ts`'s `useTranscriptionNotConfigured`/
 * `TRANSCRIPTION_UNAVAILABLE_MESSAGE`, reusing the same external-store
 * pattern as `enhance-prompt-button.tsx`.
 *
 * This repo has no component-test harness (no @testing-library/react / jsdom
 * in package.json) to render the panel and click through it — see
 * `batch-export.audio-defaults.test.ts` for the established workaround this
 * follows: assert on the source of the specific code path under test.
 */
describe("captions panel — transcribe availability", () => {
	const source = readFileSync(join(import.meta.dir, "captions.tsx"), "utf8");

	test("imports the shared not-configured store instead of inventing a local one", () => {
		expect(source).toMatch(
			/useTranscriptionNotConfigured.*from "@\/hooks\/use-transcription"|from "@\/hooks\/use-transcription"[\s\S]*?useTranscriptionNotConfigured/,
		);
		expect(source).toMatch(/TRANSCRIPTION_UNAVAILABLE_MESSAGE/);
	});

	test("only gates the mai engine — sarvam/smallest use a different backend", () => {
		const match = source.match(/const maiUnavailable = ([^;]+);/);
		expect(match).not.toBeNull();
		const expression = match?.[1] ?? "";
		expect(expression).toMatch(/selectedEngine === "mai"/);
		expect(expression).toMatch(/transcriptionNotConfigured/);
	});

	test("the Generate/Re-transcribe button disables and explains itself when mai is unavailable", () => {
		const start = source.indexOf(
			"const handleGenerateTranscript = async () => {",
		);
		const buttonStart = source.indexOf(
			"onClick={handleGenerateTranscript}",
			start,
		);
		expect(buttonStart).toBeGreaterThan(-1);
		const buttonBlock = source.slice(buttonStart, buttonStart + 800);

		// Disabled — not hidden — so the surface still LOOKS present.
		expect(buttonBlock).toMatch(
			/disabled=\{isProcessing \|\| maiUnavailable\}/,
		);
		// Explicable even if the disabled button suppresses the native hover
		// tooltip (shadcn's disabled:pointer-events-none) — a title AND a
		// persistent inline line, not hover-only.
		expect(buttonBlock).toMatch(/title=\{maiUnavailable/);
		expect(buttonBlock).toMatch(/maiUnavailable/);
	});

	test("handleGenerateTranscript itself bails out before making a network call", () => {
		const start = source.indexOf(
			"const handleGenerateTranscript = async () => {",
		);
		const guardRegion = source.slice(start, start + 400);
		expect(guardRegion).toMatch(/if \(maiUnavailable\)/);
	});

	test("the disabled-state copy names no provider, key, or env var", () => {
		const idx = source.indexOf("{maiUnavailable && !isProcessing && (");
		expect(idx).toBeGreaterThan(-1);
		const block = source.slice(idx, idx + 300);
		expect(block).not.toMatch(/azure|AZURE_SPEECH|env/i);
	});
});
