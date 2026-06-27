/**
 * Promote a take to 1080p using the locked seed from the original generation.
 * Re-fires the same prompt + seed at full resolution. No upscaling.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { generateVideo, type VideoOrientation } from "@/lib/studio/provider-adapter";
import { db } from "@/lib/db";
import { takes, generationSets } from "@/lib/db/schema-studio";

export async function POST(
	_req: Request,
	{ params }: { params: Promise<{ takeId: string }> },
) {
	try {
		const { takeId } = await params;

		// Load the take + its parent set
		const take = await db.query.takes.findFirst({
			where: eq(takes.id, takeId),
		});
		if (!take) {
			return NextResponse.json({ error: "Take not found" }, { status: 404 });
		}

		const set = await db.query.generationSets.findFirst({
			where: eq(generationSets.id, take.setId),
		});
		if (!set) {
			return NextResponse.json({ error: "Generation set not found" }, { status: 404 });
		}

		// Submit a new 1080p generation with the locked seed + same orientation, so
		// the only thing that changes is the resolution. Same shot, full quality.
		const result = await generateVideo({
			prompt: set.prompt,
			referenceImageUrl: set.referenceImageUrl ?? undefined,
			seed: take.seed ?? undefined,
			resolution: "1080p",
			orientation: set.orientation as VideoOrientation,
			duration: set.duration,
			mode: set.mode as "text-to-video" | "image-to-video",
		});

		// Persist the promoted take in the same set
		const newTakeId = nanoid();
		await db.insert(takes).values({
			id: newTakeId,
			setId: take.setId,
			seed: take.seed,
			resolution: "1080p",
			providerJobId: result.jobId,
			status: "promoted",
			videoUrl: result.videoUrl ?? null,
		});

		// Mark the source take as promoted
		await db
			.update(takes)
			.set({ status: "promoted", updatedAt: new Date() })
			.where(eq(takes.id, takeId));

		return NextResponse.json({
			takeId: newTakeId,
			jobId: result.jobId,
			status: result.status,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Promote failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
