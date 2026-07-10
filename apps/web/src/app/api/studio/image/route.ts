import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import {
	generateReferenceImage,
	type ImageSize,
	type ImageQuality,
} from "@/lib/studio/image-generator";
import { canRehost, rehostToR2, fetchBytes } from "@/lib/studio/media-storage";
import { db } from "@/lib/db";
import { imageStills } from "@/lib/db/schema-studio";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
	try {
		// Paid image generation — bills our provider key, so require a signed-in user.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

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
		};

		const { prompt, size = "1024x1024", quality = "high", n = 1 } = body;

		if (!prompt?.trim()) {
			return NextResponse.json(
				{ error: "prompt is required" },
				{ status: 400 },
			);
		}

		const results = await generateReferenceImage({ prompt, size, quality, n });

		// gpt-image-2 returns base64; rehost into R2 so the still has a stable,
		// publicly-fetchable URL (needed as an image-to-video reference, and so
		// it survives beyond the response). Falls back to the original on failure.
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
					revisedPrompt: r.revisedPrompt ?? null,
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
