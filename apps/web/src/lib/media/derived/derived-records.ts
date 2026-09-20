/**
 * Persisted analysis payloads — the actual per-asset results task B asks us
 * to stop recomputing from scratch every time. Each record is intentionally
 * NOT the full in-memory analysis shape: e.g. `AutoCutAnalysis.loudness` (a
 * per-chunk Float32Array at the analysis timebase, ~30/sec) is dropped in
 * favor of just the derived `segments` — storing the full curve for an
 * hour-long file would be ~100k floats (~400 KB) for data nobody reads back;
 * the segments ARE the decision that curve produced.
 */

import type { EditSegment } from "@/lib/auto-cut/types";
import type { LUFSMeasurement } from "@/lib/audio/loudness-types";
import type { BeatDetectionResult } from "@/lib/audio/beat-detection";
import type { ShotChange } from "./shot-detection";
import type { EncodedMotionEnergy } from "./motion-energy";
import type { HeadTailAnalysis } from "./head-tail-detection";

export interface SilenceAnalysisRecord {
	mediaId: string;
	segments: EditSegment[];
	/** Chunks/sec the analysis ran at (see `auto-cut/engine.ts`'s `computeLoudness`). */
	timebase: number;
	/** Total analyzed duration, seconds. */
	duration: number;
	analyzedAt: number;
}

export interface LoudnessAnalysisRecord {
	mediaId: string;
	measurement: LUFSMeasurement;
	analyzedAt: number;
}

export interface BeatAnalysisRecord {
	mediaId: string;
	bpm: number | null;
	confidence: number;
	/** SOURCE time, seconds — matches `stores/beat-grid-store.ts`'s `BeatGrid.beats` convention. */
	beats: number[];
	downbeats: number[];
	energyClass: BeatDetectionResult["energyClass"];
	analyzedAt: number;
}

export interface VisualAnalysisRecord {
	mediaId: string;
	shots: ShotChange[];
	motionEnergy: EncodedMotionEnergy;
	headTail: HeadTailAnalysis;
	sampleCount: number;
	analyzedAt: number;
}
