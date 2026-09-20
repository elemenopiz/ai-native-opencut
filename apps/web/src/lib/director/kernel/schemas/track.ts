/**
 * `track` — a horizontal lane on the timeline. Source of truth:
 * `types/timeline.ts`'s `TimelineTrack` union (`BaseTrack` +
 * `VideoTrack` | `TextTrack` | `AudioTrack` | `StickerTrack` | `ShapeTrack` |
 * `EffectTrack`) and the writable subset `TimelineManager.updateTrack` actually
 * accepts (`muted`, `hidden`, `volume`, `pan`, `solo`, `color`, `locked`) plus
 * the two fields with their own dedicated setters (`renameTrack` → `name`,
 * `setTrackColor`/`toggleTrackLock` → `color`/`locked`, folded back into the
 * same `updateTrack` shape here since the kernel exposes one `update`).
 *
 * Several fields below only apply to some track types (e.g. `pan` is audio-
 * only, `isMain` is video-only) — the registry stays flat per kind rather than
 * branching on `type`, so the field description carries the "only on…" note
 * instead of a nested per-subtype schema.
 */

import type { KindSchema } from "../schema";

export const trackSchema: KindSchema = {
	kind: "track",
	summary: "A lane on the timeline that holds elements of one type.",
	fields: {
		id: {
			type: "id",
			of: "track",
			description: "This track's own kernel id.",
			readOnly: true,
			readOnlyReason: "identity, not a field — addTrack mints a new one.",
			aliases: ["trackId"],
		},
		type: {
			type: "enum",
			values: ["video", "text", "audio", "sticker", "shape", "effect"],
			description: "What kind of elements this track holds.",
			readOnly: true,
			readOnlyReason:
				"fixed at creation (addTrack); a track cannot change what it holds.",
		},
		name: {
			type: "string",
			description: "The label shown for this track in the timeline UI.",
		},
		color: {
			type: "enum",
			values: [
				"default",
				"red",
				"orange",
				"yellow",
				"green",
				"blue",
				"purple",
				"pink",
			],
			description: "The track's header color, for visual grouping.",
		},
		locked: {
			type: "boolean",
			description:
				"Locked tracks reject element edits from the UI. The kernel itself is not gated by this — it is a human-facing safety, not enforcement — but respect it as intent unless told otherwise.",
		},
		muted: {
			type: "boolean",
			description:
				"Video and audio tracks only — silences every element on the track.",
		},
		hidden: {
			type: "boolean",
			description:
				"Video/text/sticker/shape/effect tracks only — hides every element on the track without removing them.",
		},
		volume: {
			type: "number",
			unit: "0-1",
			description: "Video and audio tracks only — the track's overall level.",
		},
		pan: {
			type: "number",
			unit: "-1 to 1",
			description:
				"Audio tracks only. -1 = full left, 0 = center, 1 = full right.",
		},
		solo: {
			type: "boolean",
			description:
				"Video and audio tracks only — when any track is soloed, only soloed tracks are audible/visible in preview.",
		},
		isMain: {
			type: "boolean",
			description:
				"Video tracks only — the scene's primary video track (the one new clips land on by default).",
			readOnly: true,
			readOnlyReason:
				"assigned when the track is created, not an editable flag.",
		},
		elements: {
			type: "array",
			description: "The elements placed on this track, in no particular order.",
			readOnly: true,
			readOnlyReason:
				"membership changes by creating/moving/deleting elements (kind `element`), not by writing this list.",
		},
	},
};
