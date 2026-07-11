/**
 * VIDEO adapter — Google Veo, via the public Gemini API (not Vertex).
 *
 * `generativelanguage.googleapis.com` exposes Veo as a long-running operation:
 * POST .../{model}:predictLongRunning returns an operation name, then you poll
 * that operation until `done: true`. This is Google's generic LRO pattern
 * (same shape as other async Gemini media endpoints), auth'd with a plain
 * `x-goog-api-key` header rather than OAuth — the simplest key of the five
 * providers here.
 *
 * One real wrinkle vs. our other adapters: Veo's `instances[].image` /
 * `lastFrame` / `referenceImages[].image` fields take inline base64 bytes
 * (`inlineData`), not arbitrary external URLs the way BytePlus/Kling/Luma
 * fetch server-side. Since Byorn's reference media are already-hosted public
 * URLs (R2), we fetch + base64-encode them here before submitting. For very
 * large references Google's Files API (upload once, pass a `fileUri`) would
 * be the better path — not implemented, since that's a second endpoint with
 * its own upload/poll lifecycle; flagged UNVERIFIED below.
 *
 * `GEMINI_API_KEY` comes from the validated env schema (`@byorn/env/web`); empty
 * string means "not configured" and keeps the adapter inert.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/veo
 */

import { webEnv } from "@byorn/env/web";
import { estimateVideoCredits } from "@/lib/studio/backends/cost";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	JobStatus,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { VideoOrientation } from "@/lib/studio/provider-adapter";

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

function veoBase(): string {
	return webEnv.GEMINI_BASE_URL || DEFAULT_BASE;
}

function apiKey(): string | undefined {
	return webEnv.GEMINI_API_KEY || undefined;
}

function veoModel(): string {
	return webEnv.GEMINI_VEO_MODEL || "veo-3.1-generate-preview";
}

const ASPECT_BY_ORIENTATION: Partial<Record<VideoOrientation, string>> = {
	landscape: "16:9",
	portrait: "9:16",
	// Veo does not offer a square aspect ratio; callers requesting "square"
	// fall back to landscape (UNVERIFIED — confirm Veo still lacks 1:1).
};

// Veo accepts discrete duration strings, not an arbitrary range.
function nearestDuration(sec: number | undefined): "4" | "6" | "8" {
	const n = sec ?? 6;
	if (n <= 4) return "4";
	if (n <= 6) return "6";
	return "8";
}

async function fetchAsInlineData(
	url: string,
): Promise<{ mimeType: string; data: string } | undefined> {
	try {
		const res = await fetch(url);
		if (!res.ok) return undefined;
		const mimeType = res.headers.get("content-type") || "image/png";
		const buf = Buffer.from(await res.arrayBuffer());
		return { mimeType, data: buf.toString("base64") };
	} catch {
		return undefined;
	}
}

function mapVeoStatus(done: boolean, hasError: boolean): JobStatus {
	if (hasError) return "failed";
	if (!done) return "processing";
	return "completed";
}

interface VeoOperation {
	name: string;
	done?: boolean;
	error?: { message?: string };
	response?: {
		generateVideoResponse?: {
			generatedSamples?: { video?: { uri?: string } }[];
		};
	};
}

async function veoFetch(
	path: string,
	init: RequestInit,
): Promise<VeoOperation> {
	const key = apiKey();
	if (!key) throw new Error("GEMINI_API_KEY is not configured");
	const res = await fetch(`${veoBase()}${path}`, {
		...init,
		headers: {
			...init.headers,
			"x-goog-api-key": key,
			"Content-Type": "application/json",
		},
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Veo request failed ${res.status}: ${text}`);
	}
	return (await res.json()) as VeoOperation;
}

export const googleVeoBackend: GenerationBackend = {
	id: "google-veo",
	label: "Veo 3.1",
	vendor: "Google (Gemini API)",
	modality: "video",
	// veo-3.1-generate-preview is a preview model id, not GA — experimental tier.
	safetyTier: "experimental",
	requiredEnv: ["GEMINI_API_KEY"],
	capabilities: {
		resolutions: ["720p", "1080p"],
		orientations: ["landscape", "portrait"],
		durationRangeSec: { min: 4, max: 8 },
		// No seed field in the documented instances/parameters schema.
		supportsSeedLock: false,
		// `referenceImages[].referenceType: "asset"` is real subject/style/scene
		// conditioning distinct from `image` (the animate-this-frame field).
		supportsOmniReference: true,
		// `lastFrame` field is documented alongside `image`.
		supportsLastFrame: true,
		supportsReferenceEdits: false,
		intents: ["character-video", "broll-video"],
	},

	isAvailable() {
		return Boolean(apiKey());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		// Veo is priced well above our shared per-second baseline in practice;
		// this reuses the shared table for cross-backend comparability rather
		// than inventing a bespoke (unverified) multiplier.
		const credits = estimateVideoCredits(req.resolution, req.duration);
		return {
			credits,
			basis: `Veo 3.1 ${req.resolution ?? "720p"} × ${nearestDuration(req.duration)}s`,
		};
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		try {
			const instance: Record<string, unknown> = { prompt: req.prompt };

			if (req.mode === "image-to-video" && req.referenceImageUrl) {
				const inline = await fetchAsInlineData(req.referenceImageUrl);
				if (inline) {
					instance.image = { inlineData: inline };
				}
			}
			if (req.lastFrameUrl) {
				const inline = await fetchAsInlineData(req.lastFrameUrl);
				if (inline) {
					instance.lastFrame = { inlineData: inline };
				}
			}
			if (req.referenceImages?.length) {
				const refs = await Promise.all(
					req.referenceImages.map(async (url) => {
						const inline = await fetchAsInlineData(url);
						return inline
							? { image: { inlineData: inline }, referenceType: "asset" }
							: undefined;
					}),
				);
				const filtered = refs.filter((r): r is NonNullable<typeof r> =>
					Boolean(r),
				);
				if (filtered.length) instance.referenceImages = filtered;
			}

			const body = {
				instances: [instance],
				parameters: {
					aspectRatio:
						ASPECT_BY_ORIENTATION[req.orientation ?? "landscape"] ?? "16:9",
					durationSeconds: nearestDuration(req.duration),
					resolution: req.resolution === "1080p" ? "1080p" : "720p",
					// UNVERIFIED: default person-generation policy; "allow_adult" is
					// the documented permissive default for most Veo access tiers.
					personGeneration: "allow_adult",
					numberOfVideos: 1,
					...(req.seed != null ? { seed: req.seed } : {}),
				},
			};

			const op = await veoFetch(`/models/${veoModel()}:predictLongRunning`, {
				method: "POST",
				body: JSON.stringify(body),
			});

			return {
				jobId: op.name,
				status: mapVeoStatus(Boolean(op.done), Boolean(op.error)),
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "Veo submit failed",
			};
		}
	},

	async poll(jobId: string): Promise<PollResult> {
		try {
			// The operation name is already a full resource path
			// ("models/{model}/operations/{id}"); the LRO endpoint is that path
			// rooted directly under the API version, no extra prefix.
			const op = await veoFetch(`/${jobId}`, { method: "GET" });
			const mediaUrl =
				op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
			return {
				jobId,
				status: mapVeoStatus(Boolean(op.done), Boolean(op.error)),
				// UNVERIFIED: fetching this uri may itself require the API key
				// (as a query param or x-goog-api-key header) rather than being a
				// plain public URL — confirm before wiring straight into <video src>.
				mediaUrl,
				error: op.error?.message,
			};
		} catch (err) {
			return {
				jobId,
				status: "failed",
				error: err instanceof Error ? err.message : "Veo poll failed",
			};
		}
	},
};
