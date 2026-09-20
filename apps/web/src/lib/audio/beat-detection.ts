/**
 * Local, deterministic beat-grid detection — energy-onset + inter-onset-
 * interval tempo estimation. No model, no network.
 *
 * DEVIATION NOTE: the existing beat-grid UI toggle
 * (`hooks/timeline/use-audio-tools.ts`'s `useBeatAnalysis`) calls
 * `aiClient.analyzeBeats`, which round-trips to the Python AI backend
 * (`services/ai-backend/app/routes/engagement.py`). That is real DSP, but it
 * is a NETWORK call, which conflicts with this task's hard constraint that
 * every derivation here be free/local/no-network. Rather than persisting a
 * network-dependent result at ingest (which would mean every asset import
 * silently bills/blocks on the Python backend being up), this module is a
 * genuinely new, from-scratch local implementation. It is intentionally
 * simple — energy-based onset picking + inter-onset-interval histogram
 * tempo estimation, the same family of technique auto-editor-style
 * open-source beat trackers use — and works best on percussive/rhythmic
 * material with clear transients (music with drums, a metronome/click
 * track). It will be materially less accurate than a spectral-flux or
 * ML tempo tracker on sustained pads, ambient music, or dialogue. See
 * beat-detection.test.ts for measured accuracy on synthetic click tracks.
 *
 * Output shape mirrors `stores/beat-grid-store.ts`'s `BeatGrid` fields
 * (`beats`, `downbeats`, `bpm`, `energyClass`) so callers can adopt either
 * source interchangeably.
 */

export interface OnsetEnvelope {
	/** Hop-center timestamps, seconds. */
	times: number[];
	/** Per-hop RMS energy, arbitrary units (not normalized). */
	energy: number[];
}

export interface BeatDetectionResult {
	bpm: number | null;
	/** Fraction of onsets consistent with `bpm`, in [0, 1]. 0 when bpm is null. */
	confidence: number;
	/** Detected onset ("beat") timestamps, seconds, ascending. */
	beats: number[];
	/** Subset of `beats` flagged as downbeats (every 4th, from the first beat — a time-signature-agnostic 4/4 assumption). */
	downbeats: number[];
	energyClass: "high" | "medium" | "low" | null;
}

export interface BeatDetectionOptions {
	/** Onset-envelope hop size, seconds. Default 0.02 (20ms). */
	hopSec?: number;
	/** Local-mean window for adaptive thresholding, in hops. Default 43 (~0.86s at 20ms hops). */
	adaptiveWindowHops?: number;
	/** Minimum seconds between two picked onsets (avoids double-triggering one transient). Default 0.1. */
	minOnsetGapSec?: number;
	/** Tempo search range, BPM. Default [60, 180]. */
	bpmRange?: [number, number];
}

const DEFAULTS: Required<BeatDetectionOptions> = {
	hopSec: 0.02,
	adaptiveWindowHops: 43,
	minOnsetGapSec: 0.1,
	bpmRange: [60, 180],
};

/** Per-hop RMS energy envelope. */
export function computeOnsetEnvelope(
	samples: Float32Array,
	sampleRate: number,
	hopSec: number,
): OnsetEnvelope {
	const hopSize = Math.max(1, Math.round(sampleRate * hopSec));
	const times: number[] = [];
	const energy: number[] = [];

	for (let i = 0; i < samples.length; i += hopSize) {
		const end = Math.min(i + hopSize, samples.length);
		let sum = 0;
		for (let j = i; j < end; j++) sum += samples[j] * samples[j];
		energy.push(Math.sqrt(sum / (end - i)));
		times.push((i + (end - i) / 2) / sampleRate);
	}

	return { times, energy };
}

/**
 * Pick local energy peaks that exceed their own local mean (adaptive
 * threshold, so the picker adapts to a track's overall loudness rather than
 * a fixed absolute cutoff), enforcing a minimum gap between picks.
 */
export function pickOnsets(
	envelope: OnsetEnvelope,
	options?: Pick<BeatDetectionOptions, "adaptiveWindowHops" | "minOnsetGapSec">,
): number[] {
	const adaptiveWindowHops =
		options?.adaptiveWindowHops ?? DEFAULTS.adaptiveWindowHops;
	const minOnsetGapSec = options?.minOnsetGapSec ?? DEFAULTS.minOnsetGapSec;
	const { times, energy } = envelope;
	if (energy.length < 3) return [];

	const onsets: number[] = [];
	let lastOnsetTime = -Infinity;

	for (let i = 1; i < energy.length - 1; i++) {
		// Local maximum.
		if (energy[i] < energy[i - 1] || energy[i] < energy[i + 1]) continue;

		const windowStart = Math.max(0, i - adaptiveWindowHops);
		let localSum = 0;
		for (let j = windowStart; j < i; j++) localSum += energy[j];
		const localMean = i > windowStart ? localSum / (i - windowStart) : 0;

		// Novelty: how far this peak stands above its recent local mean, scaled
		// so quiet passages need a smaller absolute jump than loud ones.
		const threshold = localMean * 1.5 + 1e-6;
		if (energy[i] <= threshold) continue;

		if (times[i] - lastOnsetTime < minOnsetGapSec) continue;
		onsets.push(times[i]);
		lastOnsetTime = times[i];
	}

	return onsets;
}

/**
 * Fold an inter-onset interval into the target BPM range by repeated
 * doubling/halving (an interval that implies 60 BPM also implies 120, 240,
 * etc. — octave ambiguity every tempo tracker has to resolve somehow).
 */
function foldToRange(bpm: number, range: [number, number]): number {
	let value = bpm;
	while (value < range[0]) value *= 2;
	while (value > range[1]) value /= 2;
	return value;
}

/** Histogram-mode tempo estimate from onset timestamps. */
export function estimateBpm(
	onsets: number[],
	bpmRange: [number, number] = DEFAULTS.bpmRange,
): { bpm: number | null; confidence: number } {
	if (onsets.length < 2) return { bpm: null, confidence: 0 };

	const folded: number[] = [];
	for (let i = 1; i < onsets.length; i++) {
		const ioi = onsets[i] - onsets[i - 1];
		if (ioi <= 0) continue;
		folded.push(foldToRange(60 / ioi, bpmRange));
	}
	if (folded.length === 0) return { bpm: null, confidence: 0 };

	// 1-BPM-wide histogram bins across the search range.
	const binCount = Math.ceil(bpmRange[1] - bpmRange[0]) + 1;
	const bins = new Array(binCount).fill(0);
	for (const bpm of folded) {
		const bin = Math.round(bpm - bpmRange[0]);
		bins[Math.max(0, Math.min(binCount - 1, bin))]++;
	}

	let bestBin = 0;
	for (let i = 1; i < bins.length; i++)
		if (bins[i] > bins[bestBin]) bestBin = i;

	return {
		bpm: bpmRange[0] + bestBin,
		confidence: bins[bestBin] / folded.length,
	};
}

function classifyEnergy(
	envelope: OnsetEnvelope,
	onsetCount: number,
	durationSec: number,
): BeatDetectionResult["energyClass"] {
	if (durationSec <= 0) return null;
	const onsetsPerSec = onsetCount / durationSec;
	if (onsetsPerSec >= 2) return "high";
	if (onsetsPerSec >= 0.5) return "medium";
	return "low";
}

/** Full pipeline: envelope → onsets → tempo → beat grid. */
export function detectBeatGrid(
	samples: Float32Array,
	sampleRate: number,
	options?: BeatDetectionOptions,
): BeatDetectionResult {
	const opts = { ...DEFAULTS, ...options };
	const envelope = computeOnsetEnvelope(samples, sampleRate, opts.hopSec);
	const onsets = pickOnsets(envelope, opts);
	const { bpm, confidence } = estimateBpm(onsets, opts.bpmRange);
	const durationSec = samples.length / sampleRate;

	return {
		bpm,
		confidence,
		beats: onsets,
		downbeats: onsets.filter((_, i) => i % 4 === 0),
		energyClass: classifyEnergy(envelope, onsets.length, durationSec),
	};
}
