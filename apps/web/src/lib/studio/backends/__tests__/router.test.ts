import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { inferIntent, realFaceVideoBackendId, routeSlot } from "../router";
import { registerBackend } from "../registry";
import type {
	BackendCapabilities,
	GenerationBackend,
	GenerationModality,
	SafetyTier,
} from "../types";
import type { GenerationSpec } from "@/types/timeline";

/**
 * Regression coverage for the slot router. The registry is process-global with
 * no reset, so every test re-registers a FIXED roster of ids: we register the
 * defaults ("byteplus-seedance" / "openai-gpt-image") plus a handful of test
 * ids, resetting them all to unavailable in beforeEach and enabling only the
 * ones a given test needs. That keeps `availableBackends()` deterministic
 * without leftovers bleeding across tests.
 */

const VIDEO_DEFAULT = "byteplus-seedance";
const IMAGE_DEFAULT = "google-nano-banana";
const ROSTER = [
	VIDEO_DEFAULT,
	IMAGE_DEFAULT,
	"vidA",
	"vidB",
	"vidC",
	"imgA",
	"runway",
];

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

function makeBackend(
	id: string,
	opts: {
		modality?: GenerationModality;
		available?: boolean;
		safetyTier?: SafetyTier;
		credits?: number;
		capabilities?: Partial<BackendCapabilities>;
	} = {},
): GenerationBackend {
	const {
		modality = "video",
		available = false,
		safetyTier = "partner",
		credits = 10,
		capabilities = {},
	} = opts;
	return {
		id,
		label: id,
		vendor: "test",
		modality,
		safetyTier,
		capabilities: caps(capabilities),
		requiredEnv: [],
		isAvailable: () => available,
		estimateCost: () => ({ credits, basis: "test" }),
		submit: async () => ({ jobId: "j", status: "completed" }),
		poll: async () => ({ jobId: "j", status: "completed" }),
	};
}

/** Reset the whole roster to unavailable so leftovers can't match. */
function resetRoster() {
	for (const id of ROSTER) {
		const modality: GenerationModality =
			id.startsWith("img") || id === IMAGE_DEFAULT ? "image" : "video";
		registerBackend(makeBackend(id, { modality, available: false }));
	}
}

function spec(overrides: Partial<GenerationSpec> = {}): GenerationSpec {
	return {
		prompt: "a wide desert landscape",
		mode: "text-to-video",
		resolution: "720p",
		orientation: "landscape",
		duration: 6,
		...overrides,
	};
}

beforeEach(() => {
	resetRoster();
});

describe("inferIntent", () => {
	it("routes identity-locked video to character-video", () => {
		expect(inferIntent(spec({ seedLocked: true }), "video")).toBe(
			"character-video",
		);
		expect(inferIntent(spec({ personaId: "p1" }), "video")).toBe(
			"character-video",
		);
	});

	it("routes plain video to broll-video", () => {
		expect(inferIntent(spec(), "video")).toBe("broll-video");
	});

	it("routes identity-locked stills to character-still", () => {
		expect(inferIntent(spec({ personaId: "p1" }), "image")).toBe(
			"character-still",
		);
	});

	it("routes typography-signalled prompts to text-in-image", () => {
		expect(
			inferIntent(
				spec({ prompt: "a bold headline poster with big text" }),
				"image",
			),
		).toBe("text-in-image");
	});

	it("routes generic stills to broll-still", () => {
		expect(inferIntent(spec({ prompt: "a mossy rock" }), "image")).toBe(
			"broll-still",
		);
	});
});

describe("routeSlot — manual pin", () => {
	it("honors a preferred backend that is available and modality-matched", () => {
		registerBackend(
			makeBackend("vidA", {
				modality: "video",
				available: true,
				capabilities: { intents: ["broll-video"] },
			}),
		);
		const res = routeSlot({
			modality: "video",
			spec: spec(),
			preferredBackendId: "vidA",
		});
		expect(res.backend.id).toBe("vidA");
		expect(res.routedBy).toBe("manual");
	});

	it("ignores a preferred backend whose modality doesn't match and auto-routes instead", () => {
		registerBackend(
			makeBackend("imgA", { modality: "image", available: true }),
		);
		registerBackend(
			makeBackend("vidA", {
				modality: "video",
				available: true,
				capabilities: { intents: ["broll-video"] },
			}),
		);
		const res = routeSlot({
			modality: "video",
			spec: spec(),
			preferredBackendId: "imgA",
		});
		expect(res.routedBy).toBe("auto");
		expect(res.backend.id).toBe("vidA");
	});

	it("ignores an unavailable preferred backend and falls through to auto", () => {
		registerBackend(
			makeBackend("vidA", { modality: "video", available: false }),
		);
		registerBackend(
			makeBackend("vidB", {
				modality: "video",
				available: true,
				capabilities: { intents: ["broll-video"] },
			}),
		);
		const res = routeSlot({
			modality: "video",
			spec: spec(),
			preferredBackendId: "vidA",
		});
		expect(res.routedBy).toBe("auto");
		expect(res.backend.id).toBe("vidB");
	});
});

describe("routeSlot — auto ranking", () => {
	it("ranks by safety tier first (indemnified beats partner)", () => {
		registerBackend(
			makeBackend("vidA", {
				available: true,
				safetyTier: "partner",
				credits: 1,
				capabilities: { intents: ["broll-video"] },
			}),
		);
		registerBackend(
			makeBackend("vidB", {
				available: true,
				safetyTier: "indemnified-equivalent",
				credits: 100,
				capabilities: { intents: ["broll-video"] },
			}),
		);
		const res = routeSlot({ modality: "video", spec: spec() });
		// Higher tier wins even though it's pricier.
		expect(res.backend.id).toBe("vidB");
	});

	it("breaks a tier tie by cheapest estimate", () => {
		registerBackend(
			makeBackend("vidA", {
				available: true,
				safetyTier: "partner",
				credits: 30,
				capabilities: { intents: ["broll-video"] },
			}),
		);
		registerBackend(
			makeBackend("vidB", {
				available: true,
				safetyTier: "partner",
				credits: 5,
				capabilities: { intents: ["broll-video"] },
			}),
		);
		const res = routeSlot({ modality: "video", spec: spec() });
		expect(res.backend.id).toBe("vidB");
	});

	it("requires seed-lock or reference-edit support for persona-critical slots", () => {
		// Matches the intent but holds no identity → excluded.
		registerBackend(
			makeBackend("vidA", {
				available: true,
				credits: 1,
				capabilities: { intents: ["character-video"] },
			}),
		);
		// Can hold identity via seed → the only valid candidate.
		registerBackend(
			makeBackend("vidB", {
				available: true,
				credits: 50,
				capabilities: { intents: ["character-video"], supportsSeedLock: true },
			}),
		);
		const res = routeSlot({
			modality: "video",
			spec: spec({ seedLocked: true }),
		});
		expect(res.backend.id).toBe("vidB");
		expect(res.intent).toBe("character-video");
	});
});

describe("routeSlot — fallback", () => {
	it("falls back to the modality default when no candidate fits", () => {
		// Default registered and available, but nothing matches the intent otherwise.
		registerBackend(
			makeBackend(VIDEO_DEFAULT, {
				modality: "video",
				available: true,
				capabilities: { intents: [] },
			}),
		);
		const res = routeSlot({ modality: "video", spec: spec() });
		expect(res.backend.id).toBe(VIDEO_DEFAULT);
		expect(res.reason).toMatch(/default/i);
	});

	it("returns the default even when unavailable so the caller can surface a config error", () => {
		registerBackend(
			makeBackend(VIDEO_DEFAULT, { modality: "video", available: false }),
		);
		const res = routeSlot({ modality: "video", spec: spec() });
		expect(res.backend.id).toBe(VIDEO_DEFAULT);
		expect(res.reason).toMatch(/not configured/i);
	});
});

describe("realFaceVideoBackendId", () => {
	it("returns undefined when the value is unset", () => {
		expect(realFaceVideoBackendId(undefined)).toBeUndefined();
	});

	it("returns undefined for an empty/whitespace-only value", () => {
		expect(realFaceVideoBackendId("")).toBeUndefined();
		expect(realFaceVideoBackendId("   ")).toBeUndefined();
	});

	it("returns the trimmed backend id when set", () => {
		expect(realFaceVideoBackendId("runway")).toBe("runway");
		expect(realFaceVideoBackendId("  runway  ")).toBe("runway");
	});
});

describe("routeSlot — real-face interim routing seam (REAL_FACE_VIDEO_BACKEND)", () => {
	const ENV_KEY = "REAL_FACE_VIDEO_BACKEND";
	const originalEnv = process.env[ENV_KEY];

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env[ENV_KEY];
		} else {
			process.env[ENV_KEY] = originalEnv;
		}
	});

	function withDefaultAndRunway(runwayAvailable: boolean) {
		registerBackend(
			makeBackend(VIDEO_DEFAULT, {
				modality: "video",
				available: true,
				capabilities: { intents: ["broll-video"] },
			}),
		);
		registerBackend(
			makeBackend("runway", {
				modality: "video",
				available: runwayAvailable,
				capabilities: { intents: ["broll-video", "character-video"] },
			}),
		);
	}

	it("flag unset: routing is unchanged even with realFaceReference: true", () => {
		delete process.env[ENV_KEY];
		withDefaultAndRunway(true);

		const withFlag = routeSlot({
			modality: "video",
			spec: spec(),
			realFaceReference: true,
		});
		const withoutFlag = routeSlot({ modality: "video", spec: spec() });

		// Byte-for-byte same RouteResult shape/values either way.
		expect(withFlag).toEqual(withoutFlag);
		expect(withFlag.backend.id).toBe(VIDEO_DEFAULT);
	});

	it("realFaceReference unset (env set): routing is unchanged", () => {
		process.env[ENV_KEY] = "runway";
		withDefaultAndRunway(true);

		const res = routeSlot({ modality: "video", spec: spec() });
		expect(res.backend.id).toBe(VIDEO_DEFAULT);
	});

	it("flag set + named backend available: routes real-face video requests to it", () => {
		process.env[ENV_KEY] = "runway";
		withDefaultAndRunway(true);

		const res = routeSlot({
			modality: "video",
			spec: spec(),
			realFaceReference: true,
		});
		expect(res.backend.id).toBe("runway");
		expect(res.routedBy).toBe("auto");
		expect(res.reason).toMatch(/real-face/i);
	});

	it("flag set + named backend unavailable: falls back to default with no throw", () => {
		process.env[ENV_KEY] = "runway";
		withDefaultAndRunway(false);

		let res: ReturnType<typeof routeSlot> | undefined;
		expect(() => {
			res = routeSlot({
				modality: "video",
				spec: spec(),
				realFaceReference: true,
			});
		}).not.toThrow();
		expect(res?.backend.id).toBe(VIDEO_DEFAULT);
	});

	it("flag set + named backend not registered: falls back to default with no throw", () => {
		process.env[ENV_KEY] = "does-not-exist";
		registerBackend(
			makeBackend(VIDEO_DEFAULT, {
				modality: "video",
				available: true,
				capabilities: { intents: ["broll-video"] },
			}),
		);

		const res = routeSlot({
			modality: "video",
			spec: spec(),
			realFaceReference: true,
		});
		expect(res.backend.id).toBe(VIDEO_DEFAULT);
	});

	it("a manual pin still wins over the real-face override", () => {
		withDefaultAndRunway(true);
		process.env[ENV_KEY] = "runway";
		registerBackend(
			makeBackend("vidA", {
				modality: "video",
				available: true,
				capabilities: { intents: ["broll-video"] },
			}),
		);

		const res = routeSlot({
			modality: "video",
			spec: spec(),
			realFaceReference: true,
			preferredBackendId: "vidA",
		});
		expect(res.backend.id).toBe("vidA");
		expect(res.routedBy).toBe("manual");
	});

	it("non-video modality is unaffected by the real-face flag/env", () => {
		process.env[ENV_KEY] = "runway";
		registerBackend(
			makeBackend(IMAGE_DEFAULT, {
				modality: "image",
				available: true,
				capabilities: { intents: ["broll-still"] },
			}),
		);

		const res = routeSlot({
			modality: "image",
			spec: spec({ prompt: "a mossy rock" }),
			// realFaceReference is typed video-only in intent, but the router must
			// still ignore it for a non-video modality even if a caller sets it.
			realFaceReference: true,
		});
		expect(res.backend.id).toBe(IMAGE_DEFAULT);
		expect(res.reason).not.toMatch(/real-face/i);
	});
});
