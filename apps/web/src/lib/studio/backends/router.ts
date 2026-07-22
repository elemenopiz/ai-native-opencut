/**
 * Slot router — auto-selects a backend by intent. This is the piece Firefly
 * conspicuously does NOT have: they make the user the router (a manual dropdown
 * over 30+ models). We route by what the slot is actually asking for, require
 * seed-lock capability for identity-critical slots, and fall back deterministically.
 *
 * A manual override (`preferredBackendId`) always wins when available — the
 * dropdown is the exception, not the default.
 *
 * ── Real-human-face routing seam (interim, campaign C2) ─────────────────────
 * BytePlus Seedance's *standard* endpoint hard-blocks generations that
 * reference a real human face — a documented BytePlus policy behavior, not a
 * bug on our side. The durable fix is BytePlus's *verified-asset* partner
 * program: once an asset is verified in the ModelArk console it's addressed
 * by an `asset://<id>` URI (see `saved-verified-assets.ts`) and the block
 * lifts for that asset. That program requires a BytePlus business
 * relationship that is currently blocked — out of our hands, not an
 * engineering task.
 *
 * Until that lands, the interim route is Runway (Gen-4 / Aleph via
 * `video/runway.ts`), which has no equivalent hard block. This router exposes
 * a narrow seam for that: `RouteInput.realFaceReference` is a signal a caller
 * sets when it knows the slot's reference material contains a real human
 * face (e.g. a persona photo with no verified-asset URI backing it yet).
 * When that signal is true AND the server env var `REAL_FACE_VIDEO_BACKEND`
 * names a registered, available *video* backend (expected value: `"runway"`),
 * that backend is preferred over the normal intent-fitness ranking — but
 * still loses to an explicit `preferredBackendId` pin, same precedence as
 * everything else auto-routed.
 *
 * `REAL_FACE_VIDEO_BACKEND` is read directly off `process.env` (not through
 * the validated `@byorn/env/web` schema — see `rate-limit.ts`'s
 * `DIRECTOR_FREE_TURNS_PER_DAY` / `TRUSTED_PROXY_HOPS` for the same pattern)
 * so this seam ships without a `packages/env` schema change. Unset ⇒ this
 * branch never fires and `routeSlot` behaves byte-for-byte as it did before
 * this signal existed.
 *
 * WAVE 2 (not this task): nothing currently sets `realFaceReference` — no
 * caller reads persona photo-provenance to populate it. That's the wiring
 * wave-2 needs: teach the caller (likely `generate-take.ts` / the
 * `/api/studio/generate` route) to detect "this slot's reference material is
 * an unverified real human face" and pass `realFaceReference: true` into
 * `RouteInput`. This file and `BackendRequest.realFaceReference` (types.ts)
 * are the seam that wiring lands on — no further archaeology needed.
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
	/**
	 * Set when the caller knows this slot's reference material contains a
	 * real human face not yet backed by a BytePlus verified asset. Combined
	 * with the `REAL_FACE_VIDEO_BACKEND` env var to prefer an interim
	 * real-face-safe backend for video slots. See the file header. Video-only;
	 * ignored for image/audio modalities. Omitted/false ⇒ no behavior change.
	 */
	realFaceReference?: boolean;
}

/**
 * Server-only env read for the interim real-face routing seam. A plain
 * default-arg `process.env` read (not `webEnv`) — see the file header for
 * why. Exported so it's independently unit-testable without mutating
 * `process.env` around every `routeSlot` call.
 */
export function realFaceVideoBackendId(
	value: string | undefined = process.env.REAL_FACE_VIDEO_BACKEND,
): BackendId | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
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
	if (
		/\b(text|title|caption|logo|typograph|word|headline)\b/i.test(spec.prompt)
	)
		return "text-in-image";
	return "broll-still";
}

function personaCritical(intent: SlotIntent): boolean {
	return intent === "character-video" || intent === "character-still";
}

/**
 * Pick a backend for a slot. Order:
 *   1. manual `preferredBackendId` if registered + available
 *   1.5. `realFaceReference` + `REAL_FACE_VIDEO_BACKEND` env override (video
 *        only) — the interim Seedance→Runway routing seam. See file header.
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

	// 1.5) Real-face interim override — video only, additive: no-op unless
	// BOTH the caller flags a real-face reference AND the env var names a
	// registered+available video backend. See file header for the rationale.
	if (modality === "video" && input.realFaceReference === true) {
		const overrideId = realFaceVideoBackendId();
		if (overrideId) {
			const overrideBackend = getBackend(overrideId);
			if (
				overrideBackend?.isAvailable() &&
				overrideBackend.modality === "video"
			) {
				return {
					backend: overrideBackend,
					intent,
					routedBy: "auto",
					reason: `Routed to ${overrideBackend.label} — real-face reference (REAL_FACE_VIDEO_BACKEND interim route)`,
				};
			}
		}
		// Named backend missing/unavailable/unset → fall through to normal
		// auto-routing below, unchanged.
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
function specToRequestShape(
	spec: GenerationSpec,
	modality: GenerationModality,
) {
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
