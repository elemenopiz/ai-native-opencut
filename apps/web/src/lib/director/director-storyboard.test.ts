import { afterEach, describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import { usePersonaStore } from "@/stores/persona-store";
import { createDirectorApi } from "./director-api";

/**
 * In-memory `EditorCore` stub for the storyboard PLANNING path: a real
 * append-only timeline (so `getReel`/deltas reflect materialized slots), no-op
 * command transactions, and empty media/project. The point under test is that
 * `storyboard` authors a persisted plan AND seeds the reel-level consistency
 * context from the style bible — the "plan → consistency-context propagation"
 * the Director relies on for cross-shot coherence.
 */
function makeEditor(): EditorCore {
	const elements: Array<Record<string, unknown>> = [];
	const tracks = [{ id: "track_1", elements }];
	let counter = 0;
	return {
		timeline: {
			getTotalDuration: () =>
				elements.reduce(
					(max, e) =>
						Math.max(max, (e.startTime as number) + (e.duration as number)),
					0,
				),
			getTracks: () => tracks,
			addGenerativeSlot: ({
				spec,
				duration,
				startTime,
			}: {
				spec: unknown;
				duration: number;
				startTime?: number;
			}) => {
				const id = `slot_${++counter}`;
				elements.push({
					id,
					type: "video",
					generation: spec,
					duration,
					startTime: startTime ?? 0,
					takes: [],
				});
				return id;
			},
		},
		command: {
			beginTransaction: () => {},
			commitTransaction: () => {},
			rollbackTransaction: () => {},
			canUndo: () => false,
			canRedo: () => false,
		},
		media: { getAssetById: () => undefined, getAssets: () => [] },
		project: { getActiveOrNull: () => null },
	} as unknown as EditorCore;
}

const THREE_SHOT_BRIEF = {
	shots: [
		{
			prompt: "wide shot of a misty coffee farm at dawn",
			duration: 5,
			intent: "cold-open establishing shot",
			camera: "slow aerial push-in",
			subject: "Mara walking the rows",
		},
		{
			prompt: "Mara inspecting a coffee cherry, close up",
			duration: 4,
			intent: "introduce the hero",
			camera: "handheld mid-shot",
			subject: "Mara, hands and face",
		},
		{
			prompt: "Mara pouring a fresh cup on the porch",
			duration: 6,
			intent: "payoff / product beauty shot",
			camera: "locked-off, shallow DoF",
			subject: "Mara seated, steam rising",
		},
	],
	bible: {
		palette: "warm amber highlights, teal shadows",
		lensMood: "anamorphic, dreamy",
		setting: "a family coffee farm at dawn",
		characters: [
			{ name: "The Dog", descriptor: "old golden retriever, always underfoot" },
		],
	},
};

afterEach(() => {
	// The persona store is global; reset it so tests don't bleed.
	usePersonaStore.setState({ personas: [] });
});

describe("director storyboard planning", () => {
	it("authors a coherent 3-shot plan and persists it on the reel", () => {
		const director = createDirectorApi(makeEditor());

		const res = director.storyboard(THREE_SHOT_BRIEF);

		expect(res.ok).toBe(true);
		expect(res.data?.slotIds).toHaveLength(3);
		const plan = res.data?.plan;
		expect(plan?.shotCount).toBe(3);
		expect(plan?.totalDuration).toBe(15);
		// Per-shot creative intent is captured, 1-based, and mapped to a slot.
		expect(plan?.shots.map((s) => s.index)).toEqual([1, 2, 3]);
		expect(plan?.shots[0]).toMatchObject({
			intent: "cold-open establishing shot",
			camera: "slow aerial push-in",
			subject: "Mara walking the rows",
		});
		expect(plan?.shots.every((s) => typeof s.slotId === "string")).toBe(true);
		expect(plan?.shots.map((s) => s.slotId)).toEqual(res.data?.slotIds);

		// Persisted: a LATER turn reads the same plan back off getReel — no re-derive.
		const readBack = director.getReel().plan;
		expect(readBack).toEqual(plan);
	});

	it("auto-seeds the consistency context from the bible so every shot inherits it", () => {
		const director = createDirectorApi(makeEditor());

		director.storyboard(THREE_SHOT_BRIEF);

		// No setConsistencyContext call was made — storyboard seeded it from the bible.
		const ctx = director.getConsistencyContext().data;
		expect(ctx).toBeDefined();
		expect(ctx?.style).toBe(
			"warm amber highlights, teal shadows; anamorphic, dreamy",
		);
		expect(ctx?.setting).toBe("a family coffee farm at dawn");
		expect(ctx?.characters).toEqual([
			{ name: "The Dog", descriptor: "old golden retriever, always underfoot" },
		]);
	});

	it("keeps recurring characters consistent across shots (personas + bible cast)", () => {
		// A persona is the primary recurring character; the bible adds a secondary one.
		usePersonaStore.setState({
			personas: [
				{
					id: "persona_mara",
					name: "Mara",
					descriptor: "farmer, 30s, curly hair, denim jacket",
					createdAt: "2026-07-10",
				},
			] as never,
		});
		const director = createDirectorApi(makeEditor());

		director.storyboard(THREE_SHOT_BRIEF);

		// ONE reel-level context holds the whole cast — the same characters every
		// shot's generate call will inherit, which is what keeps them consistent.
		const ctx = director.getConsistencyContext().data;
		const names = ctx?.characters.map((c) => c.name);
		expect(names).toEqual(["Mara", "The Dog"]);
		// The persona character carries its persona id (identity/seed anchor).
		expect(ctx?.characters.find((c) => c.name === "Mara")?.personaId).toBe(
			"persona_mara",
		);
	});

	it("keeps single-shot / bible-less requests fast — no plan-driven consistency seeding", () => {
		const director = createDirectorApi(makeEditor());

		const res = director.storyboard({
			shots: [{ prompt: "one quick clip of a cat", duration: 6 }],
		});

		expect(res.ok).toBe(true);
		expect(res.data?.plan.shotCount).toBe(1);
		// An empty bible must NOT clobber / invent a consistency context.
		expect(director.getConsistencyContext().data).toBeUndefined();
	});
});
