import { describe, expect, it } from "bun:test";
import { normalizeSeedLock } from "../seed-lock";
import type {
	BackendCapabilities,
	BackendRequest,
	GenerationBackend,
} from "../types";

/**
 * Regression coverage for `normalizeSeedLock` — the cross-backend identity
 * layer. It must pick the strongest identity mechanism a backend actually
 * supports (seed / reference / both), clamp seeds into the signed-32-bit range,
 * strip a stale seed a reference-only backend would ignore, and honestly report
 * when identity cannot be held.
 */

const MAX_SEED = 2_147_483_647;

function caps(
	overrides: Partial<BackendCapabilities> = {},
): BackendCapabilities {
	return {
		supportsSeedLock: false,
		supportsOmniReference: false,
		supportsLastFrame: false,
		supportsReferenceEdits: false,
		intents: [],
		...overrides,
	};
}

function backend(
	capOverrides: Partial<BackendCapabilities> = {},
): GenerationBackend {
	return {
		id: "test-backend",
		label: "Test Backend",
		vendor: "test",
		modality: "video",
		safetyTier: "partner",
		capabilities: caps(capOverrides),
		requiredEnv: [],
		isAvailable: () => true,
		estimateCost: () => ({ credits: 1, basis: "test" }),
		submit: async () => ({ jobId: "j", status: "completed" }),
		poll: async () => ({ jobId: "j", status: "completed" }),
	};
}

function req(overrides: Partial<BackendRequest> = {}): BackendRequest {
	return { modality: "video", prompt: "a subject", ...overrides };
}

describe("normalizeSeedLock — unlocked draft", () => {
	it("pins the given seed (clamped) but reports identity NOT held on a seed backend", () => {
		const out = normalizeSeedLock(
			req({ seed: 12345 }),
			backend({ supportsSeedLock: true }),
			{ wantsLock: false, personaLocked: false },
		);
		expect(out.mechanism).toBe("seed");
		expect(out.identityHeld).toBe(false);
		expect(out.request.seed).toBe(12345);
	});

	it("invents a random in-range seed when none supplied", () => {
		const out = normalizeSeedLock(req(), backend({ supportsSeedLock: true }), {
			wantsLock: false,
			personaLocked: false,
		});
		expect(out.request.seed).toBeGreaterThanOrEqual(0);
		expect(out.request.seed).toBeLessThanOrEqual(MAX_SEED);
	});

	it("does nothing when the backend can't seed (mechanism none)", () => {
		const out = normalizeSeedLock(req({ seed: 5 }), backend(), {
			wantsLock: false,
			personaLocked: false,
		});
		expect(out.mechanism).toBe("none");
		expect(out.identityHeld).toBe(false);
	});
});

describe("normalizeSeedLock — locked identity", () => {
	it("uses seed+reference when the backend supports both", () => {
		const out = normalizeSeedLock(
			req({ seed: 7, referenceImageUrl: "https://cdn/persona.png" }),
			backend({ supportsSeedLock: true, supportsOmniReference: true }),
			{ wantsLock: true, personaLocked: true },
		);
		expect(out.mechanism).toBe("seed+reference");
		expect(out.identityHeld).toBe(true);
		expect(out.request.seed).toBe(7);
	});

	it("holds identity by seed alone when there's no reference still", () => {
		const out = normalizeSeedLock(
			req({ seed: 7 }),
			backend({ supportsSeedLock: true }),
			{ wantsLock: true, personaLocked: true },
		);
		expect(out.mechanism).toBe("seed");
		expect(out.identityHeld).toBe(true);
		// Persona locked but no reference → surfaced as a provenance note.
		expect(out.note).toMatch(/seed only/i);
	});

	it("holds identity by reference and STRIPS a stale seed a ref-only backend ignores", () => {
		const out = normalizeSeedLock(
			req({ seed: 999, referenceImageUrl: "https://cdn/persona.png" }),
			backend({ supportsReferenceEdits: true }),
			{ wantsLock: true, personaLocked: true },
		);
		expect(out.mechanism).toBe("reference");
		expect(out.identityHeld).toBe(true);
		expect(out.request.seed).toBeUndefined();
		expect(out.note).toMatch(/reference conditioning/i);
	});

	it("treats referenceImages[] as a valid reference source", () => {
		const out = normalizeSeedLock(
			req({ referenceImages: ["https://cdn/a.png"] }),
			backend({ supportsOmniReference: true }),
			{ wantsLock: true, personaLocked: true },
		);
		expect(out.mechanism).toBe("reference");
		expect(out.identityHeld).toBe(true);
	});

	it("reports identity NOT held when the backend supports neither mechanism", () => {
		const out = normalizeSeedLock(
			req({ referenceImageUrl: "https://cdn/persona.png" }),
			backend(),
			{ wantsLock: true, personaLocked: true },
		);
		expect(out.mechanism).toBe("none");
		expect(out.identityHeld).toBe(false);
		expect(out.note).toMatch(/neither seed-lock nor reference/i);
	});

	it("cannot use reference conditioning without an actual reference image", () => {
		// Backend can reference-edit, but no reference supplied and can't seed →
		// identity falls through to 'none'.
		const out = normalizeSeedLock(
			req(),
			backend({ supportsReferenceEdits: true }),
			{
				wantsLock: true,
				personaLocked: true,
			},
		);
		expect(out.mechanism).toBe("none");
		expect(out.identityHeld).toBe(false);
	});

	it("clamps out-of-range and fractional seeds into signed-32-bit ints", () => {
		const high = normalizeSeedLock(
			req({ seed: 9_999_999_999 }),
			backend({ supportsSeedLock: true }),
			{ wantsLock: true, personaLocked: false },
		);
		expect(high.request.seed).toBe(MAX_SEED);

		const negative = normalizeSeedLock(
			req({ seed: -42 }),
			backend({ supportsSeedLock: true }),
			{ wantsLock: true, personaLocked: false },
		);
		expect(negative.request.seed).toBe(0);

		const fractional = normalizeSeedLock(
			req({ seed: 12.9 }),
			backend({ supportsSeedLock: true }),
			{ wantsLock: true, personaLocked: false },
		);
		expect(fractional.request.seed).toBe(12);
	});
});
