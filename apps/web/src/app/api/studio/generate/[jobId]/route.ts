import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { pollVideo } from "@/lib/studio/provider-adapter";
import { canRehost, rehostToR2, isRehostedUrl, fetchBytes } from "@/lib/studio/media-storage";
import { db } from "@/lib/db";
import { takes } from "@/lib/db/schema-studio";

export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ jobId: string }> },
) {
	try {
		const { jobId } = await params;
		const result = await pollVideo(jobId);

		if (result.status === "completed" || result.status === "failed") {
			let videoUrl = result.videoUrl ?? null;

			// Seedance video URLs expire ~24h. On success, copy the bytes into our
			// own R2 once and store the durable URL. Idempotent: skip if the take
			// already holds a rehosted URL. Best-effort — fall back to the provider
			// URL (still valid for ~24h) if the copy fails.
			if (result.status === "completed" && result.videoUrl && canRehost()) {
				const existing = await db.query.takes.findFirst({
					where: eq(takes.providerJobId, jobId),
				});
				if (existing?.videoUrl && isRehostedUrl(existing.videoUrl)) {
					videoUrl = existing.videoUrl;
				} else {
					try {
						const bytes = await fetchBytes(result.videoUrl);
						videoUrl = await rehostToR2(bytes, "video/mp4");
					} catch (err) {
						console.error("Failed to rehost video to R2:", err);
					}
				}
			}

			// Never write seed back to null: it's pinned at submit time and the
			// completion payload omits it.
			await db
				.update(takes)
				.set({
					status: result.status === "completed" ? "kept" : "drafting",
					videoUrl,
					errorMessage: result.error ?? null,
					...(result.seed != null ? { seed: result.seed } : {}),
					updatedAt: new Date(),
				})
				.where(eq(takes.providerJobId, jobId));

			// Hand the durable URL back to the client too.
			return NextResponse.json({ ...result, videoUrl: videoUrl ?? result.videoUrl });
		}

		return NextResponse.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Poll failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
