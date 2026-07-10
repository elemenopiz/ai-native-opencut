/**
 * Auto-review loop wiring — proves the "generate → SEE → fix" self-correction
 * acts on the critic's verdict deterministically, WITHOUT a live model or
 * generation provider. The critic is injected; the DirectorApi is a minimal
 * stateful fake that records the verbs the loop drives.
 *
 * This is the behavioral verification for "a deliberately off-prompt generation
 * gets flagged and rerolled": the critic returns `reroll-with-delta` and we
 * assert the loop revises the prompt, rerolls, and selects the corrected take.
 */
import { describe, expect, it } from "bun:test";
import { autoReviewSlot, type AgentToolStep, type CritiqueFn } from "./agent";
import type { DirectorApi } from "./director-api";
import type { CriticVerdict } from "./vision-critic";

interface FakeOpts {
	reviewOk?: boolean;
	prompt?: string;
	/** The slot's currently-stored prompt, returned by getSlot (the authored one). */
	slotPrompt?: string;
	estimate?: { low: number; high: number; clips: number };
	rerollTakeId?: string;
	rerollOk?: boolean;
	correctedStatus?: string;
}

function makeDirector(opts: FakeOpts = {}) {
	const takeId = opts.rerollTakeId ?? "take2";
	const calls = {
		setPrompt: [] as Array<{ slotId: string; prompt: string }>,
		reroll: [] as Array<{ slotId: string; alternatives?: number }>,
		remix: [] as Array<{ slotId: string; remixPrompt: string }>,
		chooseTake: [] as Array<{ slotId: string; takeId?: string }>,
		review: 0,
	};
	const director = {
		reviewTake: async (input: { slotId: string }) => {
			calls.review++;
			return opts.reviewOk === false
				? { ok: false, message: "Take is generating, not ready to review yet." }
				: {
						ok: true,
						message: "reviewing",
						data: {
							slotId: input.slotId,
							takeId: "take1",
							prompt: opts.prompt ?? "a red convertible on a beach",
							status: "ready",
							frameCount: 1,
							frames: ["data:image/jpeg;base64,AAAA"],
						},
					};
		},
		estimateGenerateCost: (_input: {
			slotIds?: string[] | "all";
			alternatives?: number;
		}) => ({
			ok: true,
			message: "estimate",
			data: opts.estimate ?? { low: 0.05, high: 0.1, clips: 1 },
		}),
		setPrompt: (input: { slotId: string; prompt: string }) => {
			calls.setPrompt.push({ slotId: input.slotId, prompt: input.prompt });
			return { ok: true, message: "prompt set" };
		},
		reroll: async (input: { slotId: string; alternatives?: number }) => {
			calls.reroll.push(input);
			return {
				ok: opts.rerollOk ?? true,
				message: "rerolled",
				data: { slotId: input.slotId, takeIds: [takeId] },
			};
		},
		remix: async (input: { slotId: string; remixPrompt: string }) => {
			calls.remix.push(input);
			return {
				ok: true,
				message: "remixed",
				data: { slotId: input.slotId, takeId },
			};
		},
		getSlot: (slotId: string) => ({
			ok: true,
			message: "slot",
			data: {
				id: slotId,
				prompt: opts.slotPrompt ?? "",
				status: "ready",
				takeCount: 2,
				takes: [
					{ id: "take1", status: "ready", spec: {}, createdAt: 0 },
					{
						id: takeId,
						status: opts.correctedStatus ?? "ready",
						spec: {},
						createdAt: 1,
					},
				],
				start: 0,
				duration: 6,
			},
		}),
		chooseTake: (input: { slotId: string; takeId?: string }) => {
			calls.chooseTake.push(input);
			return { ok: true, message: "chosen" };
		},
	} as unknown as DirectorApi;
	return { director, calls };
}

/** A critic that returns a fixed sequence of verdicts and records the intents it saw. */
function sequenceCritique(verdicts: CriticVerdict[]): {
	fn: CritiqueFn;
	intents: string[];
} {
	const intents: string[] = [];
	let i = 0;
	const fn: CritiqueFn = async (intent) => {
		intents.push(intent);
		return verdicts[Math.min(i++, verdicts.length - 1)];
	};
	return { fn, intents };
}

const base = { slotId: "slot1", shortId: "s1", threshold: 0.5 };

describe("autoReviewSlot", () => {
	it("flags an off-prompt take and rerolls from the revised prompt, then keeps the fix", async () => {
		const { director, calls } = makeDirector({ prompt: "a red convertible" });
		const { fn, intents } = sequenceCritique([
			{
				verdict: "reroll-with-delta",
				reason: "generated a blue sedan, not a red convertible",
				revisedPrompt: "a bright red convertible on a coastal road",
			},
			{ verdict: "pass", reason: "matches now" },
		]);
		const steps: AgentToolStep[] = [];

		await autoReviewSlot({ ...base, director, steps, critique: fn });

		// The critic judged against the slot's intent.
		expect(intents[0]).toBe("a red convertible");
		// It revised the prompt, rerolled once, and selected the corrected take.
		expect(calls.setPrompt).toEqual([
			{ slotId: "slot1", prompt: "a bright red convertible on a coastal road" },
		]);
		expect(calls.reroll).toHaveLength(1);
		expect(calls.chooseTake).toEqual([{ slotId: "slot1", takeId: "take2" }]);
		expect(steps.some((s) => s.action === "reroll" && s.ok)).toBe(true);
		// Two attempts: reroll, then a passing re-review that stops the loop.
		expect(calls.review).toBe(2);
	});

	it("keeps a passing take without spending", async () => {
		const { director, calls } = makeDirector();
		const { fn } = sequenceCritique([{ verdict: "pass", reason: "on brief" }]);
		const steps: AgentToolStep[] = [];

		await autoReviewSlot({ ...base, director, steps, critique: fn });

		expect(calls.setPrompt).toHaveLength(0);
		expect(calls.reroll).toHaveLength(0);
		expect(calls.remix).toHaveLength(0);
		expect(calls.review).toBe(1);
		expect(steps).toHaveLength(1); // just the review step
	});

	it("remixes in place for a mostly-right take", async () => {
		const { director, calls } = makeDirector();
		const { fn } = sequenceCritique([
			{
				verdict: "remix-with-anchor",
				reason: "extra finger on the left hand",
				revisedPrompt: "fix the left hand",
			},
			{ verdict: "pass", reason: "fixed" },
		]);
		const steps: AgentToolStep[] = [];

		await autoReviewSlot({ ...base, director, steps, critique: fn });

		expect(calls.remix).toEqual([
			{ slotId: "slot1", remixPrompt: "fix the left hand" },
		]);
		expect(calls.setPrompt).toHaveLength(0);
		expect(calls.chooseTake).toEqual([{ slotId: "slot1", takeId: "take2" }]);
	});

	it("pauses instead of spending when a correction crosses the approval threshold", async () => {
		const { director, calls } = makeDirector({
			estimate: { low: 0.4, high: 0.6, clips: 1 }, // high >= 0.5 threshold
		});
		const { fn } = sequenceCritique([
			{
				verdict: "reroll-with-delta",
				reason: "wrong",
				revisedPrompt: "new prompt",
			},
		]);
		const steps: AgentToolStep[] = [];

		await autoReviewSlot({ ...base, director, steps, critique: fn });

		expect(calls.reroll).toHaveLength(0);
		expect(calls.setPrompt).toHaveLength(0);
		expect(
			steps.some((s) => !s.ok && /approval threshold/i.test(s.message)),
		).toBe(true);
	});

	it("stops quietly when there's nothing reviewable yet", async () => {
		const { director, calls } = makeDirector({ reviewOk: false });
		let critiqued = false;
		const fn: CritiqueFn = async () => {
			critiqued = true;
			return { verdict: "pass", reason: "" };
		};
		const steps: AgentToolStep[] = [];

		await autoReviewSlot({ ...base, director, steps, critique: fn });

		expect(critiqued).toBe(false);
		expect(calls.reroll).toHaveLength(0);
		expect(steps).toHaveLength(0);
	});

	it("restores the authored prompt when a reroll fails (no silent loss)", async () => {
		const { director, calls } = makeDirector({
			slotPrompt: "a red convertible on a beach",
			rerollOk: false,
		});
		const { fn } = sequenceCritique([
			{
				verdict: "reroll-with-delta",
				reason: "wrong subject",
				revisedPrompt: "a bright red convertible on a coastal road",
			},
		]);
		const steps: AgentToolStep[] = [];

		await autoReviewSlot({ ...base, director, steps, critique: fn });

		// The prompt was revised for the attempt, then rolled back to the original
		// once the reroll came back not-ok — so the user's authored prompt survives.
		expect(calls.setPrompt).toEqual([
			{ slotId: "slot1", prompt: "a bright red convertible on a coastal road" },
			{ slotId: "slot1", prompt: "a red convertible on a beach" },
		]);
		expect(calls.reroll).toHaveLength(1);
		// Failed reroll → no take selected, loop stops.
		expect(calls.chooseTake).toHaveLength(0);
		expect(steps.some((s) => s.action === "reroll" && !s.ok)).toBe(true);
	});

	it("stops if the corrective take comes back not ready (no spiral)", async () => {
		const { director, calls } = makeDirector({ correctedStatus: "failed" });
		const { fn } = sequenceCritique([
			{
				verdict: "reroll-with-delta",
				reason: "wrong",
				revisedPrompt: "new prompt",
			},
			{
				verdict: "reroll-with-delta",
				reason: "still wrong",
				revisedPrompt: "another",
			},
		]);
		const steps: AgentToolStep[] = [];

		await autoReviewSlot({ ...base, director, steps, critique: fn });

		// Rerolled once, take came back failed → not selected, loop stops.
		expect(calls.reroll).toHaveLength(1);
		expect(calls.chooseTake).toHaveLength(0);
		expect(calls.review).toBe(1);
	});
});
