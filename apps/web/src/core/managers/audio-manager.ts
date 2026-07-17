import type { EditorCore } from "@/core";
import type { AudioClipSource } from "@/lib/media/audio";
import { createAudioContext, collectAudioClips } from "@/lib/media/audio";
import {
	resolveStretchDecision,
	stretchAudioBufferSegment,
} from "@/lib/media/pitch-preserving-stretch";
import { getNumberChannelValueAtTime } from "@/lib/animation";
import { getNumberChannelForPath } from "@/lib/animation/number-channel";
import type { NumberKeyframe } from "@/types/animation";
import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	Input,
	type WrappedAudioBuffer,
} from "mediabunny";

/** Max cached pitch-preserved renders (each is a fully decoded clip slot). */
const MAX_STRETCHED_BUFFER_CACHE = 12;

/** Minimal surface of a WebAudio `AudioParam` this module schedules against —
 *  narrowed so the scheduling plan builder/applier is testable with a plain
 *  fake, no real AudioContext required. */
export interface AudioParamLike {
	setValueAtTime(value: number, startTime: number): unknown;
	linearRampToValueAtTime(value: number, endTime: number): unknown;
}

/** One scheduled gain-automation instruction in the AudioContext time domain. */
export interface VolumeAutomationStep {
	kind: "set" | "ramp";
	value: number;
	contextTime: number;
}

/**
 * Pure builder for a clip's volume gain-automation schedule, sampled from its
 * `volume` animation channel (the same channel `resolveVolumeAtTime` reads for
 * the properties UI — see `lib/animation/resolve.ts`). Kept AudioContext-free
 * so it's unit-testable: `localTimeToContextTime` maps an element-local time
 * (0..clip duration, matching how keyframe `time` is stored — see
 * `UpsertKeyframeCommand`) to the absolute AudioContext time it should land at.
 *
 * `nowLocalTime` is the element-local time at which this schedule starts being
 * applied — a fresh playback session starts at 0, but a mid-clip seek (or a
 * resync after a scheduling underrun) starts partway through, so the plan
 * always opens with a `set` step pinning the CURRENT interpolated value at
 * `nowLocalTime`, then only schedules keyframes still ahead of it. This avoids
 * both replaying already-elapsed automation and a jarring jump from whatever
 * the gain node's default value was.
 */
export function buildVolumeAutomationPlan({
	keyframes,
	nowLocalTime,
	fallbackValue,
	localTimeToContextTime,
}: {
	keyframes: NumberKeyframe[];
	nowLocalTime: number;
	fallbackValue: number;
	localTimeToContextTime: (localTime: number) => number;
}): VolumeAutomationStep[] {
	if (keyframes.length === 0) return [];

	const sorted = [...keyframes].sort((a, b) => a.time - b.time);
	const clampedNow = Math.max(0, nowLocalTime);

	const anchorValue = getNumberChannelValueAtTime({
		channel: { valueKind: "number", keyframes: sorted },
		time: clampedNow,
		fallbackValue,
	});

	const plan: VolumeAutomationStep[] = [
		{
			kind: "set",
			value: anchorValue,
			contextTime: localTimeToContextTime(clampedNow),
		},
	];

	for (let i = 0; i < sorted.length; i++) {
		const keyframe = sorted[i];
		if (keyframe.time <= clampedNow) continue; // already elapsed — anchor covers it

		const previous = i > 0 ? sorted[i - 1] : undefined;
		const isHoldSegment = previous?.interpolation === "hold";
		plan.push({
			kind: isHoldSegment ? "set" : "ramp",
			value: keyframe.value,
			contextTime: localTimeToContextTime(keyframe.time),
		});
	}

	return plan;
}

/** Apply a schedule built by `buildVolumeAutomationPlan` to a real (or fake)
 *  AudioParam. Split out from the builder so tests can assert on the plan
 *  directly without a GainNode. */
export function applyVolumeAutomationPlan({
	gainParam,
	plan,
}: {
	gainParam: AudioParamLike;
	plan: VolumeAutomationStep[];
}): void {
	for (const step of plan) {
		if (step.kind === "set") {
			gainParam.setValueAtTime(step.value, step.contextTime);
		} else {
			gainParam.linearRampToValueAtTime(step.value, step.contextTime);
		}
	}
}

export class AudioManager {
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private masterAnalyser: AnalyserNode | null = null;
	/** Stereo tap for the timeline VU meter (§4.2, palmier-delta-refresh-2026-07-14.md):
	 * a channel splitter off masterGain feeding two dedicated L/R analysers.
	 * masterAnalyser above stays mono (Web Audio down-mixes multi-channel
	 * input for analysis) — these are separate nodes specifically so the
	 * meter reads true per-channel peaks instead of a summed signal. */
	private stereoSplitter: ChannelSplitterNode | null = null;
	private leftAnalyser: AnalyserNode | null = null;
	private rightAnalyser: AnalyserNode | null = null;
	private trackNodes = new Map<
		string,
		{
			gain: GainNode;
			panner: StereoPannerNode;
			analyser: AnalyserNode;
		}
	>();
	private playbackStartTime = 0;
	private playbackStartContextTime = 0;
	private scheduleTimer: number | null = null;
	private lookaheadSeconds = 2;
	private scheduleIntervalMs = 500;
	private clips: AudioClipSource[] = [];
	private sinks = new Map<string, AudioBufferSink>();
	private inputs = new Map<string, Input>();
	private activeClipIds = new Set<string>();
	private clipIterators = new Map<
		string,
		AsyncGenerator<WrappedAudioBuffer, void, unknown>
	>();
	private queuedSources = new Set<AudioBufferSourceNode>();
	/**
	 * Per-clip GainNode for clips with a `volume` animation channel, keyed by
	 * clip.id. Created lazily the first time `connectClipNode` sees the clip
	 * this playback session (one automation schedule for the clip's whole
	 * lookahead-streamed lifetime, not one per streamed buffer chunk — see
	 * `getOrCreateAnimatedClipGain`). Scoped to a single playback session:
	 * cleared in `stopPlayback()` alongside the other per-session maps.
	 */
	private clipGainNodes = new Map<string, GainNode>();
	/**
	 * Pitch-preserved renders of speed-changed clips, keyed by
	 * source|rate|trim|duration|sampleRate. Survives timeline restarts (every
	 * clip drag triggers one) so a clip is only decoded+stretched once; `null`
	 * results are cached too so a failing clip doesn't re-render on every
	 * restart. Cleared on dispose().
	 */
	private stretchedBuffers = new Map<string, Promise<AudioBuffer | null>>();
	private playbackSessionId = 0;
	private lastIsPlaying = false;
	private lastVolume = 1;
	private playbackLatencyCompensationSeconds = 0;
	private unsubscribers: Array<() => void> = [];

	constructor(private editor: EditorCore) {
		this.lastVolume = this.editor.playback.getVolume();

		this.unsubscribers.push(
			this.editor.playback.subscribe(this.handlePlaybackChange),
			this.editor.timeline.subscribe(this.handleTimelineChange),
			this.editor.media.subscribe(this.handleTimelineChange),
		);
		if (typeof window !== "undefined") {
			window.addEventListener("playback-seek", this.handleSeek);
		}
	}

	dispose(): void {
		this.stopPlayback();
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		if (typeof window !== "undefined") {
			window.removeEventListener("playback-seek", this.handleSeek);
		}
		this.disposeSinks();
		this.stretchedBuffers.clear();
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
			this.masterGain = null;
			this.stereoSplitter = null;
			this.leftAnalyser = null;
			this.rightAnalyser = null;
		}
	}

	private handlePlaybackChange = (): void => {
		const isPlaying = this.editor.playback.getIsPlaying();
		const volume = this.editor.playback.getVolume();

		if (volume !== this.lastVolume) {
			this.lastVolume = volume;
			this.updateGain();
		}

		if (isPlaying !== this.lastIsPlaying) {
			this.lastIsPlaying = isPlaying;
			if (isPlaying) {
				void this.startPlayback({
					time: this.editor.playback.getCurrentTime(),
				});
			} else {
				this.stopPlayback();
			}
		}
	};

	private handleSeek = (event: Event): void => {
		const detail = (event as CustomEvent<{ time: number }>).detail;
		if (!detail) return;

		if (this.editor.playback.getIsScrubbing()) {
			this.stopPlayback();
			return;
		}

		if (this.editor.playback.getIsPlaying()) {
			void this.startPlayback({ time: detail.time });
			return;
		}

		this.stopPlayback();
	};

	private handleTimelineChange = (): void => {
		this.disposeSinks();

		if (!this.editor.playback.getIsPlaying()) return;

		void this.startPlayback({ time: this.editor.playback.getCurrentTime() });
	};

	private ensureAudioContext(): AudioContext | null {
		if (this.audioContext) return this.audioContext;
		if (typeof window === "undefined") return null;

		this.audioContext = createAudioContext();
		this.masterGain = this.audioContext.createGain();
		this.masterGain.gain.value = this.lastVolume;
		this.masterAnalyser = this.audioContext.createAnalyser();
		this.masterAnalyser.fftSize = 256;
		this.masterAnalyser.smoothingTimeConstant = 0.8;
		this.masterGain.connect(this.masterAnalyser);
		this.masterAnalyser.connect(this.audioContext.destination);

		// L/R tap for the timeline VU meter: branches off masterGain (same
		// signal masterAnalyser sees) through a splitter into two raw,
		// unsmoothed analysers. smoothingTimeConstant 0 because the meter's
		// own dB decay/peak-hold state machine (lib/audio/vu-meter-math.ts)
		// does the perceptual smoothing — double-smoothing here would blunt it.
		this.stereoSplitter = this.audioContext.createChannelSplitter(2);
		this.masterGain.connect(this.stereoSplitter);
		this.leftAnalyser = this.audioContext.createAnalyser();
		this.leftAnalyser.fftSize = 256;
		this.leftAnalyser.smoothingTimeConstant = 0;
		this.rightAnalyser = this.audioContext.createAnalyser();
		this.rightAnalyser.fftSize = 256;
		this.rightAnalyser.smoothingTimeConstant = 0;
		// Analyser nodes are auto-pulled by the Web Audio spec even without a
		// downstream connection (they exist for exactly this tap-without-
		// resounding use case), so leftAnalyser/rightAnalyser deliberately
		// don't connect onward to destination.
		this.stereoSplitter.connect(this.leftAnalyser, 0);
		this.stereoSplitter.connect(this.rightAnalyser, 1);

		return this.audioContext;
	}

	private updateGain(): void {
		if (!this.masterGain) return;
		this.masterGain.gain.value = this.lastVolume;
	}

	private getOrCreateTrackNodes(trackId: string): {
		gain: GainNode;
		panner: StereoPannerNode;
		analyser: AnalyserNode;
	} | null {
		const ctx = this.audioContext;
		if (!ctx || !this.masterGain) return null;

		const existing = this.trackNodes.get(trackId);
		if (existing) return existing;

		const tracks = this.editor.timeline.getTracks();
		const track = tracks.find((t) => t.id === trackId);
		const trackVolume =
			(track && ("volume" in track ? track.volume : undefined)) ?? 1;
		const trackPan = (track && ("pan" in track ? track.pan : undefined)) ?? 0;

		const gain = ctx.createGain();
		gain.gain.value = trackVolume;

		const panner = ctx.createStereoPanner();
		panner.pan.value = trackPan;

		const analyser = ctx.createAnalyser();
		analyser.fftSize = 256;
		analyser.smoothingTimeConstant = 0.8;

		gain.connect(panner);
		panner.connect(analyser);
		analyser.connect(this.masterGain);

		const nodes = { gain, panner, analyser };
		this.trackNodes.set(trackId, nodes);
		return nodes;
	}

	private rebuildTrackNodes(): void {
		for (const [, nodes] of this.trackNodes) {
			try {
				nodes.gain.disconnect();
				nodes.panner.disconnect();
				nodes.analyser.disconnect();
			} catch {}
		}
		this.trackNodes.clear();
	}

	getTrackLevels(trackId: string): { peak: number; rms: number } {
		const nodes = this.trackNodes.get(trackId);
		if (!nodes) return { peak: 0, rms: 0 };
		return this.readAnalyserLevels(nodes.analyser);
	}

	getMasterLevels(): { peak: number; rms: number } {
		if (!this.masterAnalyser) return { peak: 0, rms: 0 };
		return this.readAnalyserLevels(this.masterAnalyser);
	}

	/**
	 * True per-channel peak amplitude (0..1, linear) for the timeline VU
	 * meter. Returns null before the audio graph has been created (nothing
	 * has played yet this session) — callers should treat that as "hidden/
	 * inert", not zero level.
	 */
	getStereoPeakLevels(): { left: number; right: number } | null {
		if (!this.leftAnalyser || !this.rightAnalyser) return null;
		return {
			left: this.readAnalyserLevels(this.leftAnalyser).peak,
			right: this.readAnalyserLevels(this.rightAnalyser).peak,
		};
	}

	private readAnalyserLevels(analyser: AnalyserNode): {
		peak: number;
		rms: number;
	} {
		const bufferLength = analyser.fftSize;
		const dataArray = new Float32Array(bufferLength);
		analyser.getFloatTimeDomainData(dataArray);

		let peak = 0;
		let sumSquares = 0;
		for (let i = 0; i < bufferLength; i++) {
			const abs = Math.abs(dataArray[i]);
			if (abs > peak) peak = abs;
			sumSquares += dataArray[i] * dataArray[i];
		}
		const rms = Math.sqrt(sumSquares / bufferLength);
		return { peak, rms };
	}

	updateTrackVolume(trackId: string, volume: number): void {
		const nodes = this.trackNodes.get(trackId);
		if (nodes) {
			nodes.gain.gain.value = volume;
		}
	}

	updateTrackPan(trackId: string, pan: number): void {
		const nodes = this.trackNodes.get(trackId);
		if (nodes) {
			nodes.panner.pan.value = pan;
		}
	}

	private getTrackDestination(clipId: string): AudioNode {
		const ctx = this.audioContext;
		if (!ctx || !this.masterGain) return ctx?.destination ?? this.masterGain!;

		const tracks = this.editor.timeline.getTracks();
		const trackWithClip = tracks.find((t) =>
			t.elements.some((el) => el.id === clipId),
		);

		if (!trackWithClip) return this.masterGain;

		const trackNodes = this.getOrCreateTrackNodes(trackWithClip.id);
		if (!trackNodes) return this.masterGain;

		const isSoloMode = tracks.some((t) => "solo" in t && t.solo);
		const trackSolo = "solo" in trackWithClip ? trackWithClip.solo : false;

		if (isSoloMode && !trackSolo) {
			const silentGain = ctx.createGain();
			silentGain.gain.value = 0;
			silentGain.connect(this.masterGain);
			return silentGain;
		}

		return trackNodes.gain;
	}

	private getPlaybackTime(): number {
		if (!this.audioContext) return this.playbackStartTime;
		const elapsed =
			this.audioContext.currentTime - this.playbackStartContextTime;
		return this.playbackStartTime + elapsed;
	}

	private async startPlayback({ time }: { time: number }): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		this.stopPlayback();
		this.rebuildTrackNodes();
		this.playbackSessionId++;
		this.playbackLatencyCompensationSeconds = 0;

		const tracks = this.editor.timeline.getTracks();
		const mediaAssets = this.editor.media.getAssets();
		const duration = this.editor.timeline.getTotalDuration();

		if (duration <= 0) return;

		if (audioContext.state === "suspended") {
			await audioContext.resume();
		}

		this.clips = await collectAudioClips({ tracks, mediaAssets });
		if (!this.editor.playback.getIsPlaying()) return;

		this.playbackStartTime = time;
		this.playbackStartContextTime = audioContext.currentTime;

		this.scheduleUpcomingClips();

		if (typeof window !== "undefined") {
			this.scheduleTimer = window.setInterval(() => {
				this.scheduleUpcomingClips();
			}, this.scheduleIntervalMs);
		}
	}

	private scheduleUpcomingClips(): void {
		if (!this.editor.playback.getIsPlaying()) return;

		const currentTime = this.getPlaybackTime();
		const windowEnd = currentTime + this.lookaheadSeconds;

		for (const clip of this.clips) {
			if (clip.muted) continue;
			if (this.activeClipIds.has(clip.id)) continue;

			const clipEnd = clip.startTime + clip.duration;
			if (clipEnd <= currentTime) continue;
			if (clip.startTime > windowEnd) continue;

			this.activeClipIds.add(clip.id);
			void this.runClipIterator({
				clip,
				startTime: currentTime,
				sessionId: this.playbackSessionId,
			});
		}
	}

	private stopPlayback(): void {
		if (this.scheduleTimer && typeof window !== "undefined") {
			window.clearInterval(this.scheduleTimer);
		}
		this.scheduleTimer = null;

		for (const iterator of this.clipIterators.values()) {
			void iterator.return();
		}
		this.clipIterators.clear();
		this.activeClipIds.clear();

		for (const source of this.queuedSources) {
			try {
				source.stop();
			} catch {}
			source.disconnect();
		}
		this.queuedSources.clear();

		for (const gain of this.clipGainNodes.values()) {
			try {
				gain.disconnect();
			} catch {}
		}
		this.clipGainNodes.clear();
	}

	private async runClipIterator({
		clip,
		startTime,
		sessionId,
	}: {
		clip: AudioClipSource;
		startTime: number;
		sessionId: number;
	}): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		// Speed handling: constant speed-changed clips take the pitch-preserving
		// path (offline signalsmith-stretch render, played back at rate 1). If the
		// stretcher is unavailable (WASM load failure, render error, oversized
		// clip), fall through to the raw-rate path below — correct speed, shifted
		// pitch, exactly like the export mixdown's fallback. Rate-1 clips never
		// touch the stretcher.
		const decision = resolveStretchDecision({
			playbackRate: clip.playbackRate,
			hasVariableRate: clip.hasVariableRate,
		});
		if (decision.mode === "stretch") {
			const played = await this.playStretchedClip({
				clip,
				rate: decision.rate,
				sessionId,
				audioContext,
			});
			if (played) return;
		}
		const rate = decision.mode === "bypass" ? 1 : decision.rate;

		const sink = await this.getAudioSink({ clip });
		if (!sink || !this.editor.playback.getIsPlaying()) return;
		if (sessionId !== this.playbackSessionId) return;

		const clipStart = clip.startTime;
		const clipEnd = clip.startTime + clip.duration;
		const playbackTimeAfterSinkReady = this.getPlaybackTime();
		const iteratorStartTime = Math.max(
			startTime,
			clipStart,
			playbackTimeAfterSinkReady,
		);
		if (iteratorStartTime >= clipEnd) {
			return;
		}
		// Timeline ↔ source mapping matches the visual renderer
		// (VisualNode.getSourceLocalTime): source = trimStart + elapsed * rate.
		const sourceStartTime =
			clip.trimStart + (iteratorStartTime - clip.startTime) * rate;

		let iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown>;
		try {
			iterator = sink.buffers(sourceStartTime);
		} catch {
			return; // Sink may have been disposed
		}
		this.clipIterators.set(clip.id, iterator);
		let consecutiveDroppedBufferCount = 0;

		try {
			for await (const { buffer, timestamp } of iterator) {
				if (!this.editor.playback.getIsPlaying()) return;
				if (sessionId !== this.playbackSessionId) return;

				// A source-side chunk at `timestamp` lands on the timeline at
				// clipStart + sourceElapsed / rate (inverse of the mapping above).
				const timelineTime =
					clip.startTime + (timestamp - clip.trimStart) / rate;
				if (timelineTime >= clipEnd) break;

				const node = audioContext.createBufferSource();
				node.buffer = buffer;

				// Raw-rate speed (pitch-shifted): only reached when the clip is
				// speed-changed AND the pitch-preserving path was unavailable, or the
				// speed curve is keyframed (constant-fallback).
				if (rate !== 1) {
					node.playbackRate.value = rate;
				}

				this.connectClipNode({ node, clip, audioContext });

				const startTimestamp =
					this.playbackStartContextTime +
					this.playbackLatencyCompensationSeconds +
					(timelineTime - this.playbackStartTime);

				if (startTimestamp >= audioContext.currentTime) {
					node.start(startTimestamp);
					consecutiveDroppedBufferCount = 0;
				} else {
					const offset = audioContext.currentTime - startTimestamp;
					// `offset` is timeline seconds; the buffer is consumed at `rate`
					// source-seconds per timeline-second.
					const sourceOffset = offset * rate;
					if (sourceOffset < buffer.duration) {
						node.start(audioContext.currentTime, sourceOffset);
						consecutiveDroppedBufferCount = 0;
					} else {
						consecutiveDroppedBufferCount += 1;
						if (consecutiveDroppedBufferCount >= 5) {
							const nextCompensationSeconds = Math.max(
								this.playbackLatencyCompensationSeconds,
								Math.min(0.25, offset + 0.01),
							);
							if (
								nextCompensationSeconds >
								this.playbackLatencyCompensationSeconds + 0.001
							) {
								this.playbackLatencyCompensationSeconds =
									nextCompensationSeconds;
							}
							const resyncStartTime = this.getPlaybackTime();
							this.clipIterators.delete(clip.id);
							void this.runClipIterator({
								clip,
								startTime: resyncStartTime,
								sessionId,
							});
							return;
						}
						continue;
					}
				}

				this.queuedSources.add(node);
				node.addEventListener("ended", () => {
					node.disconnect();
					this.queuedSources.delete(node);
				});

				const aheadTime = timelineTime - this.getPlaybackTime();
				if (aheadTime >= 1) {
					await this.waitUntilCaughtUp({ timelineTime, targetAhead: 1 });
					if (sessionId !== this.playbackSessionId) return;
				}
			}
		} catch {
			// Input may have been disposed (e.g., track deleted during playback)
		}

		this.clipIterators.delete(clip.id);
		// don't remove from activeClipIds - prevents scheduler from restarting this clip
		// the set is cleared on stopPlayback anyway
	}

	/** Shared clip→graph wiring (per-clip volume, track routing, solo/mute). */
	private connectClipNode({
		node,
		clip,
		audioContext,
	}: {
		node: AudioBufferSourceNode;
		clip: AudioClipSource;
		audioContext: AudioContext;
	}): void {
		const destinationNode = this.getTrackDestination(clip.id);

		const animatedGain = this.getOrCreateAnimatedClipGain({
			clip,
			audioContext,
			destinationNode,
		});
		if (animatedGain) {
			node.connect(animatedGain);
			return;
		}

		// Static-volume fast path — unchanged for clips without a volume
		// animation channel.
		const clipVolume = clip.volume ?? 1;
		if (clipVolume < 1) {
			const clipGain = audioContext.createGain();
			clipGain.gain.value = clipVolume;
			node.connect(clipGain);
			clipGain.connect(destinationNode);
		} else {
			node.connect(destinationNode);
		}
	}

	/**
	 * Per-clip GainNode carrying the clip's `volume` keyframe automation, or
	 * `null` when the clip has no volume animation (callers fall back to the
	 * static-volume path). Created + scheduled ONCE per clip per playback
	 * session — cached in `clipGainNodes` — because `connectClipNode` runs once
	 * per streamed buffer chunk (a clip can span many chunks) and re-scheduling
	 * automation on every chunk would repeatedly cut off in-flight ramps.
	 *
	 * The schedule is anchored at `getPlaybackTime()` (the actual clip-relative
	 * "now" of this session, whether that's the clip's own start or a mid-clip
	 * seek/resync) — see `buildVolumeAutomationPlan`.
	 */
	private getOrCreateAnimatedClipGain({
		clip,
		audioContext,
		destinationNode,
	}: {
		clip: AudioClipSource;
		audioContext: AudioContext;
		destinationNode: AudioNode;
	}): GainNode | null {
		const cached = this.clipGainNodes.get(clip.id);
		if (cached) return cached;

		const channel = getNumberChannelForPath({
			animations: clip.animations,
			propertyPath: "volume",
		});
		if (!channel || channel.keyframes.length === 0) return null;

		const gain = audioContext.createGain();
		const nowLocalTime = this.getPlaybackTime() - clip.startTime;
		// contextTime = playbackStartContextTime + latencyComp + (timelineTime - playbackStartTime)
		// timelineTime = clip.startTime + localTime, so this is that formula with
		// the clip.startTime + localTime terms factored out per-call below.
		const contextTimeBase =
			this.playbackStartContextTime +
			this.playbackLatencyCompensationSeconds -
			this.playbackStartTime +
			clip.startTime;

		const plan = buildVolumeAutomationPlan({
			keyframes: channel.keyframes,
			nowLocalTime,
			fallbackValue: clip.volume ?? 1,
			localTimeToContextTime: (localTime) => contextTimeBase + localTime,
		});
		applyVolumeAutomationPlan({ gainParam: gain.gain, plan });

		gain.connect(destinationNode);
		this.clipGainNodes.set(clip.id, gain);
		return gain;
	}

	/**
	 * Pitch-preserving playback of a constant speed-changed clip: play the
	 * offline-stretched, rate-1 render of the clip's slot as a single source
	 * node. Returns false when the stretcher is unavailable so the caller can
	 * fall back to raw-rate (pitch-shifted) streaming; returns true when the
	 * clip is fully handled (scheduled, already over, or playback ended).
	 */
	private async playStretchedClip({
		clip,
		rate,
		sessionId,
		audioContext,
	}: {
		clip: AudioClipSource;
		rate: number;
		sessionId: number;
		audioContext: AudioContext;
	}): Promise<boolean> {
		const buffer = await this.getStretchedBuffer({ clip, rate, audioContext });
		if (!buffer) return false;

		// The render may have taken a while; re-check the session is still live.
		if (!this.editor.playback.getIsPlaying()) return true;
		if (sessionId !== this.playbackSessionId) return true;

		const node = audioContext.createBufferSource();
		node.buffer = buffer;
		this.connectClipNode({ node, clip, audioContext });

		// The stretched buffer IS the clip's timeline slot at rate 1, so it is
		// scheduled exactly like a plain clip starting at clip.startTime.
		const startTimestamp =
			this.playbackStartContextTime +
			this.playbackLatencyCompensationSeconds +
			(clip.startTime - this.playbackStartTime);
		const now = audioContext.currentTime;

		if (startTimestamp >= now) {
			node.start(startTimestamp);
		} else {
			const offset = now - startTimestamp;
			if (offset >= buffer.duration) {
				node.disconnect();
				return true; // Clip already finished on the timeline.
			}
			node.start(now, offset);
		}

		this.queuedSources.add(node);
		node.addEventListener("ended", () => {
			node.disconnect();
			this.queuedSources.delete(node);
		});
		return true;
	}

	/**
	 * Cached pitch-preserved render of a clip's slot. Failures resolve to null;
	 * the cache entry is then dropped so a transient failure (e.g. a sink
	 * disposed by a mid-decode timeline edit) retries on the next playback.
	 */
	private getStretchedBuffer({
		clip,
		rate,
		audioContext,
	}: {
		clip: AudioClipSource;
		rate: number;
		audioContext: AudioContext;
	}): Promise<AudioBuffer | null> {
		const key = `${clip.sourceKey}|${rate}|${clip.trimStart}|${clip.duration}|${audioContext.sampleRate}`;
		const existing = this.stretchedBuffers.get(key);
		if (existing) return existing;

		const pending = this.renderStretchedClip({ clip, rate, audioContext })
			.catch((error) => {
				console.warn(
					"Pitch-preserving stretch failed for clip; falling back to pitch-shifted playback.",
					error,
				);
				return null;
			})
			.then((buffer) => {
				if (buffer === null && this.stretchedBuffers.get(key) === pending) {
					this.stretchedBuffers.delete(key);
				}
				return buffer;
			});

		if (this.stretchedBuffers.size >= MAX_STRETCHED_BUFFER_CACHE) {
			const oldestKey = this.stretchedBuffers.keys().next().value;
			if (oldestKey !== undefined) this.stretchedBuffers.delete(oldestKey);
		}
		this.stretchedBuffers.set(key, pending);
		return pending;
	}

	private async renderStretchedClip({
		clip,
		rate,
		audioContext,
	}: {
		clip: AudioClipSource;
		rate: number;
		audioContext: AudioContext;
	}): Promise<AudioBuffer | null> {
		const segment = await this.decodeSourceSegment({
			clip,
			rate,
			audioContext,
		});
		if (!segment) return null;

		// Same seam the export mixdown uses (resolveMixElement) — identical
		// inputs produce identical stretched audio in preview and export.
		return stretchAudioBufferSegment({
			buffer: segment.buffer,
			playbackRate: rate,
			trimStart: segment.trimStartWithinSegment,
			duration: clip.duration,
			targetSampleRate: audioContext.sampleRate,
		});
	}

	/**
	 * Decode the source span a speed-changed clip covers
	 * ([trimStart, trimStart + duration * rate)) into one contiguous
	 * native-sample-rate AudioBuffer.
	 */
	private async decodeSourceSegment({
		clip,
		rate,
		audioContext,
	}: {
		clip: AudioClipSource;
		rate: number;
		audioContext: AudioContext;
	}): Promise<{ buffer: AudioBuffer; trimStartWithinSegment: number } | null> {
		const sink = await this.getAudioSink({ clip });
		if (!sink) return null;

		const sourceStart = clip.trimStart;
		const sourceEnd = clip.trimStart + clip.duration * rate;

		const chunks: AudioBuffer[] = [];
		let firstTimestamp: number | null = null;
		let totalSamples = 0;
		try {
			for await (const { buffer, timestamp } of sink.buffers(sourceStart)) {
				if (firstTimestamp === null) firstTimestamp = timestamp;
				chunks.push(buffer);
				totalSamples += buffer.length;
				if (timestamp + buffer.duration >= sourceEnd) break;
			}
		} catch {
			return null; // Sink may have been disposed mid-decode.
		}

		if (chunks.length === 0 || firstTimestamp === null || totalSamples === 0) {
			return null;
		}

		const nativeSampleRate = chunks[0].sampleRate;
		const channels = Math.min(2, chunks[0].numberOfChannels);
		const segmentBuffer = audioContext.createBuffer(
			channels,
			totalSamples,
			nativeSampleRate,
		);
		let offset = 0;
		for (const chunk of chunks) {
			for (let channel = 0; channel < channels; channel++) {
				segmentBuffer
					.getChannelData(channel)
					.set(
						chunk.getChannelData(Math.min(channel, chunk.numberOfChannels - 1)),
						offset,
					);
			}
			offset += chunk.length;
		}

		// The first decoded chunk may begin before the requested start; tell the
		// stretcher where the clip's trim actually falls inside this segment.
		return {
			buffer: segmentBuffer,
			trimStartWithinSegment: Math.max(0, sourceStart - firstTimestamp),
		};
	}

	private waitUntilCaughtUp({
		timelineTime,
		targetAhead,
	}: {
		timelineTime: number;
		targetAhead: number;
	}): Promise<void> {
		return new Promise((resolve) => {
			const checkInterval = setInterval(() => {
				if (!this.editor.playback.getIsPlaying()) {
					clearInterval(checkInterval);
					resolve();
					return;
				}

				const playbackTime = this.getPlaybackTime();
				if (timelineTime - playbackTime < targetAhead) {
					clearInterval(checkInterval);
					resolve();
				}
			}, 100);
		});
	}

	private disposeSinks(): void {
		for (const iterator of this.clipIterators.values()) {
			void iterator.return();
		}
		this.clipIterators.clear();
		this.activeClipIds.clear();

		for (const input of this.inputs.values()) {
			input.dispose();
		}
		this.inputs.clear();
		this.sinks.clear();

		for (const [, nodes] of this.trackNodes) {
			try {
				nodes.gain.disconnect();
				nodes.panner.disconnect();
				nodes.analyser.disconnect();
			} catch {}
		}
		this.trackNodes.clear();
	}

	private async getAudioSink({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBufferSink | null> {
		const existingSink = this.sinks.get(clip.sourceKey);
		if (existingSink) return existingSink;

		try {
			const input = new Input({
				source: new BlobSource(clip.file),
				formats: ALL_FORMATS,
			});
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack) {
				input.dispose();
				return null;
			}

			const sink = new AudioBufferSink(audioTrack);
			this.inputs.set(clip.sourceKey, input);
			this.sinks.set(clip.sourceKey, sink);
			return sink;
		} catch (error) {
			console.warn("Failed to initialize audio sink:", error);
			return null;
		}
	}
}
