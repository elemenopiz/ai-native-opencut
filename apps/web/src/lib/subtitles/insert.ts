// Insert parsed subtitle cues as a real text track on the timeline.
//
// Adapted from valenbine/OpenCut-ZHS (MIT) @ 2593e12c4ff0e3649000f03fe00202f2ec941522
// src/subtitles/insert.ts. The source composes AddTrack + InsertElement commands
// into a single BatchCommand; Byorn's EditorCore exposes those as timeline manager
// methods (addTrack / insertElement / renameTrack), matching the existing
// `addSubtitleTrack` flow in captions.tsx, so this mirrors that.
// See THIRD_PARTY_NOTICES.

import type { EditorCore } from "@/core";
import { buildSubtitleTextElement } from "./build-subtitle-text-element";
import type { SubtitleCue } from "./types";

export function insertSubtitleCuesAsTextTrack({
	editor,
	cues,
	trackName,
}: {
	editor: EditorCore;
	cues: SubtitleCue[];
	trackName?: string;
}): { trackId: string; count: number } | null {
	if (cues.length === 0) {
		return null;
	}

	// One track + N cue elements is one user action — collapse into one undo step.
	const supportsTransaction =
		typeof editor.command.beginTransaction === "function";
	if (supportsTransaction) {
		editor.command.beginTransaction({ name: trackName ?? "Import subtitles" });
	}

	try {
		const trackId = editor.timeline.addTrack({ type: "text", index: 0 });
		if (trackName) {
			editor.timeline.renameTrack({ trackId, name: trackName });
		}

		const canvasSize = editor.project.getActive().settings.canvasSize;

		for (let index = 0; index < cues.length; index++) {
			editor.timeline.insertElement({
				placement: { mode: "explicit", trackId },
				element: buildSubtitleTextElement({
					index,
					cue: cues[index],
					canvasSize,
				}),
			});
		}

		if (supportsTransaction) editor.command.commitTransaction();
		return { trackId, count: cues.length };
	} catch (err) {
		if (supportsTransaction) editor.command.rollbackTransaction();
		throw err;
	}
}
