import { describe, expect, it } from "bun:test";
import {
	appendPreferenceEvent,
	distillPreferences,
	emptyUserPreferenceModel,
	logPreferenceEvent,
	MAX_PREFERENCE_EVENTS,
	type PreferenceEvent,
} from "./preference-learning";

// This suite runs in a bun environment with NO IndexedDB (mirroring SSR / a
// browser in private mode, exactly like `user-memory-store.test.ts`). The pure
// distill/append rules are exercised directly; `logPreferenceEvent`'s storage
// round-trip is exercised through its fail-soft degradation (reads resolve to
// "nothing yet", writes no-op) since that's the only storage state available here.

function event(
	type: PreferenceEvent["type"],
	ts: number,
	meta: PreferenceEvent["meta"] = {},
	projectId = "proj-1",
): PreferenceEvent {
	return { type, ts, projectId, meta };
}

describe("appendPreferenceEvent — bounded FIFO log", () => {
	it("keeps every event when under the cap", () => {
		const log = [event("chooseTake", 1), event("reroll", 2)];
		const next = appendPreferenceEvent(log, event("discard", 3), 10);
		expect(next).toHaveLength(3);
		expect(next.map((e) => e.ts)).toEqual([1, 2, 3]);
	});

	it("evicts the OLDEST event once the cap is exceeded (FIFO)", () => {
		const log = [event("chooseTake", 1), event("chooseTake", 2)];
		const next = appendPreferenceEvent(log, event("chooseTake", 3), 2);
		expect(next).toHaveLength(2);
		// ts=1 (oldest) is evicted; ts=2 and the new ts=3 survive, in order.
		expect(next.map((e) => e.ts)).toEqual([2, 3]);
	});

	it("defaults the cap to MAX_PREFERENCE_EVENTS", () => {
		let log: PreferenceEvent[] = [];
		for (let i = 0; i < MAX_PREFERENCE_EVENTS + 10; i++) {
			log = appendPreferenceEvent(log, event("chooseTake", i));
		}
		expect(log).toHaveLength(MAX_PREFERENCE_EVENTS);
		// The newest MAX_PREFERENCE_EVENTS survive — oldest 10 (ts 0..9) evicted.
		expect(log[0]?.ts).toBe(10);
		expect(log.at(-1)?.ts).toBe(MAX_PREFERENCE_EVENTS + 9);
	});
});

describe("distillPreferences — empty-log degradation", () => {
	it("distills an empty log to the well-formed 'no preferences yet' value", () => {
		const model = distillPreferences([], 5000);
		expect(model).toEqual(emptyUserPreferenceModel(5000));
		expect(model.sampleSize).toBe(0);
		expect(model.preferredAspects).toBeUndefined();
		expect(model.avgKeptDurationSec).toBeUndefined();
		expect(model.topChosenLooks).toBeUndefined();
		expect(model.topRerolledLooks).toBeUndefined();
		expect(model.backendWinRates).toBeUndefined();
	});
});

describe("distillPreferences — determinism + counting rules", () => {
	function sampleEvents(): PreferenceEvent[] {
		return [
			event("chooseTake", 1, {
				aspect: "portrait",
				durationSec: 6,
				cameraPreset: "handheld-closeup",
			}),
			event("chooseTake", 2, {
				aspect: "portrait",
				durationSec: 8,
				cameraPreset: "handheld-closeup",
			}),
			event("chooseTake", 3, {
				aspect: "landscape",
				durationSec: 4,
				cameraPreset: "static-wide",
			}),
			event("reroll", 4, {
				cameraPreset: "static-wide",
				reason: "too static",
			}),
			event("discard", 5, { cameraPreset: "static-wide" }),
			event("compareOutcome", 6, {
				competingBackendIds: ["byteplus-seedance", "runway-gen4"],
				wonBackendId: "byteplus-seedance",
			}),
			event("compareOutcome", 7, {
				competingBackendIds: ["byteplus-seedance", "runway-gen4"],
				wonBackendId: "runway-gen4",
			}),
			// Unresolved A/B — left to the user, no signal.
			event("compareOutcome", 8, {
				competingBackendIds: ["byteplus-seedance", "kling"],
			}),
		];
	}

	it("is deterministic for a fixed input + timestamp", () => {
		const a = distillPreferences(sampleEvents(), 9999);
		const b = distillPreferences(sampleEvents(), 9999);
		expect(a).toEqual(b);
	});

	it("counts sampleSize as the raw event count", () => {
		const model = distillPreferences(sampleEvents(), 9999);
		expect(model.sampleSize).toBe(sampleEvents().length);
	});

	it("preferredAspects reflects only KEPT (chooseTake) takes, most-picked first", () => {
		const model = distillPreferences(sampleEvents(), 9999);
		expect(model.preferredAspects).toEqual([
			{ tag: "portrait", count: 2 },
			{ tag: "landscape", count: 1 },
		]);
	});

	it("avgKeptDurationSec averages only KEPT takes' durations", () => {
		const model = distillPreferences(sampleEvents(), 9999);
		// (6 + 8 + 4) / 3 = 6
		expect(model.avgKeptDurationSec).toBe(6);
	});

	it("topChosenLooks vs topRerolledLooks split KEEP vs REJECT signal", () => {
		const model = distillPreferences(sampleEvents(), 9999);
		expect(model.topChosenLooks).toEqual([
			{ tag: "handheld-closeup", count: 2 },
			{ tag: "static-wide", count: 1 },
		]);
		// static-wide was chosen once but rejected (reroll + discard) twice —
		// the two signals are tracked independently, not netted against each other.
		expect(model.topRerolledLooks).toEqual([{ tag: "static-wide", count: 2 }]);
	});

	it("backendWinRates tallies only RESOLVED compareOutcome events", () => {
		const model = distillPreferences(sampleEvents(), 9999);
		expect(model.backendWinRates).toEqual(
			expect.arrayContaining([
				{ backendId: "byteplus-seedance", wins: 1, losses: 1 },
				{ backendId: "runway-gen4", wins: 1, losses: 1 },
			]),
		);
		// The unresolved comparison's competitor ("kling") never appears —
		// nothing was decided, so it carries no win/loss signal.
		expect(model.backendWinRates?.some((b) => b.backendId === "kling")).toBe(
			false,
		);
	});

	it("stamps the provided `now` as updatedAt", () => {
		const model = distillPreferences(sampleEvents(), 424242);
		expect(model.updatedAt).toBe(424242);
	});
});

describe("distillPreferences — tag ranking ties break deterministically", () => {
	it("preserves first-seen order among equal-count tags across repeated runs", () => {
		const events = [
			event("chooseTake", 1, { cameraPreset: "b-roll" }),
			event("chooseTake", 2, { cameraPreset: "a-roll" }),
		];
		const first = distillPreferences(events, 1).topChosenLooks;
		const second = distillPreferences(events, 1).topChosenLooks;
		expect(first).toEqual([
			{ tag: "b-roll", count: 1 },
			{ tag: "a-roll", count: 1 },
		]);
		expect(second).toEqual(first);
	});
});

describe("logPreferenceEvent — storage round-trip (fail-soft without IndexedDB)", () => {
	it("still returns a well-formed distilled model when persistence no-ops", async () => {
		// No IndexedDB in this environment ⇒ getPreferenceEventLog() reads back
		// `[]` regardless of prior calls, so each call distills from just the one
		// event passed in — exactly the "absence is a valid state" contract
		// `user-memory-store.ts` guarantees everywhere else.
		const model = await logPreferenceEvent(
			event("chooseTake", 1, { aspect: "square", durationSec: 10 }),
			5000,
		);
		expect(model.sampleSize).toBe(1);
		expect(model.preferredAspects).toEqual([{ tag: "square", count: 1 }]);
		expect(model.avgKeptDurationSec).toBe(10);
		expect(model.updatedAt).toBe(5000);
	});

	it("never throws even though the underlying writes are no-ops", async () => {
		await expect(
			logPreferenceEvent(event("discard", 1, { cameraPreset: "x" })),
		).resolves.toBeDefined();
	});
});
