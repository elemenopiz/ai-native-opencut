/**
 * Camera & motion presets — the Higgsfield "Cinema Studio" idea, made
 * prompt-driven. Each preset is a directorial prompt fragment that gets woven
 * into the generation prompt, so the camera move works without needing
 * model-specific camera-control params.
 *
 * The fragment is appended to the user's prompt at generation time and becomes
 * part of the stored generation_set prompt, so seed-lock promotion and history
 * replay the exact same camera move.
 */

export type CameraCategory =
	| "Basic"
	| "Push / Pull"
	| "Tracking"
	| "Crane / Aerial"
	| "Dramatic"
	| "Handheld";

export interface CameraPreset {
	id: string;
	label: string;
	category: CameraCategory;
	/** Woven into the prompt to direct the camera. */
	fragment: string;
	/** One-line hint shown in the picker. */
	hint: string;
}

export const CAMERA_PRESETS: CameraPreset[] = [
	// ── Basic ────────────────────────────────────────────────────────────────
	{ id: "static", label: "Static", category: "Basic", fragment: "locked-off static camera, no movement", hint: "Tripod-locked, no motion" },
	{ id: "pan-left", label: "Pan Left", category: "Basic", fragment: "smooth camera pan to the left", hint: "Rotate horizontally left" },
	{ id: "pan-right", label: "Pan Right", category: "Basic", fragment: "smooth camera pan to the right", hint: "Rotate horizontally right" },
	{ id: "tilt-up", label: "Tilt Up", category: "Basic", fragment: "camera tilts upward, revealing from bottom to top", hint: "Angle up to reveal" },
	{ id: "tilt-down", label: "Tilt Down", category: "Basic", fragment: "camera tilts downward, revealing from top to bottom", hint: "Angle down to reveal" },

	// ── Push / Pull ──────────────────────────────────────────────────────────
	{ id: "dolly-in", label: "Dolly In", category: "Push / Pull", fragment: "slow dolly-in, camera pushes steadily toward the subject", hint: "Move toward subject" },
	{ id: "dolly-out", label: "Dolly Out", category: "Push / Pull", fragment: "slow dolly-out, camera pulls back away from the subject", hint: "Pull back to reveal" },
	{ id: "zoom-in", label: "Zoom In", category: "Push / Pull", fragment: "gradual zoom in on the subject", hint: "Optical zoom in" },
	{ id: "zoom-out", label: "Zoom Out", category: "Push / Pull", fragment: "gradual zoom out from the subject", hint: "Optical zoom out" },

	// ── Tracking ───────────────────────────────────────────────────────────────
	{ id: "truck-left", label: "Truck Left", category: "Tracking", fragment: "camera trucks left, sliding sideways to the left", hint: "Slide sideways left" },
	{ id: "truck-right", label: "Truck Right", category: "Tracking", fragment: "camera trucks right, sliding sideways to the right", hint: "Slide sideways right" },
	{ id: "tracking-follow", label: "Tracking Follow", category: "Tracking", fragment: "tracking shot following the subject from behind, smooth steadicam motion", hint: "Follow the subject" },
	{ id: "orbit-left", label: "Orbit Left", category: "Tracking", fragment: "camera orbits around the subject counter-clockwise in a smooth arc", hint: "Arc around left" },
	{ id: "orbit-right", label: "Orbit Right", category: "Tracking", fragment: "camera orbits around the subject clockwise in a smooth arc", hint: "Arc around right" },

	// ── Crane / Aerial ─────────────────────────────────────────────────────────
	{ id: "crane-up", label: "Crane Up", category: "Crane / Aerial", fragment: "crane shot rising upward, boom up to a high angle", hint: "Boom up high" },
	{ id: "crane-down", label: "Crane Down", category: "Crane / Aerial", fragment: "crane shot descending downward, boom down to a low angle", hint: "Boom down low" },
	{ id: "fpv-drone", label: "FPV Drone", category: "Crane / Aerial", fragment: "fast FPV drone shot flying dynamically through the scene", hint: "Fast flying drone" },
	{ id: "aerial-pullback", label: "Aerial Pull Back", category: "Crane / Aerial", fragment: "aerial drone shot pulling back and rising to reveal the wider landscape", hint: "Reveal from above" },

	// ── Dramatic ───────────────────────────────────────────────────────────────
	{ id: "crash-zoom-in", label: "Crash Zoom In", category: "Dramatic", fragment: "sudden crash zoom in, rapid aggressive zoom toward the subject", hint: "Snap zoom in" },
	{ id: "crash-zoom-out", label: "Crash Zoom Out", category: "Dramatic", fragment: "sudden crash zoom out, rapid aggressive zoom away from the subject", hint: "Snap zoom out" },
	{ id: "dolly-zoom", label: "Dolly Zoom", category: "Dramatic", fragment: "dolly zoom vertigo effect, background warps while the subject stays the same size", hint: "Vertigo / Hitchcock" },
	{ id: "bullet-time", label: "Bullet Time", category: "Dramatic", fragment: "bullet-time effect, camera rotates around the frozen subject in slow motion", hint: "Frozen 360 spin" },
	{ id: "whip-pan", label: "Whip Pan", category: "Dramatic", fragment: "fast whip pan with motion blur transitioning across the scene", hint: "Fast blurred pan" },

	// ── Handheld ───────────────────────────────────────────────────────────────
	{ id: "handheld", label: "Handheld", category: "Handheld", fragment: "handheld camera with natural subtle shake, documentary feel", hint: "Natural handheld shake" },
	{ id: "shaky-action", label: "Shaky Action", category: "Handheld", fragment: "intense shaky handheld camera, frantic action-cam movement", hint: "Frantic action cam" },
	{ id: "snorricam", label: "Snorricam", category: "Handheld", fragment: "snorricam shot rigidly attached to the subject, background swirls around them", hint: "Body-mounted rig" },
];

export const CAMERA_CATEGORIES: CameraCategory[] = [
	"Basic",
	"Push / Pull",
	"Tracking",
	"Crane / Aerial",
	"Dramatic",
	"Handheld",
];

export function getCameraPreset(id: string | null | undefined): CameraPreset | undefined {
	if (!id) return undefined;
	return CAMERA_PRESETS.find((p) => p.id === id);
}

/** Compose the final generation prompt, weaving in the camera fragment. */
export function composePromptWithCamera(prompt: string, presetId: string | null): string {
	const preset = getCameraPreset(presetId);
	if (!preset) return prompt;
	const base = prompt.trim().replace(/[.,]\s*$/, "");
	return `${base}. ${preset.fragment}.`;
}
