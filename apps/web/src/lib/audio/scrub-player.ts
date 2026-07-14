/**
 * Tape-scrub grain player: audible feedback while the playhead is being
 * dragged (or single-frame-stepped), independent of normal timeline
 * playback. See apps/web/docs/poach/palmier-delta-refresh-2026-07-14.md
 * §4.2 for the mechanism this reimplements clean-room (idea-only source,
 * GPL-3.0 original never consulted — see scrub-grain-math.ts for the
 * numeric parameters this class plays back).
 *
 * Lifecycle: `beginDrag` decodes a ~2s PCM window around the topmost
 * audible clip at the drag-start time; `tick` plays one ~50ms grain per
 * drag tick (re-centering the window in the background as the playhead
 * exits it); `endDrag` stops any in-flight grains. `stepFrame` is the
 * single-shot path for arrow-key frame stepping.
 *
 * Deliberately off the React render path: nothing here touches store state
 * or triggers a re-render. It owns its own AudioContext and reads timeline/
 * media state imperatively through the EditorCore accessors passed in.
 */

import type { EditorCore } from "@/core";
import {
	type AudioClipSource,
	collectAudioClips,
	createAudioContext,
} from "@/lib/media/audio";
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import {
	GRAIN_DURATION_SECONDS,
	GRAIN_FADE_SECONDS,
	SCRUB_WINDOW_DURATION_SECONDS,
	type ScrubDirection,
	computeGrainSampleRange,
	isOutsideWindow,
	sourceTimeForTimelineTime,
} from "@/lib/audio/scrub-grain-math";

interface DecodedWindow {
	clip: AudioClipSource;
	buffer: AudioBuffer;
	/** Source-file seconds that `buffer` sample 0 corresponds to. */
	windowSourceStart: number;
}

/** Max cached mediabunny sinks (one per distinct source file touched during
 * a session) — small, since scrubbing usually stays on one or two clips. */
const MAX_SINK_CACHE = 8;

export class ScrubPlayer {
	private audioContext: AudioContext | null = null;
	private sinkCache = new Map<
		string,
		{ input: Input; sink: AudioBufferSink }
	>();
	private currentWindow: DecodedWindow | null = null;
	private decodeGeneration = 0;
	private activeGrainNodes = new Set<AudioBufferSourceNode>();

	// Verification-only instrumentation (browser-verify reads these; no
	// production UI depends on them). See BUILD SPEC item (a)/(b).
	private _grainStartCount = 0;
	private _lastDirection: ScrubDirection | null = null;

	constructor(private editor: EditorCore) {}

	get grainStartCount(): number {
		return this._grainStartCount;
	}

	get lastDirection(): ScrubDirection | null {
		return this._lastDirection;
	}

	get hasWindow(): boolean {
		return this.currentWindow !== null;
	}

	private ensureContext(): AudioContext | null {
		if (typeof window === "undefined") return null;
		if (!this.audioContext) {
			this.audioContext = createAudioContext();
		}
		if (this.audioContext.state === "suspended") {
			void this.audioContext.resume();
		}
		return this.audioContext;
	}

	/**
	 * Start (or restart) a scrub session at `time`: resolve the topmost
	 * non-muted audio-capable clip covering it and decode a fresh ~2s window.
	 * No-op (silent) when nothing audible is under the playhead.
	 */
	async beginDrag(time: number): Promise<void> {
		const generation = ++this.decodeGeneration;
		const clip = await this.resolveTopClipAt(time);
		if (!clip) {
			if (generation === this.decodeGeneration) this.currentWindow = null;
			return;
		}

		const sourceTime = sourceTimeForTimelineTime({
			time,
			clipStartTime: clip.startTime,
			trimStart: clip.trimStart,
			playbackRate: clip.playbackRate,
		});
		const decoded = await this.decodeWindow({ clip, sourceTime });
		if (generation !== this.decodeGeneration) return; // superseded by a newer drag/tick
		this.currentWindow = decoded;
	}

	/**
	 * One drag tick: play a grain from the current window if the playhead is
	 * still over the same clip, and kick off a background re-decode when the
	 * playhead has drifted outside the decoded window or off the clip
	 * entirely. Synchronous and cheap — safe to call at drag-move frequency.
	 */
	tick({ time, direction }: { time: number; direction: ScrubDirection }): void {
		const win = this.currentWindow;
		if (!win) return; // still decoding, or nothing audible here — silent no-op

		const stillOnClip =
			time >= win.clip.startTime &&
			time < win.clip.startTime + win.clip.duration;

		if (!stillOnClip) {
			void this.beginDrag(time);
			return;
		}

		const sourceTime = sourceTimeForTimelineTime({
			time,
			clipStartTime: win.clip.startTime,
			trimStart: win.clip.trimStart,
			playbackRate: win.clip.playbackRate,
		});
		if (
			isOutsideWindow({
				time: sourceTime,
				windowStart: win.windowSourceStart,
				windowDuration: win.buffer.duration,
			})
		) {
			// Keep playing from the stale window this tick; re-center in the background.
			void this.beginDrag(time);
		}

		this.playGrain({ sourceTime, direction, win });
	}

	/** Single-frame arrow-key step: resolve a window if needed, then play one grain. */
	async stepFrame({
		time,
		direction,
	}: {
		time: number;
		direction: ScrubDirection;
	}): Promise<void> {
		const win = this.currentWindow;
		const needsWindow =
			!win ||
			time < win.clip.startTime ||
			time >= win.clip.startTime + win.clip.duration;

		if (needsWindow) {
			await this.beginDrag(time);
		}
		const resolved = this.currentWindow;
		if (!resolved) return;

		const sourceTime = sourceTimeForTimelineTime({
			time,
			clipStartTime: resolved.clip.startTime,
			trimStart: resolved.clip.trimStart,
			playbackRate: resolved.clip.playbackRate,
		});
		this.playGrain({ sourceTime, direction, win: resolved });
	}

	/** Stop any in-flight grains. The decoded window is kept around — the
	 * next drag typically resumes near where the last one ended. */
	endDrag(): void {
		this.decodeGeneration++; // invalidate any in-flight decode
		for (const node of this.activeGrainNodes) {
			try {
				node.stop();
			} catch {
				// already stopped
			}
			node.disconnect();
		}
		this.activeGrainNodes.clear();
	}

	dispose(): void {
		this.endDrag();
		for (const { input } of this.sinkCache.values()) {
			input.dispose();
		}
		this.sinkCache.clear();
		this.currentWindow = null;
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
		}
	}

	/** Topmost (first in track order — index 0 renders on top in the
	 * timeline panel, see components/editor/panels/timeline/index.tsx)
	 * non-muted clip whose slot covers `time`, with audio to decode. */
	private async resolveTopClipAt(
		time: number,
	): Promise<AudioClipSource | null> {
		const tracks = this.editor.timeline.getTracks();
		const mediaAssets = this.editor.media.getAssets();
		const clips = await collectAudioClips({ tracks, mediaAssets });

		const trackOrder = new Map<string, number>();
		tracks.forEach((track, index) => trackOrder.set(track.id, index));
		const orderOf = (clip: AudioClipSource): number => {
			const track = tracks.find((t) =>
				t.elements.some((el) => el.id === clip.id),
			);
			return track
				? (trackOrder.get(track.id) ?? tracks.length)
				: tracks.length;
		};

		const covering = clips
			.filter((clip) => !clip.muted)
			.filter(
				(clip) =>
					time >= clip.startTime && time < clip.startTime + clip.duration,
			)
			.sort((a, b) => orderOf(a) - orderOf(b));

		return covering[0] ?? null;
	}

	private async getSink(
		clip: AudioClipSource,
	): Promise<AudioBufferSink | null> {
		const existing = this.sinkCache.get(clip.sourceKey);
		if (existing) return existing.sink;

		try {
			const input = new Input({
				source: new BlobSource(clip.file),
				formats: ALL_FORMATS,
			});
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack) {
				input.dispose();
				return null; // clip has no audio stream — caller no-ops
			}

			const sink = new AudioBufferSink(audioTrack);
			if (this.sinkCache.size >= MAX_SINK_CACHE) {
				const oldestKey = this.sinkCache.keys().next().value;
				if (oldestKey !== undefined) {
					this.sinkCache.get(oldestKey)?.input.dispose();
					this.sinkCache.delete(oldestKey);
				}
			}
			this.sinkCache.set(clip.sourceKey, { input, sink });
			return sink;
		} catch (error) {
			console.warn("Scrub player: failed to open audio sink:", error);
			return null;
		}
	}

	private async decodeWindow({
		clip,
		sourceTime,
	}: {
		clip: AudioClipSource;
		sourceTime: number;
	}): Promise<DecodedWindow | null> {
		const ctx = this.ensureContext();
		if (!ctx) return null;

		const sink = await this.getSink(clip);
		if (!sink) return null;

		const clipSourceEnd =
			clip.trimStart +
			clip.duration * (clip.playbackRate > 0 ? clip.playbackRate : 1);
		const half = SCRUB_WINDOW_DURATION_SECONDS / 2;
		const windowStart = Math.max(clip.trimStart, sourceTime - half);
		const windowEnd = Math.min(clipSourceEnd, sourceTime + half);

		const chunks: AudioBuffer[] = [];
		let firstTimestamp: number | null = null;
		let totalSamples = 0;
		try {
			for await (const { buffer, timestamp } of sink.buffers(windowStart)) {
				if (firstTimestamp === null) firstTimestamp = timestamp;
				chunks.push(buffer);
				totalSamples += buffer.length;
				if (timestamp + buffer.duration >= windowEnd) break;
			}
		} catch {
			return null; // sink disposed mid-decode (e.g. clip removed while dragging)
		}

		if (chunks.length === 0 || firstTimestamp === null || totalSamples === 0) {
			return null;
		}

		const sampleRate = chunks[0].sampleRate;
		const channels = Math.min(2, chunks[0].numberOfChannels);
		const windowBuffer = ctx.createBuffer(channels, totalSamples, sampleRate);
		let offset = 0;
		for (const chunk of chunks) {
			for (let channel = 0; channel < channels; channel++) {
				windowBuffer
					.getChannelData(channel)
					.set(
						chunk.getChannelData(Math.min(channel, chunk.numberOfChannels - 1)),
						offset,
					);
			}
			offset += chunk.length;
		}

		return { clip, buffer: windowBuffer, windowSourceStart: firstTimestamp };
	}

	private playGrain({
		sourceTime,
		direction,
		win,
	}: {
		sourceTime: number;
		direction: ScrubDirection;
		win: DecodedWindow;
	}): void {
		const ctx = this.ensureContext();
		if (!ctx) return;

		const centerSample = Math.round(
			(sourceTime - win.windowSourceStart) * win.buffer.sampleRate,
		);
		const grainSamples = Math.round(
			GRAIN_DURATION_SECONDS * win.buffer.sampleRate,
		);
		const range = computeGrainSampleRange({
			centerSample,
			grainSamples,
			bufferLength: win.buffer.length,
			direction,
		});
		if (!range) return;

		const channels = win.buffer.numberOfChannels;
		const grainBuffer = ctx.createBuffer(
			channels,
			range.length,
			win.buffer.sampleRate,
		);
		for (let channel = 0; channel < channels; channel++) {
			const src = win.buffer.getChannelData(channel);
			const dst = grainBuffer.getChannelData(channel);
			if (range.reversed) {
				for (let i = 0; i < range.length; i++) {
					dst[i] = src[range.startSample + (range.length - 1 - i)];
				}
			} else {
				for (let i = 0; i < range.length; i++) {
					dst[i] = src[range.startSample + i];
				}
			}
		}

		const clipVolume = win.clip.volume ?? 1;
		const grainDurationSeconds = range.length / win.buffer.sampleRate;
		const fade = Math.min(GRAIN_FADE_SECONDS, grainDurationSeconds / 2);

		const node = ctx.createBufferSource();
		node.buffer = grainBuffer;
		const gain = ctx.createGain();
		const now = ctx.currentTime;
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(clipVolume, now + fade);
		gain.gain.setValueAtTime(clipVolume, now + grainDurationSeconds - fade);
		gain.gain.linearRampToValueAtTime(0, now + grainDurationSeconds);

		node.connect(gain);
		gain.connect(ctx.destination);
		node.start(now);
		node.stop(now + grainDurationSeconds + 0.01);

		this.activeGrainNodes.add(node);
		node.addEventListener("ended", () => {
			node.disconnect();
			gain.disconnect();
			this.activeGrainNodes.delete(node);
		});

		this._grainStartCount += 1;
		this._lastDirection = direction;
	}
}
