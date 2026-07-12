/**
 * Thin client for POST /api/llm/enhance-prompt — the CLOUD prompt rewriter
 * (Gemini-first server-side; see the route header).
 *
 * Exists so surfaces without the EnhancePromptButton UI (B-roll suggestion
 * cards, template-guide properties) stop calling the RETIRED local backend's
 * `aiClient.enhancePrompt` (localhost:8420 — dead) and ride the same cloud
 * route the button does.
 */

/** The route's enhance modes. */
export type EnhancePromptMode = "image" | "video" | "director";

/**
 * Rewrite `prompt` into a generation-ready one. Throws an `Error` with honest,
 * user-showable copy on failure (callers toast `err.message`).
 */
export async function enhancePromptCloud(
	prompt: string,
	mode: EnhancePromptMode,
): Promise<string> {
	const res = await fetch("/api/llm/enhance-prompt", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt, mode }),
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => null)) as {
			error?: string;
			message?: string;
		} | null;
		if (data?.error === "enhance_not_configured") {
			throw new Error("Prompt enhancement is not configured on this server.");
		}
		if (res.status === 401) {
			throw new Error("Log in to enhance prompts.");
		}
		if (res.status === 429) {
			throw new Error("Rate limit reached — try again in a minute.");
		}
		throw new Error(
			data?.message ?? `Prompt enhancement failed (${res.status}).`,
		);
	}
	const data = (await res.json()) as { enhanced?: string };
	const enhanced = data.enhanced?.trim();
	if (!enhanced) throw new Error("The model returned no text.");
	return enhanced;
}
