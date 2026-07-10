import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { personas } from "@/lib/db/schema-studio";
import { renderPersonaStill } from "@/lib/studio/persona-still";
import type { ImageSize } from "@/lib/studio/image-generator";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";

// POST — render a per-shot reference still of this persona in a new scene via
// gpt-image-2 /images/edits. The returned imageUrl becomes the Seedance
// image-to-video reference frame (High-consistency mode).
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		// Paid still rendering (gpt-image-2) — bills our provider key.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

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
		// Only the persona's owner may render paid stills from it (anonymously
		// created personas — userId null — stay usable by any signed-in user).
		if (persona.userId && persona.userId !== session.user.id) {
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
