/**
 * Extract an actionable error message from a failed `/api/sounds/*` response.
 *
 * Those routes return `{ error, code?, message? }` — `message` carries the
 * user-facing fix (e.g. "set your Freesound API key in Settings > API Keys"),
 * so prefer it over the terse `error`, and fall back to a generic status-based
 * string when the body isn't readable.
 */
export async function readSoundsApiError({
	response,
	fallback,
}: {
	response: Response;
	fallback: string;
}): Promise<string> {
	try {
		const body = (await response.json()) as {
			error?: string;
			message?: string;
		};
		if (typeof body.message === "string" && body.message) return body.message;
		if (typeof body.error === "string" && body.error) return body.error;
	} catch {
		// Non-JSON body — fall through to the generic message.
	}
	return `${fallback} (${response.status})`;
}
