import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
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
import { db } from "@/lib/db";
import { generationSets, personas, takes } from "@/lib/db/schema-studio";
import type { GenerationSpec, Provenance, TakeCost } from "@/types/timeline";

/** Max value BytePlus accepts for a seed (signed 32-bit). */
const MAX_SEED = 2_147_483_647;

export async function POST(req: Request) {
	try {
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
			personaId?: string;
			consistencyMode?: "high" | "fast";
			userId?: string;
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
			personaId,
			consistencyMode = "high",
			userId,
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
				const still = await renderPersonaStill({
					anchorImageUrl: persona.anchorImageUrl,
					refImageUrls,
					scenePrompt: prompt,
					descriptor: persona.descriptor,
					size: STILL_SIZE_BY_ORIENTATION[orientation],
				});
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
			userId: userId ?? null,
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
		const result = await route.backend.submit(normalized.request);
		if (result.status === "failed") {
			throw new Error(result.error ?? "Generation failed");
		}

		// Persist the take
		const takeId = nanoid();
		await db.insert(takes).values({
			id: takeId,
			setId,
			seed: result.seed ?? effectiveSeed,
			resolution,
			providerJobId: result.jobId,
			status: result.status === "completed" ? "kept" : "drafting",
			videoUrl: result.mediaUrl ?? null,
		});

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
