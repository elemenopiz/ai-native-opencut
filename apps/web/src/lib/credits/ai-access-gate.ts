import { toast } from "sonner";
import { useAiAccessStore } from "@/hooks/use-ai-access";

/**
 * Mirrors the server's `AI_ACCESS_DENIED_CODE` as a literal (not an import —
 * `@/lib/ai-access` is server-only: it reads DB/session state that isn't safe
 * to pull into the client bundle). Keep this in sync with that constant.
 */
const AI_ACCESS_DENIED_CODE = "ai_access_restricted";

/**
 * Defense-in-depth client gate, parallel to {@link gateOn402}: pass a fetch
 * `Response`; if it's an HTTP 403 with body `{ code: "ai_access_restricted" }`,
 * this surfaces a friendly toast (never a raw error) and returns `true` so the
 * caller can bail out cleanly. Otherwise returns `false` and the caller
 * proceeds with its normal error handling.
 *
 * This is a backstop, not the primary defense — every AI-triggering surface
 * should already disable its action and show `<AiAccessNotice/>` when
 * `!aiAccess` (see `useAiAccess`). This only catches the cases that slip past
 * that (a stale disabled-state race, a background/resume call with no button
 * to disable, access revoked mid-session, ...).
 *
 * Reads via `clone()` so the caller can still read the original response.
 */
export async function gateOnAiAccess(res: Response): Promise<boolean> {
	if (res.status !== 403) return false;

	let code: string | undefined;
	try {
		const body = (await res.clone().json()) as { code?: string };
		code = body.code;
	} catch {
		return false; // Non-JSON 403 — not our code, let the caller handle it.
	}
	if (code !== AI_ACCESS_DENIED_CODE) return false;

	const { signedIn, refresh } = useAiAccessStore.getState();
	toast(
		signedIn
			? "AI features are available to early-access members."
			: "Sign in to use AI features",
	);
	// The cached state may be stale (e.g. access was revoked mid-session) —
	// refresh so every mounted notice/disabled-state reflects it immediately.
	void refresh();
	return true;
}
