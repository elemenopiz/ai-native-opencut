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
import { InsufficientCredits } from "@/lib/credits/ledger";
import {
	insufficientCreditsResponse,
	meteredRelease,
	meteredReserve,
	meteredSettle,
	STUDIO_REF_TYPE,
} from "@/lib/credits/metering";

// gpt-image /images/edits render + R2 rehost in one request.
export const maxDuration = 120;

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
		// `renderPersonaStill` ROUTES across the image backends, so the exact
		// provider (and its cost) isn't known until it returns. Reserve the default
		// image backend's cost up front — it's the max of the image tiers, so the
		// hold always covers the real charge — then settle the EXACT routed-backend
		// cost and release any over-hold. Release fully on failure (never bill a
		// failed call).
		const reserveCost = costFor(DEFAULT_BACKEND_ID.image, "image", {
			count: 1,
		});
		const chargeId = nanoid();
		try {
			await meteredReserve(session.user.id, reserveCost, {
				refType: STUDIO_REF_TYPE,
				refId: chargeId,
				idempotencyKey: `${chargeId}:reserve`,
				metadata: { kind: "persona-still" },
			});
		} catch (err) {
			if (err instanceof InsufficientCredits) {
				return insufficientCreditsResponse(err);
			}
			throw err;
		}

		let imageUrl: string;
		let usedBackendId: string;
		try {
			({ imageUrl, backendId: usedBackendId } = await renderPersonaStill({
				anchorImageUrl: persona.anchorImageUrl,
				refImageUrls,
				scenePrompt,
				descriptor: persona.descriptor,
				size,
			}));
		} catch (err) {
			await meteredRelease(session.user.id, reserveCost, {
				refType: STUDIO_REF_TYPE,
				refId: chargeId,
				idempotencyKey: `${chargeId}:release`,
			}).catch(() => {});
			throw err;
		}

		// Charge the exact cost of the backend the router actually used, then free
		// any difference between the reservation and the real charge.
		const actualCost = costFor(usedBackendId, "image", { count: 1 });
		if (actualCost > 0) {
			await meteredSettle(session.user.id, actualCost, {
				refType: STUDIO_REF_TYPE,
				refId: chargeId,
				idempotencyKey: `${chargeId}:settle`,
				metadata: { backendId: usedBackendId, kind: "persona-still" },
			});
		}
		if (reserveCost > actualCost) {
			await meteredRelease(session.user.id, reserveCost - actualCost, {
				refType: STUDIO_REF_TYPE,
				refId: chargeId,
				idempotencyKey: `${chargeId}:release-diff`,
			}).catch(() => {});
		}

		return NextResponse.json({ imageUrl });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to render persona still";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
