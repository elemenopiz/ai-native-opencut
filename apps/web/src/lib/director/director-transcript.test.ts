import { afterEach, describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { usePersonaStore } from "@/stores/persona-store";
import type { AssetTranscript } from "@/lib/search/asset-transcript";
import { DIGEST_SEGMENT_CAP } from "@/lib/search/asset-transcript";
import { createDirectorApi } from "./director-api";
import type { AssetTranscriptLookup } from "./transcript-lookup";

/**
 * The `getTranscript` verb + the manifest's speech facet, wired through a real
 * `DirectorApi` over an in-memory editor with an INJECTED transcript lookup —
 * proving the speech grounding ships and is testable independently of the
 * Whisper runtime (same pattern as director-manifest.test.ts).
 */

function mediaAsset(
	id: string,
	name: string,
	type: "image" | "video" | "audio",
) {
	return { id, name, type, file: new File([new Uint8Array([1])], name) };
}

function makeEditor(assets: ReturnType<typeof mediaAsset>[]): EditorCore {
	return {
		timeline: {
			getTotalDuration: () => 0,
			getTracks: () => [{ id: "track_1", elements: [] }],
		},
		command: { canUndo: () => false, canRedo: () => false },
		media: {
			getAssetById: (id: string) => assets.find((a) => a.id === id),
			getAssets: () => assets,
		},
		project: { getActiveOrNull: () => null },
	} as unknown as EditorCore;
}

function transcriptOf(
	mediaId: string,
	texts: [start: number, end: number, text: string][],
): AssetTranscript {
	return {
		mediaId,
		segments: texts.map(([start, end, text]) => ({ start, end, text })),
		language: "en",
		durationSec: texts.at(-1)?.[1] ?? 0,
		engine: "stub",
		createdAt: 1,
	};
}

afterEach(() => {
	usePersonaStore.setState({ personas: [], activePersonaId: null });
});

describe("getTranscript verb", () => {
	const rows: Record<string, AssetTranscript> = {
		talk: transcriptOf("talk", [
			[0.0, 3.2, "Welcome back to the channel."],
			[3.4, 8.9, "Today we are testing the new director."],
			[9.1, 14.0, "Let's dive right in."],
		]),
		silent: transcriptOf("silent", []),
	};
	const lookup: AssetTranscriptLookup = (id) => rows[id];

	function director(lookupArg?: AssetTranscriptLookup) {
		const editor = makeEditor([
			mediaAsset("talk", "talk.mp4", "video"),
			mediaAsset("silent", "ambience.mp3", "audio"),
			mediaAsset("broll", "broll.mp4", "video"),
		]);
		return createDirectorApi(editor, { transcripts: lookupArg });
	}

	it("returns timestamped segments with cut-point guidance in the message", () => {
		const res = director(lookup).getTranscript({ mediaId: "talk" });
		expect(res.ok).toBe(true);
		expect(res.data?.segmentCount).toBe(3);
		expect(res.data?.segments).toHaveLength(3);
		expect(res.data?.truncated).toBe(false);
		// The message IS the observation: it carries the rendered lines + the
		// trim-timebase guidance, so the agent needs no DATA echo.
		expect(res.message).toContain("[3.4–8.9] Today we are testing");
		expect(res.message).toContain("asset-relative seconds");
		expect(res.message).toContain("never cut mid-sentence");
	});

	it("windows the read with startSec/endSec (partial overlaps included)", () => {
		const res = director(lookup).getTranscript({
			mediaId: "talk",
			startSec: 4,
			endSec: 10,
		});
		expect(res.data?.segments.map((s) => s.text)).toEqual([
			"Today we are testing the new director.",
			"Let's dive right in.",
		]);
		expect(res.data?.segmentCount).toBe(3); // total is pre-window
	});

	it("caps huge transcripts and flags truncation", () => {
		const huge = transcriptOf(
			"talk",
			Array.from(
				{ length: DIGEST_SEGMENT_CAP + 10 },
				(_, i) => [i, i + 1, `sentence ${i}`] as [number, number, string],
			),
		);
		const res = director(() => huge).getTranscript({ mediaId: "talk" });
		expect(res.data?.truncated).toBe(true);
		expect(res.data?.segments).toHaveLength(DIGEST_SEGMENT_CAP);
		expect(res.message).toContain("re-query with startSec/endSec");
	});

	it("distinguishes 'no speech' (ok) from 'no record' and 'not wired' (fail)", () => {
		const d = director(lookup);
		const silent = d.getTranscript({ mediaId: "silent" });
		expect(silent.ok).toBe(true);
		expect(silent.data?.segmentCount).toBe(0);
		expect(silent.message).toContain("no speech found");

		const missing = d.getTranscript({ mediaId: "broll" });
		expect(missing.ok).toBe(false);
		expect(missing.message).toContain("No transcript");

		const unwired = director(undefined).getTranscript({ mediaId: "talk" });
		expect(unwired.ok).toBe(false);
		expect(unwired.message).toContain("No transcript pass is wired");
	});

	it("surfaces the speech facet in the library manifest digest", () => {
		const info = director(lookup).getProjectInfo().data;
		// talk has speech; silent was transcribed but empty; broll has no record.
		expect(info?.manifest.speechCount).toBe(1);
		expect(info?.manifest.digest).toContain(
			"1 with speech — getTranscript(mediaId) for sentence-aligned cut points.",
		);
	});

	it("adds zero digest bytes when nothing has speech", () => {
		const info = director(() => undefined).getProjectInfo().data;
		expect(info?.manifest.speechCount).toBe(0);
		expect(info?.manifest.digest).not.toContain("with speech");
	});
});
