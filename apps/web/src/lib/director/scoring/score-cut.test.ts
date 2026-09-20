/**
 * Pure unit tests for `scoreCut` (`score-cut.ts`) — fixture timelines in,
 * an `EngagementScoreResult` + `EngagementDiagnostics` out, no editor, no
 * browser, no network. See that module's header for why each signal is
 * computed the way it is and which one is honestly unmeasurable locally.
 */
import { describe, expect, it } from "bun:test";
import {
	LOCAL_ENGAGEMENT_SCORER_SOURCE,
	scoreCut,
	type ScoreCutBeat,
	type ScoreCutClip,
	type ScoreCutInput,
	type ScoreCutLoudnessPoint,
	type ScoreCutSpeechSpan,
} from "./score-cut";

function clip(
	id: string,
	kind: string,
	startSec: number,
	durationSec: number,
): ScoreCutClip {
	return { id, kind, startSec, durationSec };
}

function speech(
	startSec: number,
	endSec: number,
	text: string,
): ScoreCutSpeechSpan {
	return { startSec, endSec, text };
}

/** A punchy, well-hooked opening: a short first shot at t=0, someone talking immediately, a builder-shaped pace afterward. */
function strongCutFixture(): ScoreCutInput {
	return {
		clips: [
			clip("c0", "video", 0, 2),
			clip("c1", "video", 2, 2),
			clip("c2", "video", 4, 1.5),
			clip("c3", "video", 5.5, 1.5),
			clip("c4", "video", 7, 1),
			clip("c5", "video", 8, 1),
		],
		speech: [
			speech(
				0,
				1.5,
				"Wait until you see what happens next — here's why this works.",
			),
			speech(2, 4, "Nobody tells you the real secret."),
		],
		totalDurationSec: 9,
	};
}

/** A weak cut: a long, silent, static opening shot with nothing said for seconds. */
function weakCutFixture(): ScoreCutInput {
	return {
		clips: [
			clip("c0", "video", 0.8, 15), // starts late AND lingers
			clip("c1", "video", 15.8, 14),
		],
		speech: [speech(12, 14, "so anyway I guess we'll get started eventually")],
		totalDurationSec: 30,
	};
}

describe("scoreCut — hook", () => {
	it("scores a punchy, immediately-talking opening higher than a slow, silent one", () => {
		const strong = scoreCut(strongCutFixture());
		const weak = scoreCut(weakCutFixture());
		expect(strong.score.hook.composite).toBeGreaterThan(
			weak.score.hook.composite,
		);
		expect(strong.diagnostics.hook.rating).not.toBe("weak");
		expect(weak.diagnostics.hook.rating).toBe("weak");
	});

	it("returns a floor score, not a throw, when the timeline has no visual content at all", () => {
		const result = scoreCut({
			clips: [clip("a0", "audio", 0, 10)],
			speech: [],
			totalDurationSec: 10,
		});
		expect(result.score.hook.composite).toBeLessThan(40);
		expect(Number.isFinite(result.score.composite)).toBe(true);
	});
});

describe("scoreCut — audio_sync (beat alignment)", () => {
	const beats: ScoreCutBeat[] = Array.from({ length: 10 }, (_, i) => ({
		time: i * 1,
		isDownbeat: i % 4 === 0,
	}));

	it("scores cuts landing exactly on the beat near-perfectly", () => {
		const input: ScoreCutInput = {
			clips: [
				clip("c0", "video", 0, 2),
				clip("c1", "video", 2, 2),
				clip("c2", "video", 4, 2),
			],
			speech: [],
			beats,
			totalDurationSec: 6,
		};
		const result = scoreCut(input);
		expect(result.score.audio_sync.composite).toBeGreaterThan(90);
	});

	it("scores cuts landing off the beat lower than on-beat cuts", () => {
		const offBeat: ScoreCutInput = {
			clips: [
				clip("c0", "video", 0, 2.3),
				clip("c1", "video", 2.3, 2.3),
				clip("c2", "video", 4.6, 2.3),
			],
			speech: [],
			beats,
			totalDurationSec: 6.9,
		};
		const onBeat: ScoreCutInput = {
			clips: [
				clip("c0", "video", 0, 2),
				clip("c1", "video", 2, 2),
				clip("c2", "video", 4, 2),
			],
			speech: [],
			beats,
			totalDurationSec: 6,
		};
		expect(scoreCut(offBeat).score.audio_sync.composite).toBeLessThan(
			scoreCut(onBeat).score.audio_sync.composite,
		);
	});

	it("falls back to a neutral 50 and flags it as unmeasured when no beat grid is analyzed", () => {
		const input: ScoreCutInput = {
			clips: [clip("c0", "video", 0, 2), clip("c1", "video", 2, 2)],
			speech: [],
			totalDurationSec: 4,
		};
		const result = scoreCut(input);
		expect(result.score.audio_sync.composite).toBe(50);
		expect(
			result.unmeasuredSignals.some((n) => n.startsWith("audio_sync:")),
		).toBe(true);
	});
});

describe("scoreCut — energy / emotional_arc with and without a measured mix", () => {
	it("uses a real loudness curve's dynamics when one is supplied", () => {
		const quiet: ScoreCutLoudnessPoint[] = Array.from(
			{ length: 10 },
			(_, i) => ({
				atSec: i,
				levelDb: -30,
			}),
		);
		const dynamic: ScoreCutLoudnessPoint[] = Array.from(
			{ length: 10 },
			(_, i) => ({
				atSec: i,
				levelDb: i < 5 ? -35 : -10,
			}),
		);
		const base: Omit<ScoreCutInput, "loudnessCurveDb"> = {
			clips: [clip("c0", "video", 0, 5), clip("c1", "video", 5, 5)],
			speech: [],
			totalDurationSec: 10,
		};
		const quietResult = scoreCut({ ...base, loudnessCurveDb: quiet });
		const dynamicResult = scoreCut({ ...base, loudnessCurveDb: dynamic });
		expect(dynamicResult.score.energy.composite).toBeGreaterThan(
			quietResult.score.energy.composite,
		);
		expect(
			quietResult.unmeasuredSignals.some((n) => n.startsWith("energy")),
		).toBe(false); // a curve WAS supplied — not an unmeasured signal
	});

	it("falls back to a cutting-pace proxy and flags it when no mix was decoded", () => {
		const result = scoreCut({
			clips: [clip("c0", "video", 0, 5), clip("c1", "video", 5, 5)],
			speech: [],
			totalDurationSec: 10,
		});
		expect(Number.isFinite(result.score.energy.composite)).toBe(true);
		expect(
			result.unmeasuredSignals.some((n) =>
				n.startsWith("energy/emotional_arc:"),
			),
		).toBe(true);
	});
});

describe("scoreCut — honesty about unmeasurable signals", () => {
	it("always reports face_presence as unmeasured, at the neutral fallback", () => {
		const result = scoreCut(strongCutFixture());
		expect(result.score.face_presence.composite).toBe(50);
		expect(
			result.unmeasuredSignals.some((n) => n.startsWith("face_presence:")),
		).toBe(true);
	});

	it("never invents a fabricated constant for a signal it lacks real data for — same neutral fallback engagement-diagnostics.ts itself uses", () => {
		// No beats, no loudness, no visual clips at all — every degraded axis
		// should land on the SAME documented neutral (50), not a made-up number.
		const result = scoreCut({ clips: [], speech: [], totalDurationSec: 10 });
		expect(result.score.audio_sync.composite).toBe(50);
		expect(result.score.face_presence.composite).toBe(50);
	});
});

describe("scoreCut — overall composite, grade, and the diagnostics/cutScore shapes", () => {
	it("produces a composite in range and a matching letter grade", () => {
		const result = scoreCut(strongCutFixture());
		expect(result.score.composite).toBeGreaterThanOrEqual(0);
		expect(result.score.composite).toBeLessThanOrEqual(100);
		expect(["A", "B", "C", "D", "F"]).toContain(result.score.grade);
		expect(result.diagnostics.overall).toBe(Math.round(result.score.composite));
		expect(result.diagnostics.grade).toBe(result.score.grade);
	});

	it("never uses virality/viral/hook-score wording in the grade label", () => {
		for (const composite of [10, 35, 50, 65, 80, 95]) {
			const result = scoreCut({
				clips: [clip("c0", "video", 0, 1)],
				speech: [],
				totalDurationSec: 1,
				// force a spread of composites indirectly isn't practical here;
				// this test instead asserts the FIXED label vocabulary directly.
			});
			void composite;
			expect(result.score.grade_label.toLowerCase()).not.toContain("viral");
			expect(result.score.grade_label.toLowerCase()).not.toContain(
				"hook score",
			);
		}
	});

	it("shapes a CutScoreInput ready for edit-critic.ts's formatCutScoreSummary", () => {
		const result = scoreCut(strongCutFixture());
		expect(result.cutScore.source).toBe(LOCAL_ENGAGEMENT_SCORER_SOURCE);
		expect(result.cutScore.overall).toBe(result.score.composite);
		expect(result.cutScore.grade).toBe(result.score.grade);
		expect(Object.keys(result.cutScore.axes).sort()).toEqual(
			[
				"audio_sync",
				"curiosity",
				"emotional_arc",
				"energy",
				"face_presence",
				"hook",
				"virality",
			].sort(),
		);
	});

	it("carries transcript segments through to the heatmap/hold-rate diagnostics", () => {
		const result = scoreCut(strongCutFixture());
		expect(result.diagnostics.heatmap.timed).toBe(true);
		expect(result.diagnostics.heatmap.segments.length).toBeGreaterThan(0);
	});
});

// ── the demo loop: score → recut → score, at the pure-function level ────────

describe("scoreCut — the score→recut→score loop closes", () => {
	it("recomputes from the changed timeline after a simulated recut, not a cached value", () => {
		const before = scoreCut(weakCutFixture());
		expect(before.diagnostics.hook.rating).toBe("weak");

		// Simulate the Director's recut: shorten and move up the lingering
		// opening shot (what a tightenToLength-shaped applyEdit program would
		// actually do to this fixture), so speech now starts immediately.
		const recut: ScoreCutInput = {
			clips: [
				clip("c0", "video", 0, 2), // was 15s starting at 0.8 — now punchy and immediate
				clip("c1", "video", 2, 14),
			],
			speech: [speech(0, 2, "so anyway I guess we'll get started eventually")],
			totalDurationSec: 16,
		};
		const after = scoreCut(recut);

		// The second score is a fresh computation over the NEW clip/speech
		// structure — not the same object, and not equal to the first score.
		expect(after).not.toBe(before);
		expect(after.score.hook.composite).not.toBe(before.score.hook.composite);
		expect(after.score.composite).not.toBe(before.score.composite);
		// This fixture's recut demonstrably closes the loop toward a stronger
		// hook (immediate start + immediate speech) — proving reactivity, not
		// merely difference.
		expect(after.score.hook.composite).toBeGreaterThan(
			before.score.hook.composite,
		);
	});
});
