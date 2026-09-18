/**
 * `duckMusicUnderSpeech` (P5 craft macro) end to end through the real agent
 * loop — same "this must survive becoming a program" rationale as
 * `craft-cut-on-beat-scenario.ts`'s header (read that file's header for the
 * full architecture-doc citation; not repeated verbatim here).
 *
 * THE ASSERTION RULE, applied: every correctness assertion reads the
 * RESULTING volume-keyframe curve on the music element — never "was
 * `duckMusicUnderSpeech` called." `mustCallVerbs` in `expect` is the one
 * necessary exception, for the same "prove the scripted call actually ran"
 * reason the sibling craft scenarios document.
 *
 * FIXTURE: a voiceover-shaped audio clip spanning [2s, 5s] (detected as
 * speech via `isLikelyVoiceoverElement`'s name pattern — no transcript
 * needed, see `director-api.ts`'s `gatherSpeechIntervals`) plus a 10s music
 * bed spanning the whole timeline. Default duck options (-12dB, 0.15s
 * attack, 0.4s release) give an EXACT, hand-computable keyframe curve:
 *   1.85s → 1.0   (fade-in start:  2.0 - 0.15 attack)
 *   2.00s → duck   (speech starts)
 *   5.00s → duck   (still ducked: speech ends exactly at 5.0)
 *   5.40s → 1.0   (fade-out end:  5.0 + 0.4 release)
 * asserted to 4 decimal places — not just "some keyframes exist."
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor } from "../fake-editor";
import {
	closeTurn,
	insertClip,
	patchKeyframes,
	toolTurn,
	type EvalScenario,
} from "./fixtures";

const SPEECH_START_SEC = 2;
const SPEECH_DURATION_SEC = 3; // → speech ends at 5.0s
const MUSIC_DURATION_SEC = 10;
const DEFAULT_DUCK_ATTACK_SEC = 0.15;
const DEFAULT_DUCK_RELEASE_SEC = 0.4;
/** `10 ** (-12 / 20)` — the macro's default -12dB duck level as linear gain. */
const DEFAULT_DUCKED_GAIN = 10 ** (-12 / 20);

/** The exact expected keyframe curve — see this file's header for the math.
 *  Exported so `evals.test.ts` asserts against ONE source of truth rather
 *  than re-deriving the numbers next to the assertion. */
export const EXPECTED_DUCK_KEYFRAMES: Array<{ time: number; value: number }> = [
	{ time: SPEECH_START_SEC - DEFAULT_DUCK_ATTACK_SEC, value: 1 },
	{ time: SPEECH_START_SEC, value: DEFAULT_DUCKED_GAIN },
	{ time: SPEECH_START_SEC + SPEECH_DURATION_SEC, value: DEFAULT_DUCKED_GAIN },
	{
		time: SPEECH_START_SEC + SPEECH_DURATION_SEC + DEFAULT_DUCK_RELEASE_SEC,
		value: 1,
	},
];

function setupDuckMusicProject() {
	const fake = makeFakeEditor();
	patchKeyframes(fake);
	const director = createDirectorApi(fake.editor);

	// A voiceover-shaped audio clip — detected as speech by NAME PATTERN alone
	// (see `isLikelyVoiceoverElement`), no transcript machinery needed.
	const voiceoverId = insertClip(
		fake,
		{
			id: "el_voiceover_line",
			type: "audio",
			name: "voiceover-narration.mp3",
			mediaId: "m_narration",
			startTime: SPEECH_START_SEC,
			duration: SPEECH_DURATION_SEC,
			trimStart: 0,
			trimEnd: 0,
		},
		{ mode: "auto", trackType: "audio" },
	);
	// A music bed spanning the whole timeline — NOT voiceover-shaped, so it's
	// the ducking TARGET, not a speech source.
	const musicId = insertClip(
		fake,
		{
			id: "el_music_bed",
			type: "audio",
			name: "synthwave-bed.mp3",
			mediaId: "m_synthwave",
			startTime: 0,
			duration: MUSIC_DURATION_SEC,
			trimStart: 0,
			trimEnd: 0,
			volume: 1,
		},
		{ mode: "auto", trackType: "audio" },
	);

	return { fake, director, voiceoverId, musicId };
}

export const duckMusicScenario: EvalScenario = {
	id: "duck-music-under-voiceover",
	description:
		'A voiceover clip + a full-length music bed + "duck the music under the ' +
		'voiceover": duckMusicUnderSpeech must keyframe the music bed down for ' +
		"exactly the speech span (with attack/release ramps) and leave the " +
		"voiceover clip itself untouched — asserted on the resulting keyframe " +
		"curve, not on the verb name.",
	userMessage: "duck the music under my voiceover",
	setup: setupDuckMusicProject,
	turns: () => [
		toolTurn(
			"Ducking the music bed under the voiceover.",
			"t1",
			"duckMusicUnderSpeech",
			{},
		),
		closeTurn(
			"Ducked the music under your voiceover — should sit cleanly now.",
		),
	],
	expect: {
		mustCallVerbs: ["duckMusicUnderSpeech"],
		// The music/voiceover clips' own spans (10s bed, speech ending at 5s)
		// bound the timeline — ducking never changes any element's timing.
		durationBoundsSec: [MUSIC_DURATION_SEC, MUSIC_DURATION_SEC],
		mustNotAwaitApproval: true,
		mustNotGenerate: true,
	},
};
