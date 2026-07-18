import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

interface AudioWaveformProps {
	audioUrl?: string;
	audioBuffer?: AudioBuffer;
	/**
	 * Offset in seconds into the underlying source where this clip's visible
	 * content begins — mirrors `BaseTimelineElement.trimStart`. Splitting or
	 * trim-dragging a clip changes this without touching the source buffer/
	 * file, so the waveform must re-window against it or it keeps showing the
	 * pre-split/pre-trim range (BUG170). Defaults to 0 (start of the source).
	 */
	trimStart?: number;
	/**
	 * The clip's current timeline duration in seconds — mirrors
	 * `BaseTimelineElement.duration`. Combined with `trimStart` and
	 * `playbackRate` this bounds the window of source audio the waveform
	 * should reflect, matching the convention `mixAudioChannels` uses in
	 * lib/media/audio.ts (source window = [trimStart, trimStart + duration *
	 * playbackRate)). Omit to render the whole source (legacy behavior).
	 */
	duration?: number;
	/**
	 * Constant playback-speed multiplier (default 1). A 2x clip reads twice as
	 * much source per timeline second, so the source-side window widens
	 * accordingly.
	 */
	playbackRate?: number;
	height?: number;
	className?: string;
}

function extractPeaks({
	buffer,
	length = 512,
	windowStart = 0,
	windowDuration,
}: {
	buffer: AudioBuffer;
	length?: number;
	/** Offset in seconds into `buffer` where the visible window begins. */
	windowStart?: number;
	/** Seconds of `buffer` to sample starting at `windowStart`. Omit to use
	 * the remainder of the buffer (whole-buffer behavior). */
	windowDuration?: number;
}): number[][] {
	const channels = buffer.numberOfChannels;
	const peaks: number[][] = [];

	const totalSamples = buffer.length;
	const startSample = Math.min(
		Math.max(0, Math.round(windowStart * buffer.sampleRate)),
		totalSamples,
	);
	const requestedSamples =
		windowDuration != null
			? Math.round(windowDuration * buffer.sampleRate)
			: totalSamples - startSample;
	const endSample = Math.min(
		startSample + Math.max(0, requestedSamples),
		totalSamples,
	);
	const windowSamples = Math.max(0, endSample - startSample);

	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		// Guard against windows shorter than `length` samples: Math.floor would
		// yield step=0, collapsing every bucket to an empty range (flat waveform).
		const step = Math.max(1, Math.floor(windowSamples / length));
		const channelPeaks: number[] = [];

		for (let i = 0; i < length; i++) {
			const start = startSample + i * step;
			const end = Math.min(start + step, endSample);
			let max = 0;
			for (let j = start; j < end; j++) {
				const abs = Math.abs(data[j]);
				if (abs > max) max = abs;
			}
			channelPeaks.push(max);
		}
		peaks.push(channelPeaks);
	}

	return peaks;
}

/**
 * Fetches and decodes an audio URL into a full `AudioBuffer` so its peaks can
 * be windowed the same way as an in-memory `AudioBuffer` (see `extractPeaks`).
 * Mirrors the fetch+decodeAudioData pattern already used elsewhere (e.g.
 * sounds-store.ts) rather than pulling in the heavier export-mixdown decode
 * helpers from lib/media/audio.ts into this hot-path timeline component.
 */
async function decodeAudioBuffer(url: string): Promise<AudioBuffer> {
	const AudioContextCtor =
		window.AudioContext ||
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;
	const audioContext = new AudioContextCtor();
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch audio: ${response.statusText}`);
		}
		const arrayBuffer = await response.arrayBuffer();
		return await audioContext.decodeAudioData(arrayBuffer);
	} finally {
		try {
			await audioContext.close();
		} catch {}
	}
}

export function AudioWaveform({
	audioUrl,
	audioBuffer,
	trimStart = 0,
	duration,
	playbackRate = 1,
	height = 32,
	className = "",
}: AudioWaveformProps) {
	const waveformRef = useRef<HTMLDivElement>(null);
	const wavesurfer = useRef<WaveSurfer | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState(false);

	useEffect(() => {
		let mounted = true;
		const ws = wavesurfer.current;

		// The source window this clip's waveform should reflect: `duration`
		// seconds of timeline time consume `duration * playbackRate` seconds of
		// source starting at `trimStart` — same convention as mixAudioChannels
		// in lib/media/audio.ts. Omitted `duration` ⇒ whole-source (legacy).
		const windowDuration =
			duration != null ? duration * (playbackRate || 1) : undefined;
		const needsWindowing = trimStart > 0 || windowDuration != null;

		const initWaveSurfer = async () => {
			if (!waveformRef.current || (!audioUrl && !audioBuffer)) return;

			try {
				if (ws) {
					wavesurfer.current = null;
				}

				const newWaveSurfer = WaveSurfer.create({
					container: waveformRef.current,
					waveColor: "rgba(255, 255, 255, 0.6)",
					progressColor: "rgba(255, 255, 255, 0.9)",
					cursorColor: "transparent",
					barWidth: 2,
					barGap: 1,
					height,
					normalize: true,
					interact: false,
				});

				if (mounted) {
					wavesurfer.current = newWaveSurfer;
				} else {
					try {
						newWaveSurfer.destroy();
					} catch {}
					return;
				}

				newWaveSurfer.on("ready", () => {
					if (mounted) {
						setIsLoading(false);
						setError(false);
					}
				});

				newWaveSurfer.on("error", (err) => {
					if (mounted) {
						console.error("WaveSurfer error:", err);
						setError(true);
						setIsLoading(false);
					}
				});

				if (audioBuffer) {
					const peaks = extractPeaks({
						buffer: audioBuffer,
						windowStart: trimStart,
						windowDuration,
					});
					newWaveSurfer.load("", peaks, duration ?? audioBuffer.duration);
				} else if (audioUrl) {
					if (needsWindowing) {
						const decoded = await decodeAudioBuffer(audioUrl);
						if (!mounted) return;
						const peaks = extractPeaks({
							buffer: decoded,
							windowStart: trimStart,
							windowDuration,
						});
						await newWaveSurfer.load(
							"",
							peaks,
							duration ?? windowDuration ?? decoded.duration,
						);
					} else {
						await newWaveSurfer.load(audioUrl);
					}
				}
			} catch (err) {
				if (mounted) {
					console.error("Failed to initialize WaveSurfer:", err);
					setError(true);
					setIsLoading(false);
				}
			}
		};

		if (ws) {
			const wsToDestroy = ws;
			wavesurfer.current = null;

			requestAnimationFrame(() => {
				try {
					wsToDestroy.destroy();
				} catch {}
				if (mounted) {
					initWaveSurfer();
				}
			});
		} else {
			initWaveSurfer();
		}

		return () => {
			mounted = false;

			const wsToDestroy = wavesurfer.current;

			wavesurfer.current = null;

			if (wsToDestroy) {
				requestAnimationFrame(() => {
					try {
						wsToDestroy.destroy();
					} catch {}
				});
			}
		};
	}, [audioUrl, audioBuffer, height, trimStart, duration, playbackRate]);

	if (error) {
		return (
			<div
				className={`flex items-center justify-center ${className}`}
				style={{ height }}
			>
				<span className="text-foreground/60 text-xs">Audio unavailable</span>
			</div>
		);
	}

	return (
		<div className={`relative ${className}`}>
			{isLoading && (
				<div className="absolute inset-0 flex items-center justify-center">
					<span className="text-foreground/60 text-xs">Loading...</span>
				</div>
			)}
			<div
				ref={waveformRef}
				className={`w-full ${isLoading ? "opacity-0" : "opacity-100"}`}
				style={{ height }}
			/>
		</div>
	);
}

export default AudioWaveform;
