/**
 * `scene` — a named, independently-tracked cut inside the project (a project
 * can hold several; one is `isMain`). Source of truth: `types/timeline.ts`'s
 * `TScene` interface and `ScenesManager`'s `renameScene`/`createScene`/
 * `deleteScene`/`switchToScene`.
 */

import type { KindSchema } from "../schema";

export const sceneSchema: KindSchema = {
	kind: "scene",
	summary: "A named, independently-tracked cut inside the project.",
	fields: {
		id: {
			type: "id",
			of: "scene",
			description: "This scene's own kernel id.",
			readOnly: true,
			readOnlyReason: "identity, not a field — create mints a new one.",
			aliases: ["sceneId"],
		},
		name: {
			type: "string",
			description: "The scene's label, shown in the scene switcher.",
		},
		isMain: {
			type: "boolean",
			description: "The project's primary scene — cannot be deleted.",
			readOnly: true,
			readOnlyReason:
				"assigned when the scene is created, not an editable flag.",
		},
		tracks: {
			type: "array",
			description: "The tracks belonging to this scene.",
			readOnly: true,
			readOnlyReason:
				"membership changes by creating/deleting tracks (kind `track`), not by writing this list.",
		},
		markers: {
			type: "array",
			description: "The markers placed in this scene (kind `marker`).",
			readOnly: true,
			readOnlyReason:
				"membership changes by creating/deleting markers, not by writing this list.",
		},
		bookmarks: {
			type: "array",
			description:
				"Legacy time-keyed bookmarks ({ time, note?, color?, duration? }) — no stable id, so individual entries are not addressable the way markers are. Read-only here for visibility.",
			readOnly: true,
			readOnlyReason:
				"addressed by time value through ScenesManager, not a kernel id — not a kernel-writable list.",
		},
		createdAt: {
			type: "string",
			description: "When this scene was created (ISO datetime).",
			readOnly: true,
			readOnlyReason: "stamped at creation.",
		},
		updatedAt: {
			type: "string",
			description: "When this scene was last modified (ISO datetime).",
			readOnly: true,
			readOnlyReason:
				"bumped automatically on every write to the scene's tracks/markers.",
		},
	},
};
