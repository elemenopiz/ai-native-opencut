import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import type {
	VideoResolution,
	VideoOrientation,
	VideoMode,
} from "@/lib/studio/provider-adapter";
import {
	ensureBackendsRegistered,
	normalizeSeedLock,
	routeSlot,
	toTakeCost,
	type BackendRequest,
} from "@/lib/studio/backends";
import { renderPersonaStill } from "@/lib/studio/persona-still";
import { composePersonaVideoPrompt } from "@/lib/studio/personas";
import { STILL_SIZE_BY_ORIENTATION } from "@/lib/studio/options";
import { DEFAULT_BACKEND_ID } from "@/lib/studio/backends/registry";
import { db } from "@/lib/db";
import { generationSets, personas, takes } from "@/lib/db/schema-studio";
import { enforceRateLimit } from "@/lib/rate-limit";
import { costFor } from "@/lib/credits/cost-table";
import { InsufficientCredits } from "@/lib/credits/ledger";
import {
	insufficientCreditsResponse,
	meteredRelease,
	meteredReserve,
	meteredSettle,
	STUDIO_REF_TYPE,
} from "@/lib/credits/metering";
import type { GenerationSpec, Provenance, TakeCost } from "@/types/timeline";

// High-consistency mode renders an inline persona still (gpt-image edit +
// R2 rehost) before submitting the video job — well past the platform default.
export const maxDuration = 120;

/** Max value BytePlus accepts for a seed (signed 32-bit). */
const MAX_SEED = 2_147_483_647;

export async function POST(req: Request) {
	try {
		// Paid generation — bills our provider keys, so require a signed-in user.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Cap paid generation per account (both burst and daily volume).
		const limited = await enforceRateLimit({
			name: "studio:generate",
			request: req,
			userId: session.user.id,
		});
		if (limited) return limited;

		// Register the routed generation backends (idempotent). The unified
		// generator dispatches through this registry; without it the router has
		// nothing to resolve to.
		ensureBackendsRegistered();

		const body = (await req.json()) as {
			prompt: string;
			referenceImageUrl?: string;
			referenceImages?: string[];
			referenceVideos?: string[];
			lastFrameUrl?: string;
			seed?: number;
			resolution?: VideoResolution;
			orientation?: VideoOrientation;
			duration?: number;
			mode?: VideoMode;
			generateAudio?: boolean;
			personaId?: string;
			consistencyMode?: "high" | "fast";
			/** Manual model pin → the router's `preferredBackendId` (a backend id).
			 *  Absent ⇒ auto-route (defaults to Seedance for video). */
			model?: string;
		};

		const {
			prompt,
			referenceImageUrl,
			referenceImages,
			referenceVideos,
			lastFrameUrl,
			seed,
			resolution = "720p",
			orientation = "landscape",
			duration = 5,
			mode = "text-to-video",
			generateAudio,
			personaId,
			consistencyMode = "high",
		} = body;

		if (!prompt?.trim()) {
			return NextResponse.json(
				{ error: "prompt is required" },
				{ status: 400 },
			);
		}

		// Persona orchestration (reference-conditioned consistency). When a persona
		// is active we weave its locked descriptor into the prompt, force
		// image-to-video, and supply the reference frame per tier: Balanced ("high")
		// renders a fresh per-shot reference still — routed across the image
		// providers (GPT Image / Gemini / …) from the persona's anchor + uploaded
		// photos; Fast uses the persona's anchor image directly. All stored on the
		// set so promote-to-1080p reproduces the exact same shot.
		let finalPrompt = prompt;
		let finalReferenceImageUrl = referenceImageUrl;
		let finalMode: VideoMode = mode;

		if (personaId) {
			const persona = await db.query.personas.findFirst({
				where: eq(personas.id, personaId),
			});
			if (!persona) {
				return NextResponse.json(
					{ error: "Persona not found" },
					{ status: 404 },
				);
			}
			// Only the persona's owner may drive generation with it (anonymously
			// created personas — userId null — stay usable by any signed-in user).
			if (persona.userId && persona.userId !== session.user.id) {
				return NextResponse.json(
					{ error: "Persona not found" },
					{ status: 404 },
				);
			}

			finalPrompt = composePersonaVideoPrompt(prompt, persona.descriptor);
			finalMode = "image-to-video";

			if (consistencyMode === "fast") {
				finalReferenceImageUrl = persona.anchorImageUrl;
			} else if (referenceImageUrl) {
				// High/Durable consistency: the client pre-renders ONE reference still
				// for the whole batch and passes it here, so every draft shares an
				// identical frame (drafts stay comparable, promote-to-1080p reproduces
				// the exact shot) and we render the still once instead of per draft.
				// Fall through to rendering only when no still was supplied.
				finalReferenceImageUrl = referenceImageUrl;
			} else {
				const refImageUrls = persona.refImageUrls
					? (JSON.parse(persona.refImageUrls) as string[])
					: undefined;
				// Balanced ("high"): render a fresh per-shot reference still. This is
				// routed through the multi-provider image backends (GPT Image / Gemini
				// / …), feeding the persona's anchor + uploaded photos as references.
				//
				// Credits: this is a PAID image call, metered separately from the
				// video below (its own chargeId), mirroring personas/[id]/still —
				// reserve the default image backend's cost (the max of the tiers, so
				// the hold always covers the routed charge) BEFORE rendering, settle
				// the exact routed-backend cost on success, release the over-hold
				// difference, and release fully on failure. Without this, a direct
				// API/MCP caller gets free image generation even at 0 balance.
				const stillReserveCost = costFor(DEFAULT_BACKEND_ID.image, "image", {
					count: 1,
				});
				const stillChargeId = nanoid();
				try {
					await meteredReserve(session.user.id, stillReserveCost, {
						refType: STUDIO_REF_TYPE,
						refId: stillChargeId,
						idempotencyKey: `${stillChargeId}:reserve`,
						modality: "image",
						metadata: { kind: "persona-still", personaId },
					});
				} catch (err) {
					if (err instanceof InsufficientCredits) {
						return insufficientCreditsResponse(err);
					}
					throw err;
				}

				let still: Awaited<ReturnType<typeof renderPersonaStill>>;
				try {
					still = await renderPersonaStill({
						anchorImageUrl: persona.anchorImageUrl,
						refImageUrls,
						scenePrompt: prompt,
						descriptor: persona.descriptor,
						size: STILL_SIZE_BY_ORIENTATION[orientation],
					});
				} catch (err) {
					await meteredRelease(session.user.id, stillReserveCost, {
						refType: STUDIO_REF_TYPE,
						refId: stillChargeId,
						idempotencyKey: `${stillChargeId}:release`,
					}).catch(() => {});
					throw err;
				}

				const stillActualCost = costFor(still.backendId, "image", {
					count: 1,
				});
				if (stillActualCost > 0) {
					await meteredSettle(session.user.id, stillActualCost, {
						refType: STUDIO_REF_TYPE,
						refId: stillChargeId,
						idempotencyKey: `${stillChargeId}:settle`,
						metadata: { backendId: still.backendId, kind: "persona-still" },
					});
				}
				if (stillReserveCost > stillActualCost) {
					await meteredRelease(
						session.user.id,
						stillReserveCost - stillActualCost,
						{
							refType: STUDIO_REF_TYPE,
							refId: stillChargeId,
							idempotencyKey: `${stillChargeId}:release-diff`,
						},
					).catch(() => {});
				}

				finalReferenceImageUrl = still.imageUrl;
			}
		}

		// Always pin a concrete seed. If the caller locked one, clamp it into the
		// provider's accepted range; otherwise pick a random seed ourselves rather
		// than letting the provider choose silently — otherwise "generate 4 drafts,
		// promote the winner at 1080p" can't reproduce the shot, because the
		// provider doesn't reliably echo back the seed it used. We deliberately do
		// NOT fall back to a persona-level seed here: a batch of unlocked drafts
		// must each get a fresh random seed so the variations actually differ;
		// reproducibility comes from the per-take seed we persist below.
		const effectiveSeed =
			seed != null
				? Math.min(Math.max(0, Math.floor(seed)), MAX_SEED)
				: Math.floor(Math.random() * MAX_SEED);

		// Persist the generation set
		const setId = nanoid();
		await db.insert(generationSets).values({
			id: setId,
			userId: session.user.id,
			prompt: finalPrompt,
			referenceImageUrl: finalReferenceImageUrl,
			baseSeed: effectiveSeed,
			resolution,
			orientation,
			duration,
			mode: finalMode,
			personaId: personaId ?? null,
		});

		// Route the slot to a backend, then hold identity across whichever backend
		// was chosen. With no `model` pinned and Seedance available this resolves to
		// Seedance and — because we hand normalizeSeedLock the already-pinned
		// `effectiveSeed` as `request.seed` — the normalizer never rolls its own
		// random seed, so the exact seed we persisted on the set is the exact seed
		// submitted to the provider. The routing/normalizer layer only formalizes
		// what this route already did.
		const wantsLock = Boolean(personaId) || seed != null;
		const personaLocked = Boolean(personaId);

		const spec: GenerationSpec = {
			prompt: finalPrompt,
			model: body.model,
			mode: finalMode,
			referenceImageUrl: finalReferenceImageUrl,
			referenceImages,
			referenceVideos,
			personaId,
			consistencyMode,
			seed: effectiveSeed,
			seedLocked: seed != null,
			resolution,
			orientation,
			duration,
		};

		const request: BackendRequest = {
			modality: "video",
			prompt: finalPrompt,
			mode: finalMode,
			referenceImageUrl: finalReferenceImageUrl,
			referenceImages,
			referenceVideos,
			lastFrameUrl,
			seed: effectiveSeed,
			generateAudio,
			resolution,
			orientation,
			duration,
		};

		const route = routeSlot({
			modality: "video",
			spec,
			preferredBackendId: body.model,
		});

		if (!route.backend.isAvailable()) {
			return NextResponse.json(
				{
					error: `${route.backend.label} is not configured — set ${route.backend.requiredEnv.join(
						", ",
					)}`,
				},
				{ status: 400 },
			);
		}

		const normalized = normalizeSeedLock(request, route.backend, {
			wantsLock,
			personaLocked,
		});

		// Submit through the routed backend. `submit` never throws for provider
		// errors — it returns `{ status: "failed", error }` — so re-throw to land in
		// the outer catch (500, no take persisted), matching the pre-routing flow
		// where `generateVideo` threw on submit failure.
		// Credits: reserve BEFORE dispatching the paid provider call. Cost is
		// computed SERVER-SIDE from the routed backend + clip length; the client
		// never supplies a price. Hold it against the account (402 if the user
		// can't afford it) so we never bill a provider we can't cover. Keyed by
		// the take id — a PER-JOB charge id minted before dispatch — so the async
		// completion path (generate/[jobId]) settles/releases exactly THIS job's
		// hold. (Keying by setId was wrong: promote inserts its 1080p take into
		// the same set, so polling the promoted job could settle/release the
		// draft's hold.)
		const takeId = nanoid();
		const creditCost = costFor(route.backend.id, "video", {
			seconds: duration,
		});
		try {
			await meteredReserve(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: takeId,
				idempotencyKey: `${takeId}:reserve`,
				modality: "video",
				metadata: { backendId: route.backend.id, seconds: duration, setId },
			});
		} catch (err) {
			if (err instanceof InsufficientCredits) {
				return insufficientCreditsResponse(err);
			}
			throw err;
		}

		let result: Awaited<ReturnType<typeof route.backend.submit>>;
		try {
			result = await route.backend.submit(normalized.request);
			if (result.status === "failed") {
				throw new Error(result.error ?? "Generation failed");
			}

			// Persist the take (its id doubles as the credit-hold charge id;
			// ownership always stamped from the session)
			await db.insert(takes).values({
				id: takeId,
				setId,
				ownerId: session.user.id,
				seed: result.seed ?? effectiveSeed,
				resolution,
				providerJobId: result.jobId,
				status: result.status === "completed" ? "kept" : "drafting",
				videoUrl: result.mediaUrl ?? null,
			});

			// Sync backends finish inline — settle now. Async video (pending/
			// processing) stays reserved; the poll route settles on completion.
			if (result.status === "completed" && creditCost > 0) {
				await meteredSettle(session.user.id, creditCost, {
					refType: STUDIO_REF_TYPE,
					refId: takeId,
					idempotencyKey: `${takeId}:settle`,
					metadata: { backendId: route.backend.id },
				});
			}
		} catch (err) {
			// Never charge for a failed dispatch/persist — refund the hold.
			await meteredRelease(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: takeId,
				idempotencyKey: `${takeId}:release`,
			}).catch(() => {});
			throw err;
		}

		const provenance: Provenance = {
			backendId: route.backend.id,
			vendor: route.backend.vendor,
			model: body.model ?? route.backend.id,
			safetyTier: route.backend.safetyTier,
			routedBy: route.routedBy,
			intent: route.intent,
			seedLocked: normalized.mechanism.includes("seed"),
			generatedAt: Date.now(),
		};

		const cost: TakeCost = toTakeCost(
			route.backend.estimateCost(normalized.request),
			{ estimated: false },
		);

		return NextResponse.json({
			takeId,
			setId,
			jobId: result.jobId,
			seed: result.seed ?? effectiveSeed,
			status: result.status,
			videoUrl: result.mediaUrl,
			provenance,
			cost,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Generation failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
