/**
 * Higgsfield SDK smoke test — Seedance 2.5 text-to-video.
 *
 * Proves the credentials, the SDK wiring and the endpoint contract end to end
 * before any of it gets built into a `GenerationBackend` adapter. Run it with:
 *
 *     cd apps/web && bun run scripts/higgsfield-example/index.ts
 *
 * Bun loads `apps/web/.env.local` automatically, so no dotenv dependency is
 * needed — `HF_CREDENTIALS` just has to be set there in `key-id:key-secret`
 * form. It is read at runtime and never logged.
 *
 * ⚠️ THIS SPENDS MONEY. One run submits one billable generation.
 *
 * ── What is verified vs. inferred ────────────────────────────────────────────
 * The response handling below is read from the SDK source (v0.2.6), not guessed:
 * `subscribe()` POSTs `input` to the endpoint, then polls
 * `/requests/{request_id}/status` every 2s until the status is `completed`,
 * `failed` or `nsfw`, and resolves to
 * `{ status, request_id, status_url, cancel_url, images?, video? }`.
 *
 * The INPUT FIELD NAMES (`duration`, `resolution`, `aspect_ratio`) are inferred
 * from Higgsfield's own CLI docs, because `docs.higgsfield.ai` and
 * `console.higgsfield.ai` are both blocked by this environment's egress policy.
 * If the API rejects this body with a 422, read the real field names off the
 * console's API reference and fix `INPUT` below — nothing else should need to
 * change.
 */

import { createHiggsfieldClient } from "@higgsfield/client/v2";

/** Endpoint/model id. `subscribe()` prefixes a leading slash if absent. */
const MODEL = "bytedance/seedance-2.5/text-to-video";

const INPUT = {
	prompt: "A cinematic scene at sunset",
	duration: 5,
	resolution: "720p",
	aspect_ratio: "16:9",
} as const;

/**
 * Terminal statuses that are NOT success. `canceled` is deliberately included
 * even though the SDK's own `V2RequestStatus` union omits it: the SDK's poll
 * loop only breaks on `completed | failed | nsfw`, so a canceled request would
 * otherwise spin until `maxPollTime` and surface as a timeout. Treating it as a
 * terminal failure here means we report the real reason if the API ever sends
 * it inline.
 */
const FAILURE_STATUSES = new Set(["failed", "nsfw", "canceled", "cancelled"]);

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const credentials = process.env.HF_CREDENTIALS;
	if (!credentials) {
		fail(
			"HF_CREDENTIALS is not set. Add it to apps/web/.env.local as " +
				"HF_CREDENTIALS=key-id:key-secret",
		);
	}

	const client = createHiggsfieldClient({ credentials });

	console.log(`→ ${MODEL}`);
	console.log(`  prompt:     ${INPUT.prompt}`);
	console.log(
		`  format:     ${INPUT.duration}s · ${INPUT.resolution} · ${INPUT.aspect_ratio}`,
	);
	console.log("  submitting (billable) and polling to completion…\n");

	const startedAt = Date.now();
	const response = await client.subscribe(MODEL, {
		input: INPUT,
		withPolling: true,
	});
	const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

	const status = String(response.status);
	console.log(`  request_id: ${response.request_id}`);
	console.log(`  status:     ${status} (after ${elapsedSec}s)\n`);

	if (FAILURE_STATUSES.has(status)) {
		const reason =
			status === "nsfw"
				? "the prompt or output was moderated"
				: `the request ended as "${status}"`;
		fail(`No video generated — ${reason}.`);
	}

	if (status !== "completed") {
		// Polling returned a non-terminal status: the SDK stopped early, or the
		// API grew a status this script predates. Either way it is not a success.
		fail(`Unexpected non-terminal status "${status}" — treating as failure.`);
	}

	const videoUrl = response.video?.url;
	if (!videoUrl) {
		fail(
			`Status was "completed" but the response carried no video URL. ` +
				`Raw response: ${JSON.stringify(response)}`,
		);
	}

	console.log(`✓ Video URL: ${videoUrl}`);
}

main().catch((error: unknown) => {
	// The SDK maps HTTP failures onto typed errors: AuthenticationError (401),
	// NotEnoughCreditsError (403), ValidationError (422), BadInputError (400),
	// TimeoutError (poll budget exhausted), APIError (everything else).
	const name = error instanceof Error ? error.constructor.name : "Error";
	const message = error instanceof Error ? error.message : String(error);

	// A 403 is ambiguous behind an egress proxy. The SDK maps EVERY 403 to
	// NotEnoughCreditsError, but a proxy that denies the CONNECT also answers
	// 403 — so "Not enough credits" can mean "the request never left this
	// machine" and the account may be perfectly funded. Say so rather than
	// letting the credit reading stand unchallenged.
	if (name === "NotEnoughCreditsError" && process.env.HTTPS_PROXY) {
		console.error(`✗ ${name}: ${message}`);
		console.error(
			"\n  ⚠ HTTPS_PROXY is set, and the SDK reports any HTTP 403 as " +
				"'Not enough credits'.\n" +
				"    An egress proxy denying CONNECT also answers 403, so this may " +
				"not be a billing\n" +
				"    problem at all. Confirm which before trusting it:\n" +
				`      curl -sS "$HTTPS_PROXY/__agentproxy/status" | grep -A4 recentRelayFailures\n` +
				"    A 'connect_rejected' entry for api.higgsfield.ai means the " +
				"request never left\n" +
				"    this machine and nothing was billed.",
		);
		process.exit(1);
	}

	fail(`${name}: ${message}`);
});
