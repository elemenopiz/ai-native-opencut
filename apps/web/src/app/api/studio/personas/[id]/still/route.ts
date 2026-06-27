import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { personas } from "@/lib/db/schema-studio";
import { renderPersonaStill } from "@/lib/studio/persona-still";
import type { ImageSize } from "@/lib/studio/image-generator";

// POST — render a per-shot reference still of this persona in a new scene via
// gpt-image-2 /images/edits. The returned imageUrl becomes the Seedance
// image-to-video reference frame (High-consistency mode).
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const { id } = await params;
		const body = (await req.json()) as {
			scenePrompt?: string;
			size?: ImageSize;
		};
		const { scenePrompt, size } = body;

		if (!scenePrompt?.trim()) {
			return NextResponse.json(
				{ error: "scenePrompt is required" },
				{ status: 400 },
			);
		}

		const persona = await db.query.personas.findFirst({
			where: eq(personas.id, id),
		});
		if (!persona) {
			return NextResponse.json({ error: "Persona not found" }, { status: 404 });
		}

		const refImageUrls = persona.refImageUrls
			? (JSON.parse(persona.refImageUrls) as string[])
			: undefined;

		const { imageUrl } = await renderPersonaStill({
			anchorImageUrl: persona.anchorImageUrl,
			refImageUrls,
			scenePrompt,
			descriptor: persona.descriptor,
			size,
		});

		return NextResponse.json({ imageUrl });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to render persona still";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
