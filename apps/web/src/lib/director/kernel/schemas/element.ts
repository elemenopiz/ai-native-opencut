/**
 * `element` — anything living on a track: a video/image/audio clip, a text
 * overlay, a sticker, a parametric shape, or a track-level effect layer.
 * Source of truth: `types/timeline.ts`'s `TimelineElement` union
 * (`BaseTimelineElement` + `VideoElement` | `ImageElement` | `TextElement` |
 * `StickerElement` | `ShapeElement` | `AudioElement` | `EffectElement`).
 *
 * TIME VOCABULARY IS DELIBERATELY RENAMED. The raw fields are `startTime` and
 * `duration` (see `BaseTimelineElement`) — but `lib/director/program/
 * derived-data.ts`'s `toClipValue` has ALREADY renamed them to `startSec`/
 * `durationSec`/`endSec` for every program that reads a clip today. This is
 * the one place in the registry where the canonical name is NOT the raw
 * struct field: staying consistent with `derived-data.ts` matters more than
 * staying consistent with `types/timeline.ts`, because programs and the
 * kernel must agree on one vocabulary or we reintroduce the exact split this
 * kernel exists to close. The raw names survive only as aliases.
 *
 * ALIASES ARE GROUNDED, NOT INVENTED. Three sources, all cited inline:
 *  1. The 2026-09-20 prod session itself (`start`/`end`/`duration` were the
 *     model's own guesses for `startSec`/`endSec`/`durationSec`).
 *  2. `tool-catalog.ts`, where `trim`/`addClip`/`addText`/`updateText` all
 *     spell the timeline position `startTime` and only `move` breaks the
 *     pattern with `newStartTime` — the exact inconsistency the design doc
 *     names in §5. Both survive as aliases so the model can't lose either way.
 *  3. The design doc's own prose (§3, "Mutation"): `update({ at: element,
 *     patch: { activeTake } })` — the doc spells the take-selection field
 *     `activeTake`, not the real `activeTakeId`. Rather than treat the doc as
 *     wrong, treat it as one more data point on what a model reaches for.
 *
 * "X ELEMENTS ONLY" NOTES ARE CHECKED AGAINST THE PER-VARIANT TYPES, NOT
 * ASSUMED. `kernel/read.ts` independently derived its own
 * `ELEMENT_FIELD_APPLICABILITY` table straight from `types/timeline.ts`'s
 * concrete element interfaces (it has to — that is what lets `_unavailable`
 * tell a caller a field genuinely does not apply to THIS instance). Where
 * that table and this file's prose disagreed, the type won: `hidden` does
 * NOT apply to `EffectElement` (it carries no such field at all) even though
 * an earlier draft of this comment claimed it did, and `mediaId` is
 * unconditional on video/image but conditional on `AudioElement.sourceType`
 * (`"upload"` has it, `"library"` uses `sourceUrl` instead). Every other
 * "only" note in this file was re-verified against the same table.
 */

import type { KindSchema } from "../schema";

export const elementSchema: KindSchema = {
	kind: "element",
	summary:
		"One item on a track — a clip, overlay, shape, or effect layer — addressed by its own kernel id.",
	fields: {
		id: {
			type: "id",
			of: "element",
			description: "This element's own kernel id, echoed back for reference.",
			readOnly: true,
			readOnlyReason: "identity, not a field — create/duplicate mint new ids.",
			aliases: ["elementId", "slotId", "clipId"],
		},
		trackId: {
			type: "id",
			of: "track",
			description:
				"Which track this element lives on. Writing a different track id re-parents the clip — the same move a cross-track drag performs — as long as the target track's type accepts this element's kind.",
			aliases: ["track"],
		},
		trackKind: {
			type: "enum",
			values: ["video", "text", "audio", "sticker", "shape", "effect"],
			description: "The type of the track this element currently sits on.",
			readOnly: true,
			readOnlyReason: "derived from trackId — move the element to change it.",
		},
		kind: {
			type: "enum",
			values: ["video", "image", "text", "audio", "sticker", "shape", "effect"],
			description:
				"What this element actually is — determines which of the type-specific fields below apply.",
			readOnly: true,
			readOnlyReason:
				"fixed at creation; there is no in-place retype, only delete + create.",
		},
		name: {
			type: "string",
			description: "The label shown for this element in the timeline UI.",
		},
		startSec: {
			type: "number",
			unit: "seconds",
			description:
				"Where this element begins, in PROJECT-ABSOLUTE seconds (from the start of the timeline, not the source media).",
			aliases: ["startTime", "start"],
		},
		durationSec: {
			type: "number",
			unit: "seconds",
			description:
				"How long this element's visible span lasts on the timeline. A LENGTH, not a position — do not add it to nothing and call the result a time.",
			aliases: ["duration"],
		},
		endSec: {
			type: "number",
			unit: "seconds",
			description: "Where this element ends on the timeline.",
			readOnly: true,
			readOnlyReason:
				"derived: startSec + durationSec. Write one of those instead.",
			aliases: ["end"],
		},
		trimStart: {
			type: "number",
			unit: "seconds",
			description:
				"How far into the SOURCE media this element's visible span begins — ASSET-RELATIVE, the same timebase as a transcript segment or `measure` beat/silence output. Not a timeline position.",
		},
		trimEnd: {
			type: "number",
			unit: "seconds",
			description:
				"Where the visible span stops within the SOURCE media — ASSET-RELATIVE, same timebase as trimStart. Increasing it trims MORE off the tail, it does not extend the clip.",
		},
		sourceDuration: {
			type: "number",
			unit: "seconds",
			description: "The untrimmed source media's full length.",
			readOnly: true,
			readOnlyReason: "a property of the ingested asset, not this placement.",
		},
		mediaId: {
			type: "id",
			of: "asset",
			description:
				'The source media asset this clip plays. Always present on video/image elements; on audio elements only when sourceType is "upload" — a library-sourced audio clip (sourceType "library") has no mediaId, it plays from sourceUrl instead. Writing a different asset id swaps the footage entirely — this is a source replacement, not a trim.',
			aliases: ["assetId"],
		},
		isSlot: {
			type: "boolean",
			description:
				"True when this element carries a `generation` recipe — i.e. it is an AI-native generative slot, not a plain uploaded clip.",
			readOnly: true,
			readOnlyReason: "derived: Boolean(generation).",
		},
		generation: {
			type: "object",
			description:
				"The generation recipe (prompt, model, mode, resolution, orientation, reference media, seed…) that produced this slot's takes — `types/timeline.ts`'s `GenerationSpec`. Editing it changes what the NEXT `generate` call produces; it does not regenerate existing takes.",
		},
		takes: {
			type: "array",
			description:
				"This slot's generated alternates (see kind `take`). The active one's media is mirrored onto `mediaId`.",
			readOnly: true,
			readOnlyReason:
				"append/remove through generate() and the take lifecycle, not a direct list write.",
		},
		activeTakeId: {
			type: "id",
			of: "take",
			description:
				"Which take's media is currently mirrored onto this clip. Switching is non-destructive — every other take stays in `takes`, ready to switch back to.",
			aliases: ["activeTake", "takeId"],
		},
		isVoiceover: {
			type: "boolean",
			description:
				"Audio elements only — true when this clip reads as spoken dialogue/narration rather than a music bed (the same classification `duckMusicUnderSpeech` and `gatherSpeechIntervals` use).",
			readOnly: true,
			readOnlyReason:
				"a classification of the audio content, not an authored flag.",
		},
		isMusic: {
			type: "boolean",
			description: "Audio elements only — the complement of isVoiceover.",
			readOnly: true,
			readOnlyReason:
				"a classification of the audio content, not an authored flag.",
		},
		transform: {
			type: "object",
			description:
				"Position/scale/rotation on canvas — { position: { x, y }, scale, rotate } where rotate is degrees. Visual elements only (video/image/text/sticker/shape).",
		},
		opacity: {
			type: "number",
			unit: "0-1",
			description: "Visual elements only. 0 = invisible, 1 = fully opaque.",
		},
		blendMode: {
			type: "enum",
			values: [
				"normal",
				"darken",
				"multiply",
				"color-burn",
				"lighten",
				"screen",
				"plus-lighter",
				"color-dodge",
				"overlay",
				"soft-light",
				"hard-light",
				"difference",
				"exclusion",
				"hue",
				"saturation",
				"color",
				"luminosity",
			],
			description:
				"Visual elements only — how this layer composites onto what's beneath it.",
		},
		crop: {
			type: "object",
			description:
				"Pixels cropped from each edge before scaling — { top, right, bottom, left }. Visual elements only; shape elements accept it but the renderer does not yet consume it there.",
		},
		mask: {
			type: "object",
			description:
				"An alpha mask applied to this element — { type, feather (0-1 of the short side), inverted, centerX/centerY (0-1 offset from center), width/height (0-1 of element size), rotation (degrees) }. Visual elements only.",
		},
		transitionOut: {
			type: "object",
			description:
				"The transition playing as this element hands off to the next — { type, duration (seconds) }.",
		},
		volume: {
			type: "number",
			unit: "0-1",
			description:
				"Audio elements only (music/voiceover clips). Video/image clips have no independent volume field — mute the clip or the track instead.",
		},
		muted: {
			type: "boolean",
			description: "Video and audio elements only.",
		},
		hidden: {
			type: "boolean",
			description:
				'Visual elements only (video/image/text/sticker/shape) — NOT effect elements: EffectElement carries no "hidden" field at all (checked against types/timeline.ts, not assumed).',
		},
		playbackRate: {
			type: "number",
			unit: "×",
			description:
				"Speed multiplier. 1 = normal, 0.5 = half speed, 2 = double speed. Video and audio elements only.",
		},
		reversed: {
			type: "boolean",
			description:
				"Video elements only — plays the trimmed source span backwards.",
		},
		isSourceAudioEnabled: {
			type: "boolean",
			description:
				"Video elements only. False means this clip's embedded audio has been detached onto its own standalone audio element (see toggleSourceAudioSeparation) and should stay silent here.",
		},
		content: {
			type: "string",
			description: "Text elements only — the caption/title copy itself.",
		},
		fontSize: {
			type: "number",
			unit: "px",
			description: "Text elements only.",
		},
		fontFamily: { type: "string", description: "Text elements only." },
		color: { type: "string", description: "Text elements only — a CSS color." },
		highlightColor: {
			type: "string",
			description:
				"Text elements only — color applied to words once spoken (karaoke progressive fill).",
		},
		wordActiveColor: {
			type: "string",
			description:
				"Text elements only — color of the word currently being spoken; falls back to highlightColor when unset.",
		},
		wordActiveBackground: {
			type: "string",
			description:
				"Text elements only — rounded background box drawn behind the currently-spoken word.",
		},
		wordTimings: {
			type: "array",
			description:
				"Text elements only — per-word start/end times LOCAL to this element's own start, used for karaoke highlighting.",
			readOnly: true,
			readOnlyReason:
				"produced by transcription/auto-caption alignment, not hand-authored.",
		},
		wordPopScale: {
			type: "number",
			unit: "×",
			description:
				"Text elements only — scale applied to the currently-spoken word. 1 = no pop, 1.3 = 30% larger.",
		},
		strokeColor: {
			type: "string",
			description:
				"Text elements only — outline color drawn around the glyphs.",
		},
		strokeWidth: {
			type: "number",
			unit: "ratio of fontSize",
			description:
				"Text elements only. 0 = no outline, ~0.08 = a bold outline.",
		},
		background: {
			type: "object",
			description:
				"Text elements only — the caption's background box: { enabled, color, cornerRadius, paddingX, paddingY, offsetX, offsetY }.",
		},
		textAlign: {
			type: "enum",
			values: ["left", "center", "right"],
			description: "Text elements only.",
		},
		fontWeight: {
			type: "enum",
			values: ["normal", "bold"],
			description: "Text elements only.",
		},
		fontStyle: {
			type: "enum",
			values: ["normal", "italic"],
			description: "Text elements only.",
		},
		textDecoration: {
			type: "enum",
			values: ["none", "underline", "line-through"],
			description: "Text elements only.",
		},
		letterSpacing: {
			type: "number",
			unit: "px",
			description: "Text elements only.",
		},
		lineHeight: {
			type: "number",
			unit: "×",
			description: "Text elements only.",
		},
		stickerId: {
			type: "string",
			description:
				"Sticker elements only — the sticker catalog reference this element renders. Not a kernel id (the sticker library isn't an addressable kind).",
		},
		shapeKind: {
			type: "enum",
			values: ["rect", "ellipse", "line"],
			description: "Shape elements only.",
		},
		width: {
			type: "number",
			unit: "px",
			description:
				'Shape elements only — base bounding-box width at transform.scale === 1. For "line", the box diagonal is the drawn segment.',
		},
		height: {
			type: "number",
			unit: "px",
			description: "Shape elements only — base bounding-box height. See width.",
		},
		fill: {
			type: "object",
			description:
				'Shape elements only — a solid color ({ type: "solid", color }) or a linear gradient ({ type: "linear-gradient", angle (degrees), stops }).',
		},
		stroke: {
			type: "object",
			description:
				"Shape elements only — { color, width (px) }. Omitted = no outline.",
		},
		cornerRadius: {
			type: "number",
			unit: "px",
			description:
				"Shape elements only, rect shapeKind only. Clamped to half the shorter side.",
		},
		effectType: {
			type: "string",
			description:
				"Effect (track-level) elements only — which effect this adjustment layer applies. Note this is the ONE place `type` is spelled `effectType`: the object's real field is `type` (see kind `effect`'s AddClipEffectCommand-style entries), but the element wrapper around it uses `effectType`.",
			readOnly: true,
			readOnlyReason: "fixed at creation; delete and recreate to change it.",
		},
		params: {
			type: "object",
			description:
				"Effect (track-level) elements only — this effect's parameter values.",
		},
		effects: {
			type: "array",
			description:
				"Per-clip effects attached to a video/image element (see kind `effect`) — distinct from an effect TRACK element above.",
			readOnly: true,
			readOnlyReason:
				"manage via create/delete on kind 'effect', not a direct list write.",
		},
		keyframes: {
			type: "array",
			description:
				"This element's animation keyframes across every channel (see kind `keyframe`) — an array of keyframe ids by default, or full keyframe objects ({ id, propertyPath, time, value, interpolation, easing }) at depth: 'expanded'. Same ids-or-expanded convention as `effects`/`takes` — not the { propertyPath, keyframeId } ref shape SelectedKeyframeRef uses elsewhere, which is a selection reference, not a read projection.",
			readOnly: true,
			readOnlyReason:
				"add/remove/retime through create/update/delete on kind 'keyframe', not a direct list write.",
		},
	},
};
