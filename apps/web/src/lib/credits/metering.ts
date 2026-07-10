import { NextResponse } from "next/server";
import { InsufficientCredits } from "@/lib/credits/ledger";

/** Shared ref type for every studio generation charge. */
export const STUDIO_REF_TYPE = "studio_job";

/**
 * The HTTP 402 body returned when a paid studio action can't be afforded. The
 * frontend interceptor keys off `error === "insufficient_credits"` to open the
 * "Out of credits" modal.
 */
export function insufficientCreditsResponse(
	err: InsufficientCredits,
): NextResponse {
	return NextResponse.json(
		{
			error: "insufficient_credits",
			needed: err.needed,
			spendable: err.spendable,
		},
		{ status: 402 },
	);
}
