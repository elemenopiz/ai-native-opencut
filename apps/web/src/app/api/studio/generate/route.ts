import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import {
	generateVideo,
	type VideoResolution,
	type VideoOrientation,
	type VideoMode,
} from "@/lib/studio/provider-adapter";
import { db } from "@/lib/db";
import { generationSets, takes } from "@/lib/db/schema-studio";

/** Max value BytePlus accepts for a seed (signed 32-bit). */
const MAX_SEED = 2_147_483_647;

export async function POST(req: Request) {
	try {
		const body = await req.json() as {
			prompt: string;
			referenceImageUrl?: string;
			seed?: number;
			resolution?: VideoResolution;
			orientation?: VideoOrientation;
			duration?: number;
			mode?: VideoMode;
			userId?: string;
		};

		const {
			prompt,
			referenceImageUrl,
			seed,
			resolution = "720p",
			orientation = "landscape",
			duration = 5,
			mode = "text-to-video",
			userId,
		} = body;

		if (!prompt?.trim()) {
			return NextResponse.json({ error: "prompt is required" }, { status: 400 });
		}

		// Always pin a concrete seed. If the caller didn't lock one, we pick a
		// random seed ourselves rather than letting the provider choose silently —
		// otherwise "generate 4 drafts, promote the winner at 1080p" can't
		// reproduce the shot, because the provider doesn't reliably echo back the
		// seed it used for a random generation.
		const effectiveSeed = seed ?? Math.floor(Math.random() * MAX_SEED);

		// Persist the generation set
		const setId = nanoid();
		await db.insert(generationSets).values({
			id: setId,
			userId: userId ?? null,
			prompt,
			referenceImageUrl,
			baseSeed: effectiveSeed,
			resolution,
			orientation,
			duration,
			mode,
		});

		// Submit to provider
		const result = await generateVideo({
			prompt,
			referenceImageUrl,
			seed: effectiveSeed,
			resolution,
			orientation,
			duration,
			mode,
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
