/**
 * Public surface of `lib/director/craft/` — see `./types.ts` for the shared
 * contract every macro here follows (pure, deterministic, plan-only).
 *
 * NO VERBS ARE REGISTERED HERE. This is library-only: `tool-catalog.ts` /
 * `director-api.ts` wiring (turning `cutOnBeat`/`tightenToLength`/
 * `duckMusicUnderSpeech` into callable Director verbs) is a separate,
 * later change.
 */

export type { CraftOp, TimeRangeSec } from "./types";
export { CRAFT_EPSILON, roundSec } from "./types";

export {
	cutOnBeat,
	DEFAULT_BEAT_SNAP_TOLERANCE_SEC,
	DEFAULT_MIN_CLIP_DURATION_SEC as CUT_ON_BEAT_DEFAULT_MIN_CLIP_DURATION_SEC,
	type CraftBeatMarker,
	type CraftClip,
	type CutOnBeatOptions,
	type CutOnBeatPlan,
	type CutOnBeatSkip,
	type CutOnBeatSkipReason,
} from "./cut-on-beat";

export {
	tightenToLength,
	DEFAULT_CONVERGENCE_TOLERANCE_SEC,
	DEFAULT_MIN_CLIP_DURATION_SEC as TIGHTEN_TO_LENGTH_DEFAULT_MIN_CLIP_DURATION_SEC,
	type TightenElementInput,
	type TightenShortfall,
	type TightenToLengthInput,
	type TightenToLengthPlan,
	type TrimmableSegment,
} from "./tighten-to-length";

export {
	duckMusicUnderSpeech,
	DEFAULT_ATTACK_SEC,
	DEFAULT_DUCK_AMOUNT_DB,
	DEFAULT_MERGE_GAP_SEC,
	DEFAULT_RELEASE_SEC,
	type DuckKeyframeArg,
	type DuckMusicElement,
	type DuckMusicUnderSpeechOptions,
	type DuckMusicUnderSpeechPlan,
	type SpeechInterval,
} from "./duck-music-under-speech";
