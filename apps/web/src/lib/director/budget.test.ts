import { describe, expect, it } from "bun:test";
import {
	DEFAULT_TIER_COST,
	IMPORTANCE_TIER,
	allocateBudget,
	formatSpend,
	planActionWithinBudget,
	tierCostUsd,
	type ShotBudgetInput,
} from "./budget";

// A flat tier model keeps the arithmetic legible in tests: cheap 1×, standard
// 2×, premium 4× a shot's base cost.
const FLAT = { cheap: 1, standard: 2, premium: 4 };

describe("allocateBudget", () => {
	it("routes hero shots premium and b-roll cheap when the budget is ample", () => {
		const shots: ShotBudgetInput[] = [
			{ index: 1, baseCostUsd: 0.1, importance: "hero" },
			{ index: 2, baseCostUsd: 0.1, importance: "broll" },
			{ index: 3, baseCostUsd: 0.1, importance: "support" },
		];
		const plan = allocateBudget({ shots, totalBudgetUsd: 10, tierCost: FLAT });

		expect(plan.allocations.map((a) => a.tier)).toEqual([
			"premium",
			"cheap",
			"standard",
		]);
		// 0.1*4 + 0.1*1 + 0.1*2 = 0.7
		expect(plan.plannedTotalUsd).toBeCloseTo(0.7, 6);
		expect(plan.withinBudget).toBe(true);
		// No shot was forced below its importance tier.
		expect(plan.allocations.every((a) => a.downgradedFrom === undefined)).toBe(
			true,
		);
	});

	it("down-tiers the least-important shots first to fit a tight cap", () => {
		const shots: ShotBudgetInput[] = [
			{ index: 1, baseCostUsd: 1, importance: "hero" }, // wants premium (4)
			{ index: 2, baseCostUsd: 1, importance: "broll" }, // wants cheap (1)
			{ index: 3, baseCostUsd: 1, importance: "support" }, // wants standard (2)
		];
		// Full want = 4 + 1 + 2 = 7. Cap of 6 forces exactly one downgrade, and it
		// must be the least-protected non-cheap shot: the SUPPORT shot (broll is
		// already cheap, the hero is most protected).
		const plan = allocateBudget({ shots, totalBudgetUsd: 6, tierCost: FLAT });

		const byIndex = new Map(plan.allocations.map((a) => [a.index, a]));
		expect(byIndex.get(1)?.tier).toBe("premium"); // hero protected
		expect(byIndex.get(2)?.tier).toBe("cheap");
		expect(byIndex.get(3)?.tier).toBe("cheap"); // support shed a tier
		expect(byIndex.get(3)?.downgradedFrom).toBe("standard");
		expect(plan.plannedTotalUsd).toBeCloseTo(6, 6); // 4 + 1 + 1
		expect(plan.withinBudget).toBe(true);
	});

	it("sacrifices the hero's premium tier only when nothing cheaper is left to cut", () => {
		const shots: ShotBudgetInput[] = [
			{ index: 1, baseCostUsd: 1, importance: "hero" },
			{ index: 2, baseCostUsd: 1, importance: "hero" },
		];
		// Two heroes each want premium (4) → 8. Cap 5 forces both down: first to
		// standard (2+2=4 ≤ 5)… actually one to standard (4+2=6 > 5) then the other
		// to standard (2+2=4 ≤ 5). Both end at standard.
		const plan = allocateBudget({ shots, totalBudgetUsd: 5, tierCost: FLAT });
		expect(plan.allocations.map((a) => a.tier)).toEqual([
			"standard",
			"standard",
		]);
		expect(plan.plannedTotalUsd).toBeCloseTo(4, 6);
		expect(plan.withinBudget).toBe(true);
	});

	it("flags withinBudget=false when even an all-cheap reel overflows the cap", () => {
		const shots: ShotBudgetInput[] = [
			{ index: 1, baseCostUsd: 1, importance: "hero" },
			{ index: 2, baseCostUsd: 1, importance: "support" },
			{ index: 3, baseCostUsd: 1, importance: "broll" },
		];
		// All-cheap = 3, but the cap is only 2.
		const plan = allocateBudget({ shots, totalBudgetUsd: 2, tierCost: FLAT });
		expect(plan.allocations.every((a) => a.tier === "cheap")).toBe(true);
		expect(plan.plannedTotalUsd).toBeCloseTo(3, 6);
		expect(plan.withinBudget).toBe(false);
	});

	it("defaults missing importance to support and uses the default tier model", () => {
		const plan = allocateBudget({
			shots: [{ index: 1, baseCostUsd: 0.05 }],
			totalBudgetUsd: 100,
		});
		expect(plan.allocations[0].importance).toBe("support");
		expect(plan.allocations[0].tier).toBe(IMPORTANCE_TIER.support);
		expect(plan.allocations[0].allocatedUsd).toBeCloseTo(
			tierCostUsd(0.05, "standard", DEFAULT_TIER_COST),
			6,
		);
	});
});

describe("planActionWithinBudget", () => {
	it("proceeds at the requested tier when it fits the remaining budget", () => {
		const d = planActionWithinBudget({
			baseCostUsd: 1,
			requestedTier: "premium", // 4
			spentUsd: 0,
			budgetUsd: 10,
			tierCost: FLAT,
		});
		expect(d.outcome).toBe("proceed");
		expect(d.tier).toBe("premium");
		expect(d.costUsd).toBeCloseTo(4, 6);
		expect(d.remainingUsd).toBeCloseTo(10, 6);
	});

	it("down-routes to the priciest tier that still fits", () => {
		// Spent 5 of 8 → 3 left. Premium (4) overflows, standard (2) fits → route
		// standard, not all the way to cheap.
		const d = planActionWithinBudget({
			baseCostUsd: 1,
			requestedTier: "premium",
			spentUsd: 5,
			budgetUsd: 8,
			tierCost: FLAT,
		});
		expect(d.outcome).toBe("downroute");
		expect(d.tier).toBe("standard");
		expect(d.costUsd).toBeCloseTo(2, 6);
		expect(d.downroutedFrom).toBe("premium");
	});

	it("pauses when not even the cheap tier fits the remaining budget", () => {
		// Spent 9.5 of 10 → 0.5 left, cheap costs 1.
		const d = planActionWithinBudget({
			baseCostUsd: 1,
			requestedTier: "standard",
			spentUsd: 9.5,
			budgetUsd: 10,
			tierCost: FLAT,
		});
		expect(d.outcome).toBe("pause");
		expect(d.tier).toBe("cheap");
		expect(d.remainingUsd).toBeCloseTo(0.5, 6);
	});
});

describe("formatSpend", () => {
	const usd = (n: number) => `$${n.toFixed(2)}`;
	it("shows spent-of-budget when a cap is set", () => {
		expect(formatSpend({ budgetUsd: 2, spentUsd: 0.85 }, usd)).toBe(
			"spent $0.85 of $2.00",
		);
	});
	it("shows only spend when no cap is set", () => {
		expect(formatSpend({ spentUsd: 0.4 }, usd)).toBe("spent $0.40");
	});
});
