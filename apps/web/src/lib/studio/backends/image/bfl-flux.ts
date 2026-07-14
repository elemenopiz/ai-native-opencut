/**
 * Image adapter — FLUX1.1 [pro] Ultra / FLUX.1 Kontext [pro] (Black Forest Labs).
 *
 * Native BFL API (api.bfl.ai), not an aggregator. BFL's image endpoints are
 * genuinely ASYNC — submit returns `{ id, polling_url }` and you must GET the
 * exact `polling_url` returned (BFL explicitly disallows constructing your own
 * polling endpoint — it routes across regional clusters). Because typical FLUX
 * jobs settle in a few seconds, `submit()` polls that `polling_url` inline for
 * a short budget so most callers get a `completed` result synchronously, same
 * as the other image backends; if the budget is exhausted it returns
 * `status: "processing"` with `jobId` set to the `polling_url` itself (the only
 * string BFL accepts back), so `poll()` can keep querying it.
 *
 * - Text-to-image: POST /v1/flux-pro-1.1-ultra (aspect_ratio, no width/height).
 * - Reference edit / identity carry: POST /v1/flux-kontext-pro (input_image,
 *   base64) — used automatically when `req.referenceImageUrl` is set.
 */

import { webEnv } from "@byorn/env/web";
import { nanoid } from "nanoid";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/lib/studio/fetch-timeout";
import { costFor } from "@/lib/credits/cost-table";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { ImageSize } from "@/lib/studio/image-generator";

// BFL_API_KEY comes from the validated env schema (`@byorn/env/web`);
// empty string means "not configured".
const BFL_API_KEY_ENV = "BFL_API_KEY";

// Global endpoint; BFL also offers api.eu.bfl.ai / api.us.bfl.ai regional
// pinning, not needed here. https://docs.bfl.ml/quick_start/generating_images
const BFL_BASE = "https://api.bfl.ai/v1";

// BFL has no discrete low/medium/high quality knob — ultra is a fixed
// high-fidelity 4-megapixel output. The actual credit cost lives in
// `cost-table.ts` (`costFor("bfl-flux", "image", ...)`) — see `estimateCost`
// below, which reads it directly rather than hand-rolling a second number.

interface BflSubmitResponse {
	id: string;
	polling_url: string;
}

interface BflPollResponse {
	status:
		| "Ready"
		| "Pending"
		| "Error"
		| "Request Moderated"
		| "Content Moderated"
		| "Task not found";
	result?: { sample?: string };
}

function mapSizeToAspectRatio(size?: ImageSize): string {
	switch (size) {
		case "1536x1024":
			return "3:2";
		case "1024x1536":
			return "2:3";
		case "1024x1024":
		default:
			return "1:1";
	}
}

async function fetchAsBase64(url: string): Promise<string> {
	// Reference image download — media bytes, so the longer budget applies.
	const res = await fetchWithTimeout(url, { timeoutMs: MEDIA_TIMEOUT_MS });
	if (!res.ok) {
		throw new Error(`Failed to fetch reference image (${res.status})`);
	}
	const buf = await res.arrayBuffer();
	return Buffer.from(buf).toString("base64");
}

/** One GET against BFL's returned `polling_url`, mapped to our PollResult. */
async function pollOnce(pollingUrl: string, key: string): Promise<PollResult> {
	const res = await fetchWithTimeout(pollingUrl, {
		headers: { accept: "application/json", "x-key": key },
	});
	if (!res.ok) {
		return {
			jobId: pollingUrl,
			status: "failed",
			error: `BFL poll failed ${res.status}`,
		};
	}
	const data = (await res.json()) as BflPollResponse;
	if (data.status === "Ready") {
		return {
			jobId: pollingUrl,
			status: "completed",
			mediaUrl: data.result?.sample,
		};
	}
	if (
		data.status === "Error" ||
		data.status === "Request Moderated" ||
		data.status === "Content Moderated" ||
		data.status === "Task not found"
	) {
		return { jobId: pollingUrl, status: "failed", error: data.status };
	}
	return { jobId: pollingUrl, status: "processing" };
}

/** Poll inline for a short budget so most jobs resolve synchronously. */
async function pollUntilSettledOrBudget(
	pollingUrl: string,
	key: string,
	attempts = 8,
	delayMs = 1200,
): Promise<PollResult> {
	for (let i = 0; i < attempts; i++) {
		const result = await pollOnce(pollingUrl, key);
		if (result.status === "completed" || result.status === "failed") {
			return result;
		}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	return { jobId: pollingUrl, status: "processing" };
}

export const bflFluxBackend: GenerationBackend = {
	id: "bfl-flux",
	label: "FLUX1.1 [pro] Ultra",
	vendor: "Black Forest Labs",
	modality: "image",
	safetyTier: "partner",
	requiredEnv: [BFL_API_KEY_ENV],
	capabilities: {
		// BFL's aspect_ratio enum maps cleanly onto our three ImageSize values.
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"], // ultra has one fixed quality tier — see estimateCost
		supportsSeedLock: true, // real reproducible `seed` param
		supportsOmniReference: false,
		supportsLastFrame: false,
		supportsReferenceEdits: true, // flux-kontext-pro carries identity via input_image
		intents: ["character-still", "broll-still", "text-in-image"],
	},

	isAvailable() {
		return Boolean(webEnv.BFL_API_KEY);
	},

	estimateCost(_req: BackendRequest): CostEstimate {
		// Read the shared billing table directly (was a hand-set, drifted
		// constant here — display now always equals what's actually charged).
		const credits = costFor("bfl-flux", "image", { count: 1 });
		return { credits, basis: "FLUX1.1 [pro] Ultra (fixed quality tier)" };
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		const key = webEnv.BFL_API_KEY;
		if (!key) {
			return {
				jobId: "",
				status: "failed",
				error: "BFL_API_KEY is not configured",
			};
		}

		try {
			const useKontext = Boolean(req.referenceImageUrl);
			const endpoint = useKontext ? "flux-kontext-pro" : "flux-pro-1.1-ultra";
			const body: Record<string, unknown> = { prompt: req.prompt };
			if (req.seed !== undefined) body.seed = req.seed;

			if (useKontext && req.referenceImageUrl) {
				// UNVERIFIED: exact base64 framing (raw vs data-URI prefixed) for
				// flux-kontext-pro's `input_image` — sending raw base64 per BFL's
				// general image-input convention.
				body.input_image = await fetchAsBase64(req.referenceImageUrl);
			} else {
				body.aspect_ratio = mapSizeToAspectRatio(req.size);
			}

			const submitRes = await fetchWithTimeout(`${BFL_BASE}/${endpoint}`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"x-key": key,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (!submitRes.ok) {
				const text = await submitRes.text();
				return {
					jobId: "",
					status: "failed",
					error: `BFL submit failed ${submitRes.status}: ${text}`,
				};
			}

			const data = (await submitRes.json()) as BflSubmitResponse;
			if (!data.polling_url) {
				return {
					jobId: "",
					status: "failed",
					error: "BFL response missing polling_url",
				};
			}

			const settled = await pollUntilSettledOrBudget(data.polling_url, key);
			return { ...settled, seed: req.seed };
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "FLUX submit failed",
			};
		}
	},

	// jobId doubles as BFL's `polling_url` (the only handle it accepts back) —
	// see the module doc comment for why we can't construct our own endpoint.
	async poll(jobId: string): Promise<PollResult> {
		const key = webEnv.BFL_API_KEY;
		if (!key) {
			return {
				jobId,
				status: "failed",
				error: "BFL_API_KEY is not configured",
			};
		}
		try {
			return await pollOnce(jobId, key);
		} catch (err) {
			return {
				jobId,
				status: "failed",
				error: err instanceof Error ? err.message : "FLUX poll failed",
			};
		}
	},
};
