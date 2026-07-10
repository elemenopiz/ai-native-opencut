import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { personas } from "@/lib/db/schema-studio";
import { renderPersonaStill } from "@/lib/studio/persona-still";
import type { ImageSize } from "@/lib/studio/image-generator";
import { nanoid } from "nanoid";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { DEFAULT_BACKEND_ID } from "@/lib/studio/backends/registry";
import { costFor } from "@/lib/credits/cost-table";
import {
	InsufficientCredits,
	release,
	reserve,
	settle,
} from "@/lib/credits/ledger";
import {
	insufficientCreditsResponse,
	STUDIO_REF_TYPE,
} from "@/lib/credits/metering";

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

		// Cap paid still rendering per account (both burst and daily volume).
		const limited = await enforceRateLimit({
			name: "studio:persona-still",
			request: req,
			userId: session.user.id,
		});
		if (limited) return limited;

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

		// Credits: rendering a persona still is a synchronous paid image call.
		// Reserve the server-computed cost before dispatch, settle on success,
		// release on failure. `renderPersonaStill` routes internally across the
		// image backends; we price it at the default image backend's flat rate.
		const imageBackendId = DEFAULT_BACKEND_ID.image;
		const creditCost = costFor(imageBackendId, "image", { count: 1 });
		const chargeId = nanoid();
		try {
			await reserve(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: chargeId,
				idempotencyKey: `${chargeId}:reserve`,
				metadata: { backendId: imageBackendId, kind: "persona-still" },
			});
		} catch (err) {
			if (err instanceof InsufficientCredits) {
				return insufficientCreditsResponse(err);
			}
			throw err;
		}

		let imageUrl: string;
		try {
			({ imageUrl } = await renderPersonaStill({
				anchorImageUrl: persona.anchorImageUrl,
				refImageUrls,
				scenePrompt,
				descriptor: persona.descriptor,
				size,
			}));
		} catch (err) {
			await release(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: chargeId,
				idempotencyKey: `${chargeId}:release`,
			}).catch(() => {});
			throw err;
		}

		if (creditCost > 0) {
			await settle(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: chargeId,
				idempotencyKey: `${chargeId}:settle`,
				metadata: { backendId: imageBackendId, kind: "persona-still" },
			});
		}

		return NextResponse.json({ imageUrl });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to render persona still";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
