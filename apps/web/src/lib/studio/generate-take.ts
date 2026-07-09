import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/lib/media/processing";
import { composePromptWithCamera } from "@/lib/studio/camera-presets";
import { waitForJobTerminal } from "@/stores/generation-status-store";
import type { GenerationSpec, Provenance, TakeCost } from "@/types/timeline";

/** Terminal result of generating one take's media. */
export type GenerateTakeResult =
	| {
			status: "ready";
			mediaId: string;
			thumbnailUrl?: string;
			seed?: number;
			/** Which backend produced the take + its safety tier (from the route). */
			provenance?: Provenance;
			/** Actualized cost of the generation. */
			cost?: TakeCost;
	  }
	| { status: "failed"; error: string };

/** Fetch a finished take's video (via same-origin proxy to dodge provider CORS),
 *  run it through the normal media pipeline, and register it as a project asset. */
async function importVideoAsset(
	editor: EditorCore,
	projectId: string,
	url: string,
	name: string,
): Promise<{ mediaId: string; thumbnailUrl?: string }> {
	const res = await fetch(`/api/studio/proxy?url=${encodeURIComponent(url)}`);
	if (!res.ok) throw new Error(`fetch failed ${res.status}`);
	const blob = await res.blob();
	const fileName = name.toLowerCase().endsWith(".mp4") ? name : `${name}.mp4`;
	const type = blob.type.startsWith("video/") ? blob.type : "video/mp4";
	const file = new File([blob], fileName, { type });
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) throw new Error("processing produced no asset");
	const mediaId = await editor.media.addMediaAsset({ projectId, asset: processed });
	return { mediaId, thumbnailUrl: processed.thumbnailUrl };
}

/** Poll one provider job to a terminal state, routed through the shared
 *  generation-status store so concurrent watchers of the same jobId (e.g. the
 *  studio Takes grid and a timeline slot) share one deduped interval. */
async function pollJob(
	jobId: string,
): Promise<{ videoUrl?: string; seed?: number; error?: string }> {
	const outcome = await waitForJobTerminal(jobId);
	if (outcome === "timeout") return { error: "Generation timed out" };
	if (outcome === "cancelled") return { error: "Generation cancelled" };
	if (outcome.status === "completed")
		return { videoUrl: outcome.videoUrl, seed: outcome.seed };
	return { error: outcome.error ?? "Generation failed" };
}

/**
 * The single provider pipeline for one take: submit → poll → import the result
 * as a project MediaAsset. Pure (no timeline/take bookkeeping) so both the UI
 * orchestrator (`useSlotGeneration`) and the Director's `GenerateExecutor` share
 * one engine.
 */
export async function generateTakeMedia({
	editor,
	projectId,
	spec,
}: {
	editor: EditorCore;
	projectId: string;
	spec: GenerationSpec;
}): Promise<GenerateTakeResult> {
	try {
		const res = await fetch("/api/studio/generate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				// Apply the slot's camera-motion preset to the prompt, mirroring the
				// studio form — otherwise a camera move set in the clip inspector is
				// silently dropped on the slot/Director generation path.
				prompt: composePromptWithCamera(spec.prompt, spec.cameraPreset ?? null),
				referenceImageUrl: spec.referenceImageUrl,
				referenceImages: spec.referenceImages,
				referenceVideos: spec.referenceVideos,
				seed: spec.seedLocked ? spec.seed : undefined,
				resolution: spec.resolution,
				orientation: spec.orientation,
				duration: spec.duration,
				mode: spec.mode,
				personaId: spec.personaId,
				consistencyMode: spec.consistencyMode,
			}),
		});
		if (!res.ok) {
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			return { status: "failed", error: data.error ?? "Submission failed" };
		}
		const data = (await res.json()) as {
			jobId: string;
			status: string;
			videoUrl?: string;
			seed?: number;
			provenance?: Provenance;
			cost?: TakeCost;
		};

		let videoUrl = data.videoUrl;
		let seed = data.seed;
		if (data.status !== "completed") {
			const out = await pollJob(data.jobId);
			if (out.error || !out.videoUrl) {
				return { status: "failed", error: out.error ?? "No video produced" };
			}
			videoUrl = out.videoUrl;
			seed = out.seed ?? seed;
		}

		const { mediaId, thumbnailUrl } = await importVideoAsset(
			editor,
			projectId,
			videoUrl!,
			spec.prompt || "take",
		);
		return {
			status: "ready",
			mediaId,
			thumbnailUrl,
			seed,
			provenance: data.provenance,
			cost: data.cost,
		};
	} catch (err) {
		return {
			status: "failed",
			error: err instanceof Error ? err.message : "Generation failed",
		};
	}
}
