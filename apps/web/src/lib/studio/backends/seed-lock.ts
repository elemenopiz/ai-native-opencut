/**
 * Seed-lock normalizer — the cross-backend identity layer.
 *
 * Firefly's fatal aggregation flaw is that switching models changes your
 * character: no cross-model consistency, and a long-standing unshipped user
 * request ("Style Freeze"). Our answer: identity is preserved REGARDLESS of
 * which backend renders the take, by whichever mechanism that backend supports —
 *   1. a pinned `seed`, when the backend reproduces from seeds; else
 *   2. reference-conditioning (persona stills as omni-reference / image edits),
 *      when the backend can't seed but can condition on a reference image.
 * The persona reference is the portable identity token; the seed is the bonus.
 */

import type {
	BackendRequest,
	GenerationBackend,
} from "@/lib/studio/backends/types";

/** BytePlus / most providers accept a signed-32-bit seed. */
const MAX_SEED = 2_147_483_647;

export type IdentityMechanism = "seed" | "reference" | "seed+reference" | "none";

export interface NormalizedRequest {
	request: BackendRequest;
	/** How identity is being held for this backend choice. */
	mechanism: IdentityMechanism;
	/** True when the caller asked to lock identity and we could honor it somehow. */
	identityHeld: boolean;
	/** Surfaced to provenance / UI when we had to fall back off seed. */
	note?: string;
}

function clampSeed(seed: number): number {
	return Math.min(Math.max(0, Math.floor(seed)), MAX_SEED);
}

/**
 * Normalize a request so a locked persona/identity survives the chosen backend.
 * `wantsLock` is true when the slot is persona-driven or `seedLocked`.
 */
export function normalizeSeedLock(
	request: BackendRequest,
	backend: GenerationBackend,
	opts: { wantsLock: boolean; personaLocked: boolean },
): NormalizedRequest {
	const { wantsLock, personaLocked } = opts;
	const caps = backend.capabilities;
	const hasReference =
		Boolean(request.referenceImageUrl) ||
		(request.referenceImages?.length ?? 0) > 0;

	if (!wantsLock) {
		// Unlocked draft: pin a concrete random seed anyway when supported, so the
		// exact shot is reproducible for promote-to-1080p, but do NOT reuse one
		// seed across a batch (each draft must differ). Reproducibility comes from
		// persisting the per-take seed, not from locking here.
		if (caps.supportsSeedLock) {
			const seed =
				request.seed != null
					? clampSeed(request.seed)
					: Math.floor(Math.random() * MAX_SEED);
			return {
				request: { ...request, seed },
				mechanism: "seed",
				identityHeld: false,
			};
		}
		return { request, mechanism: "none", identityHeld: false };
	}

	// Locked: hold identity by the strongest mechanism this backend offers.
	const canSeed = caps.supportsSeedLock;
	const canReference =
		hasReference && (caps.supportsOmniReference || caps.supportsReferenceEdits);

	if (canSeed && canReference) {
		const seed =
			request.seed != null
				? clampSeed(request.seed)
				: Math.floor(Math.random() * MAX_SEED);
		return {
			request: { ...request, seed },
			mechanism: "seed+reference",
			identityHeld: true,
		};
	}
	if (canSeed) {
		const seed =
			request.seed != null
				? clampSeed(request.seed)
				: Math.floor(Math.random() * MAX_SEED);
		return {
			request: { ...request, seed },
			mechanism: "seed",
			identityHeld: true,
			note: personaLocked && !hasReference
				? "Persona held by seed only — no reference still supplied"
				: undefined,
		};
	}
	if (canReference) {
		// Backend can't seed: identity rides entirely on the reference still.
		// Strip a stale seed that this backend would ignore, to avoid false
		// "seedLocked" provenance downstream.
		const { seed: _drop, ...rest } = request;
		return {
			request: rest,
			mechanism: "reference",
			identityHeld: true,
			note: "Backend can't seed — identity held by reference conditioning",
		};
	}

	// Neither mechanism available on this backend: identity cannot be held.
	return {
		request,
		mechanism: "none",
		identityHeld: false,
		note: "Selected backend supports neither seed-lock nor reference conditioning",
	};
}
