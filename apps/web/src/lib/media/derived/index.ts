/**
 * Public surface for the per-asset derived-analysis subsystem (director
 * substrate task: time-ranged derivations + persistence + readiness status).
 *
 * Consumers outside `lib/media/derived` should import from here rather than
 * reaching into individual files — this is the "clean internal API" the
 * task asks for. Exposing any of this to the AI via a Director verb is a
 * later phase; this barrel is the seam that phase will read through.
 */

// Status contract (task C).
export {
	type AssetDerived,
	type DerivedKind,
	type DerivedStatus,
	OWNED_DERIVED_KINDS,
	createInitialDerived,
} from "./derived-status";

// Orchestration (task B: run + persist).
export {
	runDerivedAnalysis,
	type RunDerivedAnalysisOptions,
} from "./orchestrator";

// Reads — status + each analysis kind, keyed by mediaId.
export {
	getDerivedStatus,
	getSilenceAnalysis,
	getLoudnessAnalysis,
	getBeatAnalysis,
	getVisualAnalysis,
	deleteDerivedMedia,
	clearAllDerivedMedia,
	type StoredDerivedStatus,
} from "./derived-store";

// Record shapes.
export type {
	SilenceAnalysisRecord,
	LoudnessAnalysisRecord,
	BeatAnalysisRecord,
	VisualAnalysisRecord,
} from "./derived-records";

// Visual-derivation pieces (task A), for callers that want the raw shapes.
export { type ShotChange } from "./shot-detection";
export {
	type EncodedMotionEnergy,
	type MotionEnergyPoint,
	decodeMotionEnergy,
} from "./motion-energy";
export {
	type HeadTailAnalysis,
	type HeadTailFrameKind,
} from "./head-tail-detection";
