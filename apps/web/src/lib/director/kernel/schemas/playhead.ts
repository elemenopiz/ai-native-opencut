/**
 * `playhead` — playback transport state. Source of truth: `PlaybackManager`,
 * also a SINGLETON like `selection` — one transport per editor. Fields
 * mirror its private state exactly (`currentTime`, `isPlaying`, `volume`,
 * `muted`, `isScrubbing`, `shuttleSpeed`, `shuttleDirection`).
 *
 * The other "fully dark" manager from the design doc's §1 measurement — the
 * Director could not move the playhead or drive transport at any price
 * before this kind existed.
 *
 * NOT THE SAME NUMBER AS `TProject.timelineViewState.playheadTime`. That is
 * UI scroll/zoom state persisted with the project; this `currentTime` is the
 * live transport position `play`/`pause`/`seek` actually drive. See
 * `project.ts`'s doc comment and the final report for why that split is
 * flagged rather than quietly resolved.
 */

import type { KindSchema } from "../schema";

export const playheadSchema: KindSchema = {
	kind: "playhead",
	summary:
		"Playback transport — where the playhead is and whether it's moving.",
	fields: {
		time: {
			type: "number",
			unit: "seconds",
			description:
				"Current playback position, project-absolute. Writing this seeks (clamped to [0, project duration]).",
			aliases: ["currentTime"],
		},
		playing: {
			type: "boolean",
			description:
				"Whether playback is currently advancing. Writing true/false plays/pauses.",
			aliases: ["isPlaying"],
		},
		volume: {
			type: "number",
			unit: "0-1",
			description:
				"Monitoring volume for playback (independent of any track/clip volume).",
		},
		muted: {
			type: "boolean",
			description:
				"Playback mute. Unmuting restores the volume level from just before muting.",
		},
		scrubbing: {
			type: "boolean",
			description:
				"Whether the playhead is being actively dragged — suppresses some playback side effects while true.",
			aliases: ["isScrubbing"],
		},
		shuttleSpeed: {
			type: "number",
			unit: "×",
			description:
				"Current J/L shuttle speed multiplier (1/2/4/8), 0 when not shuttling.",
			readOnly: true,
			readOnlyReason:
				"derived from repeated shuttle-key presses, not directly settable.",
		},
		shuttleDirection: {
			type: "enum",
			values: ["forward", "reverse"],
			description: "Current shuttle direction, absent when not shuttling.",
			readOnly: true,
			readOnlyReason: "derived from which shuttle key is being pressed.",
		},
	},
};
