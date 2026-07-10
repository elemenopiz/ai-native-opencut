/**
 * Take-critic adapter — the concrete {@link TakeCritic} that wires D1's pure
 * vision critic (`vision-critic.ts`) to the real relay + frame extraction, so
 * D3's `compareTake` can AUTO-PICK the winning A/B take instead of always
 * deferring to the human.
 *
 * THE GAP THIS CLOSES: `compareTake` has always been able to auto-pick — it calls
 * an injected {@link TakeCritic.pickBest} — but no adapter existed, so `useDirector`
 * never injected one and the capability was dead. This module supplies that adapter:
 *
 *  1. Extract 1–3 frames from each candidate take (same decode path `reviewTake`
 *     uses — {@link TakeFrameSource}, wired to `extractTakeFrames` in `use-director`).
 *  2. Send them to the model as labeled image blocks through the SAME stateless
 *     relay `reviewTake`'s critic uses ({@link VisionRelay}, wired to the agent's
 *     `callVisionRelay`).
 *  3. Parse the reply back to the winning take id + a one-line rationale.
 *
 * GRACEFUL DEGRADATION is the contract: any failure — a take with no decodable
 * frames, fewer than two comparable candidates, a relay error, or an unparseable
 * verdict — returns `null`, which `compareTake` reads as "no confident pick" and
 * falls back to presenting both takes for the user to choose. The critic can never
 * make the comparison WORSE than the no-critic path.
 *
 * The relay + frame source are INJECTED (not imported) so the adapter's real
 * logic — labeling, block-building, parsing, the ≥2 gate — is unit-testable with
 * a stubbed model call and no browser.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { TakeCritic } from "./types";
import {
	buildPickUserBlocks,
	type PickCandidate,
	parsePick,
	pickLabel,
	PICK_SYSTEM_PROMPT,
} from "./vision-critic";

/**
 * One tool-less vision model round-trip: a system prompt + user content blocks
 * (text + images) → the assistant's text reply. Wired to the agent's
 * `callVisionRelay` in production; stubbed in tests.
 */
export type VisionRelay = (request: {
	system: string;
	content: Anthropic.ContentBlockParam[];
}) => Promise<string>;

/**
 * Decode a candidate take's frames (base64 `data:` image URLs, first → last).
 * Wired to `extractTakeFrames(editor.media.getAssetById(mediaId), …)` in
 * `use-director`. Should resolve `[]` (not throw) when a take has no reviewable
 * media, so the adapter can simply drop it from the comparison.
 */
export type TakeFrameSource = (input: {
	takeId: string;
	mediaId?: string;
}) => Promise<string[]>;

/**
 * Build the production vision {@link TakeCritic} for `compareTake`'s auto-pick.
 * `framesPerTake` (default 3) bounds how many frames per candidate ride to the
 * model — kept small because the payload is images.
 */
export function createVisionTakeCritic(deps: {
	relay: VisionRelay;
	extractFrames: TakeFrameSource;
	framesPerTake?: number;
}): TakeCritic {
	const { relay, extractFrames } = deps;

	return {
		async pickBest(input) {
			// 1. Decode frames for every candidate (never throw — a take that can't be
			//    decoded just drops out of the comparison).
			const decoded = await Promise.all(
				input.takes.map(async (t) => {
					let frames: string[] = [];
					try {
						frames = await extractFrames({
							takeId: t.takeId,
							mediaId: t.mediaId,
						});
					} catch {
						frames = [];
					}
					return { takeId: t.takeId, frames };
				}),
			);

			// 2. Keep only candidates the model can actually SEE. Fewer than two ⇒
			//    nothing to compare visually → no confident pick (present both).
			const comparable = decoded.filter((d) => d.frames.length > 0);
			if (comparable.length < 2) return null;

			// 3. Label each candidate (A, B, …) and map the label back to its take id.
			const labelToTakeId = new Map<string, string>();
			const candidates: PickCandidate[] = comparable.map((d, i) => {
				const label = pickLabel(i);
				labelToTakeId.set(label, d.takeId);
				return { label, frames: d.frames };
			});

			// 4. Ask the model — any relay failure degrades to "no confident pick".
			let text: string;
			try {
				text = await relay({
					system: PICK_SYSTEM_PROMPT,
					content: buildPickUserBlocks(input.prompt, candidates),
				});
			} catch {
				return null;
			}

			// 5. Parse the winning label (validated against the ones we actually sent)
			//    and map it back to the take id.
			const pick = parsePick(text, [...labelToTakeId.keys()]);
			if (!pick) return null;
			const takeId = labelToTakeId.get(pick.label);
			if (!takeId) return null;

			return { takeId, reason: pick.reason };
		},
	};
}
