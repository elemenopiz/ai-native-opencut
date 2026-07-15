import {
	estimateImageCredits,
	estimateVideoCredits,
	type VideoResolution,
} from "@/lib/credits/estimate";

/** A low/high credits range (1 credit = US$0.01 of real provider cost — see
 *  `lib/credits/cost-table.ts`, the server-authoritative billing table this
 *  whole pipeline mirrors). `low === high` when the estimate is exact (a known
 *  backend); a genuine spread only appears pre-routing, when the backend that
 *  will actually run isn't known yet. */
export interface CostRange {
	low: number;
	high: number;
}

/**
 * Whether a generation renders a fresh per-shot still that adds API cost (the
 * +1 image-backend charge). Single source of truth so the cost-estimate call
 * sites can't drift on what counts toward cost.
 *
 * Only "high" (Balanced) bills for the still — it renders a per-shot reference
 * still via a routed image provider. "fast" reuses the anchor (no still), so it
 * adds nothing to the estimate.
 */
export function addsPerShotStill(
	hasPersona: boolean,
	consistencyMode: "high" | "fast" | undefined,
): boolean {
	switch (consistencyMode) {
		case "high":
			return hasPersona;
		case "fast":
		case undefined:
			return false;
	}
}

/**
 * Live, dynamic credits estimate for the current settings. `count` variations
 * share a single per-shot still (it's rendered once for the whole batch), so
 * the still cost is added ONCE while the per-second video cost scales with
 * count. Pass `backendId` when it's known (e.g. the form's selected model) for
 * an exact number. `resolution` matters even without a known backend —
 * BytePlus Seedance's real sale rate is resolution-degressive (see
 * `cost-table.ts`), so pass it whenever the UI knows it (e.g. the form's
 * selected resolution) to narrow the pre-routing range to the right tier;
 * omitted, this spans every registered video backend at every resolution.
 */
export function estimateCost(
	duration: number,
	rendersStill: boolean,
	count = 1,
	backendId?: string,
	resolution?: VideoResolution,
): CostRange {
	const video = estimateVideoCredits(duration, backendId, resolution);
	const still = rendersStill ? estimateImageCredits(1).low : 0;
	return {
		low: video.low * count + still,
		high: video.high * count + still,
	};
}

/**
 * The subset of a `GenerationSpec` a cost estimate depends on. Kept structural
 * (rather than importing the full `GenerationSpec`) so this stays a leaf module
 * with no timeline dependency — every `GenerationSpec` is assignable to it.
 */
export interface CostSpec {
	duration: number;
	personaId?: string;
	consistencyMode?: "high" | "fast";
	resolution?: VideoResolution;
}

/** Credits to generate `count` takes of a single shot from its spec. The
 *  backend that will run isn't known pre-routing, so this is a range (unless
 *  `spec.resolution` narrows Seedance's contribution to one tier). */
export function estimateSpecCost(spec: CostSpec, count = 1): CostRange {
	const rendersStill = addsPerShotStill(!!spec.personaId, spec.consistencyMode);
	return estimateCost(
		spec.duration,
		rendersStill,
		count,
		undefined,
		spec.resolution,
	);
}

/**
 * Credits for a whole batch: `count` takes for each of `specs`. `clips` is the
 * total number of takes that will actually be rendered (the batch's "size"),
 * so a caller can show "generate N clips (~low–high cr)" from one call.
 */
export function estimateBatchCost(
	specs: CostSpec[],
	count = 1,
): CostRange & { clips: number } {
	const total = specs.reduce(
		(acc, spec) => {
			const c = estimateSpecCost(spec, count);
			return { low: acc.low + c.low, high: acc.high + c.high };
		},
		{ low: 0, high: 0 },
	);
	return { ...total, clips: specs.length * count };
}

// ─── Approval gate (concept: cost-preview gate) ──────────────────────────────
// Before a batch of generations spends real API credits, we surface the
// estimate and require explicit approval. Trivial single re-rolls fall under the
// threshold and run without a prompt; anything pricier confirms first.

/**
 * Default credits ceiling above which a generation should be confirmed before
 * it runs. Sensible middle ground: a single short re-roll on a cheap backend
 * stays under it, but a multi-shot "generate all" (or a few premium-tier
 * takes) crosses it. User-overridable via `studio-settings-store`'s
 * `approvalThresholdCredits`. (50 credits = the prior $0.50 USD default.)
 */
export const DEFAULT_APPROVAL_THRESHOLD_CREDITS = 50;

/**
 * Whether an estimate warrants explicit approval. Gates on the HIGH end of the
 * range (fail toward asking) against a configurable threshold.
 */
export function needsApproval(
	estimate: CostRange,
	threshold: number = DEFAULT_APPROVAL_THRESHOLD_CREDITS,
): boolean {
	return estimate.high >= threshold;
}

/** Render an estimate as a compact "N cr" or "low–high cr" string — for
 *  standalone text (Director chat messages) with no adjacent credits icon or
 *  label to carry the unit. */
export function formatCostRange(estimate: CostRange): string {
	return estimate.low === estimate.high
		? `${estimate.low} cr`
		: `${estimate.low}–${estimate.high} cr`;
}

/** Render an estimate as a bare "N" or "low–high" number, no unit — for UI
 *  surfaces that already pair the number with a credits icon/label (the
 *  bottom bar's coin chip, the approval dialog), where a repeated "cr" reads
 *  as noise. */
export function formatCostNumber(estimate: CostRange): string {
	return estimate.low === estimate.high
		? `${estimate.low}`
		: `${estimate.low}–${estimate.high}`;
}

// ─── Audio cost (voiceover TTS + music bed) ──────────────────────────────────
// The Director's audio verbs (`addVoiceover`/`addMusicBed`) hit PAID backends
// just like a visual `generate`, so they ride the SAME cost-preview approval
// gate — these estimators mirror `estimateBatchCost`'s shape (a `CostRange`
// plus a `clips` count) so the agent's approval path treats an audio spend
// exactly like a generation one. Unlike video/image, TTS and music-bed aren't
// metered actions in `cost-table.ts` yet (no server-authoritative rate to
// mirror), so these stay independent, hand-calibrated credit estimates —
// display/approval-gate sizing only, not a billing source of truth.

/**
 * Per-1000-characters credits range for synthesized speech. Premium neural TTS
 * with voice cloning (the persona/`voiceRef` path) is billed by the length of
 * the synthesized text, so a long monologue costs materially more than a
 * one-line VO — which is exactly why it needs the approval gate.
 */
export const TTS_CREDITS_PER_1K_CHARS: [number, number] = [15, 30];

/**
 * Flat credits range for sourcing one music-bed track — a search plus a
 * licensed download from the paid sounds backend. Independent of the query and
 * of how long the bed spans (one track is fetched once, then looped/trimmed
 * locally).
 */
export const MUSIC_BED_CREDITS: [number, number] = [2, 6];

/**
 * Credits to synthesize one voiceover from its script. `clips: 1` — a VO add
 * renders a single audio take — so the gate counts it like a one-clip generate.
 * An empty script costs nothing (the verb rejects it before spending).
 */
export function estimateVoiceoverCost(
	script: string,
): CostRange & { clips: number } {
	const chars = script.trim().length;
	if (chars === 0) return { low: 0, high: 0, clips: 0 };
	const [lo, hi] = TTS_CREDITS_PER_1K_CHARS;
	const thousands = chars / 1000;
	return {
		low: Math.max(1, Math.ceil(lo * thousands)),
		high: Math.max(1, Math.ceil(hi * thousands)),
		clips: 1,
	};
}

/** Credits to lay down one music bed (flat per-track fee). `clips: 1`. */
export function estimateMusicBedCost(): CostRange & { clips: number } {
	const [lo, hi] = MUSIC_BED_CREDITS;
	return { low: lo, high: hi, clips: 1 };
}
