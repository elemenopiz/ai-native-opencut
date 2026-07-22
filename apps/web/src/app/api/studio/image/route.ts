import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import type { ImageSize, ImageQuality } from "@/lib/studio/image-generator";
import { canRehost, rehostToR2, fetchBytes } from "@/lib/studio/media-storage";
import { db } from "@/lib/db";
import { imageStills } from "@/lib/db/schema-studio";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { aiAccessDeniedResponse, hasAiAccess } from "@/lib/ai-access";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
	availableBackends,
	defaultBackend,
	ensureBackendsRegistered,
	getBackend,
	type GenerationBackend,
} from "@/lib/studio/backends";
import { costFor } from "@/lib/credits/cost-table";
import { InsufficientCredits } from "@/lib/credits/ledger";
import {
	insufficientCreditsResponse,
	meteredRelease,
	meteredReserve,
	meteredSettle,
	STUDIO_REF_TYPE,
} from "@/lib/credits/metering";

// Synchronous image generation (+ optional R2 rehost) in one request.
export const maxDuration = 60;

export async function POST(req: Request) {
	try {
		// Paid image generation — bills our provider key, so require a signed-in user.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		if (!hasAiAccess(session.user)) return aiAccessDeniedResponse();

		// Cap paid image generation per account (both burst and daily volume).
		const limited = await enforceRateLimit({
			name: "studio:image",
			request: req,
			userId: session.user.id,
		});
		if (limited) return limited;

		const body = (await req.json()) as {
			prompt: string;
			size?: ImageSize;
			quality?: ImageQuality;
			n?: number;
			referenceImageUrl?: string;
			referenceImages?: string[];
			/** Manual model pin (a backend id) → the model picker's chosen image
			 *  backend. Absent ⇒ the platform default. Mirrors `/api/studio/generate`'s
			 *  `model` field. */
			model?: string;
		};

		// Default quality is "medium" (1K) for the beta — 2K "high" renders cost
		// ~3× more real provider spend on the shared Gemini pool for little gain
		// in a reference/reel context. Callers can still ask for "high".
		const {
			prompt,
			size = "1024x1024",
			quality = "medium",
			n = 1,
			referenceImageUrl,
			referenceImages,
			model,
		} = body;
		// Clamp the batch size: `n` now drives a loop of provider calls (one
		// submit per image), so an unclamped client value must not fan out.
		const count = Math.min(4, Math.max(1, Math.floor(n)));

		if (!prompt?.trim()) {
			return NextResponse.json(
				{ error: "prompt is required" },
				{ status: 400 },
			);
		}

		// Routed: a manually pinned model (from the panel's model picker) when
		// it's actually configured, else the platform default image backend
		// (Gemini Flash Image), else whichever image backend has a key
		// configured — so a self-hosted instance with only an OpenAI key still
		// works.
		ensureBackendsRegistered();
		const pinned = model ? getBackend(model) : undefined;
		const preferred = defaultBackend("image");
		const backend: GenerationBackend | undefined =
			pinned?.isAvailable() && pinned.modality === "image"
				? pinned
				: preferred?.isAvailable()
					? preferred
					: availableBackends("image")[0];
		if (!backend) {
			return NextResponse.json(
				{ error: "No image provider is configured on this server." },
				{ status: 503 },
			);
		}

		// Credits: image generation is synchronous — reserve the server-computed
		// cost BEFORE the paid provider call, settle on success, release on any
		// failure. Cost is flat per image × n for the routed backend.
		const imageBackendId = backend.id;
		const creditCost = costFor(imageBackendId, "image", { count });
		const chargeId = nanoid();
		try {
			await meteredReserve(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: chargeId,
				idempotencyKey: `${chargeId}:reserve`,
				metadata: { backendId: imageBackendId, count },
			});
		} catch (err) {
			if (err instanceof InsufficientCredits) {
				return insufficientCreditsResponse(err);
			}
			throw err;
		}

		// Sync image backends return the finished image inline from submit(); one
		// submit per requested image. Any failure in the batch releases the whole
		// hold — we never charge for a partial batch.
		let results: Array<{ imageUrl: string }>;
		try {
			results = await Promise.all(
				Array.from({ length: count }, async () => {
					const submitted = await backend.submit({
						modality: "image",
						prompt,
						size,
						quality,
						referenceImageUrl,
						referenceImages,
					});
					if (submitted.status !== "completed" || !submitted.mediaUrl) {
						throw new Error(submitted.error ?? "provider dispatch failed");
					}
					return { imageUrl: submitted.mediaUrl };
				}),
			);
		} catch (err) {
			await meteredRelease(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: chargeId,
				idempotencyKey: `${chargeId}:release`,
			}).catch(() => {});
			const detail =
				err instanceof Error ? err.message : "image generation failed";
			throw new Error(
				`Image generation failed (${detail}). Not charged — the credit hold was released.`,
			);
		}

		if (creditCost > 0) {
			await meteredSettle(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: chargeId,
				idempotencyKey: `${chargeId}:settle`,
				metadata: { backendId: imageBackendId, count },
			});
		}

		// Sync image backends return inline base64 (data: URLs); rehost into R2 so
		// the still has a stable, publicly-fetchable URL (needed as an
		// image-to-video reference, and so it survives beyond the response).
		// Falls back to the original on failure.
		const records = await Promise.all(
			results.map(async (r) => {
				let imageUrl = r.imageUrl;
				if (canRehost()) {
					try {
						const bytes = await fetchBytes(r.imageUrl);
						imageUrl = await rehostToR2(bytes, "image/png");
					} catch (err) {
						console.error("Failed to rehost still to R2:", err);
					}
				}
				return {
					id: nanoid(),
					userId: session.user.id,
					prompt,
					imageUrl,
					revisedPrompt: null,
					size,
					quality,
				};
			}),
		);

		await db.insert(imageStills).values(records);

		return NextResponse.json({
			images: records.map((r) => ({
				id: r.id,
				imageUrl: r.imageUrl,
				revisedPrompt: r.revisedPrompt,
			})),
		});
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Image generation failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
