import { webEnv } from "@byorn/env/web";
import { NextResponse } from "next/server";
import {
	allBackends,
	ensureBackendsRegistered,
	type GenerationModality,
} from "@/lib/studio/backends";

/**
 * Studio provider key STATUS (inventory item D1).
 *
 * The studio generation adapters (`lib/studio/backends/{video,image}/*`) read
 * their provider secrets SERVER-SIDE from `process.env` / the validated env
 * schema — there is no client-supplied key path for them (unlike Freesound,
 * whose route reads an `x-freesound-api-key` header). So the Settings panel
 * cannot meaningfully "store" these keys in the browser; the honest surface is
 * to report, per provider, whether its required env vars are configured on the
 * server RIGHT NOW.
 *
 * This mirrors `GET /api/studio/backends` exactly: the registry + adapters are
 * server modules that hold secrets, so we expose only metadata + a boolean
 * `configured` flag — NEVER a key value. `isAvailable()` already encodes
 * "are this backend's required env vars present".
 */

export interface ProviderKeyStatus {
	id: string;
	label: string;
	vendor: string;
	modality: GenerationModality;
	/** Env var(s) the adapter reads server-side (e.g. RUNWAY_API_KEY). */
	requiredEnv: string[];
	/** True when every required env var is set on the server. Never a value. */
	configured: boolean;
}

/**
 * Non-studio provider keys that Next.js API routes read server-side from the
 * validated web env (`/api/sounds/search`, `/api/images/search`). Reported as
 * booleans only — same contract as `configured` above, NEVER a value. The
 * Settings panel uses this instead of reading `process.env.FREESOUND_*` in
 * the client bundle, where server-only vars are always undefined.
 */
export type ServerEnvKey =
	| "FREESOUND_CLIENT_ID"
	| "FREESOUND_API_KEY"
	| "PEXELS_API_KEY";

export function GET() {
	ensureBackendsRegistered();

	const providers: ProviderKeyStatus[] = allBackends()
		.map((b) => ({
			id: b.id,
			label: b.label,
			vendor: b.vendor,
			modality: b.modality,
			requiredEnv: b.requiredEnv,
			configured: b.isAvailable(),
		}))
		.sort((a, b) => a.vendor.localeCompare(b.vendor));

	const serverEnv: Record<ServerEnvKey, boolean> = {
		FREESOUND_CLIENT_ID: !!webEnv.FREESOUND_CLIENT_ID,
		FREESOUND_API_KEY: !!webEnv.FREESOUND_API_KEY,
		PEXELS_API_KEY: !!webEnv.PEXELS_API_KEY,
	};

	return NextResponse.json({ providers, serverEnv });
}
