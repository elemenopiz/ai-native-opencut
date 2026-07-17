import type {
	AudioElement,
	LibraryAudioElement,
	TimelineElement,
	TimelineTrack,
} from "@/types/timeline";
import type { ElementAnimations, NumberKeyframe } from "@/types/animation";
import type { MediaAsset } from "@/types/assets";
import { canElementHaveAudio } from "@/lib/timeline/element-utils";
import { canTracktHaveAudio } from "@/lib/timeline";
import { doesElementHaveEnabledAudio } from "@/lib/timeline/audio-separation";
import { getNumberChannelForPath } from "@/lib/animation/number-channel";
import { applyEasing } from "@/lib/animation/easing";
import { TIME_EPSILON_SECONDS } from "@/constants/animation-constants";
import {
	shouldTimeStretch,
	stretchAudioBufferSegment,
} from "@/lib/media/pitch-preserving-stretch";
import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from "mediabunny";

const MAX_AUDIO_CHANNELS = 2;
const EXPORT_SAMPLE_RATE = 44100;

export type CollectedAudioElement = Omit<
	AudioElement,
	"type" | "mediaId" | "volume" | "id" | "name" | "sourceType" | "sourceUrl"
> & {
	buffer: AudioBuffer;
	/** Constant playback-speed multiplier (1.0 = normal). Slot duration is fixed; source is traversed at this rate. */
	playbackRate: number;
	/**
	 * True when the element has a keyframed (variable) speed curve, which is not
	 * yet handled in the export mixdown. When set, `playbackRate` holds the base
	 * rate used as a best-effort constant fallback. See resolveClipPlaybackRate.
	 */
	hasVariableRate: boolean;
	/**
	 * Static per-clip volume (default 1) — the same field AudioManager reads as
	 * `clip.volume ?? 1` in its static-volume fast path (see connectClipNode).
	 * Always 1 for a video element's own embedded audio: VideoElement has no
	 * `volume` field, matching collectAudioClips' playback-path precedent.
	 */
	volume: number;
	/**
	 * The element's owning track volume (default 1) — a separate multiplier
	 * from the clip's own volume, mirroring AudioManager's per-track GainNode
	 * (see getOrCreateTrackNodes).
	 */
	trackVolume: number;
	/**
	 * The element's `volume` animation-channel keyframes (auto-duck), or null
	 * when absent/empty. Mirrors AudioManager.getOrCreateAnimatedClipGain: when
	 * present, the channel entirely governs the gain at every sample (the
	 * static `volume` above only serves as the fallback value the channel
	 * evaluator would use if it had zero keyframes, which can't happen here).
	 */
	volumeKeyframes: NumberKeyframe[] | null;
};

/**
 * Resolve a clip's static volume and (optional) `volume` animation channel for
 * the export mixdown — the same two inputs AudioManager reads for playback
 * (`clip.volume ?? 1` and `getNumberChannelForPath(..., "volume")`). Called
 * uniformly for audio and video elements, matching resolveClipPlaybackRate:
 * VideoElement has no `volume` field, so video clips always resolve to a
 * static volume of 1 (their track's volume still applies separately).
 */
function resolveClipVolume(element: {
	volume?: number;
	animations?: ElementAnimations;
}): { volume: number; keyframes: NumberKeyframe[] | null } {
	const volume = typeof element.volume === "number" ? element.volume : 1;

	const channel = getNumberChannelForPath({
		animations: element.animations,
		propertyPath: "volume",
	});

	return {
		volume,
		keyframes:
			channel && channel.keyframes.length > 0 ? channel.keyframes : null,
	};
}

/**
 * Resolve a constant playback rate for an element in the export audio mixdown.
 *
 * Matches the visual renderer (see VisualNode.getSourceLocalTime): the element
 * occupies a fixed timeline `duration`, and source media is traversed at
 * `playbackRate`, so a 2x clip consumes source audio twice as fast (and
 * pitch-shifts up, matching the non-pitch-preserving preview).
 *
 * Variable/keyframed speed curves are not yet supported here and are flagged via
 * `hasVariableRate` so the mixer can warn instead of silently mishandling them.
 */
function resolveClipPlaybackRate(element: {
	playbackRate?: number;
	animations?: ElementAnimations;
}): { playbackRate: number; hasVariableRate: boolean } {
	const baseRate =
		typeof element.playbackRate === "number" && element.playbackRate > 0
			? element.playbackRate
			: 1;

	const channel = getNumberChannelForPath({
		animations: element.animations,
		propertyPath: "playbackRate",
	});

	if (!channel || channel.keyframes.length === 0) {
		return { playbackRate: baseRate, hasVariableRate: false };
	}

	// A single keyframe is a constant rate; two or more describe a curve.
	if (channel.keyframes.length === 1) {
		const value = channel.keyframes[0].value;
		return {
			playbackRate: value > 0 ? value : baseRate,
			hasVariableRate: false,
		};
	}

	return { playbackRate: baseRate, hasVariableRate: true };
}

export function createAudioContext({
	sampleRate,
}: {
	sampleRate?: number;
} = {}): AudioContext {
	const AudioContextConstructor =
		window.AudioContext ||
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;

	return new AudioContextConstructor(sampleRate ? { sampleRate } : undefined);
}

export interface DecodedAudio {
	samples: Float32Array;
	sampleRate: number;
}

export async function decodeAudioToFloat32({
	audioBlob,
}: {
	audioBlob: Blob;
}): Promise<DecodedAudio> {
	const audioContext = createAudioContext();
	try {
		const arrayBuffer = await audioBlob.arrayBuffer();
		const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

		// mix down to mono
		const numChannels = audioBuffer.numberOfChannels;
		const length = audioBuffer.length;
		const samples = new Float32Array(length);

		for (let i = 0; i < length; i++) {
			let sum = 0;
			for (let channel = 0; channel < numChannels; channel++) {
				sum += audioBuffer.getChannelData(channel)[i];
			}
			samples[i] = sum / numChannels;
		}

		return { samples, sampleRate: audioBuffer.sampleRate };
	} finally {
		// Release the decode-only context instead of leaking it toward the
		// browser's concurrent-AudioContext limit.
		audioContext.close().catch(() => {});
	}
}

export async function collectAudioElements({
	tracks,
	mediaAssets,
	audioContext,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	audioContext: AudioContext;
}): Promise<CollectedAudioElement[]> {
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((media) => [media.id, media]),
	);
	const pendingElements: Array<Promise<CollectedAudioElement | null>> = [];

	for (const track of tracks) {
		if (canTracktHaveAudio(track) && track.muted) continue;

		const trackVolume = ("volume" in track ? track.volume : undefined) ?? 1;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (element.duration <= 0) continue;

			const isTrackMuted = canTracktHaveAudio(track) && track.muted;

			if (element.type === "audio") {
				pendingElements.push(
					resolveAudioBufferForElement({
						element,
						mediaMap,
						audioContext,
					}).then((audioBuffer) => {
						if (!audioBuffer) return null;
						const { playbackRate, hasVariableRate } =
							resolveClipPlaybackRate(element);
						const { volume, keyframes: volumeKeyframes } =
							resolveClipVolume(element);
						return {
							buffer: audioBuffer,
							startTime: element.startTime,
							duration: element.duration,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							muted: element.muted || isTrackMuted,
							playbackRate,
							hasVariableRate,
							volume,
							trackVolume,
							volumeKeyframes,
						};
					}),
				);
				continue;
			}

			if (element.type === "video") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (
					!mediaAsset ||
					!doesElementHaveEnabledAudio({ element, mediaAsset })
				)
					continue;

				pendingElements.push(
					resolveAudioBufferForVideoElement({
						mediaAsset,
						audioContext,
					}).then((audioBuffer) => {
						if (!audioBuffer) return null;
						const elementMuted = element.muted ?? false;
						const { playbackRate, hasVariableRate } =
							resolveClipPlaybackRate(element);
						const { volume, keyframes: volumeKeyframes } =
							resolveClipVolume(element);
						return {
							buffer: audioBuffer,
							startTime: element.startTime,
							duration: element.duration,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							muted: elementMuted || isTrackMuted,
							playbackRate,
							hasVariableRate,
							volume,
							trackVolume,
							volumeKeyframes,
						};
					}),
				);
			}
		}
	}

	const resolvedElements = await Promise.all(pendingElements);
	const audioElements: CollectedAudioElement[] = [];
	for (const element of resolvedElements) {
		if (element) audioElements.push(element);
	}
	return audioElements;
}

async function resolveAudioBufferForElement({
	element,
	mediaMap,
	audioContext,
}: {
	element: AudioElement;
	mediaMap: Map<string, MediaAsset>;
	audioContext: AudioContext;
}): Promise<AudioBuffer | null> {
	try {
		if (element.sourceType === "upload") {
			const asset = mediaMap.get(element.mediaId);
			if (!asset || asset.type !== "audio") return null;

			const arrayBuffer = await asset.file.arrayBuffer();
			return await audioContext.decodeAudioData(arrayBuffer.slice(0));
		}

		if (element.buffer) return element.buffer;

		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		return await audioContext.decodeAudioData(arrayBuffer.slice(0));
	} catch (error) {
		console.warn("Failed to decode audio:", error);
		return null;
	}
}

async function resolveAudioBufferForVideoElement({
	mediaAsset,
	audioContext,
}: {
	mediaAsset: MediaAsset;
	audioContext: AudioContext;
}): Promise<AudioBuffer | null> {
	const input = new Input({
		source: new BlobSource(mediaAsset.file),
		formats: ALL_FORMATS,
	});

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return null;

		const sink = new AudioBufferSink(audioTrack);
		const targetSampleRate = audioContext.sampleRate;

		const chunks: AudioBuffer[] = [];
		let totalSamples = 0;

		for await (const { buffer } of sink.buffers(0)) {
			chunks.push(buffer);
			totalSamples += buffer.length;
		}

		if (chunks.length === 0) return null;

		const nativeSampleRate = chunks[0].sampleRate;
		const numChannels = Math.min(
			MAX_AUDIO_CHANNELS,
			chunks[0].numberOfChannels,
		);

		const nativeChannels = Array.from(
			{ length: numChannels },
			() => new Float32Array(totalSamples),
		);
		let offset = 0;
		for (const chunk of chunks) {
			for (let channel = 0; channel < numChannels; channel++) {
				const sourceData = chunk.getChannelData(
					Math.min(channel, chunk.numberOfChannels - 1),
				);
				nativeChannels[channel].set(sourceData, offset);
			}
			offset += chunk.length;
		}

		// use OfflineAudioContext for high-quality resampling to target rate
		const outputSamples = Math.ceil(
			totalSamples * (targetSampleRate / nativeSampleRate),
		);
		const offlineContext = new OfflineAudioContext(
			numChannels,
			outputSamples,
			targetSampleRate,
		);

		const nativeBuffer = audioContext.createBuffer(
			numChannels,
			totalSamples,
			nativeSampleRate,
		);
		for (let ch = 0; ch < numChannels; ch++) {
			nativeBuffer.copyToChannel(nativeChannels[ch], ch);
		}

		const sourceNode = offlineContext.createBufferSource();
		sourceNode.buffer = nativeBuffer;
		sourceNode.connect(offlineContext.destination);
		sourceNode.start(0);

		return await offlineContext.startRendering();
	} catch (error) {
		console.warn("Failed to decode video audio:", error);
		return null;
	} finally {
		input.dispose();
	}
}

interface AudioMixSource {
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
}

export interface AudioClipSource {
	id: string;
	sourceKey: string;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	muted: boolean;
	volume: number;
	/** Constant playback-speed multiplier (1.0 = normal). Slot duration is fixed; source is traversed at this rate. */
	playbackRate: number;
	/** True when the element has a keyframed (variable) speed curve — see CollectedAudioElement.hasVariableRate. */
	hasVariableRate: boolean;
	/** The element's animation channels (transform/opacity/volume/…), carried
	 *  through so the playback mix graph (`AudioManager.connectClipNode`) can
	 *  honor a `volume` keyframe channel via WebAudio gain automation, the same
	 *  channel the properties UI reads via `resolveVolumeAtTime`. Absent ⇒ no
	 *  animations on the element, playback falls back to the static `volume`. */
	animations?: ElementAnimations;
}

async function fetchLibraryAudioSource({
	element,
}: {
	element: LibraryAudioElement;
}): Promise<AudioMixSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			file,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

async function fetchLibraryAudioClip({
	element,
	muted,
}: {
	element: LibraryAudioElement;
	muted: boolean;
}): Promise<AudioClipSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		const { playbackRate, hasVariableRate } = resolveClipPlaybackRate(element);
		return {
			id: element.id,
			sourceKey: element.id,
			file,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			muted,
			volume: element.volume ?? 1,
			playbackRate,
			hasVariableRate,
			animations: element.animations,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

function collectMediaAudioSource({
	element,
	mediaAsset,
}: {
	element: TimelineElement;
	mediaAsset: MediaAsset;
}): AudioMixSource {
	return {
		file: mediaAsset.file,
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
	};
}

function collectMediaAudioClip({
	element,
	mediaAsset,
	muted,
}: {
	element: TimelineElement;
	mediaAsset: MediaAsset;
	muted: boolean;
}): AudioClipSource {
	const vol =
		"volume" in element ? ((element as { volume?: number }).volume ?? 1) : 1;
	const { playbackRate, hasVariableRate } = resolveClipPlaybackRate(element);
	return {
		id: element.id,
		sourceKey: mediaAsset.id,
		file: mediaAsset.file,
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		muted,
		volume: vol,
		playbackRate,
		hasVariableRate,
		animations: element.animations,
	};
}

export async function collectAudioMixSources({
	tracks,
	mediaAssets,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
}): Promise<AudioMixSource[]> {
	const audioMixSources: AudioMixSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibrarySources: Array<Promise<AudioMixSource | null>> = [];

	for (const track of tracks) {
		if (canTracktHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset }),
					);
				} else {
					pendingLibrarySources.push(fetchLibraryAudioSource({ element }));
				}
				continue;
			}

			if (element.type === "video") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset) continue;

				if (doesElementHaveEnabledAudio({ element, mediaAsset })) {
					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset }),
					);
				}
			}
		}
	}

	const resolvedLibrarySources = await Promise.all(pendingLibrarySources);
	for (const source of resolvedLibrarySources) {
		if (source) audioMixSources.push(source);
	}

	return audioMixSources;
}

export async function collectAudioClips({
	tracks,
	mediaAssets,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
}): Promise<AudioClipSource[]> {
	const clips: AudioClipSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibraryClips: Array<Promise<AudioClipSource | null>> = [];

	for (const track of tracks) {
		const isTrackMuted = canTracktHaveAudio(track) && track.muted;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;

			const isElementMuted =
				"muted" in element ? (element.muted ?? false) : false;
			const muted = isTrackMuted || isElementMuted;

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
						}),
					);
				} else {
					pendingLibraryClips.push(fetchLibraryAudioClip({ element, muted }));
				}
				continue;
			}

			if (element.type === "video") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset) continue;

				if (doesElementHaveEnabledAudio({ element, mediaAsset })) {
					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
						}),
					);
				}
			}
		}
	}

	const resolvedLibraryClips = await Promise.all(pendingLibraryClips);
	for (const clip of resolvedLibraryClips) {
		if (clip) clips.push(clip);
	}

	return clips;
}

export async function createTimelineAudioBuffer({
	tracks,
	mediaAssets,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
	audioContext,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	duration: number;
	sampleRate?: number;
	audioContext?: AudioContext;
}): Promise<AudioBuffer | null> {
	// Only close a context we allocated ourselves; a caller-supplied context is
	// the caller's to manage.
	const ownsContext = !audioContext;
	const context = audioContext ?? createAudioContext({ sampleRate });

	try {
		const audioElements = await collectAudioElements({
			tracks,
			mediaAssets,
			audioContext: context,
		});

		if (audioElements.length === 0) return null;

		const outputChannels = 2;
		const outputLength = Math.ceil(duration * sampleRate);
		const outputBuffer = context.createBuffer(
			outputChannels,
			outputLength,
			sampleRate,
		);

		for (const element of audioElements) {
			if (element.muted) continue;

			const mixElement = await resolveMixElement({ element, sampleRate });
			mixAudioChannels({
				element: mixElement,
				outputBuffer,
				outputLength,
				sampleRate,
			});
		}

		return outputBuffer;
	} finally {
		if (ownsContext) context.close().catch(() => {});
	}
}

/**
 * Prepare a collected element for the mixdown: constant speed-changed clips are
 * pitch-preservingly time-stretched up front (via the SAME seam the preview
 * uses — see pitch-preserving-stretch.ts) and handed to the mixer as a rate-1
 * clip. Rate-1 clips pass through untouched; variable-rate (keyframed) clips
 * and stretch failures keep today's raw-rate pitch-shifted behavior inside
 * mixAudioChannels.
 *
 * `stretch` is injectable for tests only.
 */
export async function resolveMixElement({
	element,
	sampleRate,
	stretch = stretchAudioBufferSegment,
}: {
	element: CollectedAudioElement;
	sampleRate: number;
	stretch?: typeof stretchAudioBufferSegment;
}): Promise<CollectedAudioElement> {
	if (
		!shouldTimeStretch({
			playbackRate: element.playbackRate,
			hasVariableRate: element.hasVariableRate,
		})
	) {
		return element;
	}

	const stretched = await stretch({
		buffer: element.buffer,
		playbackRate: element.playbackRate,
		trimStart: element.trimStart,
		duration: element.duration,
		targetSampleRate: sampleRate,
	});

	if (!stretched) {
		console.warn(
			`Export audio: pitch-preserving stretch unavailable for a ${element.playbackRate}x clip; ` +
				"mixing with shifted pitch instead.",
		);
		return element;
	}

	// The stretched buffer IS the timeline slot: rate 1, starts at source 0.
	return {
		...element,
		buffer: stretched,
		trimStart: 0,
		playbackRate: 1,
		hasVariableRate: false,
	};
}

/**
 * Sample a `volume` animation channel across `sampleCount` consecutive
 * element-local-time samples (index `i` -> time `i / sampleRate`), matching
 * `getNumberChannelValueAtTime` (lib/animation/interpolation.ts) exactly —
 * same first/last clamping, same "hold" step semantics, same eased linear
 * ramps — but walking the sorted keyframes with a forward-only cursor instead
 * of rescanning them from scratch per sample, since the queried time is
 * monotonically increasing here. See the parity test in
 * audio-mixdown.test.ts, which checks this walker against
 * `getNumberChannelValueAtTime` at many sample points.
 */
export function computeVolumeEnvelope({
	keyframes,
	fallbackValue,
	sampleCount,
	sampleRate,
}: {
	keyframes: NumberKeyframe[] | null | undefined;
	fallbackValue: number;
	sampleCount: number;
	sampleRate: number;
}): Float32Array {
	const envelope = new Float32Array(sampleCount);

	if (!keyframes || keyframes.length === 0) {
		envelope.fill(fallbackValue);
		return envelope;
	}

	const sorted = [...keyframes].sort((a, b) => a.time - b.time);
	const first = sorted[0];
	const last = sorted[sorted.length - 1];

	// Index of the left keyframe of the current [left, right] segment; only
	// ever advances, since the queried time (i / sampleRate) only increases.
	let segmentIndex = 0;

	for (let i = 0; i < sampleCount; i++) {
		const time = i / sampleRate;

		if (time <= first.time + TIME_EPSILON_SECONDS) {
			envelope[i] = first.value;
			continue;
		}
		if (time >= last.time - TIME_EPSILON_SECONDS) {
			envelope[i] = last.value;
			continue;
		}

		while (
			segmentIndex < sorted.length - 2 &&
			time > sorted[segmentIndex + 1].time + TIME_EPSILON_SECONDS
		) {
			segmentIndex++;
		}

		const leftKeyframe = sorted[segmentIndex];
		const rightKeyframe = sorted[segmentIndex + 1];

		if (Math.abs(time - rightKeyframe.time) <= TIME_EPSILON_SECONDS) {
			envelope[i] = rightKeyframe.value;
			continue;
		}

		const span = rightKeyframe.time - leftKeyframe.time;
		if (Math.abs(span) <= TIME_EPSILON_SECONDS) {
			envelope[i] = rightKeyframe.value;
			continue;
		}

		const progress = Math.max(
			0,
			Math.min(1, (time - leftKeyframe.time) / span),
		);

		envelope[i] =
			leftKeyframe.interpolation === "hold"
				? leftKeyframe.value
				: leftKeyframe.value +
					(rightKeyframe.value - leftKeyframe.value) *
						applyEasing({ easing: leftKeyframe.easing, progress });
	}

	return envelope;
}

/** Per-sample gain for a clip: either a single constant (the common case — no
 *  volume automation) or a precomputed per-output-sample envelope (already
 *  folded together with the track volume multiplier). */
type GainPlan =
	| { kind: "constant"; value: number }
	| { kind: "envelope"; values: Float32Array };

function resolveGainPlan({
	volumeKeyframes,
	volume,
	trackVolume,
	sampleCount,
	sampleRate,
}: {
	volumeKeyframes: NumberKeyframe[] | null | undefined;
	volume: number;
	trackVolume: number;
	sampleCount: number;
	sampleRate: number;
}): GainPlan {
	if (!volumeKeyframes || volumeKeyframes.length === 0) {
		return { kind: "constant", value: volume * trackVolume };
	}

	const values = computeVolumeEnvelope({
		keyframes: volumeKeyframes,
		fallbackValue: volume,
		sampleCount,
		sampleRate,
	});
	if (trackVolume !== 1) {
		for (let i = 0; i < values.length; i++) values[i] *= trackVolume;
	}
	return { kind: "envelope", values };
}

export function mixAudioChannels({
	element,
	outputBuffer,
	outputLength,
	sampleRate,
}: {
	element: CollectedAudioElement;
	outputBuffer: AudioBuffer;
	outputLength: number;
	sampleRate: number;
}): void {
	const {
		buffer,
		startTime,
		trimStart,
		duration: elementDuration,
		playbackRate,
		hasVariableRate,
		volume,
		trackVolume,
		volumeKeyframes,
	} = element;

	if (hasVariableRate) {
		// Keyframed/variable speed curves are not yet supported in the export
		// mixdown; fall back to the constant base rate rather than mishandling
		// it silently. Tracked as a follow-up.
		console.warn(
			"Export audio: variable-rate (keyframed) speed curve is not yet supported; " +
				`using constant base rate ${playbackRate}x for this clip.`,
		);
	}

	// The clip occupies a fixed timeline slot (`elementDuration`). Speed only
	// changes how fast the source is traversed within that slot, matching the
	// visual renderer (VisualNode.getSourceLocalTime): source position =
	// trimStart + timelineElapsed * playbackRate. A 2x clip therefore reads the
	// source twice as fast (and pitch-shifts up), staying in sync with video.
	const rate = playbackRate > 0 ? playbackRate : 1;

	const sourceStartSample = Math.floor(trimStart * buffer.sampleRate);
	const outputStartSample = Math.floor(startTime * sampleRate);

	const resampleRatio = sampleRate / buffer.sampleRate;
	// Output length is the timeline duration (independent of rate); the rate is
	// applied to the per-sample source step below.
	const resampledLength = Math.floor(elementDuration * sampleRate);

	// Gain is keyed on the OUTPUT-domain loop index `i` (element-local timeline
	// time = i / sampleRate), NOT the source index: the `volume` automation
	// envelope lives in timeline time, which is unaffected by playbackRate and
	// by resolveMixElement's pitch-preserving stretch (see module docs above).
	const gainPlan = resolveGainPlan({
		volumeKeyframes,
		volume: typeof volume === "number" ? volume : 1,
		trackVolume: typeof trackVolume === "number" ? trackVolume : 1,
		sampleCount: resampledLength,
		sampleRate,
	});

	const outputChannels = 2;
	for (let channel = 0; channel < outputChannels; channel++) {
		const outputData = outputBuffer.getChannelData(channel);
		const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
		const sourceData = buffer.getChannelData(sourceChannel);

		for (let i = 0; i < resampledLength; i++) {
			const outputIndex = outputStartSample + i;
			if (outputIndex >= outputLength) break;

			const sourceIndex =
				sourceStartSample + Math.floor((i * rate) / resampleRatio);
			if (sourceIndex >= sourceData.length) break;

			const gain =
				gainPlan.kind === "constant" ? gainPlan.value : gainPlan.values[i];

			outputData[outputIndex] += sourceData[sourceIndex] * gain;
		}
	}
}
