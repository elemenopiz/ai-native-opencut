/**
 * Ingest trigger for the task-B/C derivations (silence map, LUFS + true
 * peak, beat grid, shot changes/motion energy/head-tail) — mirrors
 * `use-embedding-indexer.ts`'s watch-and-process pattern so newly-added
 * assets get analyzed automatically instead of only on a manual UI action
 * (the beat grid's old "manual toggle only" path — see
 * `hooks/timeline/use-audio-tools.ts`'s `useBeatAnalysis`).
 *
 * NOT YET MOUNTED: this hook needs to be mounted once at the editor level,
 * the same way `useEmbeddingIndexer()` is (see wherever that call lives,
 * e.g. the editor provider/bootstrap). That file sits outside this task's
 * owned paths (`lib/media/**`, media-asset store/types, beat-grid store,
 * silence/loudness modules), so mounting is left as an integration step for
 * whoever owns editor bootstrap wiring, to avoid colliding with concurrent
 * work there.
 *
 * Runs off the render path (deferred via `setTimeout`, exactly like the
 * embedding indexer) and is fire-and-forget per asset — failures are
 * recorded as that kind's `failed` `DerivedStatus`, never thrown into the UI.
 */

import { useEffect, useRef } from "react";
import { useEditor } from "@/hooks/use-editor";
import type { MediaManager } from "@/core/managers/media-manager";
import { runDerivedAnalysis } from "@/lib/media/derived/orchestrator";
import { getDerivedStatus } from "@/lib/media/derived/derived-store";

/**
 * Same rationale as `use-embedding-indexer.ts`'s `shouldDeferIndexing`: don't
 * start decoding/sampling an asset while ITS OWN auto-proxy job is
 * generating — both compete for the same original-file decode.
 */
export function shouldDeferDerivedAnalysis({
	assetId,
	editor,
}: {
	assetId: string;
	editor: { media: Pick<MediaManager, "isProxyGenerating"> };
}): boolean {
	return editor.media.isProxyGenerating(assetId);
}

export function useDerivedMediaIndexer() {
	const editor = useEditor();
	const doneRef = useRef<Set<string>>(new Set());
	const inflightRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		let cancelled = false;

		const tick = async () => {
			if (cancelled) return;
			const assets = editor.media.getAssets();
			const done = doneRef.current;
			const inflight = inflightRef.current;

			for (const asset of assets) {
				if (done.has(asset.id) || inflight.has(asset.id)) continue;
				if (asset.type !== "video" && asset.type !== "audio") {
					// Images carry none of the owned kinds (see
					// `createInitialDerived`'s structural-unsupported map) — nothing
					// to run, so mark handled and move on.
					done.add(asset.id);
					continue;
				}
				if (shouldDeferDerivedAnalysis({ assetId: asset.id, editor })) {
					// Retried on the next tick, same as the embedding indexer — proxy
					// start/finish both call MediaManager.notify(), which this hook
					// also subscribes to below.
					continue;
				}

				// Hydrate from a prior session before deciding whether to (re)run —
				// `runDerivedAnalysis` already skips settled kinds internally, but
				// checking here avoids even queuing an asset that's fully done.
				const existing = await getDerivedStatus(asset.id).catch(
					() => undefined,
				);
				const relevantKinds =
					asset.type === "video"
						? (["silence", "loudness", "beats", "shots"] as const)
						: (["silence", "loudness", "beats"] as const);
				const alreadySettled =
					existing &&
					relevantKinds.every((k) =>
						["ready", "empty", "unsupported"].includes(
							existing.derived[k].state,
						),
					);
				if (alreadySettled) {
					done.add(asset.id);
					continue;
				}

				inflight.add(asset.id);
				runDerivedAnalysis(asset)
					.catch((err) => {
						console.warn(
							`[derived-media-indexer] failed for ${asset.id}:`,
							err,
						);
					})
					.finally(() => {
						inflight.delete(asset.id);
						done.add(asset.id);
					});
			}
		};

		const unsubscribe = editor.media.subscribe(() => {
			setTimeout(tick, 0);
		});

		setTimeout(tick, 500);

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [editor]);
}
