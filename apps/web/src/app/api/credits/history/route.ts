/**
 * GET /api/credits/history — the caller's recent credit ledger, newest first.
 *
 * Session-gated. Paginated via `?limit=` (1–100, default 20) and `?offset=`.
 * Returns actual credit movements (grants + charges); delta=0 reserve/release
 * markers are excluded by the ledger service. The account page renders this.
 *
 * Each entry is additionally annotated with a display-only `kind` + `label`
 * (e.g. `{ kind: "image", label: "Image · Nano Banana Pro" }`) resolved from
 * the ledger row's own `metadata.backendId` against the backend registry —
 * no new data is invented, this just reads what `meteredSettle` already wrote.
 * Raw `metadata` itself is stripped before the response goes out.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { getAccount, history, type LedgerEntry } from "@/lib/credits/ledger";
import { ensureBackendsRegistered, getBackend } from "@/lib/studio/backends";
import { STUDIO_REF_TYPE } from "@/lib/credits/metering";

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
});

/** Reasons that credit the account rather than charge it — a grant, however
 *  it was granted. */
const GRANT_REASONS = new Set([
	"grant",
	"admin_grant",
	"cli_grant",
	"beta_courtesy",
]);

const MODALITY_LABEL: Record<string, string> = {
	video: "Video",
	image: "Image",
	audio: "Audio",
};

export interface HistoryEntry extends Omit<LedgerEntry, "metadata"> {
	kind: "video" | "image" | "audio" | "grant" | "generation";
	label: string;
}

/**
 * Type-specific display label for one ledger row. Every studio charge already
 * carries `metadata.backendId` (set at `meteredSettle` time in each studio
 * route) — this just looks that id up in the backend registry for its
 * human label + modality instead of showing a bare "Generation".
 */
function classify(entry: LedgerEntry): Pick<HistoryEntry, "kind" | "label"> {
	if (GRANT_REASONS.has(entry.reason)) {
		return { kind: "grant", label: "Credit grant" };
	}

	if (entry.reason === "settle" && entry.refType === STUDIO_REF_TYPE) {
		const meta = entry.metadata as {
			backendId?: unknown;
			kind?: unknown;
		} | null;
		const backendId =
			typeof meta?.backendId === "string" ? meta.backendId : undefined;
		const backend = backendId ? getBackend(backendId) : undefined;
		if (backend) {
			const modalityLabel = MODALITY_LABEL[backend.modality] ?? "Generation";
			const noun =
				meta?.kind === "persona-still"
					? "Persona still"
					: meta?.kind === "promote"
						? "1080p upscale"
						: modalityLabel;
			return { kind: backend.modality, label: `${noun} · ${backend.label}` };
		}
	}

	return { kind: "generation", label: "Generation" };
}

export async function GET(request: NextRequest) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const parsed = querySchema.safeParse({
			limit: request.nextUrl.searchParams.get("limit") ?? undefined,
			offset: request.nextUrl.searchParams.get("offset") ?? undefined,
		});
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid query", details: parsed.error.flatten().fieldErrors },
				{ status: 400 },
			);
		}

		// The backend registry populates lazily (module-level, idempotent) — needed
		// before `classify()` can resolve a settle row's `backendId` to a label.
		ensureBackendsRegistered();

		const { limit, offset } = parsed.data;
		const [rawEntries, account] = await Promise.all([
			history(session.user.id, { limit, offset }),
			getAccount(session.user.id),
		]);

		// Drop raw `metadata` from the wire response — only the resolved
		// `kind`/`label` (from `classify`) are for display.
		const entries: HistoryEntry[] = rawEntries.map((entry) => ({
			id: entry.id,
			delta: entry.delta,
			balanceAfter: entry.balanceAfter,
			reason: entry.reason,
			refType: entry.refType,
			refId: entry.refId,
			createdAt: entry.createdAt,
			...classify(entry),
		}));

		return NextResponse.json({
			balance: account.balance,
			reserved: account.reserved,
			spendable: account.spendable,
			entries,
		});
	} catch (error) {
		console.error("Error reading credit history:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
