/**
 * `asset` — one item in the media library (uploaded or AI-generated).
 * Source of truth: `services/storage/types.ts`'s `MediaAssetData` +
 * `types/assets.ts`'s `MediaAsset`, and the writable subset
 * `MediaManager` actually exposes: `updateMediaAsset` patches ONLY
 * `label`/`name` (`Partial<Pick<MediaAsset, "label" | "name">>`), and
 * `moveAssetToFolder` patches `folderId` through a dedicated command.
 * Everything else on a `MediaAsset` is set once at ingest and never
 * patched afterward — this registry marks it read-only rather than
 * implying a write path that does not exist.
 *
 * `duration` KEEPS ITS RAW NAME ON PURPOSE. Unlike `element` — where
 * `derived-data.ts` already established `startSec`/`durationSec` as the
 * vocabulary every program reads — nothing in the codebase renames an
 * asset's `duration`. Renaming it here would invent a spelling nothing
 * else uses. The `unit: "seconds"` annotation is schema.ts's actual
 * mechanism for resolving the ambiguity a bare "duration" carries;
 * `durationSec` is kept as an alias so the vocabulary a model already
 * learned on `element` still resolves here.
 *
 * `width`/`height`/`duration`/`fps` ARE NOT TYPE-GATED THE WAY AN ELEMENT'S
 * FIELDS ARE. `MediaAssetData` is ONE flat interface for every `MediaType`
 * ("image" | "video" | "audio") — unlike `TimelineElement`, there is no
 * per-variant struct that structurally omits a field the way `EffectElement`
 * omits `hidden`. `kernel/read.ts`'s `locateAsset` says this outright:
 * "every declared field applies to every asset kind uniformly … no
 * unavailable needed." These four are populated by ingest PROBING, not
 * gated by `type` — an audio file that happened to embed video-like
 * metadata would still get a `width`. The description says "typically",
 * not "only", to avoid the same overstatement `element.hidden` made.
 */

import type { KindSchema } from "../schema";

export const assetSchema: KindSchema = {
	kind: "asset",
	summary:
		"One item in the media library — uploaded footage, audio, an image, or an AI-generated result.",
	fields: {
		id: {
			type: "id",
			of: "asset",
			description: "This asset's own kernel id.",
			readOnly: true,
			readOnlyReason: "identity, not a field.",
			aliases: ["assetId", "mediaId"],
		},
		name: {
			type: "string",
			description: "The asset's display name in the library.",
		},
		label: {
			type: "string",
			description:
				'A user-defined organizing label (e.g. "Drone shot", "Person A cam").',
		},
		folderId: {
			type: "string",
			description:
				'Which Assets-panel folder this asset sits in. Omitted/absent means the folder root — not a kernel-addressable kind, so this is a plain string id, not type "id".',
		},
		type: {
			type: "enum",
			values: ["image", "video", "audio"],
			description: "The media type.",
			readOnly: true,
			readOnlyReason: "determined by the file at ingest.",
		},
		size: {
			type: "number",
			unit: "bytes",
			description: "File size on disk.",
			readOnly: true,
			readOnlyReason: "a property of the file, not editable.",
		},
		width: {
			type: "number",
			unit: "px",
			description:
				"Native pixel width, when known. Typically populated for video/image assets; not a hard type gate — see this file's header.",
			readOnly: true,
			readOnlyReason: "probed from the file at ingest.",
		},
		height: {
			type: "number",
			unit: "px",
			description:
				"Native pixel height, when known. Typically populated for video/image assets; not a hard type gate — see this file's header.",
			readOnly: true,
			readOnlyReason: "probed from the file at ingest.",
		},
		duration: {
			type: "number",
			unit: "seconds",
			description:
				"The full source length, when known. Typically populated for video/audio assets; not a hard type gate — see this file's header.",
			readOnly: true,
			readOnlyReason: "probed from the file at ingest.",
			aliases: ["durationSec"],
		},
		fps: {
			type: "number",
			unit: "fps",
			description:
				"Source frame rate, when known. Typically populated for video assets; not a hard type gate — see this file's header.",
			readOnly: true,
			readOnlyReason: "probed from the file at ingest.",
		},
		thumbnailUrl: {
			type: "string",
			description: "Preview thumbnail for the Assets panel.",
			readOnly: true,
			readOnlyReason: "generated at ingest.",
		},
		source: {
			type: "enum",
			values: ["ai"],
			description:
				"Present when this asset was generated (Studio/Director), absent for uploads.",
			readOnly: true,
			readOnlyReason: "set at creation based on provenance.",
		},
		ephemeral: {
			type: "boolean",
			description:
				"True for a transient asset not meant to persist in the library long-term.",
			readOnly: true,
			readOnlyReason: "set at creation.",
		},
		needsProxy: {
			type: "boolean",
			description:
				"Whether this asset still needs a lower-resolution editing proxy generated.",
			readOnly: true,
			readOnlyReason:
				"computed from resolution/codec, and cleared automatically once a proxy lands.",
		},
		proxy: {
			type: "object",
			description: "The generated editing proxy's info, once one exists.",
			readOnly: true,
			readOnlyReason: "written by the background proxy-generation pipeline.",
		},
		decodeUnsupported: {
			type: "boolean",
			description:
				"True when this browser's WebCodecs cannot decode this asset's codec (re-probed fresh on every project load — codec support is browser- and build-specific).",
			readOnly: true,
			readOnlyReason: "a live capability check, not stored state.",
		},
	},
};
