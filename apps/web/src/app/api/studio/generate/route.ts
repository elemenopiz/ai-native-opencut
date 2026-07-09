import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
	generateVideo,
	type VideoResolution,
	type VideoOrientation,
	type VideoMode,
} from "@/lib/studio/provider-adapter";
import { renderPersonaStill } from "@/lib/studio/persona-still";
import { composePersonaVideoPrompt } from "@/lib/studio/personas";
import { STILL_SIZE_BY_ORIENTATION } from "@/lib/studio/options";
import { db } from "@/lib/db";
import { generationSets, personas, takes } from "@/lib/db/schema-studio";

/** Max value BytePlus accepts for a seed (signed 32-bit). */
const MAX_SEED = 2_147_483_647;

export async function POST(req: Request) {
	try {
		const body = await req.json() as {
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
			return NextResponse.json({ error: "prompt is required" }, { status: 400 });
		}

		// Persona orchestration (reference-conditioned consistency). When a persona
		// is active we weave its locked descriptor into the prompt, force
		// image-to-video, and supply the reference frame: High renders a fresh
		// per-shot still of the same character via gpt-image-2 edits; Fast uses the
		// persona's anchor image directly. All stored on the set so promote-to-1080p
		// reproduces the exact same shot.
		let finalPrompt = prompt;
		let finalReferenceImageUrl = referenceImageUrl;
		let finalMode: VideoMode = mode;

		if (personaId) {
			const persona = await db.query.personas.findFirst({
				where: eq(personas.id, personaId),
			});
			if (!persona) {
				return NextResponse.json({ error: "Persona not found" }, { status: 404 });
			}

			finalPrompt = composePersonaVideoPrompt(prompt, persona.descriptor);
			finalMode = "image-to-video";

			if (consistencyMode === "fast") {
				finalReferenceImageUrl = persona.anchorImageUrl;
			} else if (referenceImageUrl) {
				// High consistency: the client pre-renders ONE reference still for the
				// whole batch and passes it here, so every draft shares an identical
				// frame (drafts stay comparable, promote-to-1080p reproduces the exact
				// shot) and we pay for a single gpt-image render instead of one per
				// draft. Fall through to rendering only when no still was supplied.
				finalReferenceImageUrl = referenceImageUrl;
			} else {
				const refImageUrls = persona.refImageUrls
					? (JSON.parse(persona.refImageUrls) as string[])
					: undefined;
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

		// Submit to provider
		const result = await generateVideo({
			prompt: finalPrompt,
			referenceImageUrl: finalReferenceImageUrl,
			referenceImages,
			referenceVideos,
			lastFrameUrl,
			seed: effectiveSeed,
			resolution,
			orientation,
			duration,
			mode: finalMode,
		});

		// Persist the take
		const takeId = nanoid();
		await db.insert(takes).values({
			id: takeId,
			setId,
			seed: result.seed ?? effectiveSeed,
			resolution,
			providerJobId: result.jobId,
			status: result.status === "completed" ? "kept" : "drafting",
			videoUrl: result.videoUrl ?? null,
		});

		return NextResponse.json({
			takeId,
			setId,
			jobId: result.jobId,
			seed: result.seed ?? effectiveSeed,
			status: result.status,
			videoUrl: result.videoUrl,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Generation failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
