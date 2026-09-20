import { afterEach, describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import type { Command } from "@/lib/commands";
import { usePersonaStore } from "@/stores/persona-store";
import type { AssetTranscript } from "@/lib/search/asset-transcript";
import type { TimelineTrack } from "@/types/timeline";
import { createDirectorApi } from "./director-api";
import type { AssetTranscriptLookup } from "./transcript-lookup";

/**
 * `addCaptions` (Wave 3 "captions in one call") — the Director had no caption
 * verb at all, so captioning a transcript meant one `addText` call per
 * DEFAULT_WORDS_PER_CAPTION-word card: ~30 calls for 45s of speech.
 *
 * This is a REAL `DirectorApi` over a small in-memory `EditorCore` stub (not
 * `fake-editor.ts` — that shared fixture has no `addTrack`/`renameTrack`/
 * `removeTrack`/`updateElements`, which `addCaptions` needs via
 * `lib/subtitles/insert.ts`'s `insertSubtitleCuesAsTextTrack` plus its own
 * transform-override post-pass; building a small self-contained stub here
 * keeps this test file from adding surface to a fixture every other Director
 * test file shares). `command` is a REAL `CommandManager`, so undo/redo and
 * transaction batching are exercised for real, not asserted against a mock.
 */

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}_${++idCounter}`;

interface CapElement {
	id: string;
	type: "video" | "audio" | "text";
	name: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	mediaId?: string;
	content?: string;
	transform: {
		scale: number;
		position: { x: number; y: number };
		rotate: number;
	};
}

interface CapTrack {
	id: string;
	type: string;
	name: string;
	elements: CapElement[];
}

function makeCommand(
	description: string,
	doFn: () => void,
	undoFn: () => void,
): Command {
	return {
		execute: doFn,
		undo: undoFn,
		redo: doFn,
		getDescription: () => description,
	} as Command;
}

/** Options to make `insertElement` throw partway through a batch, simulating
 *  the exact mid-loop failure `addCaptions`'s ATOMICITY doc comment guards
 *  against. */
function makeCaptionEditor(opts?: { throwOnNthInsert?: number }) {
	const tracks: CapTrack[] = [];
	const command = new CommandManager();
	let insertCount = 0;

	const timeline = {
		getTracks: () => tracks as unknown as TimelineTrack[],
		addTrack: ({ type, index }: { type: string; index?: number }) => {
			const id = nextId("track");
			const track: CapTrack = { id, type, name: type, elements: [] };
			command.execute({
				command: makeCommand(
					"Add track",
					() => {
						if (index != null) tracks.splice(index, 0, track);
						else tracks.push(track);
					},
					() => {
						const i = tracks.indexOf(track);
						if (i !== -1) tracks.splice(i, 1);
					},
				),
			});
			return id;
		},
		renameTrack: ({ trackId, name }: { trackId: string; name: string }) => {
			const track = tracks.find((t) => t.id === trackId);
			if (!track) return;
			const before = track.name;
			command.execute({
				command: makeCommand(
					"Rename track",
					() => {
						track.name = name;
					},
					() => {
						track.name = before;
					},
				),
			});
		},
		removeTrack: ({ trackId }: { trackId: string }) => {
			const idx = tracks.findIndex((t) => t.id === trackId);
			if (idx === -1) return;
			const removed = tracks[idx];
			command.execute({
				command: makeCommand(
					"Remove track",
					() => {
						const i = tracks.indexOf(removed);
						if (i !== -1) tracks.splice(i, 1);
					},
					() => {
						tracks.splice(idx, 0, removed);
					},
				),
			});
		},
		insertElement: ({
			element,
			placement,
		}: {
			element: Partial<CapElement> & { type: CapElement["type"] };
			placement:
				| { mode: "explicit"; trackId: string }
				| { mode: "auto"; trackType?: string };
		}) => {
			insertCount++;
			if (
				opts?.throwOnNthInsert != null &&
				insertCount === opts.throwOnNthInsert
			) {
				throw new Error("simulated mid-batch failure");
			}
			const id = element.id ?? nextId("el");
			const full: CapElement = {
				trimStart: 0,
				trimEnd: 0,
				startTime: 0,
				duration: 5,
				name: "element",
				transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
				...element,
				id,
			} as CapElement;
			const track =
				placement.mode === "explicit"
					? tracks.find((t) => t.id === placement.trackId)
					: tracks.find((t) => t.type === (placement.trackType ?? full.type));
			if (!track) throw new Error("no track for insertElement");
			command.execute({
				command: makeCommand(
					"Insert element",
					() => track.elements.push(full),
					() => {
						track.elements = track.elements.filter((e) => e !== full);
					},
				),
			});
			return id;
		},
		updateElements: ({
			updates,
		}: {
			updates: Array<{
				trackId: string;
				elementId: string;
				updates: Record<string, unknown>;
			}>;
		}) => {
			for (const { trackId, elementId, updates: patch } of updates) {
				const track = tracks.find((t) => t.id === trackId);
				const element = track?.elements.find((e) => e.id === elementId);
				if (!track || !element) continue;
				const before = { ...element };
				command.execute({
					command: makeCommand(
						"Update element",
						() => Object.assign(element, patch),
						() => Object.assign(element, before),
					),
				});
			}
		},
	};

	// Also lets a test seed a placed clip directly (bypassing insertElement's
	// throw-injection, which only targets addCaptions' OWN inserts).
	function placeClip(
		el: Omit<CapElement, "transform"> & { type: "video" | "audio" },
	) {
		const track: CapTrack = {
			id: nextId("track"),
			type: el.type,
			name: el.type,
			elements: [],
		};
		tracks.push(track);
		track.elements.push({
			transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
			...el,
		});
		return track.id;
	}

	const activeProject = {
		metadata: { id: "proj_1", name: "Test Reel" },
		settings: { fps: 30, canvasSize: { width: 1080, height: 1920 } },
	};
	const project = {
		getActive: () => activeProject,
		getActiveOrNull: () => activeProject,
	};
	const media = { getAssets: () => [], getAssetById: () => undefined };

	const editor = { timeline, command, project, media } as unknown as EditorCore;
	return { editor, tracks, placeClip };
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

describe("addCaptions", () => {
	const rows: Record<string, AssetTranscript> = {
		talk: transcriptOf("talk", [[6.0, 9.0, "one two three four five six"]]),
		silent: transcriptOf("silent", []),
	};
	const lookup: AssetTranscriptLookup = (id) => rows[id];

	it("groups words into cards, converts asset-relative times to TIMELINE time on a TRIMMED clip, and defaults to a low-in-frame placement", () => {
		const { editor, tracks, placeClip } = makeCaptionEditor();
		// Placed at timeline t=10, trimmed in 5s (trimStart=5) — so
		// timelineOffsetForElement = startTime - trimStart = 5. The transcript's
		// [6.0–9.0] asset-relative segment must land at [11.0–14.0] TIMELINE.
		placeClip({
			id: "el_talk",
			type: "video",
			name: "talk.mp4",
			mediaId: "talk",
			startTime: 10,
			duration: 20,
			trimStart: 5,
			trimEnd: 0,
		});

		const d = createDirectorApi(editor, { transcripts: lookup });
		const res = d.addCaptions({ mediaId: "talk", wordsPerCaption: 3 });

		expect(res.ok).toBe(true);
		expect(res.data?.captionCount).toBe(2);
		expect(res.data?.droppedCards).toBe(0);

		const textTrack = tracks.find((t) => t.id === res.data?.trackId);
		expect(textTrack).toBeDefined();
		const cards = [...(textTrack?.elements ?? [])].sort(
			(a, b) => a.startTime - b.startTime,
		);
		expect(cards).toHaveLength(2);

		// Grouping: 6 words / wordsPerCaption=3 → two 3-word cards.
		expect(cards[0].content).toBe("one two three");
		expect(cards[1].content).toBe("four five six");

		// Timebase: ASSET-RELATIVE [6.0,7.5) and [7.5,9.0) shifted by the
		// element's +5s offset — NOT the raw asset-relative numbers.
		expect(cards[0].startTime).toBeCloseTo(11.0, 5);
		expect(cards[0].duration).toBeCloseTo(1.5, 5);
		expect(cards[1].startTime).toBeCloseTo(12.5, 5);
		expect(cards[1].duration).toBeCloseTo(1.5, 5);

		// Default placement: low-in-frame (bottom, ~10% margin), not dead center.
		// canvasHeight=1920 → y = 1920 * (0.5 - 0.1) = 768.
		for (const card of cards) {
			expect(card.transform.position.x).toBe(0);
			expect(card.transform.position.y).toBeCloseTo(768, 5);
		}
	});

	it("produces exactly ONE undo entry for the whole track + every card", () => {
		const { editor, placeClip } = makeCaptionEditor();
		placeClip({
			id: "el_talk",
			type: "video",
			name: "talk.mp4",
			mediaId: "talk",
			startTime: 0,
			duration: 20,
			trimStart: 0,
			trimEnd: 0,
		});

		expect(editor.command.getHistoryLength()).toBe(0);
		const d = createDirectorApi(editor, { transcripts: lookup });
		const res = d.addCaptions({ mediaId: "talk", wordsPerCaption: 3 });
		expect(res.ok).toBe(true);

		// One call → one history entry, however many cards it created.
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()).toHaveLength(2); // video + captions

		// And undo removes the WHOLE thing in one step.
		editor.command.undo();
		expect(editor.timeline.getTracks()).toHaveLength(1);
		expect(editor.command.getHistoryLength()).toBe(0);
	});

	it("overrides the default placement via transform, applied to every card", () => {
		const { editor, tracks, placeClip } = makeCaptionEditor();
		placeClip({
			id: "el_talk",
			type: "video",
			name: "talk.mp4",
			mediaId: "talk",
			startTime: 0,
			duration: 20,
			trimStart: 0,
			trimEnd: 0,
		});
		const d = createDirectorApi(editor, { transcripts: lookup });

		const res = d.addCaptions({
			mediaId: "talk",
			wordsPerCaption: 3,
			transform: { position: { y: -600 } },
		});
		expect(res.ok).toBe(true);

		const textTrack = tracks.find((t) => t.id === res.data?.trackId);
		for (const card of textTrack?.elements ?? []) {
			expect(card.transform.position.y).toBe(-600);
			expect(card.transform.position.x).toBe(0); // untouched axis kept
		}
	});

	it("rolls back cleanly on a mid-batch failure — no half-built track survives", () => {
		// Fails on the SECOND insertElement call (the caption track's own second
		// card) — insertSubtitleCuesAsTextTrack's rollback only clears undo
		// bookkeeping, so this proves addCaptions' own compensating cleanup.
		const { editor, placeClip } = makeCaptionEditor({ throwOnNthInsert: 2 });
		placeClip({
			id: "el_talk",
			type: "video",
			name: "talk.mp4",
			mediaId: "talk",
			startTime: 0,
			duration: 20,
			trimStart: 0,
			trimEnd: 0,
		});

		const tracksBefore = editor.timeline.getTracks().length;
		const d = createDirectorApi(editor, { transcripts: lookup });
		const res = d.addCaptions({ mediaId: "talk", wordsPerCaption: 3 });

		expect(res.ok).toBe(false);
		expect(res.message).toContain("rolled back");
		// No orphan caption track left behind, and no bogus history entry.
		expect(editor.timeline.getTracks()).toHaveLength(tracksBefore);
		expect(editor.command.getHistoryLength()).toBe(0);
	});

	it("reports dropped cards when part of the transcript is trimmed off the timeline, while still captioning the rest", () => {
		const { editor, placeClip } = makeCaptionEditor();
		// Only the source window [6.0, 7.6) is visible (trimEnd cuts the rest);
		// the second card's asset range [7.5,9.0) barely survives it... use a
		// tighter cut so ONE card is fully trimmed away instead.
		placeClip({
			id: "el_talk",
			type: "video",
			name: "talk.mp4",
			mediaId: "talk",
			startTime: 100,
			duration: 1.5, // visible source window: [6.0, 7.5)
			trimStart: 6.0,
			trimEnd: 0,
		});

		const d = createDirectorApi(editor, { transcripts: lookup });
		const res = d.addCaptions({ mediaId: "talk", wordsPerCaption: 3 });

		expect(res.ok).toBe(true);
		expect(res.data?.captionCount).toBe(1); // only "one two three" survives
		expect(res.data?.droppedCards).toBe(1); // "four five six" is trimmed away
		expect(res.message).toContain("dropped");
	});

	it("fails without creating anything when the transcript pass isn't wired, has no record, or has no speech", () => {
		const { editor, placeClip } = makeCaptionEditor();
		placeClip({
			id: "el_talk",
			type: "video",
			name: "talk.mp4",
			mediaId: "talk",
			startTime: 0,
			duration: 20,
			trimStart: 0,
			trimEnd: 0,
		});
		placeClip({
			id: "el_silent",
			type: "video",
			name: "silent.mp4",
			mediaId: "silent",
			startTime: 0,
			duration: 20,
			trimStart: 0,
			trimEnd: 0,
		});

		const unwired = createDirectorApi(editor).addCaptions({ mediaId: "talk" });
		expect(unwired.ok).toBe(false);
		expect(unwired.message).toContain("No transcript pass is wired");

		const d = createDirectorApi(editor, { transcripts: lookup });
		const noRecord = d.addCaptions({ mediaId: "broll" });
		expect(noRecord.ok).toBe(false);
		expect(noRecord.message).toContain("No transcript");

		const noSpeech = d.addCaptions({ mediaId: "silent" });
		expect(noSpeech.ok).toBe(false);
		expect(noSpeech.message).toContain("no speech");

		// None of the failure paths created a track.
		expect(editor.timeline.getTracks()).toHaveLength(2);
	});

	it("fails when the media isn't currently placed on the timeline", () => {
		const { editor } = makeCaptionEditor();
		const d = createDirectorApi(editor, { transcripts: lookup });
		const res = d.addCaptions({ mediaId: "talk" });
		expect(res.ok).toBe(false);
		expect(res.message).toContain("isn't currently on the timeline");
	});
});
