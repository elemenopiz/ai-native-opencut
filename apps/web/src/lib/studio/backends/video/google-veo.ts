/**
 * VIDEO adapter — Google Veo 3.1 (Standard), via the public Gemini API (not
 * Vertex).
 *
 * `generativelanguage.googleapis.com` exposes Veo as a long-running operation:
 * POST .../{model}:predictLongRunning returns an operation name, then you poll
 * that operation until `done: true`. This is Google's generic LRO pattern
 * (same shape as other async Gemini media endpoints), auth'd with a plain
 * `x-goog-api-key` header rather than OAuth — the simplest key of the video
 * providers here.
 *
 * DIFFERENTIATOR vs. Seedance/Kling/Luma/Runway/Pika: Veo generates NATIVE
 * SYNCED AUDIO (dialogue, ambience, foley) as part of the video, with no
 * separate flag to disable it — confirmed against ai.google.dev/gemini-api/docs
 * (2026-07): "Veo 3.1 now accepts up to 3 reference images to guide...natively
 * generated audio," and there is no `generateAudio`-equivalent request field.
 * Byorn's `BackendRequest.generateAudio` (used by Seedance to request a silent
 * render) is therefore intentionally NOT wired here — Veo can't turn it off.
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
 * `GEMINI_API_KEY` comes from the validated env schema (`@byorn/env/web`);
 * empty string means "not configured" and keeps the adapter inert. Shared with
 * Imagen / Nano Banana / Veo Fast (`google-veo-fast.ts`) — one key unlocks all.
 *
 * Re-verified 2026-07-14 against ai.google.dev/gemini-api/docs/video +
 * ai.google.dev/gemini-api/docs/pricing after this adapter was briefly
 * deleted and restored: `veo-3.1-generate-preview` is still the correct model
 * id, `predictLongRunning` is still the endpoint, `referenceImages` (up to 3,
 * Veo 3.1-only) and `lastFrame` are both still documented. Two additions since
 * the original pass: a `4k` resolution tier exists at the API level (NOT
 * exposed here — Byorn's shared `VideoResolution` union only has
 * 480p/720p/1080p, same cost-control precedent as Nano Banana Pro's withheld
 * 4K), and 1080p/4k/reference-image requests require `durationSeconds: "8"`
 * (enforced below, not just nearest-rounded).
 *
 * Docs: https://ai.google.dev/gemini-api/docs/video
 */

import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/lib/studio/fetch-timeout";
import { fetchReferenceMediaSafely } from "@/lib/studio/reference-fetch";
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

export function veoBase(): string {
	return webEnv.GEMINI_BASE_URL || DEFAULT_BASE;
}

function apiKey(): string | undefined {
	return webEnv.GEMINI_API_KEY || undefined;
}

export function veoModel(): string {
	return webEnv.GEMINI_VEO_MODEL || "veo-3.1-generate-preview";
}

const ASPECT_BY_ORIENTATION: Partial<Record<VideoOrientation, string>> = {
	landscape: "16:9",
	portrait: "9:16",
	// Veo does not offer a square aspect ratio; callers requesting "square"
	// fall back to landscape (UNVERIFIED — confirm Veo still lacks 1:1).
};

// Veo accepts discrete duration strings, not an arbitrary range. 1080p, any
// reference-image conditioning, and (the not-yet-exposed) 4k all require "8"
// per the current docs — nearest-rounding alone isn't enough once those modes
// are in play, so callers requesting 1080p/refs are bumped to 8s even if they
// asked for less.
export function nearestDuration(
	sec: number | undefined,
	opts: { forceMax?: boolean } = {},
): "4" | "6" | "8" {
	if (opts.forceMax) return "8";
	const n = sec ?? 6;
	if (n <= 4) return "4";
	if (n <= 6) return "6";
	return "8";
}

/**
 * The exact clip length (seconds, as a number) Veo will actually render for this
 * request. This is the SINGLE place both `submitVeo` (what we send the provider)
 * and `estimateCost` (what we bill) resolve the duration, so the charged seconds
 * can never drift from the generated seconds. 1080p and reference-image
 * conditioning each pin Veo's 8s floor regardless of the requested duration (see
 * `nearestDuration`); everything else rounds to the nearest supported 4/6/8.
 * Derived only from request fields (resolution + referenceImages) so
 * `estimateCost` — which never fetches the reference bytes — resolves the same
 * value `submit` does from the same inputs.
 */
export function resolveVeoDurationSec(req: BackendRequest): 4 | 6 | 8 {
	const forceMax =
		req.resolution === "1080p" || (req.referenceImages?.length ?? 0) > 0;
	return Number(nearestDuration(req.duration, { forceMax })) as 4 | 6 | 8;
}

export async function fetchAsInlineData(
	url: string,
): Promise<{ mimeType: string; data: string } | undefined> {
	try {
		// Reference media download — media bytes, so the longer budget applies.
		// Goes through the shared SSRF guard: this URL is caller-supplied
		// (`req.referenceImageUrl` / `req.lastFrameUrl` / `req.referenceImages[]`),
		// so the target host must be validated as public and the connection
		// pinned before we fetch it. A rejected/failed fetch falls through to the
		// existing `undefined` contract — callers already treat a missing
		// reference as "omit it and continue" rather than failing generation.
		const { contentType, arrayBuffer } = await fetchReferenceMediaSafely(url, {
			timeoutMs: MEDIA_TIMEOUT_MS,
		});
		const mimeType = contentType || "image/png";
		return { mimeType, data: Buffer.from(arrayBuffer).toString("base64") };
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

export async function veoFetch(
	path: string,
	init: RequestInit,
): Promise<VeoOperation> {
	const key = apiKey();
	if (!key) throw new Error("GEMINI_API_KEY is not configured");
	const res = await fetchWithTimeout(`${veoBase()}${path}`, {
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

/**
 * Shared submit/poll body-builder for both Veo tiers (Standard + Fast) — the
 * request shape is identical, only the model id and pricing differ. Exported
 * so `google-veo-fast.ts` reuses it instead of forking the adapter.
 */
export async function submitVeo(
	req: BackendRequest,
	model: string,
	label: string,
): Promise<SubmitResult> {
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
		let hasReferenceImages = false;
		if (req.referenceImages?.length) {
			// Veo 3.1 documents a hard cap of 3 reference images per request.
			const refs = await Promise.all(
				req.referenceImages.slice(0, 3).map(async (url) => {
					const inline = await fetchAsInlineData(url);
					return inline
						? { image: { inlineData: inline }, referenceType: "asset" }
						: undefined;
				}),
			);
			const filtered = refs.filter((r): r is NonNullable<typeof r> =>
				Boolean(r),
			);
			if (filtered.length) {
				instance.referenceImages = filtered;
				hasReferenceImages = true;
			}
		}

		const wantsHighRes = req.resolution === "1080p";
		const body = {
			instances: [instance],
			parameters: {
				aspectRatio:
					ASPECT_BY_ORIENTATION[req.orientation ?? "landscape"] ?? "16:9",
				// Same resolver `estimateCost` bills on, so the seconds we submit are
				// exactly the seconds we charged for. `resolveVeoDurationSec` reads the
				// request's own `resolution`/`referenceImages` (not the post-fetch
				// `hasReferenceImages`), so a reference-conditioned request bills and
				// renders the 8s floor consistently.
				durationSeconds: String(resolveVeoDurationSec(req)),
				resolution: wantsHighRes ? "1080p" : "720p",
				// Per current docs: "allow_all" for text-to-video, "allow_adult" once
				// an image/reference is in play (image-to-video / reference modes).
				personGeneration:
					req.mode === "image-to-video" || hasReferenceImages
						? "allow_adult"
						: "allow_all",
				numberOfVideos: 1,
				...(req.seed != null ? { seed: req.seed } : {}),
			},
		};

		const op = await veoFetch(`/models/${model}:predictLongRunning`, {
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
			error: err instanceof Error ? err.message : `${label} submit failed`,
		};
	}
}

export async function pollVeo(
	jobId: string,
	label: string,
): Promise<PollResult> {
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
			error: err instanceof Error ? err.message : `${label} poll failed`,
		};
	}
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
		// No seed field documented on the instances/parameters schema beyond a
		// "slight consistency improvement" note — not a reproducible seed-lock.
		supportsSeedLock: false,
		// `referenceImages[].referenceType: "asset"` (up to 3) is real
		// subject/style/scene conditioning distinct from `image` (the
		// animate-this-frame field).
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
		const seconds = resolveVeoDurationSec(req);
		const credits = costFor("google-veo", "video", {
			seconds,
			resolution: req.resolution,
		});
		return {
			credits,
			basis: `Veo 3.1 ${req.resolution ?? "720p"} × ${seconds}s (native audio)`,
		};
	},

	resolveDurationSec(req: BackendRequest): number {
		return resolveVeoDurationSec(req);
	},

	submit(req: BackendRequest): Promise<SubmitResult> {
		return submitVeo(req, veoModel(), "Veo 3.1");
	},

	poll(jobId: string): Promise<PollResult> {
		return pollVeo(jobId, "Veo 3.1");
	},
};
