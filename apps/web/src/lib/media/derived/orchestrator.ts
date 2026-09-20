/**
 * Ingest-time derivation orchestrator — runs every kind this module owns
 * (silence, loudness, beats, shots — plus the motion-energy/head-tail
 * bonuses that ride along with shots) for one media asset, updates
 * `DerivedStatus` as it goes, and persists results.
 *
 * Audio kinds (silence/loudness/beats) share ONE decode of the file via
 * `decodeToMono16k` — the same efficiency principle as task A's "one
 * frame-sampling pass" applied to the audio side, so a long file's audio
 * track is never decoded three times for three analyses.
 *
 * This module deliberately does NOT decide *when* to run — see
 * `use-derived-media-indexer.ts` for the ingest trigger. Kept separate so
 * `runDerivedAnalysis` stays a plain, testable "asset in → status out"
 * function.
 */

import type { MediaAsset } from "@/types/assets";
import { decodeToMono16k, DECODE_SAMPLE_RATE } from "@/lib/media/decode-audio";
import { detectSilenceSegments } from "@/lib/auto-cut/engine";
import { computeLUFS, isEffectivelySilent } from "@/lib/audio/loudness";
import { detectBeatGrid } from "@/lib/audio/beat-detection";
import { analyzeVisualDerivations } from "./visual-analysis";
import {
	createInitialDerived,
	empty,
	failed,
	queued,
	ready,
	running,
	withStatus,
	type AssetDerived,
	type DerivedKind,
} from "./derived-status";
import {
	getDerivedStatus,
	saveBeatAnalysis,
	saveDerivedStatus,
	saveLoudnessAnalysis,
	saveSilenceAnalysis,
	saveVisualAnalysis,
} from "./derived-store";

const ENGINE = "on-device";
const HAS_AUDIO_TYPES = new Set<MediaAsset["type"]>(["audio", "video"]);
const HAS_VISUAL_TYPES = new Set<MediaAsset["type"]>(["video"]);

/** A kind already in one of these states is a finished result — skip unless `force`. */
const SETTLED_STATES = new Set(["ready", "empty"]);

export interface RunDerivedAnalysisOptions {
	/** Re-run kinds that already have a settled ("ready"/"empty") result. Default false. */
	force?: boolean;
}

async function loadOrCreateDerived(asset: MediaAsset): Promise<AssetDerived> {
	const stored = await getDerivedStatus(asset.id).catch(() => undefined);
	return stored?.derived ?? createInitialDerived(asset.type);
}

async function persist(
	mediaId: string,
	derived: AssetDerived,
): Promise<AssetDerived> {
	await saveDerivedStatus({ mediaId, derived }).catch(() => undefined);
	return derived;
}

function shouldRun(
	derived: AssetDerived,
	kind: DerivedKind,
	force: boolean,
): boolean {
	const state = derived[kind].state;
	if (state === "unsupported") return false;
	if (!force && SETTLED_STATES.has(state)) return false;
	return true;
}

/**
 * Run the audio-side analyses (silence, loudness, beats) sharing one decode.
 * Mutates and returns `derived` in place across the three kinds so a single
 * decode failure marks all three `failed` together rather than repeating the
 * decode attempt per kind.
 */
async function runAudioAnalyses(
	asset: MediaAsset,
	derived: AssetDerived,
	force: boolean,
): Promise<AssetDerived> {
	const kinds: DerivedKind[] = ["silence", "loudness", "beats"];
	const runnable = kinds.filter((k) => shouldRun(derived, k, force));
	if (runnable.length === 0) return derived;
	if (!asset.file) {
		for (const k of runnable)
			derived = withStatus(derived, k, failed("no source file for this asset"));
		return derived;
	}

	for (const k of runnable) derived = withStatus(derived, k, queued(ENGINE));
	for (const k of runnable)
		derived = withStatus(derived, k, running(0, ENGINE));

	let samples: Float32Array;
	try {
		samples = await decodeToMono16k(asset.file);
	} catch {
		const reason = "couldn't read the audio in this clip";
		for (const k of runnable)
			derived = withStatus(derived, k, failed(reason, ENGINE));
		return derived;
	}

	if (runnable.includes("silence")) {
		try {
			const analysis = detectSilenceSegments(samples, DECODE_SAMPLE_RATE);
			await saveSilenceAnalysis({
				mediaId: asset.id,
				segments: analysis.segments,
				timebase: analysis.timebase,
				duration: analysis.duration,
				analyzedAt: Date.now(),
			});
			derived = withStatus(derived, "silence", ready(ENGINE));
		} catch {
			derived = withStatus(
				derived,
				"silence",
				failed("couldn't analyze silence in this clip", ENGINE),
			);
		}
	}

	let measurement: ReturnType<typeof computeLUFS> | null = null;
	if (runnable.includes("loudness")) {
		try {
			measurement = computeLUFS(samples, DECODE_SAMPLE_RATE);
			await saveLoudnessAnalysis({
				mediaId: asset.id,
				measurement,
				analyzedAt: Date.now(),
			});
			derived = withStatus(
				derived,
				"loudness",
				isEffectivelySilent(measurement)
					? empty("this clip has no audible sound", ENGINE)
					: ready(ENGINE),
			);
		} catch {
			derived = withStatus(
				derived,
				"loudness",
				failed("couldn't measure loudness in this clip", ENGINE),
			);
		}
	}

	if (runnable.includes("beats")) {
		try {
			// Cheap pre-check: reuse the loudness measurement when we just computed
			// it — a silent track has no beats to find, and running the onset
			// detector over pure silence is wasted work.
			const silent = measurement ? isEffectivelySilent(measurement) : false;
			const result = silent
				? {
						bpm: null,
						confidence: 0,
						beats: [] as number[],
						downbeats: [] as number[],
						energyClass: null,
					}
				: detectBeatGrid(samples, DECODE_SAMPLE_RATE);
			await saveBeatAnalysis({
				mediaId: asset.id,
				bpm: result.bpm,
				confidence: result.confidence,
				beats: result.beats,
				downbeats: result.downbeats,
				energyClass: result.energyClass,
				analyzedAt: Date.now(),
			});
			derived = withStatus(
				derived,
				"beats",
				result.bpm === null
					? empty("no rhythmic beat found in this clip", ENGINE)
					: ready(ENGINE),
			);
		} catch {
			derived = withStatus(
				derived,
				"beats",
				failed("couldn't analyze beats in this clip", ENGINE),
			);
		}
	}

	return derived;
}

async function runVisualAnalysis(
	asset: MediaAsset,
	derived: AssetDerived,
	force: boolean,
): Promise<AssetDerived> {
	if (!shouldRun(derived, "shots", force)) return derived;
	if (!asset.url) {
		return withStatus(
			derived,
			"shots",
			failed("no source to analyze for this asset"),
		);
	}

	derived = withStatus(derived, "shots", queued(ENGINE));
	derived = withStatus(derived, "shots", running(0, ENGINE));

	try {
		const result = await analyzeVisualDerivations(asset.url);
		await saveVisualAnalysis({
			mediaId: asset.id,
			shots: result.shots,
			motionEnergy: result.motionEnergy,
			headTail: result.headTail,
			sampleCount: result.sampleCount,
			analyzedAt: Date.now(),
		});
		derived = withStatus(
			derived,
			"shots",
			result.sampleCount === 0
				? empty("couldn't read any frames from this clip", ENGINE)
				: ready(ENGINE),
		);
	} catch {
		derived = withStatus(
			derived,
			"shots",
			failed("couldn't analyze this clip's picture", ENGINE),
		);
	}

	return derived;
}

/**
 * Run every owned derivation this asset supports and persist the result.
 * Safe to call repeatedly — kinds already `ready`/`empty` are skipped unless
 * `options.force`. Never throws: a failure in one kind is recorded as that
 * kind's `failed` status, and the rest still run.
 */
export async function runDerivedAnalysis(
	asset: MediaAsset,
	options?: RunDerivedAnalysisOptions,
): Promise<AssetDerived> {
	const force = options?.force ?? false;
	let derived = await loadOrCreateDerived(asset);

	if (HAS_AUDIO_TYPES.has(asset.type)) {
		derived = await runAudioAnalyses(asset, derived, force);
	}
	if (HAS_VISUAL_TYPES.has(asset.type)) {
		derived = await runVisualAnalysis(asset, derived, force);
	}

	// Always persist, even for an asset (e.g. an image) with nothing to run —
	// otherwise `getDerivedStatus` would return `undefined` for an asset this
	// function HAS looked at, indistinguishable from one it never saw.
	derived = await persist(asset.id, derived);

	return derived;
}
