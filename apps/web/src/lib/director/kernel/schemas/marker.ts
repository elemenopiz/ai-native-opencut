/**
 * `marker` — a labeled point in time on the active scene. Source of truth:
 * `types/timeline.ts`'s `Marker` interface ({ id, time, note?, color,
 * createdAt }) and `ScenesManager`'s `addMarker`/`updateMarker`/`removeMarker`.
 *
 * NOT THE SAME THING AS A `Bookmark`. `TScene` carries both `markers` and
 * `bookmarks`, and they look interchangeable at a glance — both are a time
 * plus a note/color. `Bookmark` has no `id`, though: it is addressed by its
 * `time` value directly (`ToggleBookmarkCommand(time)`,
 * `RemoveBookmarkCommand(time)`), which makes it unaddressable in a
 * self-typed id space without inventing an id the manager doesn't have. Only
 * `Marker` is modeled here; a Director that wants "mark this point" should
 * reach for this kind, not the legacy bookmark path.
 */

import type { KindSchema } from "../schema";

export const markerSchema: KindSchema = {
	kind: "marker",
	summary: "A labeled point in time on the active scene.",
	fields: {
		id: {
			type: "id",
			of: "marker",
			description: "This marker's own kernel id.",
			readOnly: true,
			readOnlyReason: "identity, not a field — create mints a new one.",
			aliases: ["markerId"],
		},
		time: {
			type: "number",
			unit: "seconds",
			description: "Where this marker sits, in project-absolute seconds.",
		},
		color: {
			type: "enum",
			values: ["red", "yellow", "green", "blue", "purple"],
			description:
				'The marker\'s color, for visual grouping (e.g. "needs review" vs "beat hit").',
		},
		note: {
			type: "string",
			description: "Optional label for what this point in the timeline means.",
		},
		createdAt: {
			type: "number",
			unit: "epoch-ms",
			description: "When this marker was added.",
			readOnly: true,
			readOnlyReason: "stamped at creation.",
		},
	},
};
