/**
 * Slot router — auto-selects a backend by intent. This is the piece Firefly
 * conspicuously does NOT have: they make the user the router (a manual dropdown
 * over 30+ models). We route by what the slot is actually asking for, require
 * seed-lock capability for identity-critical slots, and fall back deterministically.
 *
 * A manual override (`preferredBackendId`) always wins when available — the
 * dropdown is the exception, not the default.
 */

import type { GenerationSpec } from "@/types/timeline";
import {
	availableBackends,
	defaultBackend,
	getBackend,
} from "@/lib/studio/backends/registry";
import type {
	BackendId,
	GenerationBackend,
	GenerationModality,
	SafetyTier,
	SlotIntent,
} from "@/lib/studio/backends/types";

export interface RouteInput {
	modality: GenerationModality;
	spec: GenerationSpec;
	/** Explicit intent overrides inference. */
	intent?: SlotIntent;
	/** Manual model pin (the "exception" dropdown). Wins when available. */
	preferredBackendId?: BackendId;
}

export interface RouteResult {
	backend: GenerationBackend;
	intent: SlotIntent;
	routedBy: "auto" | "manual";
	/** Human-readable reason, shown in the slot's routing tooltip / provenance. */
	reason: string;
}

/** Safety-tier preference order for identity/brand-sensitive work. */
const TIER_RANK: Record<SafetyTier, number> = {
	"indemnified-equivalent": 0,
	partner: 1,
	experimental: 2,
};

/** Derive intent from the spec when a caller didn't set it explicitly. */
export function inferIntent(
	spec: GenerationSpec,
	modality: GenerationModality,
): SlotIntent {
	const identityLocked = Boolean(spec.personaId) || spec.seedLocked === true;
	if (modality === "video") {
		return identityLocked ? "character-video" : "broll-video";
	}
	// Image intents. Heuristic: a persona/identity lock → character still;
	// otherwise a light prompt signal for typography-heavy stills.
	if (identityLocked) return "character-still";
	if (/\b(text|title|caption|logo|typograph|word|headline)\b/i.test(spec.prompt))
		return "text-in-image";
	return "broll-still";
}

function personaCritical(intent: SlotIntent): boolean {
	return intent === "character-video" || intent === "character-still";
}

/**
 * Pick a backend for a slot. Order:
 *   1. manual `preferredBackendId` if registered + available
 *   2. available backends whose `capabilities.intents` include the intent,
 *      requiring seed-lock OR reference-edit support for persona-critical slots
 *      (so identity survives), ranked by safety tier then cheapest estimate
 *   3. the modality default (Seedance / GPT Image)
 * Never throws — always resolves to *some* backend so a slot can always generate.
 */
export function routeSlot(input: RouteInput): RouteResult {
	const { modality, spec } = input;
	const intent = input.intent ?? inferIntent(spec, modality);

	// 1) Manual pin — the exception dropdown.
	if (input.preferredBackendId) {
		const pinned = getBackend(input.preferredBackendId);
		if (pinned && pinned.isAvailable() && pinned.modality === modality) {
			return {
				backend: pinned,
				intent,
				routedBy: "manual",
				reason: `Pinned to ${pinned.label}`,
			};
		}
	}

	// 2) Auto-route by intent fitness.
	const req = specToRequestShape(spec, modality);
	const needsIdentity = personaCritical(intent);
	const candidates = availableBackends(modality)
		.filter((b) => b.capabilities.intents.includes(intent))
		.filter((b) =>
			needsIdentity
				? b.capabilities.supportsSeedLock ||
					b.capabilities.supportsReferenceEdits
				: true,
		)
		.sort((a, b) => {
			const tier = TIER_RANK[a.safetyTier] - TIER_RANK[b.safetyTier];
			if (tier !== 0) return tier;
			return a.estimateCost(req).credits - b.estimateCost(req).credits;
		});

	if (candidates[0]) {
		return {
			backend: candidates[0],
			intent,
			routedBy: "auto",
			reason: `Auto-routed for ${intent} (${candidates[0].safetyTier})`,
		};
	}

	// 3) Deterministic fallback.
	const fallback = defaultBackend(modality);
	if (fallback && fallback.isAvailable()) {
		return {
			backend: fallback,
			intent,
			routedBy: "auto",
			reason: `Fell back to default ${fallback.label}`,
		};
	}
	if (fallback) {
		// Even if the default reports unavailable (missing key), return it so the
		// caller surfaces a clear "configure X" error rather than a null crash.
		return {
			backend: fallback,
			intent,
			routedBy: "auto",
			reason: `Default ${fallback.label} (not configured)`,
		};
	}
	throw new Error(`No backend registered for modality "${modality}"`);
}

/** Minimal spec→request projection for cost ranking (full mapping lives in the
 *  wiring layer). Kept local so the router has no dependency on the API route. */
function specToRequestShape(spec: GenerationSpec, modality: GenerationModality) {
	return {
		modality,
		prompt: spec.prompt,
		mode: spec.mode,
		referenceImageUrl: spec.referenceImageUrl,
		referenceImages: spec.referenceImages,
		referenceVideos: spec.referenceVideos,
		seed: spec.seed,
		resolution: spec.resolution,
		orientation: spec.orientation,
		duration: spec.duration,
	} as const;
}
