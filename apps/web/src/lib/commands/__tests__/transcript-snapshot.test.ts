import { beforeEach, describe, expect, test } from "bun:test";
import { useTranscriptStore } from "@/stores/transcript-store";
import {
	captureTranscriptSnapshot,
	hasTranscriptChanged,
	TranscriptSnapshotCommand,
} from "@/lib/commands/transcript";
import type { TranscriptionSegment } from "@/types/ai";

/**
 * `TranscriptSnapshotCommand` (#44) property tests. Unlike every other
 * command in this campaign, this one operates on real zustand state directly
 * (`useTranscriptStore`) rather than through `EditorCore` — no fake-editor
 * harness needed. It's also structurally different from the "re-snapshot
 * current state" pattern the rest of the inventory follows: `before`/`after`
 * are captured by the CALLER (see `hooks/use-smart-cut.ts`,
 * `hooks/use-text-timeline-bridge.ts`) and passed in fully formed, so
 * `execute()`/`redo()` (inherited, `redo()=execute()`) always replay the
 * exact same fixed `afterState` — trivially redo-idempotent by construction,
 * confirmed here.
 */
function segment(id: number, text: string): TranscriptionSegment {
	return { id, start: 0, end: 1, text } as TranscriptionSegment;
}

beforeEach(() => {
	useTranscriptStore.getState().reset();
});

describe("TranscriptSnapshotCommand", () => {
	test("execute applies the after-state; undo restores the exact before-state", () => {
		const before = captureTranscriptSnapshot();
		useTranscriptStore.getState().setSegments([segment(1, "hello")]);
		const after = captureTranscriptSnapshot();

		useTranscriptStore.getState().reset();
		expect(useTranscriptStore.getState().segments).toEqual([]);

		const command = new TranscriptSnapshotCommand(before, after);
		command.execute();

		expect(useTranscriptStore.getState().segments).toEqual([
			segment(1, "hello"),
		]);

		command.undo();
		expect(useTranscriptStore.getState().segments).toEqual([]);
	});

	test("redo (inherited execute()) re-applies the SAME fixed after-state, not a re-derived current one", () => {
		const before = captureTranscriptSnapshot();
		useTranscriptStore.getState().setSegments([segment(1, "hello")]);
		const after = captureTranscriptSnapshot();

		const command = new TranscriptSnapshotCommand(before, after);
		command.execute();
		command.undo();

		// Mutate the store to something ELSE entirely in between, simulating
		// unrelated state drift before a redo happens.
		useTranscriptStore.getState().setSegments([segment(9, "unrelated")]);

		command.redo();

		expect(useTranscriptStore.getState().segments).toEqual([
			segment(1, "hello"),
		]);
	});

	test("restores speaker names, positions, and translations on undo", () => {
		const before = captureTranscriptSnapshot();
		useTranscriptStore.getState().setSpeakerNames({ SPEAKER_A: "Alice" });
		useTranscriptStore.getState().setSpeakerPosition("SPEAKER_A", "left");
		useTranscriptStore.getState().addTranslation({
			languageCode: "es",
			languageName: "Spanish",
			segments: [segment(1, "hola")],
		});
		const after = captureTranscriptSnapshot();

		const command = new TranscriptSnapshotCommand(before, after);
		command.execute();

		expect(useTranscriptStore.getState().speakerNames).toEqual({
			SPEAKER_A: "Alice",
		});
		expect(useTranscriptStore.getState().translations).toHaveLength(1);

		command.undo();

		expect(useTranscriptStore.getState().speakerNames).toEqual({});
		expect(useTranscriptStore.getState().speakerPositions).toEqual({});
		expect(useTranscriptStore.getState().translations).toEqual([]);
	});

	test("hasTranscriptChanged is false for two captures of identical unchanged state", () => {
		const a = captureTranscriptSnapshot();
		const b = captureTranscriptSnapshot();
		expect(hasTranscriptChanged(a, b)).toBe(false);
	});

	test("hasTranscriptChanged is true once segments differ", () => {
		const before = captureTranscriptSnapshot();
		useTranscriptStore.getState().setSegments([segment(1, "hello")]);
		const after = captureTranscriptSnapshot();
		expect(hasTranscriptChanged(before, after)).toBe(true);
	});
});
