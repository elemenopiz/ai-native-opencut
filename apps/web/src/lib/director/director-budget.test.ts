import { afterEach, describe, expect, it } from "bun:test";
import { usePersonaStore } from "@/stores/persona-store";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor } from "./fake-editor";
import type { BackendCatalogEntry } from "./types";

afterEach(() => {
	usePersonaStore.setState({ personas: [] });
});

/** A tiny backend catalog: a cheap draft model and a premium hero model. */
function catalog(): BackendCatalogEntry[] {
	return [
		{
			id: "cheap-draft",
			label: "Cheap Draft",
			vendor: "test",
			modality: "video",
			safetyTier: "experimental",
			intents: ["broll-video"],
			supportsSeedLock: false,
			supportsReferenceEdits: false,
			costTier: "cheap",
			relativeCost: 1,
		},
		{
			id: "premium-hero",
			label: "Premium Hero",
			vendor: "test",
			modality: "video",
			safetyTier: "partner",
			intents: ["character-video"],
			supportsSeedLock: true,
			supportsReferenceEdits: true,
			costTier: "premium",
			relativeCost: 3.4,
		},
	];
}

// Three shots at 480p × 4s each → base (cheapest-tier) estimate = 0.05×4 = $0.20.
const THREE_SHOTS = {
	shots: [
		{
			prompt: "logo reveal, hero money shot",
			duration: 4,
			importance: "hero" as const,
		},
		{
			prompt: "product on a table",
			duration: 4,
			importance: "support" as const,
		},
		{
			prompt: "ambient b-roll of the street",
			duration: 4,
			importance: "broll" as const,
		},
	],
};

describe("storyboard budget allocation", () => {
	it("routes hero premium / support standard / b-roll cheap under an ample cap", () => {
		const director = createDirectorApi(makeFakeEditor().editor);
		const res = director.storyboard({ ...THREE_SHOTS, budgetUsd: 5 });

		expect(res.ok).toBe(true);
		const budget = res.data?.plan.budget;
		expect(budget).toBeDefined();
		expect(budget?.totalBudgetUsd).toBe(5);
		expect(budget?.allocations.map((a) => a.tier)).toEqual([
			"premium",
			"standard",
			"cheap",
		]);
		expect(budget?.withinBudget).toBe(true);
		// Per-shot tier is mirrored onto the plan shots (routing hint).
		expect(res.data?.plan.shots.map((s) => s.tier)).toEqual([
			"premium",
			"standard",
			"cheap",
		]);
		// The tracker is armed at zero spend.
		const status = director.getBudgetStatus().data;
		expect(status?.budgetUsd).toBe(5);
		expect(status?.spentUsd).toBe(0);
		expect(status?.remainingUsd).toBe(5);
	});

	it("down-tiers the least-important shots first to fit a tight cap, protecting the hero longest", () => {
		const director = createDirectorApi(makeFakeEditor().editor);
		// Full want ≈ premium 0.64 + standard 0.38 + cheap 0.20 = 1.22. A $1 cap
		// forces two downgrades: support first (least protected), then the hero.
		const res = director.storyboard({ ...THREE_SHOTS, budgetUsd: 1 });

		const budget = res.data?.plan.budget;
		expect(budget?.withinBudget).toBe(true);
		expect(budget?.plannedTotalUsd).toBeLessThanOrEqual(1 + 1e-6);
		const byImp = new Map(
			budget?.allocations.map((a) => [a.importance, a]) ?? [],
		);
		// The b-roll is already cheap; support gave way before the hero did.
		expect(byImp.get("support")?.tier).toBe("cheap");
		expect(byImp.get("support")?.downgradedFrom).toBe("standard");
		expect(byImp.get("hero")?.tier).toBe("standard");
		expect(byImp.get("hero")?.downgradedFrom).toBe("premium");
	});

	it("leaves the reel unbudgeted when no budgetUsd is given", () => {
		const director = createDirectorApi(makeFakeEditor().editor);
		const res = director.storyboard(THREE_SHOTS);
		expect(res.data?.plan.budget).toBeUndefined();
		expect(director.getBudgetStatus().data?.budgetUsd).toBeUndefined();
	});
});

describe("spend gate (evaluateSpend)", () => {
	it("is inactive when the reel has no budget", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			backends: async () => catalog(),
		});
		director.storyboard(THREE_SHOTS); // no budget
		const ev = await director.evaluateSpend({
			slotIds: "all",
			alternatives: 1,
		});
		expect(ev.active).toBe(false);
	});

	it("proceeds when the requested tier fits the remaining budget", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			backends: async () => catalog(),
		});
		const res = director.storyboard({ ...THREE_SHOTS, budgetUsd: 5 });
		const heroSlot = res.data!.slotIds[0];
		const ev = await director.evaluateSpend({
			slotIds: [heroSlot],
			alternatives: 1,
		});
		expect(ev.active).toBe(true);
		expect(ev.decision?.outcome).toBe("proceed");
		// Hero shot → premium tier requested (from the plan allocation).
		expect(ev.decision?.tier).toBe("premium");
	});

	it("down-routes a shot that would overrun to a concrete cheaper backend", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			backends: async () => catalog(),
		});
		const res = director.storyboard({ ...THREE_SHOTS, budgetUsd: 5 });
		const heroSlot = res.data!.slotIds[0];
		// Burn the budget down so only the cheap tier of the hero shot fits.
		// Hero base = 0.20; cheap 0.20, standard 0.38, premium 0.64. Leave $0.25.
		director.recordSpend({ usd: 5 - 0.25 });

		const ev = await director.evaluateSpend({
			slotIds: [heroSlot],
			alternatives: 1,
		});
		expect(ev.active).toBe(true);
		expect(ev.decision?.outcome).toBe("downroute");
		expect(ev.decision?.tier).toBe("cheap");
		expect(ev.decision?.downroutedFrom).toBe("premium");
		// The cheaper backend from the catalog is named for the pin.
		expect(ev.downrouteBackendId).toBe("cheap-draft");
	});

	it("pauses when not even the cheap tier fits the remaining budget", async () => {
		const director = createDirectorApi(makeFakeEditor().editor, {
			backends: async () => catalog(),
		});
		const res = director.storyboard({ ...THREE_SHOTS, budgetUsd: 5 });
		const heroSlot = res.data!.slotIds[0];
		director.recordSpend({ usd: 5 - 0.05 }); // only $0.05 left; cheap needs $0.20
		const ev = await director.evaluateSpend({
			slotIds: [heroSlot],
			alternatives: 1,
		});
		expect(ev.decision?.outcome).toBe("pause");
	});
});

describe("spend tracking + brief", () => {
	it("accumulates recorded spend on the reel snapshot", () => {
		const director = createDirectorApi(makeFakeEditor().editor);
		director.storyboard({ ...THREE_SHOTS, budgetUsd: 5 });
		director.recordSpend({ usd: 0.64 });
		director.recordSpend({ usd: 0.38 });
		const spend = director.getReel().spend;
		expect(spend?.budgetUsd).toBe(5);
		expect(spend?.spentUsd).toBeCloseTo(1.02, 6);
	});

	it("records the final spend as a durable brief note", () => {
		const director = createDirectorApi(makeFakeEditor().editor);
		director.storyboard({ ...THREE_SHOTS, budgetUsd: 5 });
		director.recordSpend({ usd: 1.25 });
		const res = director.recordFinalSpend();
		expect(res.ok).toBe(true);
		expect(res.data?.note).toContain("Reel spend:");
		const notes = director.getBrief().data?.notes ?? [];
		expect(notes.some((n) => n.includes("$1.25") && n.includes("$5.00"))).toBe(
			true,
		);
	});

	it("re-allocates an existing plan when setBudget tightens the cap", () => {
		const director = createDirectorApi(makeFakeEditor().editor);
		director.storyboard({ ...THREE_SHOTS, budgetUsd: 5 }); // hero premium
		const res = director.setBudget({ budgetUsd: 1 });
		expect(res.ok).toBe(true);
		// The stored plan was re-tiered against the tighter cap.
		const plan = director.getReel().plan;
		const hero = plan?.shots.find((s) => s.importance === "hero");
		expect(hero?.tier).toBe("standard"); // dropped from premium to fit $1
		expect(director.getBudgetStatus().data?.spentUsd).toBe(0); // reset
	});
});
