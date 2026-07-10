import { useCreditsStore } from "@/stores/credits-store";

/**
 * Client-side 402 gate for paid studio actions. Pass a fetch `Response`; if it's
 * an HTTP 402 `insufficient_credits`, this opens the "Out of credits" modal and
 * returns true so the caller can bail early. Otherwise returns false and the
 * caller proceeds with its normal error handling.
 *
 * Studio fetch boundaries call this inside their `if (!res.ok)` branch. It reads
 * the body via `clone()` so the caller can still read the original response.
 */
export async function gateOn402(res: Response): Promise<boolean> {
	if (res.status !== 402) return false;

	let needed = 0;
	let spendable = 0;
	try {
		const body = (await res.clone().json()) as {
			error?: string;
			needed?: number;
			spendable?: number;
		};
		if (body.error !== "insufficient_credits") return false;
		needed = typeof body.needed === "number" ? body.needed : 0;
		spendable = typeof body.spendable === "number" ? body.spendable : 0;
	} catch {
		// Non-JSON 402 — still treat it as a credit gate with unknown numbers.
	}

	const store = useCreditsStore.getState();
	store.openOutOfCredits({ needed, spendable });
	// Refresh the header pill so it reflects the (low) balance immediately.
	void store.refresh();
	return true;
}
