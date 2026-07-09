// Adapted from palmier-io/sixsevenstudio (MIT). See THIRD_PARTY_NOTICES.
/**
 * Remix / edit-in-place — ports sixsevenstudio's `remixVideo` pattern
 * (`src/lib/openai/video.ts`'s `remixVideo(apiKey, videoId, remixPrompt)`,
 * surfaced by `src/components/videos/RemixPopover.tsx`): take a PRIOR
 * generation's id plus a short delta prompt ("make the colors more vibrant,
 * add a sunset...") and produce a new generation that's the same shot, edited.
 *
 * Sora 2 has a first-class `client.videos.remix(videoId, { prompt })`
 * endpoint that edits a previously generated video server-side.
 *
 * WIRING TODO: BytePlus ModelArk (`provider-adapter.ts`) has NO equivalent
 * remix/edit endpoint — `byteplusSubmit`/`byteplusPoll` only support
 * *creating* a fresh generation task, never editing an existing `jobId`'s
 * result. This stub captures the PATTERN (prior generation + delta prompt →
 * new generation) using what Seedance 2.0 actually offers instead:
 *   1. Anchor on the prior take's result — its `referenceImageUrl` (e.g. the
 *      persona still that was its first frame) or, once we have a "last
 *      frame of a completed take" extractor, a frame pulled from the
 *      finished video itself.
 *   2. Re-submit as `mode: "image-to-video"` with that anchor as
 *      `referenceImageUrl`, the ORIGINAL prompt plus the delta prompt
 *      appended (not replaced — Seedance has no separate "edit" instruction
 *      channel, so the delta has to ride inside the one `prompt` field), and
 *      the prior take's `seed` carried over with `seedLocked: true` so the
 *      remix stays visually anchored to the original instead of drawing a
 *      fresh random seed.
 * This is an img2img re-generation, not a true edit — implement for real once
 * either (a) Seedance ships a native edit/remix endpoint, or (b) we add a
 * "grab last frame from a completed take" utility to key off of.
 *
 * WIRED: `director-api.ts`'s `remix` verb calls `buildRemixSpec` and runs the
 * result through the same `GenerateExecutor` boundary every other take uses
 * (no separate `RemixExecutor` needed — see below). `agent.ts` lists `remix`
 * in `TOOLS`/`TOOL_DOCS`. Still open: a manual "Remix" affordance on a take
 * (mirroring `RemixPopover`) in `timeline-element.tsx`/
 * `generative-clip-properties.tsx`, for users who don't go through the agent.
 */

import type { GenerationSpec, Take } from "@/types/timeline";

export interface RemixInput {
	/** The take being remixed — supplies the prior prompt, seed, and spec to anchor on. */
	priorTake: Pick<Take, "spec" | "seed">;
	/** Short instruction describing the desired change (e.g. "add a sunset in the background"). */
	remixPrompt: string;
	/**
	 * Frame to re-condition on. Pass a frame pulled from the prior take's
	 * finished video once that extractor exists; falls back to the prior
	 * spec's own `referenceImageUrl` (e.g. a persona still) if the take had one.
	 */
	anchorImageUrl?: string;
}

/**
 * Build the `GenerationSpec` for a remix generation. Pure — does not call the
 * provider. Composes the delta prompt onto the original (Seedance has no
 * separate edit-instruction field) and locks the seed so the remix stays
 * anchored to the original take instead of drawing a fresh random one.
 */
export function buildRemixSpec(input: RemixInput): GenerationSpec {
	const { priorTake, remixPrompt, anchorImageUrl } = input;
	const basePrompt = priorTake.spec.prompt.trim();
	const delta = remixPrompt.trim();
	const referenceImageUrl = anchorImageUrl ?? priorTake.spec.referenceImageUrl;

	return {
		...priorTake.spec,
		prompt: delta ? `${basePrompt}. ${delta}.` : basePrompt,
		mode: referenceImageUrl ? "image-to-video" : priorTake.spec.mode,
		referenceImageUrl,
		seed: priorTake.seed ?? priorTake.spec.seed,
		seedLocked: true,
	};
}
