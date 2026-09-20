/**
 * `project` — the whole document. Source of truth: `types/project.ts`'s
 * `TProject`/`TProjectMetadata`/`TProjectSettings`, and `ProjectManager`'s
 * actual writers: `renameProject` → `metadata.name`, `updateSettings` →
 * `TProjectSettings` (`fps`/`canvasSize`/`background`/`proxyEditing`/
 * `proxyResolution`), `updateThumbnail` → `metadata.thumbnail`,
 * `setDirectorBrief` → `directorBrief`, and `ScenesManager.switchToScene`,
 * which is the ACTUAL writer of `currentSceneId` (it patches the project
 * record directly, there is no dedicated project-manager method for it).
 *
 * SCOPED DELIBERATELY. `TProject` also carries `projectBible` (the
 * versioned creative-memory system — style, cast, plan, checkpoint history)
 * and `mediaFolders`. Both are real and real writable, but they are deep,
 * mostly-internal state the Director's own machinery maintains rather than
 * fields a kernel `update` call is the natural way to touch — see the
 * schemas.test.ts notes / final report for why they were left out rather
 * than modeled shallowly and wrong.
 *
 * `currentSceneId` VS. THE `playhead` KIND — A GENUINE SUBSTRATE AMBIGUITY.
 * `TProject.timelineViewState.playheadTime` (UI scroll/zoom state) and
 * `PlaybackManager.currentTime` (the actual transport position kind
 * `playhead` models) are two DIFFERENT numbers that both mean "where the
 * playhead is". Neither is exposed here: see the report for why this is
 * flagged as unresolved substrate rather than silently picked one way.
 */

import type { KindSchema } from "../schema";

export const projectSchema: KindSchema = {
	kind: "project",
	summary:
		"The project as a whole — its settings, brief, and which scene is active.",
	fields: {
		id: {
			type: "id",
			of: "project",
			description: "This project's own kernel id.",
			readOnly: true,
			readOnlyReason: "identity, not a field.",
			aliases: ["projectId"],
		},
		name: {
			type: "string",
			description: "The project's display name.",
		},
		duration: {
			type: "number",
			unit: "seconds",
			description: "The project's total built length.",
			readOnly: true,
			readOnlyReason:
				"derived from the timeline — extend it by moving/adding elements, not by writing this.",
			aliases: ["durationSec"],
		},
		thumbnail: {
			type: "string",
			description: "The project's cover thumbnail (a data/blob URL).",
		},
		fps: {
			type: "number",
			unit: "fps",
			description:
				"The project's frame rate — governs frame-snapping everywhere in the timeline.",
		},
		canvasSize: {
			type: "object",
			description: "The output frame size — { width, height } in pixels.",
		},
		background: {
			type: "object",
			description:
				'What renders behind content that doesn\'t fill the canvas — { type: "color", color } or { type: "blur", blurIntensity }.',
		},
		proxyEditing: {
			type: "boolean",
			description:
				"Whether playback prefers lower-resolution editing proxies over full-resolution source.",
		},
		proxyResolution: {
			type: "enum",
			values: ["480p", "720p", "1080p"],
			description: "The target resolution for auto-generated editing proxies.",
		},
		currentSceneId: {
			type: "id",
			of: "scene",
			description:
				"Which scene is being edited. Reads/writes of kind `track` and `element` resolve against this scene — switching it changes what those calls see.",
			aliases: ["sceneId", "activeSceneId"],
		},
		directorBrief: {
			type: "object",
			description:
				"The durable creative brief the Director reads every turn and writes back as it learns — { goal, audience, tone, styleNote, platform, dos[], donts[], mustInclude[], notes[], durationSec }.",
			aliases: ["brief"],
		},
		createdAt: {
			type: "string",
			description: "When this project was created (ISO datetime).",
			readOnly: true,
			readOnlyReason: "stamped at creation.",
		},
		updatedAt: {
			type: "string",
			description: "When this project was last modified (ISO datetime).",
			readOnly: true,
			readOnlyReason: "bumped automatically on every write.",
		},
	},
};
