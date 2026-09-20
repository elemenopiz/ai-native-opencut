/**
 * CapCut / JianYing (剪映) draft serializer.
 *
 * Maps a Byorn timeline (tracks -> elements) onto the reverse-engineered
 * CapCut draft format: a draft folder containing `draft_content.json`
 * (materials + tracks of segments) and `draft_meta_info.json`.
 *
 * Schema target: the plain-JSON draft format written by JianYing desktop 5.9
 * and read by CapCut desktop (international) builds that still use
 * unencrypted drafts (draft `version` 360000, `new_version` "110.0.0").
 * JianYing 6.0+ encrypts `draft_content.json`; those versions can usually
 * still import older plain drafts. Field reference: the openly documented
 * format used by pyJianYingDraft (Apache-2.0) and other OSS draft tools.
 * No AGPL code was referenced or copied.
 *
 * Mapping summary (see apps/web/docs/capcut-export.md for the full table):
 * - Time: seconds -> integer microseconds (`target_timerange` on the track,
 *   `source_timerange` into the source media; source duration is scaled by
 *   playbackRate, which becomes segment `speed`).
 * - video/image elements -> `materials.videos` (type "video"/"photo") +
 *   segments on "video" tracks. Track order is bottom-to-top (main track
 *   first) so z-order matches our compositor.
 * - audio elements -> `materials.audios` (type "extract_music") + "audio"
 *   track segments.
 * - text elements -> `materials.texts` with the JSON-in-JSON `content`
 *   payload + "text" track segments. Font family is not mapped (CapCut
 *   fonts are library resources); size/alignment/color/bold/italic are.
 * - Transform: position px (y-down, canvas-centered) -> `clip.transform`
 *   in half-canvas units (y-up); scale -> `clip.scale`; rotate (deg, CW)
 *   -> `clip.rotation`; opacity -> `clip.alpha`.
 * - Keyframes: linear number keyframes on position/scale/rotate/opacity/
 *   volume -> `common_keyframes` (KFType*). "hold" interpolation degrades
 *   to linear with a warning.
 * - Degraded/skipped with warnings (never a crash): stickers, effect
 *   elements/tracks, transitions, masks, crops, blend modes, karaoke word
 *   timings, color/background/playbackRate animation channels.
 *
 * Media files are referenced by draft-relative paths ("Resources/<file>").
 * If a CapCut build does not resolve relative paths it will prompt to
 * relink; the files sit next to the draft so relinking is trivial.
 */

import type { ElementAnimations, NumberKeyframe } from "@/types/animation";
import type { MediaType } from "@/types/assets";
import type { TCanvasSize } from "@/types/project";
import type {
	AudioElement,
	ImageElement,
	TextElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";
import { isMainTrack } from "@/lib/timeline";

const MICROSECONDS_PER_SECOND = 1_000_000;
const DRAFT_VERSION = 360000;
const DRAFT_NEW_VERSION = "110.0.0";
const DRAFT_PLATFORM = {
	app_id: 3704,
	app_source: "lv",
	app_version: "5.9.0",
	os: "windows",
};
const RESOURCES_DIR = "Resources";
/** CapCut represents still images as very long "photo" materials. */
const PHOTO_MATERIAL_DURATION_SECONDS = 10800;

export interface CapcutMediaAssetInfo {
	id: string;
	name: string;
	type: MediaType;
	width?: number;
	height?: number;
	/** Source duration in seconds. */
	duration?: number;
}

export type CapcutMediaFileRef =
	| {
			kind: "asset";
			assetId: string;
			fileName: string;
			/** Path inside the draft folder, e.g. "Resources/clip.mp4". */
			zipPath: string;
	  }
	| {
			kind: "url";
			url: string;
			fileName: string;
			zipPath: string;
	  };

export interface CapcutDraftResult {
	/** The draft_content.json payload. */
	draftContent: Record<string, unknown>;
	/** The draft_meta_info.json payload. */
	draftMetaInfo: Record<string, unknown>;
	/** Media files that must be placed in the draft folder for paths to resolve. */
	mediaFiles: CapcutMediaFileRef[];
	/** Human-readable notes about anything that was degraded or skipped. */
	warnings: string[];
}

export interface SerializeCapcutDraftParams {
	projectName: string;
	fps: number;
	canvasSize: TCanvasSize;
	tracks: TimelineTrack[];
	mediaAssets: CapcutMediaAssetInfo[];
	/** Injectable for deterministic tests. Defaults to crypto.randomUUID. */
	createId?: () => string;
	/** Injectable clock for deterministic tests. Defaults to Date.now. */
	now?: () => number;
}

interface Timerange {
	duration: number;
	start: number;
}

interface SerializerContext {
	createId: () => string;
	canvasSize: TCanvasSize;
	warnings: string[];
	mediaFiles: CapcutMediaFileRef[];
	usedFileNames: Set<string>;
	materials: {
		videos: Record<string, unknown>[];
		audios: Record<string, unknown>[];
		texts: Record<string, unknown>[];
		speeds: Record<string, unknown>[];
	};
	/** Our mediaId/sourceUrl -> CapCut material id, to reuse materials. */
	materialIdByMediaKey: Map<string, string>;
}

function toMicroseconds(seconds: number): number {
	return Math.round(seconds * MICROSECONDS_PER_SECOND);
}

function timerange({
	start,
	duration,
}: {
	start: number;
	duration: number;
}): Timerange {
	return { duration: toMicroseconds(duration), start: toMicroseconds(start) };
}

function sanitizeFileName({ name }: { name: string }): string {
	const sanitized = name
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/\s+/g, " ")
		.trim();
	return sanitized.length > 0 ? sanitized : "media";
}

function reserveFileName({
	context,
	name,
}: {
	context: SerializerContext;
	name: string;
}): string {
	const base = sanitizeFileName({ name });
	if (!context.usedFileNames.has(base)) {
		context.usedFileNames.add(base);
		return base;
	}
	const dotIndex = base.lastIndexOf(".");
	const stem = dotIndex > 0 ? base.slice(0, dotIndex) : base;
	const ext = dotIndex > 0 ? base.slice(dotIndex) : "";
	let counter = 2;
	let candidate = `${stem}-${counter}${ext}`;
	while (context.usedFileNames.has(candidate)) {
		counter += 1;
		candidate = `${stem}-${counter}${ext}`;
	}
	context.usedFileNames.add(candidate);
	return candidate;
}

function hexToRgbFloats({
	color,
}: {
	color: string;
}): [number, number, number] {
	const match = /^#?([0-9a-f]{6})/i.exec(color.trim());
	if (!match) {
		return [1, 1, 1];
	}
	const value = Number.parseInt(match[1], 16);
	return [
		((value >> 16) & 0xff) / 255,
		((value >> 8) & 0xff) / 255,
		(value & 0xff) / 255,
	];
}

/** px (y-down, canvas-centered) -> CapCut half-canvas units (y-up). */
function toClipTransform({
	position,
	canvasSize,
}: {
	position: { x: number; y: number };
	canvasSize: TCanvasSize;
}): { x: number; y: number } {
	return {
		x: canvasSize.width > 0 ? position.x / (canvasSize.width / 2) : 0,
		y: canvasSize.height > 0 ? -position.y / (canvasSize.height / 2) : 0,
	};
}

function buildClip({
	element,
	context,
}: {
	element: VideoElement | ImageElement | TextElement;
	context: SerializerContext;
}): Record<string, unknown> {
	return {
		alpha: element.opacity,
		flip: { horizontal: false, vertical: false },
		rotation: element.transform.rotate,
		scale: { x: element.transform.scale, y: element.transform.scale },
		transform: toClipTransform({
			position: element.transform.position,
			canvasSize: context.canvasSize,
		}),
	};
}

function createSpeedMaterial({
	context,
	speed,
}: {
	context: SerializerContext;
	speed: number;
}): string {
	const id = context.createId();
	context.materials.speeds.push({
		curve_speed: null,
		id,
		mode: 0,
		speed,
		type: "speed",
	});
	return id;
}

const KEYFRAME_PROPERTY_BY_CHANNEL: Record<
	string,
	{ propertyType: string; kind: "positionX" | "positionY" | "scalar" }
> = {
	"transform.position.x": {
		propertyType: "KFTypePositionX",
		kind: "positionX",
	},
	"transform.position.y": {
		propertyType: "KFTypePositionY",
		kind: "positionY",
	},
	"transform.scale": { propertyType: "KFTypeScaleX", kind: "scalar" },
	"transform.rotate": { propertyType: "KFTypeRotation", kind: "scalar" },
	opacity: { propertyType: "KFTypeAlpha", kind: "scalar" },
	volume: { propertyType: "KFTypeVolume", kind: "scalar" },
};

function buildCommonKeyframes({
	element,
	context,
	elementLabel,
}: {
	element: { animations?: ElementAnimations };
	context: SerializerContext;
	elementLabel: string;
}): Record<string, unknown>[] {
	const channels = element.animations?.channels;
	if (!channels) {
		return [];
	}

	const keyframeLists: Record<string, unknown>[] = [];

	for (const [channelPath, channel] of Object.entries(channels)) {
		if (!channel || channel.keyframes.length === 0) {
			continue;
		}

		const mapping = KEYFRAME_PROPERTY_BY_CHANNEL[channelPath];
		if (!mapping) {
			context.warnings.push(
				`${elementLabel}: "${channelPath}" keyframes are not supported by CapCut drafts and were dropped.`,
			);
			continue;
		}
		if (channel.valueKind !== "number") {
			context.warnings.push(
				`${elementLabel}: non-numeric keyframes on "${channelPath}" were dropped.`,
			);
			continue;
		}

		const numberKeyframes = channel.keyframes as NumberKeyframe[];
		if (numberKeyframes.some((kf) => kf.interpolation === "hold")) {
			context.warnings.push(
				`${elementLabel}: "hold" keyframes on "${channelPath}" were exported as linear.`,
			);
		}

		const halfWidth = context.canvasSize.width / 2 || 1;
		const halfHeight = context.canvasSize.height / 2 || 1;

		keyframeLists.push({
			id: context.createId(),
			keyframe_list: numberKeyframes.map((keyframe) => {
				let value = keyframe.value;
				if (mapping.kind === "positionX") {
					value = keyframe.value / halfWidth;
				} else if (mapping.kind === "positionY") {
					value = -keyframe.value / halfHeight;
				}
				return {
					curveType: "Line",
					graphID: "",
					left_control: { x: 0, y: 0 },
					right_control: { x: 0, y: 0 },
					id: context.createId(),
					time_offset: toMicroseconds(keyframe.time),
					values: [value],
				};
			}),
			material_id: "",
			property_type: mapping.propertyType,
		});
	}

	return keyframeLists;
}

function baseSegment({
	context,
	materialId,
	target,
	commonKeyframes,
}: {
	context: SerializerContext;
	materialId: string;
	target: Timerange;
	commonKeyframes: Record<string, unknown>[];
}): Record<string, unknown> {
	return {
		enable_adjust: true,
		enable_color_correct_adjust: false,
		enable_color_curves: true,
		enable_color_match_adjust: false,
		enable_color_wheels: true,
		enable_lut: true,
		enable_smart_color_adjust: false,
		last_nonzero_volume: 1.0,
		reverse: false,
		track_attribute: 0,
		track_render_index: 0,
		visible: true,
		id: context.createId(),
		material_id: materialId,
		target_timerange: target,
		common_keyframes: commonKeyframes,
		keyframe_refs: [],
	};
}

function getOrCreateVisualMaterial({
	context,
	element,
	asset,
}: {
	context: SerializerContext;
	element: VideoElement | ImageElement;
	asset: CapcutMediaAssetInfo;
}): string {
	const existing = context.materialIdByMediaKey.get(asset.id);
	if (existing) {
		return existing;
	}

	const fileName = reserveFileName({ context, name: asset.name });
	const zipPath = `${RESOURCES_DIR}/${fileName}`;
	const materialId = context.createId();
	const isPhoto = asset.type === "image";
	const sourceDuration = isPhoto
		? PHOTO_MATERIAL_DURATION_SECONDS * MICROSECONDS_PER_SECOND
		: toMicroseconds(
				asset.duration ??
					element.sourceDuration ??
					element.trimStart + element.duration,
			);

	context.materials.videos.push({
		audio_fade: null,
		category_id: "",
		category_name: "local",
		check_flag: 63487,
		crop: {
			lower_left_x: 0,
			lower_left_y: 1,
			lower_right_x: 1,
			lower_right_y: 1,
			upper_left_x: 0,
			upper_left_y: 0,
			upper_right_x: 1,
			upper_right_y: 0,
		},
		crop_ratio: "free",
		crop_scale: 1.0,
		duration: sourceDuration,
		height: asset.height ?? 0,
		id: materialId,
		local_material_id: "",
		material_id: materialId,
		material_name: fileName,
		media_path: "",
		path: zipPath,
		type: isPhoto ? "photo" : "video",
		width: asset.width ?? 0,
	});
	context.mediaFiles.push({
		kind: "asset",
		assetId: asset.id,
		fileName,
		zipPath,
	});
	context.materialIdByMediaKey.set(asset.id, materialId);
	return materialId;
}

function serializeVisualElement({
	context,
	element,
	mediaById,
	segments,
}: {
	context: SerializerContext;
	element: VideoElement | ImageElement;
	mediaById: Map<string, CapcutMediaAssetInfo>;
	segments: Record<string, unknown>[];
}): void {
	const asset = mediaById.get(element.mediaId);
	if (!asset) {
		context.warnings.push(
			`"${element.name}": media asset not found; clip skipped.`,
		);
		return;
	}

	const speed = element.type === "video" ? (element.playbackRate ?? 1) : 1;
	const materialId = getOrCreateVisualMaterial({ context, element, asset });
	const speedId = createSpeedMaterial({ context, speed });

	const segment = baseSegment({
		context,
		materialId,
		target: timerange({
			start: element.startTime,
			duration: element.duration,
		}),
		commonKeyframes: buildCommonKeyframes({
			element,
			context,
			elementLabel: `"${element.name}"`,
		}),
	});
	segment.source_timerange = timerange({
		start: element.trimStart,
		duration: element.duration * speed,
	});
	segment.speed = speed;
	segment.volume = element.type === "video" && element.muted ? 0.0 : 1.0;
	segment.extra_material_refs = [speedId];
	segment.is_tone_modify = false;
	segment.clip = buildClip({ element, context });
	segment.uniform_scale = { on: true, value: 1.0 };
	segments.push(segment);

	warnUnsupportedVisualFeatures({ context, element });
}

function warnUnsupportedVisualFeatures({
	context,
	element,
}: {
	context: SerializerContext;
	element: VideoElement | ImageElement | TextElement;
}): void {
	const label = `"${element.name}"`;
	if (element.transitionOut) {
		context.warnings.push(
			`${label}: transition "${element.transitionOut.type}" has no CapCut equivalent and was dropped.`,
		);
	}
	if (element.effects && element.effects.length > 0) {
		context.warnings.push(
			`${label}: ${element.effects.length} effect(s) were dropped (CapCut effects are library resources).`,
		);
	}
	if (element.mask) {
		context.warnings.push(`${label}: mask was dropped.`);
	}
	if (
		element.crop &&
		(element.crop.top !== 0 ||
			element.crop.right !== 0 ||
			element.crop.bottom !== 0 ||
			element.crop.left !== 0)
	) {
		context.warnings.push(`${label}: crop was dropped.`);
	}
	if (element.blendMode && element.blendMode !== "normal") {
		context.warnings.push(
			`${label}: blend mode "${element.blendMode}" was dropped.`,
		);
	}
}

function serializeAudioElement({
	context,
	element,
	mediaById,
	segments,
}: {
	context: SerializerContext;
	element: AudioElement;
	mediaById: Map<string, CapcutMediaAssetInfo>;
	segments: Record<string, unknown>[];
}): void {
	let mediaKey: string;
	let name: string;
	let sourceDuration: number | undefined;

	if (element.sourceType === "upload") {
		const asset = mediaById.get(element.mediaId);
		if (!asset) {
			context.warnings.push(
				`"${element.name}": media asset not found; clip skipped.`,
			);
			return;
		}
		mediaKey = asset.id;
		name = asset.name;
		sourceDuration = asset.duration;
	} else {
		mediaKey = element.sourceUrl;
		const urlName = element.sourceUrl.split("/").pop() ?? "";
		name = urlName.length > 0 ? urlName : `${element.name}.mp3`;
		sourceDuration = element.sourceDuration;
	}

	let materialId = context.materialIdByMediaKey.get(mediaKey);
	if (!materialId) {
		const fileName = reserveFileName({ context, name });
		const zipPath = `${RESOURCES_DIR}/${fileName}`;
		materialId = context.createId();
		context.materials.audios.push({
			app_id: 0,
			category_id: "",
			category_name: "local",
			check_flag: 3,
			copyright_limit_type: "none",
			duration: toMicroseconds(
				sourceDuration ?? element.trimStart + element.duration,
			),
			effect_id: "",
			formula_id: "",
			id: materialId,
			local_material_id: materialId,
			music_id: materialId,
			name: fileName,
			path: zipPath,
			source_platform: 0,
			type: "extract_music",
			wave_points: [],
		});
		context.mediaFiles.push(
			element.sourceType === "upload"
				? { kind: "asset", assetId: element.mediaId, fileName, zipPath }
				: { kind: "url", url: element.sourceUrl, fileName, zipPath },
		);
		context.materialIdByMediaKey.set(mediaKey, materialId);
	}

	const speed = element.playbackRate ?? 1;
	const speedId = createSpeedMaterial({ context, speed });

	const segment = baseSegment({
		context,
		materialId,
		target: timerange({
			start: element.startTime,
			duration: element.duration,
		}),
		commonKeyframes: buildCommonKeyframes({
			element,
			context,
			elementLabel: `"${element.name}"`,
		}),
	});
	segment.source_timerange = timerange({
		start: element.trimStart,
		duration: element.duration * speed,
	});
	segment.speed = speed;
	segment.volume = element.muted ? 0.0 : element.volume;
	segment.extra_material_refs = [speedId];
	segment.is_tone_modify = false;
	segments.push(segment);
}

const TEXT_ALIGNMENT: Record<TextElement["textAlign"], number> = {
	left: 0,
	center: 1,
	right: 2,
};

function serializeTextElement({
	context,
	element,
	segments,
}: {
	context: SerializerContext;
	element: TextElement;
	segments: Record<string, unknown>[];
}): void {
	const materialId = context.createId();
	const [r, g, b] = hexToRgbFloats({ color: element.color });

	const contentJson = {
		styles: [
			{
				fill: {
					alpha: 1.0,
					content: {
						render_type: "solid",
						solid: { alpha: 1.0, color: [r, g, b] },
					},
				},
				range: [0, element.content.length],
				// Both Byorn and CapCut use canvas-relative font sizes with a
				// default of 15; mapped 1:1 (approximate, not pixel-exact).
				size: element.fontSize,
				bold: element.fontWeight === "bold",
				italic: element.fontStyle === "italic",
				underline: element.textDecoration === "underline",
				strokes: [],
			},
		],
		text: element.content,
	};

	let checkFlag = 7;
	const material: Record<string, unknown> = {
		id: materialId,
		content: JSON.stringify(contentJson),
		typesetting: 0,
		alignment: TEXT_ALIGNMENT[element.textAlign],
		letter_spacing: 0,
		line_spacing: 0.02,
		line_feed: 1,
		line_max_width: 0.82,
		force_apply_line_max_width: false,
		type: "text",
		global_alpha: 1.0,
	};

	if (element.background.enabled) {
		checkFlag |= 16;
		material.background_style = 1;
		material.background_color = element.background.color;
		material.background_alpha = 1.0;
		material.background_round_radius = 0.0;
		material.background_height = 0.14;
		material.background_width = 0.14;
		material.background_horizontal_offset = 0.0;
		material.background_vertical_offset = 0.0;
	}
	material.check_flag = checkFlag;
	context.materials.texts.push(material);

	const speedId = createSpeedMaterial({ context, speed: 1.0 });
	const segment = baseSegment({
		context,
		materialId,
		target: timerange({
			start: element.startTime,
			duration: element.duration,
		}),
		commonKeyframes: buildCommonKeyframes({
			element,
			context,
			elementLabel: `"${element.name}"`,
		}),
	});
	segment.source_timerange = null;
	segment.speed = 1.0;
	segment.volume = 1.0;
	segment.extra_material_refs = [speedId];
	segment.is_tone_modify = false;
	segment.clip = buildClip({ element, context });
	segment.uniform_scale = { on: true, value: 1.0 };
	segments.push(segment);

	if (element.wordTimings && element.wordTimings.length > 0) {
		context.warnings.push(
			`"${element.name}": karaoke word timings were dropped.`,
		);
	}
	warnUnsupportedVisualFeatures({ context, element });
}

function sortedVisibleElements<T extends { startTime: number; id: string }>({
	elements,
}: {
	elements: T[];
}): T[] {
	return elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

function serializeTrack({
	context,
	track,
	mediaById,
}: {
	context: SerializerContext;
	track: TimelineTrack;
	mediaById: Map<string, CapcutMediaAssetInfo>;
}): Record<string, unknown> | null {
	if (track.type === "effect") {
		if (track.elements.length > 0) {
			context.warnings.push(
				`Effect track "${track.name}" was skipped (CapCut effects are library resources).`,
			);
		}
		return null;
	}
	if (track.type === "sticker") {
		if (track.elements.length > 0) {
			context.warnings.push(
				`Sticker track "${track.name}" was skipped (stickers have no local media files).`,
			);
		}
		return null;
	}
	if (track.type === "shape") {
		if (track.elements.length > 0) {
			context.warnings.push(
				`Shape track "${track.name}" was skipped (CapCut has no parametric shape equivalent).`,
			);
		}
		return null;
	}

	const segments: Record<string, unknown>[] = [];
	let previousEnd = Number.NEGATIVE_INFINITY;
	const elements: (VideoElement | ImageElement | AudioElement | TextElement)[] =
		track.elements;

	for (const element of sortedVisibleElements({ elements })) {
		if (element.startTime < previousEnd - 1e-6) {
			context.warnings.push(
				`"${element.name}": overlaps the previous clip on track "${track.name}"; clip skipped.`,
			);
			continue;
		}

		const segmentCountBefore = segments.length;
		if (element.type === "video" || element.type === "image") {
			serializeVisualElement({ context, element, mediaById, segments });
		} else if (element.type === "audio") {
			serializeAudioElement({ context, element, mediaById, segments });
		} else if (element.type === "text") {
			serializeTextElement({ context, element, segments });
		}

		if (segments.length > segmentCountBefore) {
			previousEnd = element.startTime + element.duration;
		}
	}

	if (segments.length === 0) {
		return null;
	}

	const isMuted =
		("muted" in track && track.muted) ||
		("volume" in track && track.volume === 0);

	return {
		attribute: isMuted ? 1 : 0,
		flag: 0,
		id: context.createId(),
		is_default_name: true,
		name: "",
		segments,
		type: track.type,
	};
}

/**
 * Orders tracks bottom-to-top for CapCut (earlier tracks render below):
 * main video track first, then overlay video tracks, then audio, then text.
 */
function orderTracksForCapcut({
	tracks,
}: {
	tracks: TimelineTrack[];
}): TimelineTrack[] {
	const visible = tracks.filter(
		(track) => !("hidden" in track && track.hidden),
	);
	const videoTracks = visible.filter((track) => track.type === "video");
	const bottomToTopVideo = [
		...videoTracks.filter((track) => isMainTrack(track)),
		...videoTracks.filter((track) => !isMainTrack(track)).reverse(),
	];
	const audioTracks = visible.filter((track) => track.type === "audio");
	const otherTracks = visible
		.filter((track) => track.type !== "video" && track.type !== "audio")
		.reverse();
	return [...bottomToTopVideo, ...audioTracks, ...otherTracks];
}

const EMPTY_MATERIAL_KEYS = [
	"ai_translates",
	"audio_balances",
	"audio_effects",
	"audio_fades",
	"audio_track_indexes",
	"beats",
	"canvases",
	"chromas",
	"color_curves",
	"digital_humans",
	"drafts",
	"effects",
	"flowers",
	"green_screens",
	"handwrites",
	"hsl",
	"images",
	"log_color_wheels",
	"loudnesses",
	"manual_deformations",
	"masks",
	"material_animations",
	"material_colors",
	"multi_language_refs",
	"placeholders",
	"plugin_effects",
	"primary_color_wheels",
	"realtime_denoises",
	"shapes",
	"smart_crops",
	"smart_relights",
	"sound_channel_mappings",
	"stickers",
	"tail_leaders",
	"text_templates",
	"time_marks",
	"transitions",
	"video_effects",
	"video_trackings",
	"vocal_beautifys",
	"vocal_separations",
] as const;

export function serializeCapcutDraft({
	projectName,
	fps,
	canvasSize,
	tracks,
	mediaAssets,
	createId = () => crypto.randomUUID(),
	now = () => Date.now(),
}: SerializeCapcutDraftParams): CapcutDraftResult {
	const context: SerializerContext = {
		createId,
		canvasSize,
		warnings: [],
		mediaFiles: [],
		usedFileNames: new Set(),
		materials: { videos: [], audios: [], texts: [], speeds: [] },
		materialIdByMediaKey: new Map(),
	};
	const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));

	const draftTracks: Record<string, unknown>[] = [];
	for (const track of orderTracksForCapcut({ tracks })) {
		const serialized = serializeTrack({ context, track, mediaById });
		if (serialized) {
			draftTracks.push(serialized);
		}
	}

	// CapCut renders later tracks on top; render_index mirrors track order.
	let durationMicroseconds = 0;
	for (const [trackIndex, track] of draftTracks.entries()) {
		for (const segment of track.segments as Record<string, unknown>[]) {
			segment.render_index = trackIndex;
			segment.track_render_index = 0;
			const target = segment.target_timerange as Timerange;
			durationMicroseconds = Math.max(
				durationMicroseconds,
				target.start + target.duration,
			);
		}
	}

	const draftId = createId().toUpperCase();
	const materials: Record<string, unknown> = Object.fromEntries(
		EMPTY_MATERIAL_KEYS.map((key) => [key, []]),
	);
	materials.videos = context.materials.videos;
	materials.audios = context.materials.audios;
	materials.texts = context.materials.texts;
	materials.speeds = context.materials.speeds;

	const draftContent: Record<string, unknown> = {
		canvas_config: {
			width: canvasSize.width,
			height: canvasSize.height,
			ratio: "original",
		},
		color_space: 0,
		config: {
			adjust_max_index: 1,
			attachment_info: [],
			combination_max_index: 1,
			export_range: null,
			extract_audio_last_index: 1,
			lyrics_recognition_id: "",
			lyrics_sync: true,
			lyrics_taskinfo: [],
			maintrack_adsorb: true,
			material_save_mode: 0,
			multi_language_current: "none",
			multi_language_list: [],
			multi_language_main: "none",
			multi_language_mode: "none",
			original_sound_last_index: 1,
			record_audio_last_index: 1,
			sticker_max_index: 1,
			subtitle_keywords_config: null,
			subtitle_recognition_id: "",
			subtitle_sync: true,
			subtitle_taskinfo: [],
			system_font_list: [],
			video_mute: false,
			zoom_info_params: null,
		},
		cover: null,
		create_time: 0,
		duration: durationMicroseconds,
		extra_info: null,
		fps,
		free_render_index_mode_on: false,
		group_container: null,
		id: draftId,
		keyframe_graph_list: [],
		keyframes: {
			adjusts: [],
			audios: [],
			effects: [],
			filters: [],
			handwrites: [],
			stickers: [],
			texts: [],
			videos: [],
		},
		last_modified_platform: DRAFT_PLATFORM,
		platform: DRAFT_PLATFORM,
		materials,
		mutable_config: null,
		name: projectName,
		new_version: DRAFT_NEW_VERSION,
		relationships: [],
		render_index_track_mode_on: false,
		retouch_cover: null,
		source: "default",
		static_cover_image_path: "",
		time_marks: null,
		tracks: draftTracks,
		update_time: 0,
		version: DRAFT_VERSION,
	};

	const nowMs = now();
	const draftMetaInfo: Record<string, unknown> = {
		cloud_package_completed_time: "",
		draft_cloud_capcut_purchase_info: "",
		draft_cloud_last_action_download: false,
		draft_cloud_materials: [],
		draft_cloud_purchase_info: "",
		draft_cloud_template_id: "",
		draft_cloud_tutorial_info: "",
		draft_cloud_videocut_purchase_info: "",
		draft_cover: "",
		draft_deeplink_url: "",
		draft_enterprise_info: {
			draft_enterprise_extra: "",
			draft_enterprise_id: "",
			draft_enterprise_name: "",
			enterprise_material: [],
		},
		draft_fold_path: "",
		draft_id: draftId,
		draft_is_ai_packaging_used: false,
		draft_is_ai_shorts: false,
		draft_is_ai_translate: false,
		draft_is_article_video_draft: false,
		draft_is_from_deeplink: "false",
		draft_is_invisible: false,
		draft_materials: [
			{
				type: 0,
				value: buildMetaMediaEntries({ context, mediaById, nowMs }),
			},
			{ type: 1, value: [] },
			{ type: 2, value: [] },
			{ type: 3, value: [] },
			{ type: 6, value: [] },
			{ type: 7, value: [] },
			{ type: 8, value: [] },
		],
		draft_materials_copied_info: [],
		draft_name: projectName,
		draft_new_version: "",
		draft_removable_storage_device: "",
		draft_root_path: "",
		draft_segment_extra_info: [],
		draft_type: "",
		tm_draft_cloud_completed: "",
		tm_draft_cloud_modified: 0,
		tm_draft_create: nowMs * 1000,
		tm_draft_modified: nowMs * 1000,
		tm_draft_removed: 0,
		tm_duration: durationMicroseconds,
	};

	return {
		draftContent,
		draftMetaInfo,
		mediaFiles: context.mediaFiles,
		warnings: context.warnings,
	};
}

function buildMetaMediaEntries({
	context,
	mediaById,
	nowMs,
}: {
	context: SerializerContext;
	mediaById: Map<string, CapcutMediaAssetInfo>;
	nowMs: number;
}): Record<string, unknown>[] {
	return context.mediaFiles.map((file) => {
		const asset = file.kind === "asset" ? mediaById.get(file.assetId) : null;
		const metetype =
			asset?.type === "image"
				? "photo"
				: asset?.type === "video"
					? "video"
					: "music";
		const durationMicroseconds = toMicroseconds(asset?.duration ?? 0);
		return {
			create_time: Math.floor(nowMs / 1000),
			duration: durationMicroseconds,
			extra_info: file.fileName,
			file_Path: file.zipPath,
			height: asset?.height ?? 0,
			id: context.createId(),
			import_time: Math.floor(nowMs / 1000),
			import_time_ms: nowMs * 1000,
			item_source: 1,
			md5: "",
			metetype,
			roughcut_time_range: { duration: durationMicroseconds, start: 0 },
			sub_time_range: { duration: -1, start: -1 },
			type: 0,
			width: asset?.width ?? 0,
		};
	});
}
