/**
 * Reel budget planning — spend intelligence ACROSS the whole reel, not per shot.
 *
 * D3 routes each shot to a backend by intent (cheap draft vs. premium hero), but
 * it never plans SPEND across the sequence: a "$2, 6-shot reel" would happily
 * blow the whole budget on shot 1 at a premium tier. This module is the missing
 * treasurer:
 *
 *  1. ALLOCATE — split one total USD budget across shots weighted by importance,
 *     giving hero shots a premium tier and b-roll a cheap tier, then GREEDILY
 *     down-tiering the least-important shots until the plan fits the cap
 *     ({@link allocateBudget}). Hero shots keep their premium tier as long as
 *     possible.
 *  2. GATE — before a shot actually spends, decide whether it fits the REMAINING
 *     budget at its requested tier; if not, down-route it to the priciest tier
 *     that still fits, or (when nothing fits) pause for the user
 *     ({@link planActionWithinBudget}).
 *  3. TRACK — a per-editor running tally of actual spend against the cap
 *     ({@link getReelSpend}/{@link recordReelSpend}), surfaced to the panel and
 *     recorded in the brief.
 *
 * Everything here is USD, matching the existing cost-preview approval gate
 * (`studio/cost.ts`) and the panel — a backend's per-model credit tier
 * (`backends/cost.ts`) is projected onto a USD MULTIPLIER over a shot's base
 * (resolution/duration) estimate, so "route to a premium model" honestly costs
 * more USD than "route to a cheap model" for the same shot.
 *
 * Pure and dependency-light: the allocation/gate solvers take plain numbers so
 * they're trivially testable; only the spend registry touches editor state (a
 * `WeakMap`, same lifetime scheme as the storyboard plan / consistency context).
 */

import type { EditorCore } from "@/core";

/**
 * Relative cost tier a shot is routed at — the SAME vocabulary the router's
 * `relativeCostTier` buckets backends into (`backends/cost.ts`) and the agent's
 * MODEL ROUTING policy reasons over ("draft on cheap, hero on premium").
 */
export type CostTier = "cheap" | "standard" | "premium";

/** Cheapest → priciest, so a down-route walks this array leftward. */
export const TIER_ORDER: readonly CostTier[] = ["cheap", "standard", "premium"];

/**
 * How important a shot is to the reel — the signal that picks its tier. A hero
 * shot (the money shot, the logo reveal) earns a premium backend; b-roll and
 * filler ride the cheap tier.
 */
export type ShotImportance = "hero" | "support" | "broll";

/** Importance → the tier a shot STARTS at before any budget-fit down-tiering. */
export const IMPORTANCE_TIER: Record<ShotImportance, CostTier> = {
	hero: "premium",
	support: "standard",
	broll: "cheap",
};

/**
 * How aggressively to protect a shot from being down-tiered when the plan
 * overflows the budget: LOWER = downgraded first. B-roll gives way before a
 * hero shot loses its premium tier.
 */
const PROTECTION: Record<ShotImportance, number> = {
	broll: 0,
	support: 1,
	hero: 2,
};

/**
 * USD cost of a tier as a MULTIPLIER over a shot's base (cheapest-tier) estimate.
 * Calibrated to the router's `relativeCostTier` bands (cheap ≤1.34× the floor,
 * standard ≤2.5×, premium >2.5×): a representative point in each band. Overridable
 * (e.g. derived from the live backend catalog) via the `tierCost` arg everywhere.
 */
export interface TierCostModel {
	cheap: number;
	standard: number;
	premium: number;
}

export const DEFAULT_TIER_COST: TierCostModel = {
	cheap: 1,
	standard: 1.9,
	premium: 3.2,
};

/** Times are compared with a small tolerance so float sums don't spuriously overflow. */
const EPSILON = 1e-6;

/** USD cost of rendering a shot with `baseCostUsd` at `tier`. */
export function tierCostUsd(
	baseCostUsd: number,
	tier: CostTier,
	model: TierCostModel = DEFAULT_TIER_COST,
): number {
	return baseCostUsd * model[tier];
}

/** One shot as the allocator sees it: its base cost and how important it is. */
export interface ShotBudgetInput {
	/** 1-based shot index (mirrors {@link PlannedShot.index}). */
	index: number;
	/** The shot's base (cheapest-tier) USD estimate, from resolution × duration. */
	baseCostUsd: number;
	/** How important the shot is — picks its starting tier. Default "support". */
	importance?: ShotImportance;
}

/** The tier + planned USD a single shot was allocated. */
export interface ShotAllocation {
	index: number;
	importance: ShotImportance;
	/** The tier this shot will route at after budget-fit down-tiering. */
	tier: CostTier;
	/** Planned USD for this shot at its allocated tier. */
	allocatedUsd: number;
	/** Set when the fit pass had to drop this shot below its importance tier. */
	downgradedFrom?: CostTier;
}

/**
 * A whole-reel budget: the cap, each shot's tier + planned spend, and whether
 * the allocation actually fits. Authored once (persisted on the storyboard plan)
 * and read back for routing hints and the panel's "spent X of $Y".
 */
export interface ReelBudget {
	/** Total USD the reel may spend. */
	totalBudgetUsd: number;
	/** Per-shot tier + planned USD, in shot order. */
	allocations: ShotAllocation[];
	/** Sum of every shot's `allocatedUsd` (≤ budget once it fits). */
	plannedTotalUsd: number;
	/**
	 * True when the plan fits the cap. False ⇒ even routing EVERY shot at the
	 * cheap tier overflows the budget, so generation will pause for approval.
	 */
	withinBudget: boolean;
	/** The tier→USD multiplier model used (echoed so callers can re-derive costs). */
	tierCost: TierCostModel;
}

function downTier(tier: CostTier): CostTier | null {
	const i = TIER_ORDER.indexOf(tier);
	return i > 0 ? TIER_ORDER[i - 1] : null;
}

/**
 * Split `totalBudgetUsd` across `shots` weighted by importance: each shot starts
 * at its {@link IMPORTANCE_TIER}, then — while the plan overflows the cap — the
 * least-protected, currently-priciest shot is down-tiered one step, repeatedly,
 * until it fits or every shot sits at the cheap tier. Hero shots keep premium
 * longest; b-roll gives way first.
 *
 * Pure: no editor state, plain numbers in and out, so allocation is fully
 * unit-testable. `withinBudget:false` means the cap is too small even for an
 * all-cheap reel — the caller should still let the user proceed (the per-action
 * gate will pause), it just can't promise the plan fits.
 */
export function allocateBudget(input: {
	shots: ShotBudgetInput[];
	totalBudgetUsd: number;
	tierCost?: TierCostModel;
}): ReelBudget {
	const tierCost = input.tierCost ?? DEFAULT_TIER_COST;
	const budget = Math.max(0, input.totalBudgetUsd);

	// Working state: start every shot at its importance-preferred tier.
	const working = input.shots.map((s) => {
		const importance = s.importance ?? "support";
		const startTier = IMPORTANCE_TIER[importance];
		return {
			index: s.index,
			baseCostUsd: Math.max(0, s.baseCostUsd),
			importance,
			startTier,
			tier: startTier,
		};
	});

	const totalCost = () =>
		working.reduce(
			(sum, w) => sum + tierCostUsd(w.baseCostUsd, w.tier, tierCost),
			0,
		);

	// Greedy down-tiering: protect heroes, shed cost from the cheapest-to-protect
	// (b-roll) and, among equals, the most expensive shot first.
	while (totalCost() > budget + EPSILON) {
		const candidates = working.filter((w) => w.tier !== "cheap");
		if (candidates.length === 0) break; // already all cheap — can't shrink further
		candidates.sort((a, b) => {
			const prot = PROTECTION[a.importance] - PROTECTION[b.importance];
			if (prot !== 0) return prot; // least-protected first
			// tie-break: bigger current spend first (down-tiering it saves more)
			return (
				tierCostUsd(b.baseCostUsd, b.tier, tierCost) -
				tierCostUsd(a.baseCostUsd, a.tier, tierCost)
			);
		});
		const pick = candidates[0];
		const next = downTier(pick.tier);
		if (!next) break;
		pick.tier = next;
	}

	const allocations: ShotAllocation[] = working.map((w) => ({
		index: w.index,
		importance: w.importance,
		tier: w.tier,
		allocatedUsd: tierCostUsd(w.baseCostUsd, w.tier, tierCost),
		...(w.tier !== w.startTier ? { downgradedFrom: w.startTier } : {}),
	}));
	const plannedTotalUsd = allocations.reduce((s, a) => s + a.allocatedUsd, 0);

	return {
		totalBudgetUsd: budget,
		allocations,
		plannedTotalUsd,
		withinBudget: plannedTotalUsd <= budget + EPSILON,
		tierCost,
	};
}

/** What the budget gate decided a single spend should do. */
export interface BudgetGateDecision {
	/**
	 * - `proceed`: fits at the requested tier, run as asked.
	 * - `downroute`: doesn't fit at the requested tier but a cheaper one does —
	 *   run at `tier` instead (the caller should pin that backend).
	 * - `pause`: doesn't fit even at the cheap tier — stop and ask the user.
	 */
	outcome: "proceed" | "downroute" | "pause";
	/** The tier the action should actually run at. */
	tier: CostTier;
	/** USD this action will cost at `tier` (the projected spend). */
	costUsd: number;
	/** The originally-requested tier, present only on a down-route. */
	downroutedFrom?: CostTier;
	/** Budget left before this action (budget − already-spent). */
	remainingUsd: number;
}

/**
 * Decide how a single spend should proceed against the remaining budget. Walks
 * DOWN from the requested tier and returns the priciest tier whose cost still
 * fits `budgetUsd − spentUsd`; if the requested tier already fits it's a
 * `proceed`, a lower one is a `downroute`, and nothing fitting (not even cheap)
 * is a `pause`. Pure — the caller supplies the numbers and acts on the verdict.
 */
export function planActionWithinBudget(input: {
	baseCostUsd: number;
	requestedTier: CostTier;
	spentUsd: number;
	budgetUsd: number;
	tierCost?: TierCostModel;
}): BudgetGateDecision {
	const tierCost = input.tierCost ?? DEFAULT_TIER_COST;
	const remainingUsd = input.budgetUsd - input.spentUsd;
	const startIdx = TIER_ORDER.indexOf(input.requestedTier);

	for (let i = startIdx; i >= 0; i--) {
		const tier = TIER_ORDER[i];
		const costUsd = tierCostUsd(input.baseCostUsd, tier, tierCost);
		if (input.spentUsd + costUsd <= input.budgetUsd + EPSILON) {
			return {
				outcome: i === startIdx ? "proceed" : "downroute",
				tier,
				costUsd,
				...(i === startIdx ? {} : { downroutedFrom: input.requestedTier }),
				remainingUsd,
			};
		}
	}

	// Nothing fits — surface the cheap-tier cost as the (still-too-big) ask.
	return {
		outcome: "pause",
		tier: "cheap",
		costUsd: tierCostUsd(input.baseCostUsd, "cheap", tierCost),
		remainingUsd,
	};
}

// ── per-editor spend registry ────────────────────────────────────────────────
//
// Live budget cap + running actual spend for a reel, held for the editor's
// lifetime (session state, GC'd with the editor) — the same `WeakMap` scheme as
// the storyboard plan and consistency context. The AUTHORED allocation lives on
// the persisted plan (`StoryboardPlan.budget`); THIS is the mutable tally the
// gate reads and the panel/brief render.

/** A reel's running spend against its cap. */
export interface ReelSpend {
	/** The active USD cap, if a budget was set for this reel. */
	budgetUsd?: number;
	/** Actual USD spent so far (cumulative across the turn / session). */
	spentUsd: number;
}

const spendByEditor = new WeakMap<EditorCore, ReelSpend>();

/** Read the reel's spend tally (a zeroed, budget-less tally when none is set). */
export function getReelSpend(editor: EditorCore): ReelSpend {
	return spendByEditor.get(editor) ?? { spentUsd: 0 };
}

/**
 * (Re)establish a budget for the reel and RESET the running spend to zero — the
 * caller sets a fresh cap (a new "$2 reel"). Passing `undefined` clears the cap
 * but keeps the tally at zero.
 */
export function setReelBudget(
	editor: EditorCore,
	budgetUsd: number | undefined,
): ReelSpend {
	const next: ReelSpend = {
		spentUsd: 0,
		...(budgetUsd != null && budgetUsd > 0 ? { budgetUsd } : {}),
	};
	spendByEditor.set(editor, next);
	return next;
}

/** Add `usd` to the reel's running spend, returning the updated tally. */
export function recordReelSpend(editor: EditorCore, usd: number): ReelSpend {
	const current = getReelSpend(editor);
	const next: ReelSpend = {
		...current,
		spentUsd: current.spentUsd + Math.max(0, usd),
	};
	spendByEditor.set(editor, next);
	return next;
}

/** USD left before the cap, or `undefined` when no budget is set. */
export function remainingBudgetUsd(spend: ReelSpend): number | undefined {
	return spend.budgetUsd == null ? undefined : spend.budgetUsd - spend.spentUsd;
}

/** Compact "spent $X of $Y" (or just "spent $X" with no cap) for panel/brief copy. */
export function formatSpend(
	spend: ReelSpend,
	formatUsd: (n: number) => string,
): string {
	const spent = formatUsd(spend.spentUsd);
	return spend.budgetUsd == null
		? `spent ${spent}`
		: `spent ${spent} of ${formatUsd(spend.budgetUsd)}`;
}

/**
 * Format a USD amount for reel-budget copy. This module stays USD-denominated
 * by design (a real dollar cap the user sets — see the module doc above), a
 * separate unit from the credits-denominated per-action cost-preview gate
 * (`studio/cost.ts`). Lives here (rather than there) so budget callers don't
 * depend on the credits-display module for a dollar formatter.
 */
export function formatUsd(n: number): string {
	return n < 1 ? `${(n * 100).toFixed(0)}¢` : `$${n.toFixed(2)}`;
}
